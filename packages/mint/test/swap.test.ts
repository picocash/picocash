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

describe('PIP-08 P2PK spending conditions', () => {
  it('enforces the lock on swap and melt; refund key after locktime', async () => {
    const { p2pkPublicKey, p2pkSecretHex, p2pkWitness, signP2pk, randomScalarBytes } = await import('@picocash/crypto');
    const mint = await makeMint();
    const plain = await mintTokens(mint, 8);
    const agent = randomScalarBytes(), human = randomScalarBytes();
    const now = Math.floor(Date.now() / 1000);

    // lock 8 to the agent's key with a refund to the human in 1000s
    const lockSecret = p2pkSecretHex(p2pkPublicKey(agent), { locktime: now + 1000, refund: [p2pkPublicKey(human)] });
    const { outputs, pending } = makeOutputs(mint.keyset.id, [8], [lockSecret]);
    const swapped = await mint.post('/v1/swap', { inputs: plain, outputs });
    expect(swapped.status).toBe(200);
    const locked = toProofs(mint, pending, swapped.body.signatures);

    // nobody can spend it bare
    const bare = await mint.post('/v1/swap', { inputs: locked, outputs: makeOutputs(mint.keyset.id, [8]).outputs });
    expect(bare.status).toBe(403);
    expect(bare.body.error.code).toBe('SPENDING_CONDITION_FAILED');

    // a signature from the wrong key is no better
    const wrong = locked.map((p) => ({ ...p, witness: p2pkWitness([signP2pk(p.secret, human)]) }));
    expect((await mint.post('/v1/swap', { inputs: wrong, outputs: makeOutputs(mint.keyset.id, [8]).outputs })).status).toBe(403);

    // the agent's signature unlocks it — for melt too
    const signed = locked.map((p) => ({ ...p, witness: p2pkWitness([signP2pk(p.secret, agent)]) }));
    const quote = await mint.post('/v1/melt/quote', { amount: 8, unit: mint.config.unit, to: '0x00000000000000000000000000000000000000A1' });
    const melted = await mint.post('/v1/melt', { melt_id: quote.body.melt_id, inputs: signed });
    expect(melted.status).toBe(200);
    expect(melted.body.state).toBe('PAID');
  });

  it('a malformed P2PK secret can be minted (it is just bytes) but never spent', async () => {
    const mint = await makeMint();
    const plain = await mintTokens(mint, 2);
    const badSecret = Buffer.from(JSON.stringify(['P2PK', { nonce: 'n', data: 'not-a-key' }])).toString('hex');
    const { outputs, pending } = makeOutputs(mint.keyset.id, [2], [badSecret]);
    const swapped = await mint.post('/v1/swap', { inputs: plain, outputs });
    expect(swapped.status).toBe(200);
    const stuck = toProofs(mint, pending, swapped.body.signatures);
    const res = await mint.post('/v1/swap', { inputs: stuck, outputs: makeOutputs(mint.keyset.id, [2]).outputs });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('compressed pubkey');
  });
});
