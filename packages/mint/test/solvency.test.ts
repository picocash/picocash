import { describe, expect, it } from 'vitest';
import { computeOutstanding } from '../src/solvency.js';
import { makeMint, makeOutputs, mintTokens } from './helpers.js';

const PAYOUT_ADDR = '0x00000000000000000000000000000000000000C3';

describe('solvency', () => {
  it('outstanding = issued − spent across mint, swap, and melt', async () => {
    const mint = await makeMint();
    expect(await computeOutstanding(mint.db, mint.keyset.id)).toBe(0);

    const proofs = await mintTokens(mint, 100);
    expect(await computeOutstanding(mint.db, mint.keyset.id)).toBe(100);

    // swap is liability-neutral
    const total = proofs.reduce((s, p) => s + p.amount, 0);
    const { outputs } = makeOutputs(mint.keyset.id, [64, 32, 4]);
    expect(total).toBe(100);
    await mint.post('/v1/swap', { inputs: proofs, outputs });
    expect(await computeOutstanding(mint.db, mint.keyset.id)).toBe(100);

    // melt burns liability
    const more = await mintTokens(mint, 28);
    const quote = await mint.post('/v1/melt/quote', { amount: 28, unit: mint.config.unit, to: PAYOUT_ADDR });
    await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: more });
    expect(await computeOutstanding(mint.db, mint.keyset.id)).toBe(100);

    const solvency = await mint.get('/v1/solvency');
    expect(solvency.status).toBe(200);
    expect(solvency.body.outstanding).toBe(100);
    expect(solvency.body.keyset_id).toBe(mint.keyset.id);
  });

  it('refuses new quotes while the vault attestation is overdue', async () => {
    const mint = await makeMint();
    (mint.fakeVault as any).isPublicationOverdue = async () => true;
    const refused = await mint.post('/v1/mint/quote', { amount: 8, unit: mint.config.unit });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('ATTESTATION_OVERDUE');

    (mint.fakeVault as any).isPublicationOverdue = async () => false;
    expect((await mint.post('/v1/mint/quote', { amount: 8, unit: mint.config.unit })).status).toBe(200);
  });

  it('enforces the global outstanding cap at quote time', async () => {
    const mint = await makeMint();
    mint.config.maxOutstanding = 150;
    await mintTokens(mint, 100);

    const over = await mint.post('/v1/mint/quote', { amount: 64, unit: mint.config.unit });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('AMOUNT_LIMIT');
    expect(over.body.error.recovery).toContain('/v1/solvency');

    const under = await mint.post('/v1/mint/quote', { amount: 32, unit: mint.config.unit });
    expect(under.status).toBe(200);
  });
});

describe('outstanding cap — reservation (review P0-4)', () => {
  it('counts open quotes against the cap so a quote flood cannot bypass it', async () => {
    const mint = await makeMint();
    mint.config.maxOutstanding = 100;
    // open quotes totalling 90 while nothing is issued yet
    for (let i = 0; i < 3; i++) expect((await mint.post('/v1/mint/quote', { amount: 30, unit: mint.config.unit })).status).toBe(200);
    const over = await mint.post('/v1/mint/quote', { amount: 20, unit: mint.config.unit });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain('reserved by open quotes 90');
    expect((await mint.post('/v1/mint/quote', { amount: 10, unit: mint.config.unit })).status).toBe(200);
  });

  it('re-enforces the cap at issuance time under the transaction', async () => {
    const mint = await makeMint();
    mint.config.maxOutstanding = 0; // uncapped while quotes are created...
    const q1 = await mint.post('/v1/mint/quote', { amount: 64, unit: mint.config.unit });
    const q2 = await mint.post('/v1/mint/quote', { amount: 64, unit: mint.config.unit });
    await mint.post('/dev/deposit', { quote_id: q1.body.quote_id, amount: 64 });
    await mint.post('/dev/deposit', { quote_id: q2.body.quote_id, amount: 64 });
    mint.config.maxOutstanding = 100; // ...then the cap drops; only one can issue
    const first = await mint.post('/v1/mint', { quote_id: q1.body.quote_id, outputs: makeOutputs(mint.keyset.id, [64]).outputs });
    expect(first.status).toBe(200);
    const second = await mint.post('/v1/mint', { quote_id: q2.body.quote_id, outputs: makeOutputs(mint.keyset.id, [64]).outputs });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('AMOUNT_LIMIT');
    expect(await computeOutstanding(mint.db, mint.keyset.id)).toBe(64);
  });
});
