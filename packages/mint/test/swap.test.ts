import { describe, expect, it } from 'vitest';
import { hexToBytes, verifyDleqBlindSignature } from '@picocash/crypto';
import { makeMint, makeOutputs, mintTokens, toProofs, yOf } from './helpers.js';

describe('swap', () => {
  it('splits a proof into change; new proofs verify and old one is spent', async () => {
    const mint = await makeMint();
    const [proof] = await mintTokens(mint, 8);
    const { outputs, pending } = makeOutputs(mint.keyset.id, [4, 2, 2]);

    const swapped = await mint.post('/v1/swap', { inputs: [proof], outputs });
    expect(swapped.status).toBe(200);
    expect(swapped.body.signatures).toHaveLength(3);
    for (const [i, sig] of swapped.body.signatures.entries()) {
      const pubkey = mint.keyset.keys.get(sig.amount)!.pubkey;
      expect(
        verifyDleqBlindSignature(hexToBytes(outputs[i].B_), hexToBytes(sig.C_), pubkey, {
          e: hexToBytes(sig.dleq.e),
          s: hexToBytes(sig.dleq.s),
        }),
      ).toBe(true);
    }

    const state = await mint.post('/v1/checkstate', { Ys: [yOf(proof!)] });
    expect(state.body.states[0].state).toBe('SPENT');

    // the change proofs themselves are spendable
    const change = toProofs(mint, pending, swapped.body.signatures);
    const next = makeOutputs(mint.keyset.id, [8]);
    const respend = await mint.post('/v1/swap', { inputs: change, outputs: next.outputs });
    expect(respend.status).toBe(200);
  });

  it('rejects a double spend and signs nothing for the failed attempt', async () => {
    const mint = await makeMint();
    const [proof] = await mintTokens(mint, 4);
    const first = makeOutputs(mint.keyset.id, [2, 2]);
    expect((await mint.post('/v1/swap', { inputs: [proof], outputs: first.outputs })).status).toBe(200);

    const second = makeOutputs(mint.keyset.id, [2, 2]);
    const doubleSpend = await mint.post('/v1/swap', { inputs: [proof], outputs: second.outputs });
    expect(doubleSpend.status).toBe(409);
    expect(doubleSpend.body.error.code).toBe('TOKEN_ALREADY_SPENT');

    // insert-before-sign: the losing request's outputs were never recorded/signed
    const orphan = await mint.db.query('SELECT 1 FROM blind_signatures WHERE b = $1', [second.outputs[0].B_]);
    expect(orphan.rows).toHaveLength(0);
  });

  it('validates amounts, proofs, and duplicates', async () => {
    const mint = await makeMint();
    const [proof] = await mintTokens(mint, 4);

    const mismatch = await mint.post('/v1/swap', { inputs: [proof], outputs: makeOutputs(mint.keyset.id, [2, 1]).outputs });
    expect(mismatch.body.error.code).toBe('AMOUNT_MISMATCH');

    const forged = { ...proof!, C: '02' + 'ab'.repeat(32) };
    const invalid = await mint.post('/v1/swap', { inputs: [forged], outputs: makeOutputs(mint.keyset.id, [4]).outputs });
    expect(invalid.body.error.code).toBe('INVALID_PROOF');

    const duplicated = await mint.post('/v1/swap', {
      inputs: [proof, proof],
      outputs: makeOutputs(mint.keyset.id, [8]).outputs,
    });
    expect(duplicated.status).toBe(400);
    expect(duplicated.body.error.code).toBe('INVALID_REQUEST');
  });

  it('concurrent redemption race: exactly one of 8 parallel swaps wins', async () => {
    const mint = await makeMint();
    const [proof] = await mintTokens(mint, 16);

    const attempts = Array.from({ length: 8 }, () => makeOutputs(mint.keyset.id, [8, 8]));
    const results = await Promise.all(
      attempts.map((attempt) => mint.post('/v1/swap', { inputs: [proof], outputs: attempt.outputs })),
    );

    const wins = results.filter((r) => r.status === 200);
    const losses = results.filter((r) => r.status === 409);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(7);
    for (const loss of losses) expect(loss.body.error.code).toBe('TOKEN_ALREADY_SPENT');

    // the ledger holds exactly one spend, and only the winner's outputs were signed
    const spent = await mint.db.query('SELECT count(*)::int AS n FROM spent_secrets');
    expect(Number((spent.rows[0] as any).n)).toBe(1);
    const signed = await mint.db.query('SELECT count(*)::int AS n FROM blind_signatures WHERE quote_id IS NULL');
    expect(Number((signed.rows[0] as any).n)).toBe(2);
  });
});
