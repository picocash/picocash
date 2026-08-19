# 05 — Vault contract & proof of liabilities

**Status: v0.1-draft, implemented** in [picocash/picocash-contracts](https://github.com/picocash/picocash-contracts) (`PicocashVault.sol`), built after the mint ran against a fake vault so the interface was dictated by a running consumer. Current Tempo **Moderato testnet** deployment: `0x4336A5914BFF9912050c6518fbF46e599336D384` (token pathUSD `0x20c0…0000`, 2-day rotation timelock).

The primary deposit flow needs no vault call at all: a TIP-20 `transferWithMemo(vault, amount, quoteId)` credits the vault and emits the memo event the mint watches (memo is indexed on Tempo's TIP-20). `deposit(amount, mintQuoteId)` exists as an allowance-based fallback. Melt payouts go through `withdraw(to, amount, meltId)` — operator-only, **one payout per meltId enforced on-chain**, and with no pause check anywhere on the path.

Settled design constraints the implementation honors:

- Holds **USDC.e on Tempo** (TIP-20 `0x20C0000000000000000000000000000000000000` on mainnet — confirm current address before deployment) backing outstanding tokens 1:1.
- `deposit(amount, mintQuoteId)` — pulls USDC.e via `transferWithMemo` pattern; the memo binds the deposit to a mint quote; emits the event the mint watches before releasing blind signatures.
- `withdraw(to, amount, meltId)` — mint-operator-signed release for melts.
- **Solvency invariant**: vault balance ≥ outstanding token supply per keyset. Outstanding supply is published **on-chain per epoch**, so anyone can verify solvency — proof of liabilities beats "trust me".
- Operator key rotation is **timelocked**. Deposits are pausable; **withdrawals are never pausable** — holders must always be able to exit.
- Foundry; deployed to Tempo testnet first (build step 5), mainnet reference deployment behind hard caps (per-wallet and global outstanding limits) only at build step 9.
