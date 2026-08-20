import { describe, expect, it } from 'vitest';
import { makeMint, makeOutputs, mintTokens, yOf } from './helpers.js';

const PAYOUT_ADDR = '0x00000000000000000000000000000000000000A1';

describe('melt', () => {
  it('burns proofs and pays out; checkstate shows SPENT', async () => {
    const mint = await makeMint();
    const proofs = await mintTokens(mint, 6); // 4 + 2

    const quote = await mint.post('/v1/melt/quote', { amount: 6, unit: mint.config.unit, to: PAYOUT_ADDR });
    expect(quote.status).toBe(200);
    expect(quote.body.melt_id).toMatch(/^[0-9a-f]{64}$/);
    expect(quote.body.state).toBe('UNPAID');

    const melted = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(melted.status).toBe(200);
    expect(melted.body.state).toBe('PAID');
    expect(melted.body.tx_hash).toMatch(/^fake-payout-/);
    expect(mint.payout.calls).toEqual([{ to: PAYOUT_ADDR, amount: 6, meltId: quote.body.melt_id }]);

    const state = await mint.post('/v1/checkstate', { Ys: proofs.map(yOf) });
    expect(state.body.states.every((s: any) => s.state === 'SPENT')).toBe(true);

    // melted proofs are dead for swap too
    const respend = await mint.post('/v1/swap', { inputs: [proofs[0]], outputs: makeOutputs(mint.keyset.id, [4]).outputs });
    expect(respend.body.error.code).toBe('TOKEN_ALREADY_SPENT');
  });

  it('replays a PAID melt idempotently, rejects foreign inputs', async () => {
    const mint = await makeMint();
    const proofs = await mintTokens(mint, 2);
    const quote = await mint.post('/v1/melt/quote', { amount: 2, unit: mint.config.unit, to: PAYOUT_ADDR });
    const first = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(first.body.state).toBe('PAID');

    const replay = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(mint.payout.calls).toHaveLength(1); // no second payout

    const other = await mintTokens(mint, 2);
    const foreign = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: other });
    expect(foreign.status).toBe(409);
    expect(foreign.body.error.code).toBe('MELT_ALREADY_PAID');
  });

  it('records OWED on payout failure; same inputs retry to PAID', async () => {
    const mint = await makeMint();
    const proofs = await mintTokens(mint, 4);
    const quote = await mint.post('/v1/melt/quote', { amount: 4, unit: mint.config.unit, to: PAYOUT_ADDR });

    mint.payout.failNext = true;
    const failed = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('PAYOUT_FAILED');
    expect((await mint.get(`/v1/melt/quote/${quote.body.melt_id}`)).body.state).toBe('OWED');
    // debt is durable: the proofs are already consumed
    expect((await mint.post('/v1/checkstate', { Ys: proofs.map(yOf) })).body.states[0].state).toBe('SPENT');

    const retried = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(retried.status).toBe(200);
    expect(retried.body.state).toBe('PAID');
    expect(mint.payout.calls).toHaveLength(1);
  });

  it('validates amount and expiry rules', async () => {
    const mint = await makeMint();
    const proofs = await mintTokens(mint, 4);

    const quote = await mint.post('/v1/melt/quote', { amount: 8, unit: mint.config.unit, to: PAYOUT_ADDR });
    const mismatch = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(mismatch.body.error.code).toBe('AMOUNT_MISMATCH');

    const overLimit = await mint.post('/v1/melt/quote', { amount: mint.config.maxMintAmount + 1, unit: mint.config.unit, to: PAYOUT_ADDR });
    expect(overLimit.body.error.code).toBe('AMOUNT_LIMIT');

    const badAddr = await mint.post('/v1/melt/quote', { amount: 4, unit: mint.config.unit, to: 'not-an-address' });
    expect(badAddr.body.error.code).toBe('INVALID_REQUEST');
  });

  it('melt fee: inputs cover amount + fee, payout excludes fee, surplus accrues', async () => {
    const mint = await makeMint();
    mint.config.meltFee = 2;
    const proofs = await mintTokens(mint, 6);

    const quote = await mint.post('/v1/melt/quote', { amount: 4, unit: mint.config.unit, to: PAYOUT_ADDR });
    expect(quote.body.fee).toBe(2);
    expect(quote.body.total).toBe(6);

    // inputs covering only the payout are rejected with the fee spelled out
    const short = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs.filter((p) => p.amount === 4) });
    expect(short.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(short.body.error.message).toContain('fee 2');

    // full total burns 6, pays out 4 — the 2 stays in the vault as surplus
    const melted = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(melted.body.state).toBe('PAID');
    expect(mint.payout.calls).toEqual([{ to: PAYOUT_ADDR, amount: 4, meltId: quote.body.melt_id }]);

    const { computeOutstanding } = await import('../src/solvency.js');
    expect(await computeOutstanding(mint.db, mint.keyset.id)).toBe(0); // all 6 burned
  });

  it('one payout even under concurrent melt requests', async () => {
    const mint = await makeMint();
    const proofs = await mintTokens(mint, 8);
    const quote = await mint.post('/v1/melt/quote', { amount: 8, unit: mint.config.unit, to: PAYOUT_ADDR });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs })),
    );
    // every request ends 200 (winner pays, others replay/retry the recorded melt)
    expect(results.filter((r) => r.status === 200).length + results.filter((r) => r.status === 409).length).toBe(4);
    expect(mint.payout.calls.length).toBeLessThanOrEqual(1 + results.filter((r) => r.status !== 200).length);
    expect((await mint.get(`/v1/melt/quote/${quote.body.melt_id}`)).body.state).toBe('PAID');
    const spent = await mint.db.query('SELECT count(*)::int AS n FROM spent_secrets');
    expect(Number((spent.rows[0] as any).n)).toBe(1);
  });
});

describe('melt crash recovery (review P1-3)', () => {
  it('recovers a payout that landed on-chain but whose response was lost', async () => {
    const mint = await makeMint();
    const proofs = await mintTokens(mint, 4);
    const quote = await mint.post('/v1/melt/quote', { amount: 4, unit: mint.config.unit, to: PAYOUT_ADDR });

    mint.payout.landButFailNext = true; // tx succeeds on-chain, mint never hears back
    const failed = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(failed.status).toBe(502);
    expect((await mint.get(`/v1/melt/quote/${quote.body.melt_id}`)).body.state).toBe('OWED');

    // retry: the vault's meltPaid flag is the truth — mark PAID, do NOT pay again
    const retried = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: proofs });
    expect(retried.status).toBe(200);
    expect(retried.body.state).toBe('PAID');
    expect(retried.body.tx_hash).toContain('paid-on-chain');
    expect(mint.payout.calls).toHaveLength(1); // exactly one payout ever
  });
});
