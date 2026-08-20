# @picocash/mint

The picocash mint server: Hono HTTP API over Postgres, implementing keysets, mint quotes, blind-signature issuance, swap, and checkstate per [`spec/03-mint-api.md`](../../spec/03-mint-api.md). **Build step 4: runs against a fake in-memory vault** — the `DepositOracle` interface in [`src/vault.ts`](src/vault.ts) is what the real Tempo chain watcher implements in step 5; the API doesn't change.

## The security model in one paragraph

The `spent_secrets` table (PRIMARY KEY on `Y`) is the double-spend ledger. On swap, input `Y`s are **inserted before any output is signed, inside one DB transaction**: a conflict rolls the whole thing back and no signature leaves the mint. Concurrent redemptions of the same proof — the headline attack — resolve to exactly one winner (see `test/swap.test.ts`, "concurrent redemption race"). Issuance is idempotent per quote, and every `B_` is globally single-use (PRIMARY KEY on `b`), so a replayed or duplicated mint request can never create money twice. Every signature carries a DLEQ proof so clients verify issuance without trusting the mint.

## Storage

Real Postgres semantics either way:

- `DATABASE_URL` set → node-postgres pool (production path).
- unset → embedded [PGlite](https://pglite.dev) at `.data/mint-db` (dev) or in-memory (tests). Zero infrastructure; note PGlite serializes transactions on one connection, so run race tests against real Postgres too before anything ships.

## Run it

**Against Tempo testnet (Moderato)** — real on-chain deposits, real oracle:

```sh
npx tsx scripts/setup-testnet.ts   # writes .env (seed + wallets, gitignored) and faucet-funds them
npm run dev                        # mint on :3338, watching TransferWithMemo events on chain 42431
npx tsx scripts/testnet-e2e.ts     # quote → real pathUSD transferWithMemo → mint → DLEQ verify → swap
```

The deposit flow: the quote id is 32 bytes and doubles as the TIP-20 `bytes32` memo; the mint credits quotes from `TransferWithMemo(from, to, amount, memo)` events (memo is **indexed** on Tempo — a non-indexed ABI decodes it as undefined and deposits vanish, ask us how we know). Deposits go to the vault contract, and at startup the mint verifies the whole chain binding: the unit's token address is a live TIP-20 and `vault.token()` matches it exactly, refusing to start otherwise. Note: `setup-testnet.ts` writes the operator EOA as the deposit address — deploy [PicocashVault](https://github.com/picocash/picocash-contracts) and point `PICOCASH_DEPOSIT_ADDRESS` at it for the full vault flow.

**Against the fake vault** (no chain, no config):

```sh
npm run dev          # with no .env: fake vault + an INSECURE fixed dev seed
```

```sh
# happy path against the dev server
curl -s -X POST :3338/v1/mint/quote -d '{"amount":1000000,"unit":"tip20:42431:0x20c0000000000000000000000000000000000000"}'
curl -s -X POST :3338/dev/deposit   -d '{"quote_id":"<id>","amount":1000000}'   # fake the on-chain deposit
curl -s -X POST :3338/v1/mint       -d '{"quote_id":"<id>","outputs":[...]}'    # blinded messages → signatures
```

Config via env: `PICOCASH_MINT_SEED` (32-byte hex; encrypted at rest in real deployments, never in code or logs), `PICOCASH_OPERATOR_KEY` (signs `vault.ecashMelt` for melts; melt answers `NOT_IMPLEMENTED` without it), `PORT`, `DATABASE_URL`, `PICOCASH_MAX_MINT_AMOUNT`, `PICOCASH_QUOTE_TTL_SECONDS`.

**Melt** (`POST /v1/melt/quote` → `POST /v1/melt`) burns proofs insert-before-pay and pays out through [`PicocashVault.ecashMelt`](https://github.com/picocash/picocash-contracts) — one payout per melt id enforced on-chain, so a failed payout (`OWED`) can be retried with the same inputs without double-pay risk. Deposits go to the vault contract (Moderato: `0x1607001B73dC69C559376299354b17C72906123f`).

```sh
npm test             # 19 tests incl. double-spend + concurrency races and melt failure/retry
```
