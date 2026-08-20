# @picocash/mppx-method

Reference implementation of the `picocash` MPP payment method ([PIP-05](https://github.com/picocash/pips/blob/main/PIP-05.md)): challenge → credential → receipt with **offline verification** and **accept-then-settle**.

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

Measured in the test suite: **one $1 deposit funds 20 paid calls with mean merchant-side offline verification of ~45ms** (max 48ms). That number is the service's verification step, not end-to-end payment latency. The mppx `charge` binding is **settle-first by default** — `success` is returned only after the proofs are swapped at the mint — and `mode: 'accept-then-settle'` is an explicit opt-in that returns `settlement: 'pending'` and leaves the double-spend exposure (amount × settlement lag) with the service. Verification runs the six PIP-05 checks in order (challenge single-use → mint allowlist → `PC-BIND` challenge binding → exact amount/denominations → DLEQ per proof → duplicate-`Y` guard) and rejects with a typed `CredentialRejected` naming the failed check.

The double-spend exposure of accept-then-settle is bounded and tested: a payer who re-swaps their bound proofs before settlement produces a `double-spent` receipt at settle time — recourse is service-level, and per-call amounts keep the window small.

## mppx binding

`@picocash/mppx-method/mppx` plugs the method into [mppx](https://mpp.dev) (peer dependency): `picocashMethod` is the `Method.from` wire definition, `picocash({ wallet, getProofs, onChange })` the client method (creates `Authorization: Payment …` credentials), and `picocashCharge({ acceptor })` the server method using mppx's modern split — `validate` maps to the acceptor's non-mutating offline pre-check, `broadcast` to the terminal offline accept (settlement stays async via `acceptor.settle()`). The challenge nonce rides in the method's `request` schema; inject a fresh one per challenge (`freshNonce()`) via the server's `request` hook. Tested through mppx's own `Credential.serialize` / `Method.validateCredential` / `Method.broadcastCredential` pipeline.

`npm test` runs the paid-echo-service end-to-end and the mppx adapter round trip against an in-process mint.
