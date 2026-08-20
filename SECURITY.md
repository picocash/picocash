# Security Policy

## Status

picocash is **pre-alpha**. Nothing here has been audited. Do not use it with real funds. The reference mint (when live) operates under strict small-value caps as a technology demonstration.

## Reporting a vulnerability

Please **do not** open a public issue for security-sensitive reports.

- Email: **security@picocash.dev**
- Include: affected component (crypto / mint / vault / SDK / method), reproduction steps or a proof of concept, and impact assessment if you have one.

You will get an acknowledgment within 72 hours. Coordinated disclosure is appreciated; we will credit reporters (or keep you anonymous, your choice) in release notes.

## Scope notes for researchers

The interesting attack surfaces, in rough priority order:

1. **Double-spend** — the mint's spent-secret ledger (insert-before-sign inside one DB transaction) is the entire runtime security model. Race conditions in concurrent redemption are the headline bug class.
2. **Crypto core** — hash-to-curve edge cases, DLEQ soundness, blinding-factor reuse, cross-keyset signature confusion.
3. **Vault solvency** — any path where outstanding token supply can exceed vault balance, or where withdrawals can be paused/frozen.
4. **Challenge binding** — replay of intercepted MPP credentials across services or challenges.

## Known limitations (tracked, not yet fixed)

These came out of an external design review (August 2026) and are acknowledged rather than hidden. Each is either a conscious pre-alpha simplification or waiting on a spec decision.

| Area | Limitation | Consequence | Plan |
|---|---|---|---|
| Keyset rotation | `/v1/solvency` and `publishOutstandingSupply` report the **active** keyset only; tokens from a retired keyset are still a liability until swapped. | A mint that rotates and then publishes only the new keyset under-reports outstanding supply. | PIP-01/04: publish per-keyset and in aggregate; retired keysets stay redeemable-by-swap for a committed window. |
| Deposit observation | The deposit log is scanned from the mint's last-seen block; a deep reorg on Tempo could, in principle, un-confirm a deposit the mint already credited. | Bounded by Tempo finality (sub-second, single-slot finality on Moderato); not a practical risk today, but not formally handled. | Confirm against finalized blocks once the RPC exposes a finality tag; persist the scan cursor durably (it is today in the DO/PGlite store). |
| Abuse limits | Quote creation, relay uploads, and the faucet proxy are capped by amount and size, not by rate per client. | A hostile client can exhaust the reserved-capacity cap (quotes) or the relay's storage budget until entries expire. | Per-IP / per-token-bucket rate limits at the Worker edge; short quote TTLs (15 min by default) bound the damage. |
| Token format | Only `picoA` (JSON) exists. | Tokens are larger than they need to be. | `picoB` (CBOR) is an open item in PIP-06; parsers already dispatch on the version byte. |
| Vault deployment | The factory does not enforce a minimum rotation/fee-increase timelock; a vault can be deployed with `rotationTimelock = 0`. | A user must read `info()` before trusting a vault — the factory's `isVault` proves bytecode, not safe parameters. | Add `MIN_TIMELOCK` to the factory in the next contract version (the current testnet vaults use 2 days); wallets/SDK will warn on short timelocks meanwhile. |
| Acceptor replay state | The default `MemoryAcceptorStore` is process-local. | Correct for one instance; two instances behind a load balancer would each accept the same credential once. | The `AcceptorStore` interface exists for a shared, transactional store; a Postgres reference implementation is next. |
| Operator liveness | The vault cannot be told to stop paying out, but it also cannot pay out without the operator's signature. | An abandoned mint strands holders; the publication policy makes abandonment visible (deposits halt), it does not cure it. | Under RFC: a holder-initiated exit path (e.g. operator-inactivity timeout unlocking a claims process) — PIP-04 open question. |
