# Contributing to picocash

Thanks for looking. picocash is pre-alpha and the **spec is under RFC** — right now, design feedback is worth more than code.

## What's most useful today

1. **Spec review** — read [the pips](https://github.com/picocash/pips), especially the [MPP method draft](https://github.com/picocash/pips/blob/main/PIP-05.md), and open an issue for anything unsound, underspecified, or gratuitously incompatible with prior art (Cashu NUTs, MPP methods).
2. **Test-vector cross-checks** — implement the [published test vectors](https://github.com/picocash/pips/tree/main/vectors) in another language and report mismatches. Vector bugs are spec bugs.
3. **Adversarial thinking** — see the scope notes in [SECURITY.md](SECURITY.md). Non-sensitive design-level concerns can be public issues; exploitable bugs go to the security contact.

## Ground rules

- **Spec before code.** Changes to protocol behavior version-bump `spec/` first; implementation follows the spec, never the reverse.
- **Integers everywhere.** All amounts are base units (TIP-20 stablecoins use 6 decimals) as integers end to end. PRs introducing floats to money paths will be declined.
- **No new dependencies without cause.** Crypto stays on `@noble/curves` / `@noble/hashes` (audited, zero-dep).
- **Errors teach recovery.** Every API error message tells the calling agent how to recover.

## Process

- Small fixes: PR directly.
- Behavior changes: issue first, so spec impact can be sorted out before you write code.
- Commits: conventional-ish, present tense, scoped (`crypto:`, `mint:`, `spec:` …).

## License

Contributions are accepted under [Apache-2.0](LICENSE).
