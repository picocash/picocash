import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@picocash/crypto';
import { Hono } from 'hono';
import type { MintContext } from '../context.js';
import { ApiError } from '../errors.js';
import { spendInputs, sumAmounts, verifyInputs, type VerifiedInput } from '../signing.js';
import { meltQuoteRequestSchema, meltRequestSchema, parseBody } from '../validation.js';

interface MeltRow {
  id: string;
  amount: string | number;
  unit: string;
  to_address: string;
  state: string; // UNPAID → PENDING → PAID, OWED = retryable payout failure
  inputs_hash: string | null;
  tx_hash: string | null;
  expires_at: string | number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const inputsHash = (inputs: VerifiedInput[]) =>
  bytesToHex(sha256(utf8ToBytes(inputs.map((i) => i.y).sort().join(','))));

function meltResponse(row: MeltRow) {
  return {
    melt_id: row.id,
    amount: Number(row.amount),
    unit: row.unit,
    to: row.to_address,
    state: row.state,
    tx_hash: row.tx_hash,
    expires_at: Number(row.expires_at),
  };
}

async function fetchMelt(ctx: MintContext, meltId: string): Promise<MeltRow> {
  const result = await ctx.db.query<MeltRow>('SELECT * FROM melt_quotes WHERE id = $1', [meltId]);
  const row = result.rows[0];
  if (!row) throw new ApiError(404, 'QUOTE_NOT_FOUND', `no melt quote ${meltId}`, 'request a new quote via POST /v1/melt/quote');
  return row;
}

export function meltRoutes(ctx: MintContext): Hono {
  const app = new Hono();
  const payout = ctx.payout;

  const requirePayout = () => {
    if (!payout) {
      throw new ApiError(501, 'NOT_IMPLEMENTED', 'this mint has no payout executor configured (no operator key)', 'melt is unavailable here; hold or swap tokens, or use a mint that advertises melt in GET /v1/info');
    }
    return payout;
  };

  app.post('/quote', async (c) => {
    requirePayout();
    const body = await parseBody(c, meltQuoteRequestSchema);
    if (body.unit !== ctx.config.unit) {
      throw new ApiError(400, 'INVALID_REQUEST', `unsupported unit ${body.unit}`, `this mint settles ${ctx.config.unit}; see GET /v1/info`);
    }
    if (body.amount > ctx.config.maxMintAmount) {
      throw new ApiError(400, 'AMOUNT_LIMIT', `amount exceeds the per-quote limit of ${ctx.config.maxMintAmount}`, 'request a smaller amount, or split across multiple melts');
    }
    const id = randomBytes(32).toString('hex'); // becomes the vault's bytes32 meltId
    const expiresAt = nowSeconds() + ctx.config.quoteTtlSeconds;
    await ctx.db.query('INSERT INTO melt_quotes (id, amount, unit, to_address, expires_at) VALUES ($1, $2, $3, $4, $5)', [id, body.amount, body.unit, body.to, expiresAt]);
    return c.json(meltResponse(await fetchMelt(ctx, id)));
  });

  app.get('/quote/:id', async (c) => c.json(meltResponse(await fetchMelt(ctx, c.req.param('id')))));

  app.post('/', async (c) => {
    const executor = requirePayout();
    const body = await parseBody(c, meltRequestSchema);
    const melt = await fetchMelt(ctx, body.melt_id);
    const inputs = verifyInputs(ctx.keyset, body.inputs);
    if (sumAmounts(inputs) !== Number(melt.amount)) {
      throw new ApiError(400, 'AMOUNT_MISMATCH', `inputs sum to ${sumAmounts(inputs)}, melt is for ${melt.amount}`, 'inputs must sum to exactly the melt amount (no fees in v0.1); use /v1/swap for change first');
    }
    const hash = inputsHash(inputs);

    if (melt.state === 'PAID') {
      if (melt.inputs_hash === hash) return c.json(meltResponse(melt)); // idempotent replay
      throw new ApiError(409, 'MELT_ALREADY_PAID', 'this melt already paid out against a different input set', 'a melt quote is single-use: request a new quote for further melts');
    }

    if (melt.state === 'UNPAID') {
      if (Number(melt.expires_at) < nowSeconds()) {
        throw new ApiError(400, 'QUOTE_EXPIRED', `melt quote ${melt.id} expired`, 'request a new quote via POST /v1/melt/quote');
      }
      // Insert-before-pay: consume the proofs and durably record the debt in
      // one transaction, before any chain call. A spent-ledger conflict aborts
      // everything and nothing is owed.
      await ctx.db.tx(async (q) => {
        const locked = await q.query<{ state: string }>('SELECT state FROM melt_quotes WHERE id = $1 FOR UPDATE', [melt.id]);
        if (locked.rows[0]?.state !== 'UNPAID') {
          throw new ApiError(409, 'MELT_ALREADY_PAID', `melt ${melt.id} is already ${locked.rows[0]?.state}`, 'if you hold the original inputs, re-POST them to retry/fetch the result');
        }
        await spendInputs(q, inputs);
        await q.query(`UPDATE melt_quotes SET state = 'PENDING', inputs_hash = $2 WHERE id = $1`, [melt.id, hash]);
      });
    } else if (melt.state === 'PENDING' || melt.state === 'OWED') {
      // Retry path: proofs were already consumed. Only the original input set
      // may retry, and the vault's one-payout-per-meltId guard is the backstop.
      if (melt.inputs_hash !== hash) {
        throw new ApiError(409, 'MELT_ALREADY_PAID', 'these inputs do not match the recorded melt', 'retry with exactly the original inputs, or contact the operator');
      }
    }

    try {
      const txHash = await executor.execute(melt.to_address, Number(melt.amount), melt.id);
      await ctx.db.query(`UPDATE melt_quotes SET state = 'PAID', tx_hash = $2 WHERE id = $1`, [melt.id, txHash]);
    } catch (err) {
      await ctx.db.query(`UPDATE melt_quotes SET state = 'OWED' WHERE id = $1`, [melt.id]);
      console.error(`[mint] payout failed for melt ${melt.id}:`, err);
      throw new ApiError(502, 'PAYOUT_FAILED', `payout for melt ${melt.id} failed; your tokens are consumed and the debt is recorded`, `re-POST /v1/melt with the same melt_id and inputs to retry the payout; poll GET /v1/melt/quote/${melt.id}`);
    }
    return c.json(meltResponse(await fetchMelt(ctx, melt.id)));
  });

  return app;
}
