import { describe, expect, it } from 'vitest';
import { hexToBytes, verifyDleqBlindSignature } from '@picocash/crypto';
import { decompose, makeMint, makeOutputs, mintTokens, toProofs, yOf } from './helpers.js';

describe('info and keys', () => {
  it('publishes mint metadata and a well-formed keyset', async () => {
    const mint = await makeMint();
    const info = await mint.get('/v1/info');
    expect(info.status).toBe(200);
    expect(info.body.unit).toBe('usdc.e-base');
    expect(info.body.vault).toBe('fake');

    const keys = await mint.get('/v1/keys');
    expect(keys.status).toBe(200);
    const keyset = keys.body.keysets[0];
    expect(keyset.id).toMatch(/^00[0-9a-f]{14}$/);
    expect(Object.keys(keyset.keys)).toHaveLength(31); // 2^0 .. 2^30
    expect(keyset.keys['1']).toMatch(/^0[23][0-9a-f]{64}$/);

    const byId = await mint.get(`/v1/keys/${keyset.id}`);
    expect(byId.status).toBe(200);
    const missing = await mint.get('/v1/keys/00ffffffffffffff');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('KEYSET_UNKNOWN');
    expect(missing.body.error.recovery).toBeTruthy();
  });
});

describe('mint flow', () => {
  it('quote → deposit → mint, with client-verifiable DLEQ on every signature', async () => {
    const mint = await makeMint();
    const amount = 1_000_000; // $1
    const quote = await mint.post('/v1/mint/quote', { amount, unit: 'usdc.e-base' });
    expect(quote.status).toBe(200);
    expect(quote.body.state).toBe('UNPAID');
    expect(quote.body.quote_id).toMatch(/^[0-9a-f]{64}$/); // 32 bytes: doubles as the bytes32 memo
    expect(quote.body.deposit.memo).toBe(`0x${quote.body.quote_id}`);

    const { outputs, pending } = makeOutputs(mint.keyset.id, decompose(amount));

    // minting before the deposit lands must fail with recovery instructions
    const early = await mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs });
    expect(early.status).toBe(402);
    expect(early.body.error.code).toBe('PAYMENT_REQUIRED');
    expect(early.body.error.recovery).toContain(quote.body.quote_id);

    await mint.post('/dev/deposit', { quote_id: quote.body.quote_id, amount });
    const polled = await mint.get(`/v1/mint/quote/${quote.body.quote_id}`);
    expect(polled.body.state).toBe('PAID');

    const minted = await mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs });
    expect(minted.status).toBe(200);
    expect(minted.body.signatures).toHaveLength(outputs.length);

    // every signature carries a DLEQ the client verifies without trusting the mint
    for (const [i, sig] of minted.body.signatures.entries()) {
      const pubkey = mint.keyset.keys.get(sig.amount)!.pubkey;
      const ok = verifyDleqBlindSignature(hexToBytes(outputs[i].B_), hexToBytes(sig.C_), pubkey, {
        e: hexToBytes(sig.dleq.e),
        s: hexToBytes(sig.dleq.s),
      });
      expect(ok).toBe(true);
    }

    // unblinded proofs are UNSPENT
    const proofs = toProofs(mint, pending, minted.body.signatures);
    const state = await mint.post('/v1/checkstate', { Ys: proofs.map(yOf) });
    expect(state.body.states.every((s: any) => s.state === 'UNSPENT')).toBe(true);
  });

  it('replays identical mint requests idempotently, rejects different outputs', async () => {
    const mint = await makeMint();
    const amount = 7;
    const quote = await mint.post('/v1/mint/quote', { amount, unit: 'usdc.e-base' });
    await mint.post('/dev/deposit', { quote_id: quote.body.quote_id, amount });
    const { outputs } = makeOutputs(mint.keyset.id, decompose(amount));

    const first = await mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs });
    const replay = await mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const different = makeOutputs(mint.keyset.id, decompose(amount));
    const rejected = await mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs: different.outputs });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('QUOTE_ALREADY_ISSUED');
  });

  it('enforces sum, denomination, limits, and B_ single-use', async () => {
    const mint = await makeMint();

    const overLimit = await mint.post('/v1/mint/quote', { amount: mint.config.maxMintAmount + 1, unit: 'usdc.e-base' });
    expect(overLimit.body.error.code).toBe('AMOUNT_LIMIT');

    const quote = await mint.post('/v1/mint/quote', { amount: 8, unit: 'usdc.e-base' });
    await mint.post('/dev/deposit', { quote_id: quote.body.quote_id, amount: 8 });

    const wrongSum = makeOutputs(mint.keyset.id, [4, 2]);
    const mismatch = await mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs: wrongSum.outputs });
    expect(mismatch.body.error.code).toBe('AMOUNT_MISMATCH');

    const badDenom = makeOutputs(mint.keyset.id, [8]);
    badDenom.outputs[0].amount = 3;
    const invalid = await mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs: badDenom.outputs });
    expect(invalid.body.error.code).toBe('INVALID_REQUEST');

    // issue the quote, then try to reuse one of its B_ under a new quote
    const good = makeOutputs(mint.keyset.id, [8]);
    await mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs: good.outputs });
    const quote2 = await mint.post('/v1/mint/quote', { amount: 8, unit: 'usdc.e-base' });
    await mint.post('/dev/deposit', { quote_id: quote2.body.quote_id, amount: 8 });
    const reused = await mint.post('/v1/mint', { quote_id: quote2.body.quote_id, outputs: good.outputs });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('OUTPUT_ALREADY_SIGNED');
  });

  it('404s unknown quotes', async () => {
    const mint = await makeMint();
    const missing = await mint.post('/v1/mint', { quote_id: 'nope', outputs: makeOutputs(mint.keyset.id, [1]).outputs });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('QUOTE_NOT_FOUND');
  });

  it('serves concurrent identical mint requests exactly once', async () => {
    const mint = await makeMint();
    const amount = 16;
    const quote = await mint.post('/v1/mint/quote', { amount, unit: 'usdc.e-base' });
    await mint.post('/dev/deposit', { quote_id: quote.body.quote_id, amount });
    const { outputs } = makeOutputs(mint.keyset.id, decompose(amount));

    const results = await Promise.all(
      Array.from({ length: 4 }, () => mint.post('/v1/mint', { quote_id: quote.body.quote_id, outputs })),
    );
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual(results[0]!.body);
    }
    const recorded = await mint.db.query('SELECT count(*)::int AS n FROM blind_signatures WHERE quote_id = $1', [quote.body.quote_id]);
    expect(Number((recorded.rows[0] as any).n)).toBe(outputs.length);
  });
});

it('helper mintTokens returns spendable proofs', async () => {
  const mint = await makeMint();
  const proofs = await mintTokens(mint, 21);
  expect(proofs.map((p) => p.amount).sort((a, b) => a - b)).toEqual([1, 4, 16]);
});
