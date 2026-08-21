# RFC: `picocash` — an eCash payment method for MPP

> **Draft for internal review — not yet posted.** Venue: a new issue on [tempoxyz/mpp-specs](https://github.com/tempoxyz/mpp-specs/issues) (their CONTRIBUTING says: issue first for discussion, then a method draft from `examples/method-template.md` into `specs/methods/` as `draft-picocash-payment-method-00`). Everything below the rule is the issue text, ready to paste. Review notes at the bottom.

---

**Proposed issue title:** `RFC: picocash — an eCash payment method (offline-verified, lockable bearer tokens)`

**TL;DR.** We have built and would like feedback on **picocash**, a proposed MPP `charge` method using Chaumian eCash backed 1:1 by a TIP-20 stablecoin on Tempo. A service verifies token authenticity offline against an allowlisted mint keyset — **~45 ms mean** merchant-side in the current reference tests — and, by default, settles the proofs at the mint *before* returning payment success. One on-chain deposit funds many calls with no on-chain transaction on the request path, and the credential exposes no payer address.

Proofs may also carry **P2PK spending conditions** (PIP-08), so a principal can fund an agent with tokens redeemable only by a named merchant and reclaimable by the principal after a locktime. The reference vault adds timelocked custody changes, operator-outflow rate limits, public reserve/liability reconciliation, and a capped emergency-redemption path. These mechanisms reduce and expose custodial risk; they do not eliminate operator-attestation trust or reconstruct the mint's off-chain spent set.

Specs, implementation, a public Moderato mint, and a browser demo are at **https://github.com/picocash**. Everything is pre-alpha, testnet-only, unaudited, Apache-2.0, and under RFC.

## Why another method

Two properties existing rails don't combine:

1. **Privacy.** On-chain settlement is transparent; for autonomous agents a public transaction graph is strategy leakage — what an agent buys, how often, from which wallet. Blind signatures cryptographically decouple issuance from redemption, and the service sees valid tokens, not a payer. Timing, network, amount-decomposition, and reused-P2PK-key side channels remain outside that guarantee.
2. **Latency without an on-chain transaction on the request path.** The service validates a credential offline via DLEQ proofs against the mint's published keys, then settles by swapping the proofs at the mint (an off-chain HTTP call). The chain is touched only on deposit and on melt (withdrawal), not per call.

This is volume-*additive* to Tempo — deposits, melts, and solvency attestations stay on-chain; the per-call hot path does not.

picocash is complementary to [Tempo Zones](https://github.com/tempoxyz/zones): Zones provide execution-layer privacy and compliance-oriented private-chain infrastructure, while picocash targets small, unlinkable bearer payments with offline merchant verification. A service operating in a Zone could accept the same picocash credential flow.

## Proposed MPP mapping

The reference mppx binding currently uses a flat method-specific request object; for the method draft we intend to align with the shared `charge` fields (string `amount`, `currency`, method-specific data under `methodDetails`, expiry from the authentication envelope), JCS canonicalisation, and the standard challenge/credential/receipt envelope. Proposed shape:

```json
{
  "amount": "50000",
  "currency": "0x20c0000000000000000000000000000000000000",
  "methodDetails": {
    "chainId": 42431,
    "unit": "tip20:42431:0x20c0000000000000000000000000000000000000",
    "nonce": "<32-byte hex>",
    "mints": [{ "url": "https://mint.picocash.dev", "keysetIds": ["…"] }],
    "pubkey": "<optional service P2PK lock key>"
  }
}
```

- **Credential**: `{ mint, keysetId, proofs[] }` — proofs summing to exactly `amount`, each carrying a DLEQ payload `{e, s, r}` so the service can verify the mint's signature without calling the mint.
- **Receipt**: `{ challengeId, amount, settlement }` with `settlement ∈ { settled, pending, double-spent }` (see finality below).

Whether the unit should be `currency` + `methodDetails.chainId`, a CAIP-19 asset id, or the current `tip20:<chain_id>:<address>` string is our first schema question.

## Payment flow and finality

1. Service issues a challenge with a fresh 32-byte nonce.
2. Agent answers with proofs whose secrets commit to the nonce and realm (`PC-BIND`), or with proofs P2PK-locked to `methodDetails.pubkey`.
3. Service runs six offline checks — challenge single-use → mint/keyset/unit allowlisted → binding → exact amount/denominations → DLEQ per proof → duplicate-proof guard — in ~45 ms, no network.
4. **Settle-first (default)**: the service swaps the proofs at the mint and returns `success` with `settlement: settled` only after the swap lands. The swap is the moment of finality; a double-spend fails here and the request is rejected.
5. **Accept-then-settle (opt-in)**: the service returns success on the offline checks with `settlement: pending`, settles asynchronously, and carries an exposure bounded by per-call amount × settlement lag. Whether this mode conforms to `charge` is the first thing we want reviewed.

## Binding and replay protection

`PC-BIND` prevents a credential from being repurposed for another challenge or realm. Same-challenge replay is rejected by the service's **required atomic challenge-and-proof replay store**. P2PK proofs are service-bound rather than challenge-bound and rely on that same duplicate-proof guard across challenges. The reference acceptor ships a memory store that is **single-instance only**; a shared store interface is defined and a production implementation is pending.

## Lockable tokens (PIP-08)

A bare eCash proof is a bearer instrument, which is sometimes exactly wrong for agents. PIP-08 adds pay-to-public-key spending conditions: the secret carries a lock key, an optional `locktime`, and optional `refund` keys; spending requires a Schnorr witness, enforced by the mint on swap and melt. Two flows fall out:

- A **merchant pays an agent** (rebate, bounty, refund) with tokens only that agent can redeem — worthless in a log file.
- A **human funds an agent** with tokens locked to merchant M and a refund key of their own: the agent can pay M and nobody else, and after the locktime the principal can reclaim any unredeemed proofs using the refund key. Spending authority is bounded by the token, not by a policy the agent could ignore.

The wire format follows the established eCash convention for well-known secrets; the lock is readable offline by any receiver.

## Custody and trust model (summary)

A mint is a custodian, and an eCash mint's *issuance* is unauditable by construction, so no vault can make operator theft impossible. The reference vault makes it slow, visible, rate-limited, and escapable, with its parameters and observable state committed on-chain and checkable before deposit:

- **Slow**: operator rotation, fee-ceiling increases, and breaker changes go through a public timelock.
- **Visible**: outstanding supply is operator-attested on-chain under a committed publication policy; deposits close if it lapses. Each mint serves a status page (https://mint.picocash.dev/) reconciling its books against the chain — backing vs. outstanding, Σ deposits − Σ payouts vs. vault balance, attestation freshness, breaker utilisation.
- **Rate-limited**: a withdrawal breaker limits operator-controlled outflow to a committed share of backing per epoch; consuming the full allowance latches the vault and opens immediate emergency redemption. A malicious operator can still withdraw *below* the threshold in successive epochs, so monitoring and response time remain security assumptions.
- **Escapable**: holders can redeem tokens at the vault directly — DLEQ and P2PK witnesses verified on-chain against the registered keyset public key — once the attestation is overdue past a grace period, or immediately when the breaker trips. Payouts are never contract-pausable.

**Emergency redemption is a capped recovery mechanism, not an on-chain reconstruction of the mint ledger.** The vault does not know the mint's off-chain spent set, so stale copies of proofs already spent at the mint may compete with genuinely unspent proofs; redemption is first-come within the attested cap unless an orderly-shutdown spent-set commitment is available. Operator attestation is the residual trust assumption — now rate- and amount-bounded rather than open-ended.

Full design, limitations, and current Moderato gas/cost measurements with reproducible transaction links: [PIP-04](https://github.com/picocash/pips/blob/main/PIP-04.md) and the repo's SECURITY.md.

## Intersections with open issues here

- **#292** (receipt/settlement semantics) and **#317** (correlating paid async MCP delivery to receipts): our receipts carry an explicit `settlement` state and reference the challenge id; whether they should also be **mint-cosigned** so agents can prove payment to third parties is our *receipts* question below.
- **#307/#308** (Lightning refund/second-payment ambiguity after settlement failure): our melt path takes a position worth scrutinising — burn-before-pay with a durable `OWED` state and same-inputs retry, made double-payout-proof by an on-chain per-id guard. If that pattern holds up, it may generalise.

## Where we'd most value review

1. **Finality and intent.** Settle-first returns success only after the mint swap. Should accept-then-settle remain an optional risk mode under `charge`, require a distinct experimental intent, or return a non-success authorization receipt until settlement?
2. **MPP schema mapping.** `currency` + `methodDetails.chainId`, CAIP-19, or the current `tip20:<chain>:<address>` identifier? [PIP-01]
3. **Replay and binding.** Is challenge-bound `PC-BIND` plus service-bound P2PK the right split, and what durable replay-store guarantees belong in the method specification itself? [PIP-05, PIP-08]
4. **Emergency fairness.** Is first-come redemption against an attested cap acceptable when stale spent proofs are indistinguishable on-chain, or should emergency redemption require an orderly-shutdown spent-set commitment, a periodic accumulator, or another anti-replay commitment? [PIP-04]
5. **P2PK witnesses.** Should `SIG_ALL` (witness also covers swap outputs) be mandatory before signed witnesses travel over untrusted transports? [PIP-08]
6. **Receipts.** Mint-cosigned or service-signed only? (See #292/#317.)
7. **Custody breaker.** Is per-epoch rate limiting sufficient, or is a cumulative multi-epoch cap worth the complexity? [PIP-04]
8. **Fees.** Flat melt fee under an on-chain policy ceiling vs. gas-indexed. [PIP-03]

And anything unsound: spent-secret ledger is insert-before-sign in one transaction; DLEQ on every signature; on-chain secp256k1 verifier (Jacobian arithmetic, Shamir, BIP-340) written for auditability. Break any of it and we want to know before this touches real money.

## Try it / read it

- Specs with test vectors: https://github.com/picocash/pips — open questions threaded in [Discussions](https://github.com/picocash/pips/discussions)
- Mint status, live: https://mint.picocash.dev/
- Demo, no install: https://picocash.dev/demo/ — throwaway testnet wallet, faucet, deposit, mint with DLEQ verified client-side, send as token or encrypted short link, melt back on-chain.
- Reference stack (crypto, mint, SDK, mppx method, browser wallet): https://github.com/picocash/picocash
- Contracts (factory, vault v3, on-chain proof verifier; Sourcify exact-match on Moderato): https://github.com/picocash/picocash-contracts

**Proposed next step**, if there's appetite: we'll submit `draft-picocash-payment-method-00` from the method template into `specs/methods/`, structured to slot alongside the existing charge-type drafts.

Status: pre-alpha, testnet only, unaudited; an external design review's findings and what remains open are tracked in the repo's SECURITY.md. Per this repo's contribution guidelines: parts of the implementation and this text were AI-assisted; all of it has been human-reviewed and the measured figures come from the test suites.

---

## Review notes (not part of the issue)

1. **Their AI-disclosure rule**: mpp-specs CONTRIBUTING requires disclosure of AI-assisted contributions — the closing line handles it; keep or reword to taste, but don't drop it.
2. **The issue-number references (#292, #317, #307/#308)** were verified open on 2026-08-21 — reverify before posting, and consider a short comment in #292 the same day linking back to start the cross-pollination.
3. **Tone**: leads with method semantics, not the project; never names the prior-art protocol (positioning rule) — attribution lives in PIP-00 and PIP-08's header. Custody is a summary section; the full design is linked (PIP-04, SECURITY.md) rather than restated.
4. **The method-draft offer** follows their documented workflow (issue → template → `specs/methods/`).
5. **The MPP mapping is a proposal**, not what the mppx binding ships today (flat `{amount, unit, nonce, mints}` request). Saying so in the post is deliberate; the method draft is where it gets pinned down.
6. **Zones** is two sentences by design — do not expand it into a comparison.
7. **Volatile numbers** (gas, dollar cost, sequencing latency) are kept out of the issue; PIP-04 §Implementation and cost holds the measurements.
