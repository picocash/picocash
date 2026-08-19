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
