import { describe, expect, it } from 'vitest';
import {
  canonicalPcBind,
  decompose,
  MintApiError,
  parsePcBindSecret,
  pcBindSecretHex,
  sumProofs,
  verifyProofOffline,
  Wallet,
} from '../src/index.js';
import { makeTestMint, TEST_MINT_URL } from './helper.js';

async function fundedWallet(amount: number) {
  const mint = await makeTestMint();
  const wallet = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl: mint.fetchImpl });
  const quote = await wallet.requestMintQuote(amount);
  mint.fakeVault.simulateDeposit(quote.quote_id, amount);
  const proofs = await wallet.mintProofs(quote.quote_id, amount);
  return { mint, wallet, proofs };
}

describe('Wallet', () => {
  it('mints DLEQ-verified, offline-verifiable proofs', async () => {
    const { mint, wallet, proofs } = await fundedWallet(21);
    expect(proofs.map((p) => p.amount).sort((a, b) => a - b)).toEqual([1, 4, 16]);
    const keyset = await wallet.getKeyset();
    expect(keyset.id).toBe(mint.keyset.id);
    for (const proof of proofs) {
      expect(proof.dleq?.r).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyProofOffline(proof, keyset)).toBe(true);
    }
    // tampering kills offline verification
    const forged = { ...proofs[0]!, C: proofs[1]!.C };
    expect(verifyProofOffline(forged, keyset)).toBe(false);
  });

  it('send produces an exact bundle + change; receive claims it and burns the original', async () => {
    const { wallet, proofs } = await fundedWallet(100);
    const { bundle, change } = await wallet.send(proofs, 37);
    expect(sumProofs(bundle.proofs)).toBe(37);
    expect(sumProofs(change)).toBe(63);
    expect(bundle.keyset_id).toBe((await wallet.getKeyset()).id);

    const received = await wallet.receive(bundle);
    expect(sumProofs(received)).toBe(37);

    // the bundle's proofs are now spent: a second receive must fail at the mint
    await expect(wallet.receive(bundle)).rejects.toMatchObject({ code: 'TOKEN_ALREADY_SPENT' });

    // and a tampered bundle never even reaches the mint
    const bad = { ...bundle, proofs: [{ ...received[0]!, C: received[1]!.C }] };
    await expect(wallet.receive(bad)).rejects.toThrow(/offline DLEQ/);
  });

  it('binds payment secrets to a challenge (PC-BIND)', async () => {
    const { wallet, proofs } = await fundedWallet(8);
    const nonce = 'ab'.repeat(32);
    const secrets = decompose(5).map(() => pcBindSecretHex(nonce, 'api.example.dev'));
    const { bundle } = await wallet.send(proofs, 5, secrets);
    for (const proof of bundle.proofs) {
      const bind = parsePcBindSecret(proof.secret);
      expect(bind).not.toBeNull();
      expect(bind!.nonce).toBe(nonce);
      expect(bind!.realm).toBe('api.example.dev');
    }
    // non-canonical encodings are rejected by the parser
    const shuffled = Buffer.from('["PC-BIND",{"realm":"x","nonce":"y","salt":"z"}]').toString('hex');
    expect(parsePcBindSecret(shuffled)).toBeNull();
    expect(canonicalPcBind({ nonce: 'y', realm: 'x', salt: 'z' })).toContain('"nonce":"y"');
  });

  it('melts proofs through the payout executor', async () => {
    const { mint, wallet, proofs } = await fundedWallet(6);
    const result = await wallet.meltProofs('0x00000000000000000000000000000000000000B2', proofs);
    expect(result.state).toBe('PAID');
    expect(mint.payout.calls).toEqual([
      { to: '0x00000000000000000000000000000000000000B2', amount: 6, meltId: result.melt_id },
    ]);
    const states = await wallet.checkstate(proofs);
    expect(states.every((s) => s.state === 'SPENT')).toBe(true);
  });

  it('surfaces mint errors as MintApiError with recovery hints', async () => {
    const { wallet, proofs } = await fundedWallet(4);
    const quote = await wallet.requestMeltQuote(999, '0x00000000000000000000000000000000000000B2');
    const err = await wallet.melt(quote.melt_id, proofs).catch((e) => e);
    expect(err).toBeInstanceOf(MintApiError);
    expect(err.code).toBe('AMOUNT_MISMATCH');
    expect(err.recovery).toBeTruthy();
  });

  it('decompose rejects non-positive and unsafe amounts', () => {
    expect(() => decompose(0)).toThrow();
    expect(() => decompose(-5)).toThrow();
    expect(decompose(1_000_000)).toHaveLength(7);
  });
});
