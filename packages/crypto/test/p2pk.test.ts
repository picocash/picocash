import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hashToCurve, hexToBytes, bytesToHex } from '../src/index.js';
import { p2pkPublicKey, p2pkSecretHex, p2pkWitness, parseP2pkSecret, signP2pk, verifyP2pkSpend } from '../src/p2pk.js';

const alice = secp256k1.utils.randomPrivateKey();
const bob = secp256k1.utils.randomPrivateKey();
const carol = secp256k1.utils.randomPrivateKey();
const A = p2pkPublicKey(alice), B = p2pkPublicKey(bob), C = p2pkPublicKey(carol);
const NOW = 1_800_000_000;

describe('PIP-08 P2PK', () => {
  it('round-trips a secret and is usable as a hash_to_curve input', () => {
    const s = p2pkSecretHex(A, { locktime: NOW + 100, refund: [B] });
    const c = parseP2pkSecret(s)!;
    expect(c.data).toBe(A);
    expect(c.locktime).toBe(NOW + 100);
    expect(c.refund).toEqual([B]);
    expect(hashToCurve(hexToBytes(s)).toRawBytes(true)).toHaveLength(33);
    expect(parseP2pkSecret(bytesToHex(secp256k1.utils.randomPrivateKey()))).toBeNull(); // plain secret
  });

  it('lock key spends before locktime; nobody else does', () => {
    const s = p2pkSecretHex(A, { locktime: NOW + 100, refund: [B] });
    expect(verifyP2pkSpend(s, p2pkWitness([signP2pk(s, alice)]), NOW)).toEqual({ ok: true, path: 'lock' });
    expect(verifyP2pkSpend(s, p2pkWitness([signP2pk(s, bob)]), NOW).ok).toBe(false);
    expect(verifyP2pkSpend(s, undefined, NOW).ok).toBe(false);
    // signature over a different secret does not transfer
    const other = p2pkSecretHex(A);
    expect(verifyP2pkSpend(s, p2pkWitness([signP2pk(other, alice)]), NOW).ok).toBe(false);
  });

  it('after locktime: refund key spends, lock key no longer does; no refund key → anyone', () => {
    const s = p2pkSecretHex(A, { locktime: NOW + 100, refund: [B] });
    expect(verifyP2pkSpend(s, p2pkWitness([signP2pk(s, bob)]), NOW + 100)).toEqual({ ok: true, path: 'refund' });
    expect(verifyP2pkSpend(s, p2pkWitness([signP2pk(s, alice)]), NOW + 100).ok).toBe(false);
    const open = p2pkSecretHex(A, { locktime: NOW + 100 });
    expect(verifyP2pkSpend(open, undefined, NOW + 100)).toEqual({ ok: true, path: 'expired' });
    expect(verifyP2pkSpend(open, undefined, NOW + 99).ok).toBe(false);
  });

  it('n_sigs multisig over data + pubkeys', () => {
    const s = p2pkSecretHex(A, { pubkeys: [B, C], nSigs: 2 });
    expect(verifyP2pkSpend(s, p2pkWitness([signP2pk(s, alice)]), NOW).ok).toBe(false);
    expect(verifyP2pkSpend(s, p2pkWitness([signP2pk(s, alice), signP2pk(s, carol)]), NOW)).toEqual({ ok: true, path: 'lock' });
    // the same key twice is one signature
    expect(verifyP2pkSpend(s, p2pkWitness([signP2pk(s, alice), signP2pk(s, alice)]), NOW).ok).toBe(false);
  });

  it('rejects malformed P2PK secrets and witnesses', () => {
    const bad = bytesToHex(new TextEncoder().encode(JSON.stringify(['P2PK', { nonce: 'x', data: 'nope' }])));
    expect(verifyP2pkSpend(bad, undefined, NOW).ok).toBe(false);
    const s = p2pkSecretHex(A);
    expect(verifyP2pkSpend(s, '{"signatures":["zz"]}', NOW).ok).toBe(false);
    expect(verifyP2pkSpend(s, 'not json', NOW).ok).toBe(false);
    expect(() => p2pkSecretHex('abcd')).toThrow(/compressed/);
  });

  it('matches Cashu NUT-11 wire shape', () => {
    const s = p2pkSecretHex(A, { nonce: '859d4935c4907062a6297cf4e663e2835d90d97ecdd510745d32f6816323a41f', locktime: 1689418329, refund: [B] });
    const text = new TextDecoder().decode(hexToBytes(s));
    expect(text).toBe(`["P2PK",{"nonce":"859d4935c4907062a6297cf4e663e2835d90d97ecdd510745d32f6816323a41f","data":"${A}","tags":[["locktime","1689418329"],["refund","${B}"]]}]`);
  });
});
