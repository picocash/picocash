# 05 — Vault contract & proof of liabilities

**Status: draft skeleton** — the contract is deliberately built **last** (build step 5), after the mint runs against a fake vault, so the Solidity interface is dictated by a running, proven consumer rather than guessed. This doc records the settled design constraints the implementation must honor.

- Holds **USDC.e on Tempo** (TIP-20 `0x20C0000000000000000000000000000000000000` on mainnet — confirm current address before deployment) backing outstanding tokens 1:1.
- `deposit(amount, mintQuoteId)` — pulls USDC.e via `transferWithMemo` pattern; the memo binds the deposit to a mint quote; emits the event the mint watches before releasing blind signatures.
- `withdraw(to, amount, meltId)` — mint-operator-signed release for melts.
- **Solvency invariant**: vault balance ≥ outstanding token supply per keyset. Outstanding supply is published **on-chain per epoch**, so anyone can verify solvency — proof of liabilities beats "trust me".
- Operator key rotation is **timelocked**. Deposits are pausable; **withdrawals are never pausable** — holders must always be able to exit.
- Foundry; deployed to Tempo testnet first (build step 5), mainnet reference deployment behind hard caps (per-wallet and global outstanding limits) only at build step 9.
