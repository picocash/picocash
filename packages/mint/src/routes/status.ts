import { Hono } from 'hono';
import type { MintContext } from '../context.js';
import { computeOutstanding, computeReserved } from '../solvency.js';
import { statusPage } from './status-page.js';

/**
 * Mint transparency: GET /v1/status composes the mint's own books, the
 * vault's on-chain state, and the reconciliation checks between them; GET /
 * renders it. "Slow, visible, bounded, escapable" — this is the visible part.
 */
export function statusRoutes(ctx: MintContext): Hono {
  const app = new Hono();

  app.get('/v1/status', async (c) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const amounts = [...ctx.keyset.keys.keys()];
    const probeAmount = Math.max(...amounts);
    const [outstanding, reserved, chain, mints, melts, totals] = await Promise.all([
      computeOutstanding(ctx.db, ctx.keyset.id),
      computeReserved(ctx.db, nowSeconds),
      ctx.oracle.chainStatus ? ctx.oracle.chainStatus(ctx.keyset.id, probeAmount).catch(() => null) : Promise.resolve(null),
      ctx.db.query<{ id: string; amount: string | number; state: string; deposit_ref: string | null; created_at: string | Date }>(
        `SELECT id, amount, state, deposit_ref, created_at FROM mint_quotes WHERE state IN ('PAID','ISSUED') ORDER BY created_at DESC LIMIT 25`,
      ),
      ctx.db.query<{ id: string; amount: string | number; fee: string | number; state: string; tx_hash: string | null; created_at: string | Date }>(
        `SELECT id, amount, fee, state, tx_hash, created_at FROM melt_quotes WHERE state IN ('PAID','OWED','PENDING') ORDER BY created_at DESC LIMIT 25`,
      ),
      ctx.db.query<{ deposits: string | number; deposit_count: string | number; payouts: string | number; fees: string | number; payout_count: string | number; owed: string | number }>(
        `SELECT
           (SELECT COALESCE(SUM(amount),0) FROM mint_quotes WHERE state IN ('PAID','ISSUED')) AS deposits,
           (SELECT COUNT(*) FROM mint_quotes WHERE state IN ('PAID','ISSUED')) AS deposit_count,
           (SELECT COALESCE(SUM(amount),0) FROM melt_quotes WHERE state = 'PAID') AS payouts,
           (SELECT COALESCE(SUM(fee),0) FROM melt_quotes WHERE state = 'PAID') AS fees,
           (SELECT COUNT(*) FROM melt_quotes WHERE state = 'PAID') AS payout_count,
           (SELECT COALESCE(SUM(amount),0) FROM melt_quotes WHERE state IN ('OWED','PENDING')) AS owed`,
      ),
    ]);
    const t = totals.rows[0]!;
    const n = (x: string | number | undefined | null) => Number(x ?? 0);
    const ts = (d: string | Date) => Math.floor(new Date(d).getTime() / 1000);
    const deposits = n(t.deposits), payouts = n(t.payouts), fees = n(t.fees), owed = n(t.owed);
    const balance = chain ? Number(chain.balance) : null;

    // ---- reconciliation checks: each is a statement that SHOULD hold, with the numbers ----
    const checks: Array<{ id: string; label: string; ok: boolean | null; detail: string }> = [];
    checks.push({
      id: 'backing', label: 'Backing ≥ outstanding tokens',
      ok: balance === null ? null : balance >= outstanding,
      detail: balance === null ? 'no chain data' : `vault ${balance} ≥ outstanding ${outstanding} (surplus ${balance - outstanding})`,
    });
    const attested = chain?.last_outstanding !== null && chain?.last_outstanding !== undefined ? Number(chain.last_outstanding) : null;
    checks.push({
      id: 'attestation', label: 'Attested outstanding matches the mint\'s books',
      ok: attested === null ? null : Math.abs(attested - outstanding) <= Math.max(1, Math.floor(outstanding * 0.02)),
      detail: attested === null ? 'never attested' : `attested ${attested} vs books ${outstanding} (drift ${outstanding - attested}; new issuance since publication is expected drift)`,
    });
    const interval = chain?.publish_interval_blocks ?? null;
    const sinceBlocks = chain?.last_published_block ? chain.block - chain.last_published_block : null;
    checks.push({
      id: 'freshness', label: 'Attestation within the vault\'s interval',
      ok: chain?.publication_overdue === null || chain?.publication_overdue === undefined ? null : !chain.publication_overdue,
      detail: sinceBlocks === null ? 'never attested' : `${sinceBlocks} blocks since last publication, interval ${interval ?? '—'}`,
    });
    const explained = deposits - payouts; // fees stay in the vault, so they are part of balance, not a subtraction
    checks.push({
      id: 'ledger', label: 'Deposits − payouts reconcile with the vault balance',
      ok: balance === null ? null : Math.abs(balance - explained) <= Math.max(1, Math.floor(balance * 0.001)),
      detail: balance === null ? 'no chain data' : `Σ deposits ${deposits} − Σ payouts ${payouts} = ${explained}; vault ${balance}; delta ${balance - explained} (operator top-ups, vault migrations, emergency redemptions, or direct transfers)`,
    });
    const maxFee = chain?.max_melt_fee !== null && chain?.max_melt_fee !== undefined ? Number(chain.max_melt_fee) : null;
    checks.push({
      id: 'fee', label: 'Melt fee under the on-chain ceiling',
      ok: maxFee === null ? null : ctx.config.meltFee <= maxFee,
      detail: maxFee === null ? 'vault predates maxMeltFee' : `fee ${ctx.config.meltFee} ≤ maxMeltFee ${maxFee}`,
    });
    checks.push({
      id: 'exit', label: 'Unilateral exit armed (grace > 0, keyset registered)',
      ok: chain?.emergency ? chain.emergency.grace_blocks > 0 && chain.keyset_registered === true : chain ? false : null,
      detail: chain?.emergency ? `grace ${chain.emergency.grace_blocks} blocks, keyset ${chain.keyset_registered ? 'registered' : 'NOT registered'}, mode ${chain.emergency.mode ? 'EMERGENCY' : 'normal'}, redeemed ${chain.emergency.redeemed} / cap ${chain.emergency.cap}` : 'vault has no emergency redemption (v1)',
    });
    checks.push({ id: 'owed', label: 'No unpaid melt debt', ok: owed === 0, detail: owed === 0 ? 'no OWED/PENDING melts' : `${owed} base units owed across unpaid melts` });

    return c.json({
      generated_at: nowSeconds,
      mint: {
        name: ctx.config.name, version: 'picocash-mint/0.1.0', unit: ctx.config.unit,
        keyset: { id: ctx.keyset.id, denominations: amounts.length, max: probeAmount },
        fees: { melt: ctx.config.meltFee }, limits: { max_mint_amount: ctx.config.maxMintAmount, max_outstanding: ctx.config.maxOutstanding || null },
        spending_conditions: ['P2PK'], relay: ctx.config.relay.enabled, melt: Boolean(ctx.payout),
      },
      vault: ctx.config.vault === 'tempo' && ctx.config.tempo
        ? { chain_id: ctx.config.tempo.chainId, address: ctx.config.tempo.depositAddress, token: ctx.config.tempo.tokenAddress }
        : null,
      books: { outstanding, reserved, deposits, deposit_count: n(t.deposit_count), payouts, payout_count: n(t.payout_count), fees_retained: fees, owed },
      chain,
      checks,
      ledger: {
        mints: mints.rows.map((r) => ({ quote_id: r.id, amount: n(r.amount), state: r.state, tx: r.deposit_ref, at: ts(r.created_at) })),
        melts: melts.rows.map((r) => ({ melt_id: r.id, amount: n(r.amount), fee: n(r.fee), state: r.state, tx: r.tx_hash, at: ts(r.created_at) })),
      },
    });
  });

  app.get('/', (c) => {
    if (!(c.req.header('accept') ?? '').includes('text/html')) {
      return c.json({ name: ctx.config.name, info: '/v1/info', status: '/v1/status', keys: '/v1/keys', solvency: '/v1/solvency' });
    }
    c.header('cache-control', 'no-store');
    c.header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'");
    return c.html(statusPage({ name: ctx.config.name }));
  });

  return app;
}
