# RFC: `picocash` — an eCash payment method for MPP

> **Draft for internal review — not yet posted.** Venue: a new issue on [tempoxyz/mpp-specs](https://github.com/tempoxyz/mpp-specs/issues) (their CONTRIBUTING says: issue first for discussion, then a method draft from `examples/method-template.md` into `specs/methods/` as `draft-picocash-payment-method-00`). Everything below the rule is the issue text, ready to paste. Review notes at the bottom.

---

**Proposed issue title:** `RFC: picocash — an eCash payment method (offline-verified, accept-then-settle)`

**TL;DR.** We've built and would like feedback on a new payment method: agents pay with Chaumian eCash — blind-signature bearer tokens backed 1:1 by a TIP-20 stablecoin held in an on-chain vault on Tempo. A service verifies payment **offline** (no round-trip on the hot path — measured **~45 ms mean** in our reference implementation), learns no payer identity, and the payer produces **no on-chain transaction per call**: one deposit funds many payments, with deposits and net settlement still landing on Tempo. Specs: **https://github.com/picocash/pips** · everything Apache-2.0, running on Moderato.

## Why another method

Two properties existing rails don't combine:

1. **Privacy.** On-chain settlement is transparent; for autonomous agents, a public transaction graph is strategy leakage — what an agent buys, how often, from which wallet. With eCash, the mint cannot link token issuance to redemption (blind signatures), and the service sees valid tokens, not a payer.
2. **Latency without custody games.** Accept-then-settle: the service validates a credential offline via DLEQ proofs against the mint's published keys, serves the request immediately, and settles with the mint asynchronously. Sub-100 ms acceptance with the double-spend window bounded by per-call amounts.

This is volume-*additive* to Tempo — the on-chain legs (deposit, melt, periodic net settlement, solvency attestations) don't go away; the per-call hot path does.

**Relative to Zones.** [Zones](https://github.com/tempoxyz/zones) solve privacy at the execution layer: a private chain anchored to Tempo with confidential balances and inherited TIP-403 compliance — the right shape for institutional flows, with the infrastructure of a chain (sequencing, proof batches, escrow) and an operator who, by design, retains full state visibility for compliance. A picocash mint sits at the other end of the same spectrum. It's a much smaller lift — one HTTP service plus one factory-deployed contract, no new chain to run — and it offers a narrower but stronger privacy property: the payment graph is unlinkable **even to the mint operator** (blind signatures), not just to outside observers. And where Zone payments are still per-transaction (250 ms sequencing), picocash acceptance is offline entirely. We see these as complements, not competitors: Zones for confidential institutional execution, a mint for per-payment agent privacy at service latency — a zone-resident service could accept picocash unchanged.

## The method in one screen

- **Challenge** (`method: "picocash"`, intent `charge`): amount, unit (`tip20:<chain_id>:<token_address>` — the unit *is* the token contract), a mint allowlist, and a 32-byte nonce.
- **Credential**: proofs summing to exactly the amount, each carrying a DLEQ payload `{e, s, r}`, with secrets structured to **commit to the challenge nonce and realm** (`PC-BIND`) — an intercepted credential replays nowhere.
- **Verification (offline, six checks)**: challenge single-use → mint/keyset allowlisted → binding → exact amount/denominations → DLEQ per proof → duplicate-token guard. No network.
- **Receipt**: immediate, with `settlement: pending → settled | double-spent`; finality is the service's async swap at the mint.

We've also implemented the mppx binding (`Method.toClient`/`toServer`, `validate` = non-mutating pre-check, `broadcast` = terminal offline accept).

## Custody, stated as a guarantee

The vault side is where trust concentrates, so it's structured as an **exit guarantee, every clause on-chain and checkable before depositing**: withdrawals can never be paused; each melt pays out exactly once (`meltPaid`); the exit fee is capped by the vault's committed `maxMeltFee`; raising that cap takes the same 2-day timelock as rotating the operator key. Vaults also commit at deployment to a **solvency-publication policy** — outstanding supply is attested on-chain, and a mint that misses its attestation interval stops being able to accept deposits until it publishes. Factory-deployed (`isVault()` proves canonical bytecode), source-verified, live on Moderato.

## Intersections with open issues here

- **#292** (receipt/settlement semantics for card-class methods) and **#317** (correlating paid async MCP delivery to receipts): our receipts carry an explicit `settlement` state machine and reference the challenge id; whether receipts should additionally be **mint-cosigned** so agents can prove payment to third parties is our open question 2 — input from those discussions would directly shape it.
- **#307/#308** (Lightning refund/second-payment ambiguity after settlement failure): our melt path takes a position worth scrutinizing — burn-before-pay with a durable `OWED` state and same-inputs retry, made double-payout-proof by an on-chain per-id guard. If that pattern holds up, it may generalize.

## Where we'd most value review

1. **Challenge binding**: `PC-BIND` secret-format commitment (simple, implemented) vs. P2PK-style spending conditions (richer, heavier for verifiers). [PIP-05]
2. **Unit identity**: `tip20:<chain_id>:<address>` with keys/ids derived from it — is CAIP-19 alignment worth the ceremony? [PIP-01]
3. **Receipts**: mint-cosigned or service-signed only? (See #292/#317 above.)
4. **Fees**: flat melt fee under an on-chain ceiling vs. gas-indexed. [PIP-03]
5. **Anything unsound.** Runtime model: spent-secret ledger is insert-before-sign in one transaction; DLEQ on every signature. Break it and we want to know before this touches real money.

## Try it / read it

- Specs (with published test vectors): https://github.com/picocash/pips — open questions are threaded in [Discussions](https://github.com/picocash/pips/discussions)
- Reference stack (crypto, mint, SDK, mppx method, browser wallet demo): https://github.com/picocash/picocash
- Contracts (factory + vault, verified on Moderato): https://github.com/picocash/picocash-contracts
- Site: https://picocash.dev

**Proposed next step**, if there's appetite: we'll submit `draft-picocash-payment-method-00` from the method template into `specs/methods/`, and would structure it to slot alongside the existing charge-type drafts.

Status: pre-alpha, testnet only, unaudited. Per this repo's contribution guidelines: parts of the implementation and this text were AI-assisted; all of it has been human-reviewed and the measured figures come from the test suites.

---

## Review notes (not part of the issue)

1. **Their AI-disclosure rule**: mpp-specs CONTRIBUTING requires disclosure of AI-assisted contributions — the closing line handles it; keep or reword to taste, but don't drop it.
2. **The issue-number references (#292, #317, #307/#308)** are live as of 2026-08-20 — reverify they're still open before posting, and consider dropping a short comment in #292 the same day linking back ("we took a position on this in an RFC, curious for your take") to start the cross-pollination.
3. **Tone check**: the draft deliberately leads with the two properties, not the project — and never names the prior-art protocol (positioning rule); the crypto attribution lives in PIP-00 where reviewers will find it.
4. **The method-draft offer** at the end follows their documented workflow (issue → template → `specs/methods/`), which signals we've read their process — reviewers notice.
5. **The Zones paragraph is deliberately complementary, and every claim is sourced** from tempoxyz/zones' own README (operator "maintains full visibility into state for compliance", 250 ms sequencing, testnet status). It positions the mint as the lightweight point on *their* privacy spectrum rather than an alternative to their flagship — do not sharpen it into a comparison table; the one-paragraph form is the right level of assertiveness for their repo. The compliance question (bearer instruments vs. TIP-403 inheritance) is intentionally not raised here; if a reviewer raises it, the answer is the reference mint's hard caps + the credits-keyset design.
