# picocash

> **Status: pre-alpha. The protocol spec is under RFC — design feedback welcome. Do not use with real funds.**

**Private, instant, feeless bearer tokens for machine payments** — Chaumian ecash backed 1:1 by TIP-20 stablecoins (e.g. USDC.e) on [Tempo](https://tempo.xyz), designed as a custom payment method for [MPP](https://mpp.dev).

## The demo this project is built around

An agent deposits **$1 of stablecoin once**, receives bearer tokens, then makes **20 paid API calls** with:

- **sub-100ms payment acceptance** — the service verifies tokens *offline* (DLEQ proofs), then settles with the mint asynchronously. Accept-then-settle, no round-trip on the hot path. **Measured: ~45ms mean over 20 calls** in the [reference implementation's](packages/mppx-method/) end-to-end test.
- **no on-chain transaction per call** — one deposit funds many payments; the mint nets out settlement on Tempo periodically.
- **payer privacy** — the mint cannot link token issuance to redemption (blind signatures), and the service operator sees valid tokens, not a payer address.

On-chain settlement rails are transparent by design; an agent's transaction graph is strategy leakage. picocash is the privacy + latency layer on top: volume-**additive** to Tempo (deposits and net settlement still land on-chain), a complement to MPP's existing methods, not a competing rail.

## How it works (one paragraph)

A **mint** holds a TIP-20 stablecoin (e.g. USDC.e) in an on-chain **vault contract**, 1:1 against outstanding tokens, with per-epoch on-chain publication of outstanding supply so anyone can verify solvency. Clients deposit into the vault, then obtain **blind signatures** over secrets they choose (the mint signs without seeing them — BDHKE on secp256k1, Cashu NUT-00 compatible). The resulting `(secret, signature)` pairs are bearer tokens. Every signature carries a **DLEQ proof**, so any third party can verify a token came from a given mint's keyset *without contacting the mint* — that's what enables offline acceptance and agent-to-agent transfer. Spending a token online marks its secret spent at the mint (the double-spend ledger); holders exit by **melting** tokens back to the stablecoin from the vault.

## The MPP payment method

The core deliverable is [`PIP-05`](https://github.com/picocash/pips/blob/main/PIP-05.md): a `picocash` method binding for MPP's challenge → credential → receipt flow. A service issues a challenge naming an amount and a mint allowlist; the agent answers with a token bundle cryptographically bound to the challenge nonce (so intercepted credentials can't be replayed); the service verifies offline via DLEQ and redeems asynchronously.

## Repo layout

| Path | What | Status |
|---|---|---|
| [pips](https://github.com/picocash/pips) | **The specifications (PIP-00…05) + test vectors** — separate repo, the RFC home | all under RFC |
| [`packages/crypto`](packages/crypto/) | BDHKE, hash-to-curve, DLEQ (secp256k1, `@noble/curves`) | **implemented, tested** |
| [`packages/mint`](packages/mint/) | Mint server (TypeScript + Hono + Postgres) | **live on Tempo testnet** — mint/swap/melt/checkstate against the deployed vault |
| [`packages/sdk`](packages/sdk/) | Agent wallet-lite client | **implemented** — mint/swap/melt/send/receive, offline verification |
| [`packages/mppx-method`](packages/mppx-method/) | MPP method reference implementation | **implemented** — paid echo service e2e, **~45ms mean offline verification** |
| [picocash-contracts](https://github.com/picocash/picocash-contracts) | Vault contract (Foundry, Tempo) — separate repo | **deployed to Moderato testnet** |
| [`apps/wallet-demo`](apps/wallet-demo/) | Static HTML wallet | **complete on Tempo testnet** — mint, offline-verified transfer, and melt in-browser |
| [`apps/reference`](apps/reference/) | picocash.app reference mint deployment | skeleton |

## Test vectors

[pips/vectors](https://github.com/picocash/pips/blob/main/../tree/main/vectors) publishes versioned test vectors for hash-to-curve, blind/unblind round-trips, and DLEQ proofs. The crypto constructions are **Cashu NUT-00/NUT-12 compatible** (same hash-to-curve domain separator, same DLEQ hash), verified against the upstream Cashu test vectors — a second implementation in any language should pass both sets. If you're implementing, start there.

## Relationship to Cashu

The blind-signature cryptography follows the [Cashu NUTs](https://github.com/cashubtc/nuts) (NUT-00 BDHKE, NUT-12 DLEQ) so the audit surface is shared. picocash diverges above the crypto layer: EVM/stablecoin-denominated with an on-chain vault on Tempo (not Lightning), on-chain proof-of-liabilities, and an MPP payment-method binding instead of Lightning invoices.

## Contributing

The specs are under RFC — [design feedback](https://github.com/picocash/pips) on the pips is the most valuable contribution right now. See [SECURITY.md](SECURITY.md) for vulnerability disclosure.

## License

[Apache-2.0](LICENSE)
