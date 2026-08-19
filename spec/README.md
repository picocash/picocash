# picocash protocol specification

> **Status: pre-alpha, under RFC.** Numbered documents are versioned; implementations follow the spec, never the reverse. Spec changes version-bump here before any code implements them.

| Doc | Title | Status |
|---|---|---|
| [01-crypto.md](01-crypto.md) | Blind signatures, hash-to-curve, DLEQ | **v0.1** — implemented in `packages/crypto` |
| [02-keysets.md](02-keysets.md) | Keysets, units (unit = TIP-20 contract), rotation | **v0.1-draft** — unit binding + derivation implemented; rotation lifecycle draft |
| [03-mint-api.md](03-mint-api.md) | Mint HTTP API | **v0.1-draft** — fully implemented incl. melt, live on Tempo testnet |
| [04-mpp-method.md](04-mpp-method.md) | **MPP payment method `picocash`** | **draft — the RFC centerpiece** |
| [05-vault.md](05-vault.md) | Vault contract & proof of liabilities | **v0.1-draft** — implemented + deployed to Moderato ([picocash-contracts](https://github.com/picocash/picocash-contracts)) |
| [vectors/](vectors/) | Test vectors | crypto v0.1 published |

## Conventions

- All amounts are **integer base units** (USDC.e, 6 decimals). No floats anywhere in the protocol.
- Byte strings are lowercase hex unless stated otherwise.
- Elliptic-curve points serialize as 33-byte SEC1 compressed unless a construction explicitly requires uncompressed.
- Key words MUST / SHOULD / MAY per RFC 2119.

## Relationship to Cashu NUTs

The cryptographic layer (01) is deliberately **byte-compatible with Cashu NUT-00 (BDHKE, hash-to-curve) and NUT-12 (DLEQ)** so that the audit surface, tooling, and intuitions transfer. Everything above the crypto layer — vault backing, mint API details, the MPP method — is picocash-specific. Do not import Lightning assumptions.
