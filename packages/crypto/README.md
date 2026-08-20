# @picocash/crypto

The cryptographic core of picocash: BDHKE blind signatures, NUT-00-compatible hash-to-curve, and DLEQ proofs on secp256k1, built on `@noble/curves` / `@noble/hashes` (audited, zero-dep). Pure library — no network, no storage.

Spec: [`PIP-00`](https://github.com/picocash/pips/blob/main/PIP-00.md) · Vectors: [pips/vectors](https://github.com/picocash/pips/tree/main/vectors)

## API sketch

```ts
import {
  blindMessage, signBlindedMessage, unblindSignature, verifyProof,
  createDleqProof, verifyDleqBlindSignature, verifyDleqProof,
  hashToCurve, derivePublicKey, randomScalarBytes,
} from '@picocash/crypto';

// client
const { B_, r } = blindMessage(secret);          // → send B_ to mint
// mint
const C_ = signBlindedMessage(B_, mintPrivkey);
const dleq = createDleqProof(B_, mintPrivkey);   // → return { C_, dleq }
// client
const C = unblindSignature(C_, r, mintPubkey);   // token = (secret, C), keep r for offline DLEQ
verifyDleqBlindSignature(B_, C_, mintPubkey, dleq); // true
// any third party, offline — the sub-100ms acceptance path
verifyDleqProof(secret, C, r, mintPubkey, dleq);    // true
```

All points are 33-byte SEC1 compressed `Uint8Array`s, all scalars 32-byte big-endian. All verification functions return booleans and never throw on malformed input.

## Commands

```sh
npm test                 # vitest: Cashu compat vectors + round-trip/negative tests
npm run vectors          # regenerate the vectors (deterministic; canonical copy lives in picocash/pips)
npm run build
```
