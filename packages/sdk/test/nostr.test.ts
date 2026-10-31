import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { p2pkSecretHex, verifyP2pkSpend } from '@picocash/crypto';
import { lockKeyFromNpub, npubFromPubkey, privkeyFromNsec, signerFromNsec } from '../src/nostr.js';

// Known NIP-19 vector (from the NIP-19 spec): this nsec decodes to this hex.
const KNOWN_NSEC = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const KNOWN_HEX = '67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa';

describe('nostr key adapter', () => {
  it('decodes the known NIP-19 nsec to its documented hex', () => {
    expect(bytesToHex(privkeyFromNsec(KNOWN_NSEC))).toBe(KNOWN_HEX);
    // and accepts bare hex too
    expect(bytesToHex(privkeyFromNsec(KNOWN_HEX))).toBe(KNOWN_HEX);
  });

  it('round-trips npub ⇄ x-only pubkey and derives a 02-prefixed lock key', () => {
    const xonly = bytesToHex(schnorr.getPublicKey(privkeyFromNsec(KNOWN_NSEC)));
    const npub = npubFromPubkey(xonly);
    expect(npub.startsWith('npub1')).toBe(true);
    expect(lockKeyFromNpub(npub)).toBe(`02${xonly}`);
    // lockKeyFromNpub accepts bare x-only and compressed forms identically
    expect(lockKeyFromNpub(xonly)).toBe(`02${xonly}`);
    expect(lockKeyFromNpub(`03${xonly}`)).toBe(`02${xonly}`);
  });

  it('rejects malformed input', () => {
    expect(() => privkeyFromNsec('npub1xxx')).toThrow();
    expect(() => lockKeyFromNpub('nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5')).toThrow(/npub/);
    expect(() => lockKeyFromNpub('deadbeef')).toThrow();
  });

  it('signs a proof locked to its own npub and the mint accepts it — for BOTH key parities', () => {
    // Prove the parity-robust path: force one even-Y (02) and one odd-Y (03) key.
    const keys: Record<string, Uint8Array> = {};
    for (let i = 0; i < 200 && Object.keys(keys).length < 2; i++) {
      const pk = secp256k1.utils.randomPrivateKey();
      const parity = secp256k1.getPublicKey(pk, true)[0] === 0x03 ? '03' : '02';
      keys[parity] ??= pk;
    }
    expect(Object.keys(keys).sort()).toEqual(['02', '03']); // got both

    for (const [parity, privkey] of Object.entries(keys)) {
      const signer = signerFromNsec(bytesToHex(privkey));
      const secret = p2pkSecretHex(signer.lockKey); // lock to this npub
      const [signed] = signer.sign([{ amount: 1, secret, C: '02'.padEnd(66, '0'), keyset_id: 'a'.repeat(16) }]);
      const verdict = verifyP2pkSpend(secret, signed!.witness, Math.floor(Date.now() / 1000));
      expect(verdict.ok, `parity ${parity} should verify`).toBe(true);
    }
  });

  it('signs via the refund path and leaves unrelated proofs untouched', () => {
    const agent = signerFromNsec(bytesToHex(secp256k1.utils.randomPrivateKey()));
    const owner = signerFromNsec(bytesToHex(secp256k1.utils.randomPrivateKey()));
    const stranger = signerFromNsec(bytesToHex(secp256k1.utils.randomPrivateKey()));

    // Owner funds agent: locked to agent, refundable to owner after locktime.
    const past = Math.floor(Date.now() / 1000) - 3600;
    const secret = p2pkSecretHex(agent.lockKey, { locktime: past, refund: [owner.lockKey] });
    const proof = { amount: 2, secret, C: '02'.padEnd(66, '0'), keyset_id: 'b'.repeat(16) };

    // After locktime the owner's refund key can spend it.
    const [refunded] = owner.sign([proof]);
    expect(verifyP2pkSpend(secret, refunded!.witness, Math.floor(Date.now() / 1000)).ok).toBe(true);

    // A stranger's key signs nothing (proof passes through unchanged).
    expect(stranger.sign([proof])[0]).toBe(proof);
  });
});
