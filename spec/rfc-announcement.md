# RFC: `picocash` — an eCash payment method for MPP

> **Draft of the stage-one community post** (Tempo forum + mpp-specs discussions). Not yet posted; let it sit, then post when it reads right. Keep the ask focused on design feedback, not contribution.

---

**TL;DR:** We're building an MPP payment method where agents pay with Chaumian eCash backed 1:1 by USDC.e on Tempo. A service verifies payment **offline in under 50ms measured** (no round-trip on the hot path), gets no payer identity, and the payer produces no on-chain transaction per call. Deposits and settlement still land on Tempo — this is volume-additive to the chain, a privacy and latency layer on top of it. The method spec is a draft and we'd like your eyes on it before anything hardens.

## Why

Tempo settlement is transparent by design. For autonomous agents, a public transaction graph is strategy leakage: what an agent pays for, how often, and from which wallet says a lot about what it's doing. And per-call on-chain settlement puts chain latency inside every API call's critical path.

picocash moves the per-call hot path off-chain without moving custody off-chain: an agent deposits once into an on-chain **vault** (per-epoch proof of liabilities — anyone can verify solvency), receives blind-signed bearer tokens, and spends them per call. The mint that issues tokens cannot link issuance to redemption; the service that accepts them sees valid tokens, not a payer.

## What works today (all public, pre-alpha)

- **Crypto core** with published test vectors ([spec/vectors](https://github.com/picocash/picocash/tree/main/spec/vectors)) — blind signatures + DLEQ proofs on secp256k1, so any third party verifies a token against a mint's published keys without contacting the mint.
- **Mint server** live against Tempo Moderato testnet: deposits observed ~2s after confirmation, double-spend ledger with concurrency race tests, melt back to on-chain funds.
- **Vault contract** deployed to Moderato ([picocash-contracts](https://github.com/picocash/picocash-contracts)), factory-deployed with on-chain discovery (`info()` returns the mint's URL, keyset, balance, and last attested outstanding supply in one call). Every vault carries two deploy-time commitments: a **solvency-publication policy** (miss the attestation interval and the vault stops accepting deposits until the mint publishes again) and a **melt-fee ceiling** (see the exit guarantee below).
- **The MPP method** ([spec/04](https://github.com/picocash/picocash/blob/main/spec/04-mpp-method.md)): challenge → credential → receipt, with credentials cryptographically bound to the challenge nonce so interception buys nothing. Reference implementation pays a demo service end to end: **one $1 deposit funds 20 calls, mean offline verification 45ms**.
- A browser wallet demo (mint / transfer / melt against the live testnet mint).

## Where we want your input (the actual RFC)

1. **Challenge binding**: secrets that commit to the challenge (`PC-BIND` format, simple, implemented) vs. P2PK-style spending conditions (richer — could lock to a service pubkey — but heavier for verifiers). [spec/04, open question 1]
2. **Unit identity**: we've bound units to token contracts — `tip20:<chain_id>:<token_address>` — with keyset keys and ids derived from that string, and the mint refusing to start unless `vault.token()` matches. Is CAIP-19 alignment worth the ceremony? [spec/02]
3. **Receipts**: should acceptance receipts be mint-cosigned so agents can prove payment to third parties?
4. **Keyset rotation windows**: protocol constants or per-mint policy?
5. Anything that smells unsound. The runtime security model is two sentences: the mint's spent-secret ledger is insert-before-sign in one transaction, and every signature carries a DLEQ proof. The custody model is one **exit guarantee**, every clause of it on-chain and checkable before you deposit: *withdrawals can never be paused; each melt pays out exactly once (`meltPaid`); the fee to exit is capped by the vault's committed `maxMeltFee`; and raising that cap — like rotating the operator key — takes two days of public notice.* We closed the fee-based soft-freeze hole ourselves; we'd like you to look for the ones we haven't found. Break any clause and we want to know before this touches real money.

Spec: https://github.com/picocash/picocash/tree/main/spec · Issues welcome on either repo. This is pre-alpha under RFC — design feedback now is worth ten patches later.
