import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import {
  blindMessage,
  hashToCurve,
  signBlindedMessage,
  verifyDleqBlindSignature,
  verifyDleqProof,
} from '../src/index.js';

// Upstream Cashu test vectors (github.com/cashubtc/nuts/tree/main/tests).
// Passing these demonstrates byte-compatibility of the crypto layer (PIP-00 §4).

describe('NUT-00 hash_to_curve', () => {
  const vectors = [
    ['0000000000000000000000000000000000000000000000000000000000000000', '024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725'],
    ['0000000000000000000000000000000000000000000000000000000000000001', '022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf'],
    ['0000000000000000000000000000000000000000000000000000000000000002', '026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f'],
  ] as const;

  it.each(vectors)('maps %s', (message, expected) => {
    expect(bytesToHex(hashToCurve(hexToBytes(message)).toRawBytes(true))).toBe(expected);
  });
});

describe('NUT-00 blinded messages', () => {
  // x is the secret as hex-decoded raw bytes (unlike NUT-12's proof secret, which is UTF-8)
  const vectors = [
    {
      x: 'd341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6',
      r: '99fce58439fc37412ab3468b73db0569322588f62fb3a49182d67e23d877824a',
      B_: '033b1a9737a40cc3fd9b6af4b723632b76a67a36782596304612a6c2bfb5197e6d',
    },
    {
      x: 'f1aaf16c2239746f369572c0784d9dd3d032d952c2d992175873fb58fae31a60',
      r: 'f78476ea7cc9ade20f9e05e58a804cf19533f03ea805ece5fee88c8e2874ba50',
      B_: '029bdf2d716ee366eddf599ba252786c1033f47e230248a4612a5670ab931f1763',
    },
  ];

  it.each(vectors)('blinds secret $x', ({ x, r, B_ }) => {
    const result = blindMessage(hexToBytes(x), hexToBytes(r));
    expect(bytesToHex(result.B_)).toBe(B_);
  });
});

describe('NUT-00 blind signatures', () => {
  const B_ = '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2';

  it('signs with k=1 (identity)', () => {
    const C_ = signBlindedMessage(
      hexToBytes(B_),
      hexToBytes('0000000000000000000000000000000000000000000000000000000000000001'),
    );
    expect(bytesToHex(C_)).toBe(B_);
  });

  it('signs with k=7f7f…7f', () => {
    const C_ = signBlindedMessage(
      hexToBytes(B_),
      hexToBytes('7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f'),
    );
    expect(bytesToHex(C_)).toBe('0398bc70ce8184d27ba89834d19f5199c84443c31131e48d3c1214db24247d005d');
  });
});

describe('NUT-12 DLEQ', () => {
  const A = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

  it('verifies a valid BlindSignature DLEQ', () => {
    const valid = verifyDleqBlindSignature(
      hexToBytes('02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2'),
      hexToBytes('02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2'),
      hexToBytes(A),
      {
        e: hexToBytes('9818e061ee51d5c8edc3342369a554998ff7b4381c8652d724cdf46429be73d9'),
        s: hexToBytes('9818e061ee51d5c8edc3342369a554998ff7b4381c8652d724cdf46429be73da'),
      },
    );
    expect(valid).toBe(true);
  });

  it('verifies a valid Proof DLEQ (offline path)', () => {
    const valid = verifyDleqProof(
      utf8ToBytes('daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9'),
      hexToBytes('024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc'),
      hexToBytes('a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861'),
      hexToBytes(A),
      {
        e: hexToBytes('b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4'),
        s: hexToBytes('8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8'),
      },
    );
    expect(valid).toBe(true);
  });
});
