# 05 — Vault contract & proof of liabilities

**Status: v0.1-draft, implemented** in [picocash/picocash-contracts](https://github.com/picocash/picocash-contracts) (`PicocashVault.sol`), built after the mint ran against a fake vault so the interface was dictated by a running consumer. Current Tempo **Moderato testnet** deployment: `0x8431C3ce797995B75d18c30cBe9a06B9F1D377B9` (token pathUSD `0x20c0…0000`, 2-day rotation timelock).

**One vault per currency.** The vault is bound to exactly one TIP-20 token at deployment; `vault.token()` is the on-chain authority for the mint's unit binding (`tip20:<chain_id>:<token_address>`, spec/02), and the mint refuses to start if its configured unit disagrees. A mint supporting multiple currencies runs one vault per unit — solvency stays one number against one number, and a fault in one currency's custody cannot touch another's.

The primary deposit flow needs no vault call at all: a TIP-20 `transferWithMemo(vault, amount, quoteId)` credits the vault and emits the memo event the mint watches (memo is indexed on Tempo's TIP-20). `deposit(amount, mintQuoteId)` exists as an allowance-based fallback. Melt payouts go through `withdraw(to, amount, meltId)` — operator-only, **one payout per meltId enforced on-chain**, and with no pause check anywhere on the path.

Settled design constraints the implementation honors:

- Holds **USDC.e on Tempo** (TIP-20 `0x20C0000000000000000000000000000000000000` on mainnet — confirm current address before deployment) backing outstanding tokens 1:1.
- `deposit(amount, mintQuoteId)` — pulls USDC.e via `transferWithMemo` pattern; the memo binds the deposit to a mint quote; emits the event the mint watches before releasing blind signatures.
- `withdraw(to, amount, meltId)` — mint-operator-signed release for melts.
- **Solvency invariant**: vault balance ≥ outstanding token supply per keyset. Outstanding supply is published **on-chain per epoch**, so anyone can verify solvency — proof of liabilities beats "trust me".
- Operator key rotation is **timelocked**. Deposits are pausable; **withdrawals are never pausable** — holders must always be able to exit.
- Foundry; deployed to Tempo testnet first (build step 5), mainnet reference deployment behind hard caps (per-wallet and global outstanding limits) only at build step 9.
