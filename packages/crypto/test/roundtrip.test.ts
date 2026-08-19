import { describe, expect, it } from 'vitest';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import {
  blindMessage,
  createDleqProof,
  derivePublicKey,
  randomScalarBytes,
  signBlindedMessage,
  unblindSignature,
  verifyDleqBlindSignature,
  verifyDleqProof,
  verifyProof,
} from '../src/index.js';

function freshMint() {
  const privkey = randomScalarBytes();
  return { privkey, pubkey: derivePublicKey(privkey) };
}

describe('BDHKE round trip', () => {
  it('blind → sign → unblind yields a proof the mint accepts', () => {
    const { privkey, pubkey } = freshMint();
    const secret = randomScalarBytes(); // arbitrary 32 bytes
    const { B_, r } = blindMessage(secret);
    const C_ = signBlindedMessage(B_, privkey);
    const C = unblindSignature(C_, r, pubkey);
    expect(verifyProof(secret, C, privkey)).toBe(true);
  });

  it('rejects a proof against a different mint key', () => {
    const mintA = freshMint();
    const mintB = freshMint();
    const secret = utf8ToBytes('some secret');
    const { B_, r } = blindMessage(secret);
    const C = unblindSignature(signBlindedMessage(B_, mintA.privkey), r, mintA.pubkey);
    expect(verifyProof(secret, C, mintB.privkey)).toBe(false);
  });

  it('rejects a proof for a different secret', () => {
    const { privkey, pubkey } = freshMint();
    const { B_, r } = blindMessage(utf8ToBytes('secret one'));
    const C = unblindSignature(signBlindedMessage(B_, privkey), r, pubkey);
    expect(verifyProof(utf8ToBytes('secret two'), C, privkey)).toBe(false);
  });

  it('rejects out-of-range blinding factors', () => {
    const zero = new Uint8Array(32);
    expect(() => blindMessage(utf8ToBytes('x'), zero)).toThrow();
    const tooBig = hexToBytes('fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe');
    expect(() => blindMessage(utf8ToBytes('x'), tooBig)).toThrow(); // ≥ n
  });
});

describe('DLEQ round trip', () => {
  function issueToken(secret: Uint8Array) {
    const { privkey, pubkey } = freshMint();
    const { B_, r } = blindMessage(secret);
    const C_ = signBlindedMessage(B_, privkey);
    const C = unblindSignature(C_, r, pubkey);
    const dleq = createDleqProof(B_, privkey);
    return { privkey, pubkey, B_, r, C_, C, dleq };
  }

  it('issuance-side verification passes', () => {
    const secret = utf8ToBytes('["PC-BIND",{"nonce":"ab","realm":"t","salt":"cd"}]');
    const { B_, C_, pubkey, dleq } = issueToken(secret);
    expect(verifyDleqBlindSignature(B_, C_, pubkey, dleq)).toBe(true);
  });

  it('proof-side (offline) verification passes', () => {
    const secret = utf8ToBytes('offline-verified token');
    const { C, r, pubkey, dleq } = issueToken(secret);
    expect(verifyDleqProof(secret, C, r, pubkey, dleq)).toBe(true);
  });

  it('fails against the wrong mint pubkey', () => {
    const secret = utf8ToBytes('wrong key');
    const { B_, C_, C, r, dleq } = issueToken(secret);
    const other = freshMint().pubkey;
    expect(verifyDleqBlindSignature(B_, C_, other, dleq)).toBe(false);
    expect(verifyDleqProof(secret, C, r, other, dleq)).toBe(false);
  });

  it('fails on a tampered signature', () => {
    const secret = utf8ToBytes('tampered');
    const { B_, pubkey, dleq } = issueToken(secret);
    const forgedC_ = derivePublicKey(randomScalarBytes());
    expect(verifyDleqBlindSignature(B_, forgedC_, pubkey, dleq)).toBe(false);
  });

  it('fails on a tampered proof scalar', () => {
    const secret = utf8ToBytes('tampered s');
    const { B_, C_, pubkey, dleq } = issueToken(secret);
    const bad = { e: dleq.e, s: randomScalarBytes() };
    expect(verifyDleqBlindSignature(B_, C_, pubkey, bad)).toBe(false);
  });

  it('fails with the wrong blinding factor on the offline path', () => {
    const secret = utf8ToBytes('wrong r');
    const { C, pubkey, dleq } = issueToken(secret);
    expect(verifyDleqProof(secret, C, randomScalarBytes(), pubkey, dleq)).toBe(false);
  });

  it('returns false (not throws) on garbage inputs', () => {
    const garbage = new Uint8Array(33).fill(7);
    const { B_, C_, pubkey, dleq } = issueToken(utf8ToBytes('garbage'));
    expect(verifyDleqBlindSignature(garbage, C_, pubkey, dleq)).toBe(false);
    expect(verifyDleqBlindSignature(B_, C_, garbage, dleq)).toBe(false);
    expect(verifyDleqBlindSignature(B_, C_, pubkey, { e: new Uint8Array(31), s: dleq.s })).toBe(false);
  });
});
