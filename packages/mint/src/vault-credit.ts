import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { MintContext } from './context.js';
import type { Db } from './db.js';
import { ApiError } from './errors.js';
import { parseBody } from './validation.js';
import type { Deposit, DepositOracle } from './vault.js';

/**
 * Closed-loop credit (vault 'credit'): a quote is "paid" when the issuer has
 * recorded an issuance for it. There is no chain and no deposit; the issuer's
 * own books (e.g. Stripe settlements) are the backing, and the credit is only
 * spendable at the issuer's services.
 */
export class CreditLedger implements DepositOracle {
  constructor(private readonly db: Db) {}

  async getDeposit(quoteId: string): Promise<Deposit | null> {
    const r = await this.db.query<{ ref: string; amount: string | number }>('SELECT ref, amount FROM credit_issuances WHERE quote_id = $1', [quoteId]);
    const row = r.rows[0];
    return row ? { amount: Number(row.amount), txRef: `credit:${row.ref}` } : null;
  }
}

export async function totalIssued(db: Db): Promise<number> {
  const r = await db.query<{ total: string | number | null }>('SELECT COALESCE(SUM(amount), 0) AS total FROM credit_issuances');
  return Number(r.rows[0]?.total ?? 0);
}

const issueSchema = z.object({
  quote_id: z.string().regex(/^[0-9a-f]{64}$/),
  /** The issuer's idempotency reference, e.g. the settlement release id. */
  ref: z.string().min(1).max(200),
});

function bearerOk(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** POST /v1/credit/issue — issuer only. Funds an open quote in full; idempotent per ref. */
export function creditRoutes(ctx: MintContext): Hono {
  const app = new Hono();
  app.post('/issue', async (c) => {
    const credit = ctx.config.credit!;
    if (!bearerOk(c.req.header('authorization'), credit.issueToken)) {
      throw new ApiError(401, 'UNAUTHORIZED', 'credit issuance needs the issuer token', 'only the issuer can create credit');
    }
    const body = await parseBody(c, issueSchema);
    const existing = await ctx.db.query<{ quote_id: string; amount: string | number }>('SELECT quote_id, amount FROM credit_issuances WHERE ref = $1', [body.ref]);
    if (existing.rows[0]) {
      if (existing.rows[0].quote_id !== body.quote_id) {
        throw new ApiError(409, 'REF_ALREADY_ISSUED', `ref ${body.ref} already funded another quote`, 'each issuer reference funds exactly one quote; mint from that quote');
      }
      return c.json({ quote_id: body.quote_id, ref: body.ref, amount: Number(existing.rows[0].amount), replay: true });
    }
    const q = await ctx.db.query<{ amount: string | number; state: string; expires_at: string | number; unit: string }>('SELECT amount, state, expires_at, unit FROM mint_quotes WHERE id = $1', [body.quote_id]);
    const quote = q.rows[0];
    if (!quote) throw new ApiError(404, 'QUOTE_NOT_FOUND', `no mint quote ${body.quote_id}`, 'create a quote first via POST /v1/mint/quote');
    if (quote.state !== 'UNPAID' || Number(quote.expires_at) < Math.floor(Date.now() / 1000)) {
      throw new ApiError(409, 'QUOTE_NOT_OPEN', `quote ${body.quote_id} is ${quote.state}${quote.state === 'UNPAID' ? ' but expired' : ''}`, 'create a fresh quote and issue against it');
    }
    try {
      await ctx.db.query('INSERT INTO credit_issuances (ref, quote_id, amount) VALUES ($1, $2, $3)', [body.ref, body.quote_id, Number(quote.amount)]);
    } catch {
      throw new ApiError(409, 'QUOTE_ALREADY_FUNDED', `quote ${body.quote_id} or ref ${body.ref} was funded concurrently`, 'retry with the same ref to read the result');
    }
    return c.json({ quote_id: body.quote_id, ref: body.ref, amount: Number(quote.amount), replay: false });
  });
  return app;
}
