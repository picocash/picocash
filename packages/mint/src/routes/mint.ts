import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { MintContext } from '../context.js';
import { ApiError } from '../errors.js';
import { loadIssuedSignatures, signAndRecord, sumAmounts, validateOutputs } from '../signing.js';
import { computeOutstanding } from '../solvency.js';
import { mintQuoteRequestSchema, mintRequestSchema, parseBody } from '../validation.js';

interface QuoteRow {
  id: string;
  amount: string | number;
  unit: string;
  state: string;
  deposit_ref: string | null;
  expires_at: string | number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function quoteResponse(ctx: MintContext, row: QuoteRow) {
  const tempo = ctx.config.tempo;
  return {
    quote_id: row.id,
    amount: Number(row.amount),
    unit: row.unit,
    state: row.state,
    deposit:
      ctx.config.vault === 'tempo' && tempo
        ? {
            method: 'tempo',
            chain_id: tempo.chainId,
            token: tempo.tokenAddress,
            to: tempo.depositAddress, // vault contract once it lands; mint-operator address until then
            memo: `0x${row.id}`,
            note: 'call transferWithMemo(to, amount, memo) on the token contract; the memo binds the deposit to this quote',
          }
        : {
            method: 'fake-vault',
            memo: `0x${row.id}`,
            note: 'fake vault: POST /dev/deposit {"quote_id","amount"} to simulate the on-chain deposit',
          },
    expires_at: Number(row.expires_at),
  };
}

async function fetchQuote(ctx: MintContext, quoteId: string): Promise<QuoteRow> {
  const result = await ctx.db.query<QuoteRow>('SELECT * FROM mint_quotes WHERE id = $1', [quoteId]);
  const row = result.rows[0];
  if (!row) {
    throw new ApiError(404, 'QUOTE_NOT_FOUND', `no mint quote ${quoteId}`, 'request a new quote via POST /v1/mint/quote');
  }
  return row;
}

/** UNPAID quotes check the deposit oracle on demand and flip to PAID when covered. */
async function pollDeposit(ctx: MintContext, quote: QuoteRow): Promise<void> {
  if (quote.state !== 'UNPAID') return;
  const deposit = await ctx.oracle.getDeposit(quote.id);
  if (deposit && deposit.amount >= Number(quote.amount)) {
    await ctx.db.query(`UPDATE mint_quotes SET state = 'PAID', deposit_ref = $2 WHERE id = $1 AND state = 'UNPAID'`, [quote.id, deposit.txRef]);
    quote.state = 'PAID';
    quote.deposit_ref = deposit.txRef;
  }
}

export function mintRoutes(ctx: MintContext): Hono {
  const app = new Hono();

  app.post('/quote', async (c) => {
    const body = await parseBody(c, mintQuoteRequestSchema);
    if (body.unit !== ctx.config.unit) {
      throw new ApiError(400, 'INVALID_REQUEST', `unsupported unit ${body.unit}`, `this mint issues ${ctx.config.unit}; see GET /v1/info`);
    }
    if (body.amount > ctx.config.maxMintAmount) {
      throw new ApiError(400, 'AMOUNT_LIMIT', `amount exceeds the per-quote limit of ${ctx.config.maxMintAmount}`, 'request a smaller amount, or split across multiple quotes');
    }
    // Reference-mint hard cap: global outstanding supply (showcase, not a bank).
    if (ctx.config.maxOutstanding > 0) {
      const outstanding = await computeOutstanding(ctx.db, ctx.keyset.id);
      if (outstanding + body.amount > ctx.config.maxOutstanding) {
        throw new ApiError(400, 'AMOUNT_LIMIT', `this mint caps outstanding supply at ${ctx.config.maxOutstanding} (currently ${outstanding})`, 'melt some tokens first, request a smaller amount, or use another mint; see GET /v1/solvency');
      }
    }
    const id = randomBytes(32).toString('hex'); // 32 bytes: fits a TIP-20 bytes32 memo exactly
    const expiresAt = nowSeconds() + ctx.config.quoteTtlSeconds;
    await ctx.db.query('INSERT INTO mint_quotes (id, amount, unit, expires_at) VALUES ($1, $2, $3, $4)', [id, body.amount, body.unit, expiresAt]);
    const quote = await fetchQuote(ctx, id);
    return c.json(quoteResponse(ctx, quote));
  });

  app.get('/quote/:id', async (c) => {
    const quote = await fetchQuote(ctx, c.req.param('id'));
    await pollDeposit(ctx, quote);
    return c.json(quoteResponse(ctx, quote));
  });

  app.post('/', async (c) => {
    const body = await parseBody(c, mintRequestSchema);
    const quote = await fetchQuote(ctx, body.quote_id);
    validateOutputs(body.outputs, ctx.keyset);

    if (quote.state === 'ISSUED') {
      const replay = await loadIssuedSignatures(ctx.db, quote.id, body.outputs);
      if (replay) return c.json({ signatures: replay });
      throw new ApiError(409, 'QUOTE_ALREADY_ISSUED', 'this quote already issued signatures for a different output set', 'a quote is single-use: repeat the original outputs to re-fetch its signatures, or request a new quote');
    }
    if (quote.state === 'UNPAID' && Number(quote.expires_at) < nowSeconds()) {
      throw new ApiError(400, 'QUOTE_EXPIRED', `quote ${quote.id} expired unpaid`, 'request a new quote via POST /v1/mint/quote');
    }
    await pollDeposit(ctx, quote);
    if (quote.state !== 'PAID') {
      throw new ApiError(402, 'PAYMENT_REQUIRED', `no deposit of ${quote.amount} observed for quote ${quote.id}`, `deposit ${quote.amount} ${quote.unit} with memo ${quote.id}, then retry; poll GET /v1/mint/quote/${quote.id}`);
    }
    if (sumAmounts(body.outputs) !== Number(quote.amount)) {
      throw new ApiError(400, 'AMOUNT_MISMATCH', `outputs sum to ${sumAmounts(body.outputs)}, quote is for ${quote.amount}`, 'blinded outputs must sum to exactly the quote amount');
    }

    const signatures = await ctx.db.tx(async (q) => {
      // Row lock so concurrent mints of one quote serialize; the loser replays idempotently.
      const locked = await q.query<{ state: string }>('SELECT state FROM mint_quotes WHERE id = $1 FOR UPDATE', [quote.id]);
      const state = locked.rows[0]?.state;
      if (state === 'ISSUED') {
        const replay = await loadIssuedSignatures(q, quote.id, body.outputs);
        if (replay) return replay;
        throw new ApiError(409, 'QUOTE_ALREADY_ISSUED', 'this quote already issued signatures for a different output set', 'repeat the original outputs to re-fetch its signatures, or request a new quote');
      }
      if (state !== 'PAID') {
        throw new ApiError(402, 'PAYMENT_REQUIRED', `quote ${quote.id} is not paid`, `poll GET /v1/mint/quote/${quote.id} until state is PAID, then retry`);
      }
      const signed = [];
      for (const output of body.outputs) signed.push(await signAndRecord(q, ctx.keyset, output, quote.id));
      await q.query(`UPDATE mint_quotes SET state = 'ISSUED' WHERE id = $1`, [quote.id]);
      return signed;
    });
    return c.json({ signatures });
  });

  return app;
}
