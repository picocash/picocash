import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { MintContext } from './context.js';
import { ApiError } from './errors.js';
import { publicKeysJson } from './keyset.js';
import { meltRoutes } from './routes/melt.js';
import { mintRoutes } from './routes/mint.js';
import { swapRoutes } from './routes/swap.js';
import { computeOutstanding } from './solvency.js';
import { amountSchema, checkstateRequestSchema, parseBody } from './validation.js';

export function buildApp(ctx: MintContext): Hono {
  const app = new Hono();

  // Browser wallets (apps/wallet-demo) talk to the mint cross-origin. The API
  // is unauthenticated by design — tokens are bearer instruments — so open
  // CORS gives up nothing.
  app.use('*', cors());

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as never);
    console.error('[mint] internal error:', err);
    return c.json(
      { error: { code: 'INTERNAL', message: 'internal mint error', recovery: 'retry with backoff; report persistent failures to the mint operator' } },
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: `no route ${c.req.method} ${c.req.path}`, recovery: 'see GET /v1/info for the endpoint list (spec/03-mint-api.md)' } },
      404,
    ),
  );

  app.get('/v1/info', (c) =>
    c.json({
      name: ctx.config.name,
      version: 'picocash-mint/0.1.0',
      unit: ctx.config.unit,
      keysets: [{ id: ctx.keyset.id, unit: ctx.keyset.unit, state: 'active' }],
      limits: { max_mint_amount: ctx.config.maxMintAmount },
      fees: { melt: ctx.config.meltFee },
      melt: Boolean(ctx.payout),
      vault:
        ctx.config.vault === 'tempo' && ctx.config.tempo
          ? { method: 'tempo', chain_id: ctx.config.tempo.chainId, token: ctx.config.tempo.tokenAddress, deposit_address: ctx.config.tempo.depositAddress }
          : 'fake',
      contact: { security: 'security@picocash.dev' },
      status: 'pre-alpha technology demonstration — do not use with real funds',
    }),
  );

  const keysetJson = () => ({
    keysets: [{ id: ctx.keyset.id, unit: ctx.keyset.unit, state: 'active', keys: publicKeysJson(ctx.keyset) }],
  });
  app.get('/v1/keys', (c) => c.json(keysetJson()));
  app.get('/v1/keys/:id', (c) => {
    if (c.req.param('id') !== ctx.keyset.id) {
      throw new ApiError(404, 'KEYSET_UNKNOWN', `no keyset ${c.req.param('id')}`, `this mint's active keyset is ${ctx.keyset.id}; see GET /v1/keys`);
    }
    return c.json(keysetJson());
  });

  // Transparency endpoint: the liability side of proof of liabilities.
  // Anyone can compare this to the vault's on-chain balance (spec/05).
  app.get('/v1/solvency', async (c) => {
    const outstanding = await computeOutstanding(ctx.db, ctx.keyset.id);
    return c.json({
      keyset_id: ctx.keyset.id,
      unit: ctx.keyset.unit,
      outstanding,
      vault: ctx.config.tempo ? { chain_id: ctx.config.tempo.chainId, address: ctx.config.tempo.depositAddress, token: ctx.config.tempo.tokenAddress } : 'fake',
    });
  });

  app.route('/v1/mint', mintRoutes(ctx));
  app.route('/v1/swap', swapRoutes(ctx));

  app.post('/v1/checkstate', async (c) => {
    const body = await parseBody(c, checkstateRequestSchema);
    const placeholders = body.Ys.map((_, i) => `$${i + 1}`).join(', ');
    const spent = await ctx.db.query<{ y: string }>(`SELECT y FROM spent_secrets WHERE y IN (${placeholders})`, body.Ys);
    const spentSet = new Set(spent.rows.map((row) => row.y));
    return c.json({ states: body.Ys.map((y) => ({ y, state: spentSet.has(y) ? 'SPENT' : 'UNSPENT' })) });
  });

  app.route('/v1/melt', meltRoutes(ctx));

  if (ctx.fakeVault) {
    const fakeVault = ctx.fakeVault;
    const devDepositSchema = z.object({ quote_id: z.string().min(1).max(64), amount: amountSchema.max(Number.MAX_SAFE_INTEGER) });
    app.post('/dev/deposit', async (c) => {
      const body = await parseBody(c, devDepositSchema);
      const quote = await ctx.db.query('SELECT id FROM mint_quotes WHERE id = $1', [body.quote_id]);
      if (quote.rows.length === 0) {
        throw new ApiError(404, 'QUOTE_NOT_FOUND', `no mint quote ${body.quote_id}`, 'create a quote first via POST /v1/mint/quote');
      }
      const deposit = fakeVault.simulateDeposit(body.quote_id, body.amount);
      return c.json({ quote_id: body.quote_id, deposited: deposit.amount, tx_ref: deposit.txRef });
    });
  }

  return app;
}
