# @picocash/mppx-method

Reference implementation of the `picocash` MPP payment method ([spec/04](../../spec/04-mpp-method.md)): challenge → credential → receipt with **offline verification** and **accept-then-settle**.

```ts
// service side
const acceptor = new PicocashAcceptor({ realm: 'api.example.dev', mints: [{ url, keyset }] });
const challenge = acceptor.createChallenge(50_000);          // → return in your 402
const receipt = acceptor.verifyCredential(credential);        // offline, no mint round-trip
// … serve the request immediately …
await acceptor.settle(challenge.challenge_id, serviceWallet); // async: swap at the mint = finality

// agent side
const { credential, change } = await payChallenge(wallet, proofs, challenge);
```

Measured in the test suite: **one $1 deposit funds 20 paid calls with mean offline verification of ~45ms** (max 48ms) — the sub-100ms path is real, not aspirational. Verification runs the six spec/04 checks in order (challenge single-use → mint allowlist → `PC-BIND` challenge binding → exact amount/denominations → DLEQ per proof → duplicate-`Y` guard) and rejects with a typed `CredentialRejected` naming the failed check.

The double-spend exposure of accept-then-settle is bounded and tested: a payer who re-swaps their bound proofs before settlement produces a `double-spent` receipt at settle time — recourse is service-level, and per-call amounts keep the window small.

Status: implements the spec shapes directly; the thin adapter onto the `mppx` custom-method interface lands when that binding is pinned (consult the MPP docs MCP server: `claude mcp add --transport http mpp https://mpp.dev/api/mcp`).

`npm test` runs the paid-echo-service end-to-end against an in-process mint.
