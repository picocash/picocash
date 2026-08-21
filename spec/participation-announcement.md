# Announcement: picocash works end to end — come break it

> **Draft of the stage-two community post.** Venue: [tempoxyz/tempo-apps discussions](https://github.com/tempoxyz/tempo-apps/discussions) (the only tempoxyz repo with Discussions — the de-facto community board), after the mpp-specs RFC has had time to gather feedback. Lead with the demo link, ask for participation only now that everything runs. Not yet posted.

---

**TL;DR:** The whole loop works on Tempo Moderato testnet, and you can click through it yourself at **https://picocash.dev/demo/** (public mint: `mint.picocash.dev`): deposit $1 of pathUSD, mint private bearer tokens in your browser, hand them to another wallet with **offline verification**, pay an MPP service with **~45ms measured merchant-side verification**, and melt back to on-chain funds from a vault whose solvency is published on-chain. Everything is Apache-2.0. We'd like implementers, reviewers, and first services.

## What you can do today

- **Click the demo**: a static HTML wallet (mint / transfer / melt) against a testnet mint — [apps/wallet-demo](https://github.com/picocash/picocash/tree/main/apps/wallet-demo). Faucet money, real chain, real vault.
- **Verify solvency yourself**: `GET /v1/solvency` on any mint gives outstanding token supply; compare it to the vault's on-chain balance. The invariant is published per epoch via `publishOutstandingSupply` — operator-attested liabilities you can check against the vault balance — not cryptographic proof, but on-chain, timestamped, and policy-enforced.
- **Watch the custody, live**: https://mint.picocash.dev/ reconciles the mint's books against the vault on-chain every 30 s — and if the operator ever goes silent or trips the payout breaker, holders redeem at the vault directly with `scripts/emergency-redeem.ts`, no mint involved (PIP-04).
- **Lock tokens to a key** (PIP-08): fund an agent that can spend only with a named merchant, with an automatic refund if unused — `wallet.sendLocked(...)`; the merchant claims with `receive(token, { unlockKey })`.
- **Pay a service with mppx**: the `picocash` method plugs into mppx's `validate`/`broadcast` interface — [`@picocash/mppx-method`](https://github.com/picocash/picocash/tree/main/packages/mppx-method). Measured: one $1 deposit → 20 calls, mean 45ms merchant-side offline verification (settlement at the mint is then the default before success).
- **Build a wallet or a second mint**: [`@picocash/sdk`](https://github.com/picocash/picocash/tree/main/packages/sdk) is a stateless wallet-lite; [pips/vectors](https://github.com/picocash/pips/tree/main/vectors) are versioned test vectors any implementation must reproduce.

## Where we'd love help

1. **Adversarial review** — the double-spend ledger, the challenge binding, the vault ([SECURITY.md](https://github.com/picocash/picocash/blob/main/SECURITY.md) has the scope notes and disclosure contact).
2. **A second implementation** in another language, against the published test vectors. Vector bugs are spec bugs — we want them found.
3. **First services**: if you run an MPP endpoint on Tempo, adding `picocash` next to `tempo` is one method entry. We'll help.
4. **Spec feedback** still counts — the RFC ([pips](https://github.com/picocash/pips)) is open until v0.2 freeze.

Status remains pre-alpha, testnet only, unaudited — that's exactly why now is the cheap moment to change things.
