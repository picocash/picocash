import { describe, expect, it } from 'vitest';
import {
  canonicalPcBind,
  createTokenLink,
  decompose,
  MintApiError,
  parsePcBindSecret,
  parseToken,
  pcBindSecretHex,
  serializeToken,
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

  it('meltProofs nets the mint fee out of the payout', async () => {
    const { mint, wallet, proofs } = await fundedWallet(6);
    mint.config.meltFee = 2;
    const result = await wallet.meltProofs('0x00000000000000000000000000000000000000B2', proofs);
    expect(result.state).toBe('PAID');
    expect(result.amount).toBe(4); // 6 burned − 2 fee
    expect(result.fee).toBe(2);
    expect(mint.payout.calls[0]!.amount).toBe(4);

    const dust = await fundedWallet(2);
    dust.mint.config.meltFee = 2;
    await expect(dust.wallet.meltProofs('0x00000000000000000000000000000000000000B2', dust.proofs)).rejects.toThrow(/does not cover the melt fee/);
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

describe('token serialization (PIP-06)', () => {
  it('round-trips a bundle through picoA and receives from the string', async () => {
    const { wallet, proofs } = await fundedWallet(50);
    const { token, bundle, change } = await wallet.send(proofs, 13, undefined, 'lunch');
    expect(token.startsWith('picoA')).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // url/qr-safe, no padding
    const parsed = parseToken(token);
    expect(parsed.memo).toBe('lunch');
    expect(parsed.bundle.proofs.map((p) => p.amount).sort((a, b) => a - b)).toEqual([1, 4, 8]);
    expect(parsed.bundle).toEqual({ ...bundle, proofs: [...bundle.proofs].sort((a, b) => b.amount - a.amount) });

    const received = await wallet.receive(token);
    expect(sumProofs(received)).toBe(13);
    expect(sumProofs(change)).toBe(37);
  });

  it('rejects garbage, wrong versions, and DLEQ-less proofs', async () => {
    expect(() => parseToken('cashuAeyJ0b2tlbiI6W119')).toThrow(/pico/);
    expect(() => parseToken('picoBabc')).toThrow(/unsupported token version/);
    expect(() => parseToken('picoA!!!')).toThrow(/base64url/);
    const { wallet, proofs } = await fundedWallet(2);
    const bare = { mint: wallet.mintUrl, unit: 'x', keyset_id: proofs[0]!.keyset_id, proofs: [{ ...proofs[0]!, dleq: undefined }] };
    expect(() => serializeToken(bare as any)).toThrow(/DLEQ/);
  });
});

describe('token links (PIP-07)', () => {
  it('creates a short link, resolves it once, and the relay never sees plaintext', async () => {
    const { mint, wallet, proofs } = await fundedWallet(40);
    const { token } = await wallet.send(proofs, 9);
    const link = await wallet.createLink(token);
    expect(link).toMatch(/^https:\/\/mint\.test\/t\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/);
    expect(link.length).toBeLessThan(120);

    // what the relay stored is ciphertext, not the token
    const stored = await mint.db.query<{ ct: string }>('SELECT ct FROM relay_blobs');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.ct.includes('picoA')).toBe(false);
    expect(Buffer.from(stored.rows[0]!.ct, 'base64url').toString('utf8').includes('"m"')).toBe(false);

    const received = await wallet.receive(link);
    expect(sumProofs(received)).toBe(9);

    // burn-after-read
    await expect(wallet.receive(link)).rejects.toThrow(/RELAY_NOT_FOUND/);
  });

  it('rejects wrong keys and oversized uploads', async () => {
    const { wallet, proofs } = await fundedWallet(2);
    const { token } = await wallet.send(proofs, 1);
    const link = await wallet.createLink(token);
    const wrongKey = link.replace(/#.*$/, '#' + 'A'.repeat(43));
    await expect(wallet.receive(wrongKey)).rejects.toThrow(/could not be decrypted/);
    await expect(createTokenLink('x'.repeat(20_000), wallet.mintUrl, (wallet as any).fetchImpl)).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
  });
});

describe('token parse limits and link policy (review P2-1/P2-2)', () => {
  it('rejects oversize, over-count, and malformed-unit tokens', async () => {
    const { parseToken, serializeToken, TOKEN_LIMITS, parseTokenLink } = await import('../src/index.js');
    expect(() => parseToken('x'.repeat(TOKEN_LIMITS.maxChars + 1))).toThrow(/exceeds/);
    const proof = { amount: 1, keyset_id: '00deadbeefcafe00', secret: 'ab'.repeat(32), C: '02' + 'ab'.repeat(32), dleq: { e: 'ab'.repeat(32), s: 'ab'.repeat(32), r: 'ab'.repeat(32) } };
    const many = serializeToken({ mint: 'https://m.example', unit: 'tip20:1:0x' + '11'.repeat(20), keyset_id: proof.keyset_id, proofs: Array(TOKEN_LIMITS.maxProofs + 1).fill(proof) });
    expect(() => parseToken(many)).toThrow(/proofs/);
    const badUnit = serializeToken({ mint: 'https://m.example', unit: 'usd', keyset_id: proof.keyset_id, proofs: [proof] });
    expect(() => parseToken(badUnit)).toThrow(/tip20/);
    const badMint = serializeToken({ mint: 'javascript:alert(1)', unit: 'tip20:1:0x' + '11'.repeat(20), keyset_id: proof.keyset_id, proofs: [proof] });
    expect(() => parseToken(badMint)).toThrow(/http/);
  });

  it('only accepts https links (localhost exempt)', async () => {
    const { parseTokenLink } = await import('../src/index.js');
    const id = 'A'.repeat(22), key = 'B'.repeat(43);
    expect(parseTokenLink(`https://mint.example/t/${id}#${key}`)).not.toBeNull();
    expect(parseTokenLink(`http://localhost:3338/t/${id}#${key}`)).not.toBeNull();
    expect(parseTokenLink(`http://mint.example/t/${id}#${key}`)).toBeNull();
  });
});

describe('PIP-08 P2PK locks', () => {
  it('human locks to a merchant key and hands to an agent; only the merchant can claim, human can refund later', async () => {
    const { randomScalarBytes, p2pkPublicKey } = await import('@picocash/crypto');
    const { lockOf } = await import('../src/index.js');
    const { mint, wallet: human, proofs } = await fundedWallet(64);
    const merchantKey = randomScalarBytes(), humanKey = randomScalarBytes(), agentKey = randomScalarBytes();
    const now = Math.floor(Date.now() / 1000);

    const { token, change } = await human.sendLocked(proofs, 48, p2pkPublicKey(merchantKey), { locktime: now + 3600, refund: [p2pkPublicKey(humanKey)] });
    expect(sumProofs(change)).toBe(16);
    expect(token.startsWith('picoA')).toBe(true);

    // the agent carrying the token cannot claim it for itself
    const agent = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl: mint.fetchImpl });
    await expect(agent.receive(token)).rejects.toThrow(/locked/);
    await expect(agent.receive(token, { unlockKey: agentKey })).rejects.toThrow(/locked/);
    // the lock is visible offline
    expect(lockOf(parseToken(token).bundle.proofs[0]!)?.data).toBe(p2pkPublicKey(merchantKey));

    // the merchant can
    const merchant = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl: mint.fetchImpl });
    const claimed = await merchant.receive(token, { unlockKey: merchantKey });
    expect(sumProofs(claimed)).toBe(48);
    expect(claimed.every((p) => lockOf(p) === null)).toBe(true); // fresh, unconditional proofs
  });

  it('refund key reclaims after locktime; witness survives serialization', async () => {
    const { randomScalarBytes, p2pkPublicKey } = await import('@picocash/crypto');
    const { signProofs } = await import('../src/index.js');
    const { wallet, proofs } = await fundedWallet(4);
    const merchantKey = randomScalarBytes(), humanKey = randomScalarBytes();
    const past = Math.floor(Date.now() / 1000) - 10;
    const { bundle } = await wallet.sendLocked(proofs, 4, p2pkPublicKey(merchantKey), { locktime: past, refund: [p2pkPublicKey(humanKey)] });

    const signed = signProofs(bundle.proofs, humanKey);
    expect(signed[0]!.witness).toMatch(/signatures/);
    const reparsed = parseToken(serializeToken({ ...bundle, proofs: signed })).bundle;
    expect(reparsed.proofs[0]!.witness).toBe(signed[0]!.witness);

    const back = await wallet.receive(reparsed);
    expect(sumProofs(back)).toBe(4);
  });
});
