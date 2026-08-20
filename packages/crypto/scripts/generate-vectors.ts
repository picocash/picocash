/**
 * Generates the crypto test vectors deterministically (canonical copy:
 * github.com/picocash/pips vectors/).
 *
 * All private values (keys, blinding factors, DLEQ nonces) are derived by
 * hashing fixed labels, so anyone can regenerate the file bit-for-bit and no
 * value is secret. Every vector is self-verified before writing.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import {
  blindMessage,
  createDleqProof,
  derivePublicKey,
  hashToCurve,
  ORDER,
  signBlindedMessage,
  unblindSignature,
  verifyDleqBlindSignature,
  verifyDleqProof,
  verifyProof,
} from '../src/index.js';

/** Deterministic scalar in [1, n) from a label. */
function scalarFromLabel(label: string): Uint8Array {
  let candidate = sha256(utf8ToBytes(`picocash-vectors-v0.1/${label}`));
  while (true) {
    const x = BigInt('0x' + bytesToHex(candidate));
    if (x > 0n && x < ORDER) return candidate;
    candidate = sha256(candidate);
  }
}

const hex = bytesToHex;

// --- hash_to_curve vectors -------------------------------------------------
const h2cMessages = [
  { desc: 'empty message', messageHex: '' },
  { desc: 'ascii "picocash"', messageHex: hex(utf8ToBytes('picocash')) },
  { desc: '32 bytes 0xff', messageHex: 'ff'.repeat(32) },
  {
    desc: 'PC-BIND structured secret (canonical JSON, utf-8)',
    messageHex: hex(
      utf8ToBytes(
        '["PC-BIND",{"nonce":"b7e2c1a0d94f6e3812aa05c47db9f1e6b7e2c1a0d94f6e3812aa05c47db9f1e6","realm":"api.example.dev","salt":"5f1d0c3b2a49687e5f1d0c3b2a49687e5f1d0c3b2a49687e5f1d0c3b2a49687e"}]',
      ),
    ),
  },
];
const hashToCurveVectors = h2cMessages.map(({ desc, messageHex }) => ({
  description: desc,
  message: messageHex,
  point: hex(hashToCurve(hexToBytes(messageHex)).toRawBytes(true)),
}));

// --- full BDHKE + DLEQ round trips -----------------------------------------
const roundTrips = [
  { label: 'rt-0', secretHex: hex(utf8ToBytes('picocash test vector secret 0')) },
  { label: 'rt-1', secretHex: hex(utf8ToBytes('["PC-BIND",{"nonce":"00","realm":"vector.test","salt":"01"}]')) },
  { label: 'rt-2', secretHex: 'deadbeef' },
].map(({ label, secretHex }) => {
  const secret = hexToBytes(secretHex);
  const mintPrivkey = scalarFromLabel(`${label}/mint-key`);
  const mintPubkey = derivePublicKey(mintPrivkey);
  const r = scalarFromLabel(`${label}/blinding-factor`);
  const nonce = scalarFromLabel(`${label}/dleq-nonce`);

  const Y = hashToCurve(secret);
  const { B_ } = blindMessage(secret, r);
  const C_ = signBlindedMessage(B_, mintPrivkey);
  const C = unblindSignature(C_, r, mintPubkey);
  const dleq = createDleqProof(B_, mintPrivkey, nonce);

  if (!verifyProof(secret, C, mintPrivkey)) throw new Error(`${label}: proof self-check failed`);
  if (!verifyDleqBlindSignature(B_, C_, mintPubkey, dleq)) throw new Error(`${label}: DLEQ (blind-sig) self-check failed`);
  if (!verifyDleqProof(secret, C, r, mintPubkey, dleq)) throw new Error(`${label}: DLEQ (proof) self-check failed`);

  return {
    description: label,
    secret: secretHex,
    mint_privkey: hex(mintPrivkey),
    mint_pubkey: hex(mintPubkey),
    r: hex(r),
    Y: hex(Y.toRawBytes(true)),
    B_: hex(B_),
    C_: hex(C_),
    C: hex(C),
    dleq_nonce: hex(nonce),
    dleq: { e: hex(dleq.e), s: hex(dleq.s) },
  };
});

// --- assemble --------------------------------------------------------------
const vectors = {
  version: '0.1',
  curve: 'secp256k1',
  spec: 'PIP-00',
  notes:
    'All byte strings are lowercase hex; points are 33-byte SEC1 compressed. Secrets and hash_to_curve messages are raw bytes (hex-decoded) EXCEPT cashu_compat.dleq.proof.secret_utf8, which is a UTF-8 string per upstream NUT-12. Never reuse these keys, factors, or nonces outside tests. cashu_compat reproduces upstream vectors from github.com/cashubtc/nuts/tree/main/tests.',
  cashu_compat: {
    hash_to_curve: [
      { message: '0000000000000000000000000000000000000000000000000000000000000000', point: '024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725' },
      { message: '0000000000000000000000000000000000000000000000000000000000000001', point: '022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf' },
      { message: '0000000000000000000000000000000000000000000000000000000000000002', point: '026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f' },
    ],
    blinded_messages: [
      { secret: 'd341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6', r: '99fce58439fc37412ab3468b73db0569322588f62fb3a49182d67e23d877824a', B_: '033b1a9737a40cc3fd9b6af4b723632b76a67a36782596304612a6c2bfb5197e6d' },
      { secret: 'f1aaf16c2239746f369572c0784d9dd3d032d952c2d992175873fb58fae31a60', r: 'f78476ea7cc9ade20f9e05e58a804cf19533f03ea805ece5fee88c8e2874ba50', B_: '029bdf2d716ee366eddf599ba252786c1033f47e230248a4612a5670ab931f1763' },
    ],
    blind_signatures: [
      { mint_privkey: '0000000000000000000000000000000000000000000000000000000000000001', B_: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2', C_: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2' },
      { mint_privkey: '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', B_: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2', C_: '0398bc70ce8184d27ba89834d19f5199c84443c31131e48d3c1214db24247d005d' },
    ],
    dleq: {
      blind_signature: {
        mint_pubkey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        B_: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2',
        C_: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2',
        e: '9818e061ee51d5c8edc3342369a554998ff7b4381c8652d724cdf46429be73d9',
        s: '9818e061ee51d5c8edc3342369a554998ff7b4381c8652d724cdf46429be73da',
        valid: true,
      },
      proof: {
        mint_pubkey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        secret_utf8: 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9',
        C: '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc',
        e: 'b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4',
        s: '8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8',
        r: 'a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861',
        valid: true,
      },
    },
  },
  picocash: {
    hash_to_curve: hashToCurveVectors,
    bdhke_dleq_round_trips: roundTrips,
  },
};

// Canonical vectors live in github.com/picocash/pips (vectors/); copy this
// output there when a spec change regenerates them.
const outPath = join(dirname(fileURLToPath(import.meta.url)), '../crypto-v0.1.generated.json');
writeFileSync(outPath, JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${outPath}`);
