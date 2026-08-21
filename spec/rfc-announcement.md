# RFC: `picocash` — an eCash payment method for MPP

> **Draft for internal review — not yet posted.** Venue: a new issue on [tempoxyz/mpp-specs](https://github.com/tempoxyz/mpp-specs/issues) (their CONTRIBUTING says: issue first for discussion, then a method draft from `examples/method-template.md` into `specs/methods/` as `draft-picocash-payment-method-00`). Everything below the rule is the issue text, ready to paste. Review notes at the bottom.

---

**Proposed issue title:** `RFC: picocash — an eCash payment method (offline-verified, lockable bearer tokens)`

**TL;DR.** We've built and would like feedback on a new payment method: agents pay with Chaumian eCash — blind-signature bearer tokens backed 1:1 by a TIP-20 stablecoin held in an on-chain vault on Tempo. A service verifies payment **offline** (merchant-side verification measured **~45 ms mean** in our reference implementation, no mint round-trip), learns no payer address, and the payer produces **no on-chain transaction per call**: one deposit funds many payments, with deposits and net settlement still landing on Tempo. Tokens can be **locked to a public key** (PIP-08), so a human can fund an agent that can spend only with a named merchant. Specs: **https://github.com/picocash/pips** · everything Apache-2.0 · live on Moderato with a public mint and a browser demo you can click through.

## Why another method

Two properties existing rails don't combine:

1. **Privacy.** On-chain settlement is transparent; for autonomous agents, a public transaction graph is strategy leakage — what an agent buys, how often, from which wallet. With eCash, the mint cannot link token issuance to redemption (blind signatures), and the service sees valid tokens, not a payer.
2. **Latency without custody games.** The service validates a credential offline via DLEQ proofs against the mint's published keys — ~45 ms, no mint round-trip — then settles by swapping the proofs at the mint. Settle-first is the default (`success` only after the swap lands); a service can opt into accept-then-settle and take on a double-spend exposure bounded by per-call amount × settlement lag. Either way, nothing touches the chain per call.

This is volume-*additive* to Tempo — the on-chain legs (deposit, melt, periodic net settlement, solvency attestations) don't go away; the per-call hot path does.

**Relative to Zones.** [Zones](https://github.com/tempoxyz/zones) solve privacy at the execution layer: a private chain anchored to Tempo with confidential balances and inherited TIP-403 compliance — the right shape for institutional flows, with the infrastructure of a chain (sequencing, proof batches, escrow) and an operator who, by design, retains full state visibility for compliance. A picocash mint sits at the other end of the same spectrum. It's a much smaller lift — one HTTP service plus one factory-deployed contract, no new chain to run — and it offers a narrower but stronger privacy property: the payment graph is unlinkable **even to the mint operator** (blind signatures), not just to outside observers. And where Zone payments are still per-transaction (250 ms sequencing), picocash acceptance is offline entirely. We see these as complements, not competitors: Zones for confidential institutional execution, a mint for per-payment agent privacy at service latency — a zone-resident service could accept picocash unchanged.

## The method in one screen

- **Challenge** (`method: "picocash"`, intent `charge`): amount, unit (`tip20:<chain_id>:<token_address>` — the unit *is* the token contract), a mint allowlist, and a 32-byte nonce.
- **Credential**: proofs summing to exactly the amount, each carrying a DLEQ payload `{e, s, r}`, with secrets structured to **commit to the challenge nonce and realm** (`PC-BIND`) — an intercepted credential replays nowhere. Alternatively, proofs **P2PK-locked to the service's published key** (PIP-08) are accepted as bound: that is how an agent spends tokens its principal pre-locked to this merchant.
- **Verification (offline, six checks)**: challenge single-use → mint/keyset/unit allowlisted → binding → exact amount/denominations → DLEQ per proof → duplicate-token guard. No network.
- **Receipt**: `settlement: settled` by default (the swap at the mint is the moment of finality), or `pending → settled | double-spent` for services that opt into accept-then-settle.

We've also implemented the mppx binding (`Method.toClient`/`toServer`, `validate` = non-mutating pre-check, `broadcast` = accept + settle).

## Lockable tokens (PIP-08)

A bare eCash proof is a bearer instrument, which is sometimes exactly wrong for agents. PIP-08 adds **pay-to-public-key spending conditions**: the secret carries a lock key, an optional `locktime`, and optional `refund` keys; spending requires a Schnorr witness, enforced by the mint on swap and melt. Two flows fall out:

- A **merchant pays an agent** (rebate, bounty, refund) with tokens only that agent can redeem — worthless in a log file.
- A **human funds an agent** with tokens locked to merchant M and a refund to themself: the agent can pay M and nobody else, and an unredeemed balance comes back automatically after the locktime. Spending authority is bounded by the token, not by a policy the agent could ignore.

The wire format follows the established eCash convention for well-known secrets, so existing wallet code and auditors recognise it; the lock is readable offline by any receiver.

## Custody, stated as a guarantee

The vault side is where trust concentrates, so it's structured as an **exit guarantee, every clause on-chain and checkable before depositing**: payouts cannot be paused by the contract; each melt pays out exactly once (`meltPaid`); the exit fee is capped by the vault's committed `maxMeltFee`; raising that cap takes the same timelock as rotating the operator key (a per-deployment parameter, 2 days on our testnet vaults). Vaults also commit at deployment to a **solvency-publication policy** — outstanding supply is an operator attestation published on-chain under that policy, checkable against the vault balance by anyone, and a mint that misses its attestation interval stops being able to accept deposits until it publishes. What the contract cannot do is make an absent operator sign melts; abandonment is made *visible* early, not cured — that gap is listed openly in our known limitations. Factory-deployed (`isVault()` proves canonical bytecode), source-verified, live on Moderato.

## Intersections with open issues here

- **#292** (receipt/settlement semantics for card-class methods) and **#317** (correlating paid async MCP delivery to receipts): our receipts carry an explicit `settlement` state machine and reference the challenge id; whether receipts should additionally be **mint-cosigned** so agents can prove payment to third parties is our open question 3 — input from those discussions would directly shape it.
- **#307/#308** (Lightning refund/second-payment ambiguity after settlement failure): our melt path takes a position worth scrutinizing — burn-before-pay with a durable `OWED` state and same-inputs retry, made double-payout-proof by an on-chain per-id guard. If that pattern holds up, it may generalize.

## Where we'd most value review

1. **Binding modes**: `PC-BIND` binds a credential to a *challenge*; a P2PK lock binds it to a *service*, with cross-challenge replay resting on the duplicate-token guard. Is that the right split, and should `SIG_ALL` (witness also covers swap outputs) be mandatory before locked tokens travel over untrusted transports? [PIP-05, PIP-08]
2. **Unit identity**: `tip20:<chain_id>:<address>` with keys/ids derived from it — is CAIP-19 alignment worth the ceremony? [PIP-01]
3. **Receipts**: mint-cosigned or service-signed only? (See #292/#317 above.)
4. **Fees**: flat melt fee under an on-chain ceiling vs. gas-indexed. [PIP-03]
5. **Anything unsound.** Runtime model: spent-secret ledger is insert-before-sign in one transaction; DLEQ on every signature. Break it and we want to know before this touches real money.

## Try it / read it

- Specs (with published test vectors): https://github.com/picocash/pips — open questions are threaded in [Discussions](https://github.com/picocash/pips/discussions)
- **Demo, no install**: https://picocash.dev/demo/ — creates a throwaway testnet wallet, funds it from the Moderato faucet, deposits $1 of pathUSD, mints tokens in the browser with DLEQ verified client-side, sends them as a token string or an encrypted short link, and melts back on-chain. Runs against the public mint at `https://mint.picocash.dev` (`GET /v1/info`, `/v1/solvency`).
- Reference stack (crypto, mint, SDK, mppx method, browser wallet): https://github.com/picocash/picocash
- Contracts (factory + vault, verified on Moderato): https://github.com/picocash/picocash-contracts
- Site: https://picocash.dev

**Proposed next step**, if there's appetite: we'll submit `draft-picocash-payment-method-00` from the method template into `specs/methods/`, and would structure it to slot alongside the existing charge-type drafts.

Status: pre-alpha, testnet only, unaudited; an external design review's findings and what remains open are tracked in the repo's SECURITY.md. Per this repo's contribution guidelines: parts of the implementation and this text were AI-assisted; all of it has been human-reviewed and the measured figures come from the test suites.

---

## Review notes (not part of the issue)

1. **Their AI-disclosure rule**: mpp-specs CONTRIBUTING requires disclosure of AI-assisted contributions — the closing line handles it; keep or reword to taste, but don't drop it.
2. **The issue-number references (#292, #317, #307/#308)** are live as of 2026-08-20 — reverify they're still open before posting, and consider dropping a short comment in #292 the same day linking back ("we took a position on this in an RFC, curious for your take") to start the cross-pollination.
3. **Tone check**: the draft deliberately leads with the two properties, not the project — and never names the prior-art protocol (positioning rule); the crypto attribution lives in PIP-00 where reviewers will find it.
4. **The method-draft offer** at the end follows their documented workflow (issue → template → `specs/methods/`), which signals we've read their process — reviewers notice.
5. **PIP-08 wording** says "the established eCash convention for well-known secrets" rather than naming NUT-10/11 — the naming rule holds here too; the attribution is in PIP-00 and PIP-08's header.
6. **The Zones paragraph is deliberately complementary, and every claim is sourced** from tempoxyz/zones' own README (operator "maintains full visibility into state for compliance", 250 ms sequencing, testnet status). It positions the mint as the lightweight point on *their* privacy spectrum rather than an alternative to their flagship — do not sharpen it into a comparison table; the one-paragraph form is the right level of assertiveness for their repo. The compliance question (bearer instruments vs. TIP-403 inheritance) is intentionally not raised here; if a reviewer raises it, the answer is the reference mint's hard caps + the credits-keyset design.
