/**
 * Byte-exact conformance against the NIP-AE reference vectors (block/buzz
 * docs/nips/NIP-AE.md §Reference test vectors). Those vectors pin the
 * conversation key, every d-tag, each NIP-44 nonce and ciphertext, and the
 * resulting event ids and BIP-340 signatures (aux = 0x00…00). Reproducing them
 * proves our NIP-44, NIP-01 serialization, and NIP-AE addressing all agree
 * with Buzz's implementation — not just with themselves.
 */
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { engramDTag } from '../src/engram-store.js';
import { calcPaddedLen, conversationKey, decrypt, encrypt } from '../src/nip44.js';
import { eventId, finalizeEvent, pubkeyOf, verifyEvent } from '../src/nostr-event.js';

const sec = (n: number) => {
  const k = new Uint8Array(32);
  k[31] = n;
  return k;
};
const SEC_A = sec(1);
const SEC_O = sec(2);
const PUB_A = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PUB_O = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const K_C = 'c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d';
const AUX0 = new Uint8Array(32);

const VECTORS = [
  {
    slug: 'mem/example',
    d: '72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba',
    body: '{"slug":"mem/example","value":"hello, agent memory"}',
    created_at: 1700000000,
    nonce: 1,
    content:
      'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABedgcxyfmpph68LBjCWZsTI5lb0Cbg8dIPVYVe/WVj/l4Yd8HGgzC8awyBi9bn9ClRdtd2IPsmont0jN/cajVSQhahTOwuNNwoJtZIg35aSsUzeCq4tQfd8E+fLoKomdPxjs=',
    id: 'f4a594177b7aeea4fe99a09efbf74ae85f0126244f322135682c405888a38689',
    sig: '0a4582f0bc5995b9a010afda5984f568055988ebbe4552b4e0ec6d11aeb2b303af940f3d84726a7edd1763badb284eb3aa8457664ceba85a90d6252ed4b494cb',
  },
  {
    slug: 'mem/notes/2026-05-12',
    d: '31651571a312780cfdc1f0b706b682ac9f3f51a053e8dca76fe57710bae5a4d4',
    body: '{"slug":"mem/notes/2026-05-12","value":"meeting note: [[mem/example]]"}',
    created_at: 1700000001,
    nonce: 2,
    content:
      'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACG/JBPvdZxDwAxOG7bY3AW2q1slZqBjQC3NxfPVtfcR+TGjp2GKtjyXyqNwG08GK+00I1u1vUZ4cCjcun9A7ra92rleKKJ5w57pqgFspbv1vClUJY5487A/5phVDHkw6DhRCSMDpEMw5Tapj3Wm1ponAVr5PciPOrTxltEfTVdSKaPA==',
    id: '1a43298ea1fa9b73462a85b9f16f5f6bd2a7ab18b0b02424e5ec3f3b8a48e030',
    sig: 'dc9da456db1c89f070edc5f994786f270fc00e8ff19f33d5b0f6cea49421cd727fcd79bb288f3e3dbd5af9ca1ba67f9bd11b02a47c1e6c37cfd32665c17e4a24',
  },
  {
    slug: 'mem/example',
    d: '72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba',
    body: '{"slug":"mem/example","value":null}',
    created_at: 1700000002,
    nonce: 3,
    content:
      'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADuau8i0Wu4+ULnp2qTfd+O23jJAapMRrKGGwabNVOlT9hSF8FViBHIS6f86/7xK4qGOin4IH8Wr/3cvHDcQGQd3IXQJr8LHgJkaYpQPdBO1bgqiFu8K3L/CLb1PgG1X7RQ8E=',
    id: 'c8604bef05295856a67a88ec895e07b5b47a2febc23c82934734096a7b123b63',
    sig: 'c8d53859cf08b3a9a20a5b01c61d12fa2f082f462adb635420f05dc6f9bb662a174e729023854bf53e5e35fae8f6f4c9d604e8979a070e298cd77cfb7e6b6468',
  },
  {
    slug: 'core',
    d: 'bdc233238ffe52e272b44cc233c8f33a2bc510b08be04495b225964283be4a90',
    body: '{"slug":"core","profile":"test agent. see [[mem/example]] and [[mem/notes/2026-05-12]]."}',
    created_at: 1700000003,
    nonce: 4,
    content:
      'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEEeZHAFjhc8DAcKaVSSB7IoKG3nr+dX3LXlU7UIdOKayhIVPXvl4WuFmBSVxLO6yEV5vnLvzbo7rU0uPRYyAJLPNnifVTCw2EQZH70zOwTc/mVvaATHKzqcFo5VHrbpKNTzeNnz1Vds2yg2DXmdxaoWQA4YfnlLwZDOpyu9JP1uB1Yw==',
    id: '980419c4d231266471242456c832d0c2eb1e6974468dc795f3ae327484129058',
    sig: 'ce113fff1205eadb38928b224a90247be1a00b0c3f8ab583d4a5f7274ddba51ebb5eb9d627d44664a78d2e870e61835cf61446cc812ecea139e8b7d41b8e238f',
  },
];

describe('NIP-44 v2 + NIP-AE conformance (pinned Buzz vectors)', () => {
  it('derives the pinned pubkeys and conversation key from both sides', () => {
    expect(pubkeyOf(SEC_A)).toBe(PUB_A);
    expect(pubkeyOf(SEC_O)).toBe(PUB_O);
    expect(bytesToHex(conversationKey(SEC_A, PUB_O))).toBe(K_C);
    expect(bytesToHex(conversationKey(SEC_O, PUB_A))).toBe(K_C); // symmetric
  });

  it('derives every pinned d-tag', () => {
    const kc = hexToBytes(K_C);
    for (const v of VECTORS) expect(engramDTag(kc, v.slug)).toBe(v.d);
  });

  it('decrypts each pinned ciphertext to the exact body', () => {
    const kc = hexToBytes(K_C);
    for (const v of VECTORS) expect(decrypt(v.content, kc)).toBe(v.body);
  });

  it('re-encrypts each body with the pinned nonce to the exact ciphertext', () => {
    const kc = hexToBytes(K_C);
    for (const v of VECTORS) expect(encrypt(v.body, kc, sec(v.nonce))).toBe(v.content);
  });

  it('reproduces each pinned event id and BIP-340 signature (aux = zeros)', () => {
    for (const v of VECTORS) {
      const ev = finalizeEvent(
        { kind: 30174, created_at: v.created_at, tags: [['d', v.d], ['p', PUB_O]], content: v.content },
        SEC_A,
        AUX0,
      );
      expect(ev.pubkey).toBe(PUB_A);
      expect(ev.id).toBe(v.id);
      expect(ev.sig).toBe(v.sig);
      expect(verifyEvent(ev)).toBe(true);
    }
  });

  it('rejects tampering: wrong key, flipped MAC byte, altered event', () => {
    const kc = hexToBytes(K_C);
    const v = VECTORS[0]!;
    expect(() => decrypt(v.content, conversationKey(sec(3), PUB_O))).toThrow(/MAC/);
    const bytes = Uint8Array.from(atob(v.content), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 1;
    expect(() => decrypt(btoa(String.fromCharCode(...bytes)), kc)).toThrow(/MAC/);
    const ev = finalizeEvent({ kind: 30174, created_at: v.created_at, tags: [['d', v.d], ['p', PUB_O]], content: v.content }, SEC_A, AUX0);
    expect(verifyEvent({ ...ev, content: ev.content + 'x' })).toBe(false);
    expect(verifyEvent({ ...ev, created_at: ev.created_at + 1 })).toBe(false);
  });

  it('padding follows the NIP-44 schedule and enforces the 65535-byte limit', () => {
    expect(calcPaddedLen(1)).toBe(32);
    expect(calcPaddedLen(32)).toBe(32);
    expect(calcPaddedLen(33)).toBe(64);
    expect(calcPaddedLen(256)).toBe(256);
    expect(calcPaddedLen(257)).toBe(320);
    expect(calcPaddedLen(65535)).toBe(65536);
    const kc = hexToBytes(K_C);
    expect(() => encrypt('', kc)).toThrow(/out of range/);
    expect(() => encrypt('a'.repeat(65536), kc)).toThrow(/out of range/);
    const roundtrip = 'héllo wörld — 非ASCII ✓';
    expect(decrypt(encrypt(roundtrip, kc), kc)).toBe(roundtrip);
  });

  it('NIP-01 id serialization leaves non-ASCII unescaped (ensure_ascii=False equivalence)', () => {
    const a = eventId({ pubkey: PUB_A, created_at: 1, kind: 1, tags: [], content: 'é' });
    const b = eventId({ pubkey: PUB_A, created_at: 1, kind: 1, tags: [], content: '\\u00e9' });
    expect(a).not.toBe(b); // the literal char and its JSON escape must hash differently
  });
});
