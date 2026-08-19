# 03 — Mint HTTP API

**Version: 0.1-draft** · Status: implemented in `packages/mint` for info/keys/mint/swap/checkstate (against a fake vault, build step 4); melt lands with the vault (build step 5).

Base path `/v1`, JSON bodies. All amounts are integer base units. Byte strings (secrets, points, `Y` values) are lowercase hex; points are 33-byte SEC1 compressed. Secrets are **raw bytes**, hex-encoded on the wire (a structured `PC-BIND` secret is the hex of its canonical-JSON UTF-8 bytes).

## Errors

Every error is:

```jsonc
{ "error": { "code": "TOKEN_ALREADY_SPENT", "message": "…", "recovery": "…" } }
```

`recovery` is mandatory and tells the calling agent what to do next (a9n9 convention). Codes used below: `INVALID_REQUEST`, `QUOTE_NOT_FOUND`, `QUOTE_EXPIRED`, `PAYMENT_REQUIRED`, `QUOTE_ALREADY_ISSUED`, `TOKEN_ALREADY_SPENT`, `OUTPUT_ALREADY_SIGNED`, `KEYSET_UNKNOWN`, `KEYSET_INACTIVE`, `AMOUNT_MISMATCH`, `INVALID_PROOF`, `AMOUNT_LIMIT`, `NOT_IMPLEMENTED`.

## Objects

**Proof** (a spendable token unit):

```jsonc
{ "amount": 4096, "keyset_id": "00a1…", "secret": "<hex>", "C": "02…" }
```

(The DLEQ payload `{e, s, r}` travels with tokens between agents/services but the mint does not require it — the mint verifies with its private key.)

**BlindedMessage** / **BlindSignature**:

```jsonc
{ "amount": 4096, "keyset_id": "00a1…", "B_": "02…" }
{ "amount": 4096, "keyset_id": "00a1…", "C_": "02…", "dleq": { "e": "<hex32>", "s": "<hex32>" } }
```

DLEQ on issuance is REQUIRED (spec 01 §3).

## Endpoints

### `GET /v1/info`

Mint metadata: `name`, `version`, `unit`, `keysets` (ids + state), `limits` (`max_mint_amount`), `vault` (`"fake"` until step 5, then contract address), `contact`.

### `GET /v1/keys` · `GET /v1/keys/{keyset_id}`

```jsonc
{ "keysets": [ { "id": "00a1…", "unit": "usdc.e-base", "state": "active", "keys": { "1": "02…", "2": "03…", … } } ] }
```

### `POST /v1/mint/quote` → deposit instructions

Request `{ "amount": 1000000, "unit": "usdc.e-base" }`. Response:

```jsonc
{
  "quote_id": "<32 bytes, hex>",        // doubles as the bytes32 deposit memo
  "amount": 1000000, "unit": "usdc.e-base",
  "state": "UNPAID",                    // UNPAID → PAID → ISSUED
  "deposit": {
    "method": "tempo",                  // or "fake-vault" in dev
    "chain_id": 42431,
    "token": "0x20c0…0000",             // TIP-20 token contract
    "to": "0x…",                        // deposit address (vault contract once it lands; mint-operator address until then)
    "memo": "0x<quote_id>",
    "note": "call transferWithMemo(to, amount, memo) on the token contract; the memo binds the deposit to this quote"
  },
  "expires_at": 1755630000
}
```

The quote id is 32 random bytes so it fits a TIP-20 `bytes32` memo exactly, with no padding convention needed. The mint observes `TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)` events (memo is indexed on Tempo's TIP-20) and credits the quote whose id matches the memo; deposits may span multiple transfers. Note the sender's fee is charged separately in the same token — the deposited `amount` arrives intact.

`GET /v1/mint/quote/{quote_id}` polls state.

### `POST /v1/mint` → blind signatures

Request `{ "quote_id": "…", "outputs": [BlindedMessage…] }`. Rules:

- Quote must be **PAID** (the mint checks the deposit oracle on demand); otherwise `PAYMENT_REQUIRED` with deposit instructions in `recovery`.
- `sum(outputs.amount) == quote.amount`, every amount a valid denomination of an **active** keyset.
- **Idempotent**: repeating the call with the identical output set returns the identical signatures. A different output set for an ISSUED quote → `QUOTE_ALREADY_ISSUED`.
- Each `B_` is globally single-use (`OUTPUT_ALREADY_SIGNED` on reuse) — signatures are recorded before they are returned, inside one DB transaction with the quote-state change.

Response `{ "signatures": [BlindSignature…] }`, ordered as the request.

### `POST /v1/swap` → change-making / refresh

Request `{ "inputs": [Proof…], "outputs": [BlindedMessage…] }`. Rules:

- Every input proof verifies (`k·hash_to_curve(secret) == C`) against its keyset (active or swap-only); `INVALID_PROOF` otherwise.
- `sum(inputs) == sum(outputs)` (`AMOUNT_MISMATCH`; no fees in v0.1).
- No duplicate `Y` among inputs, no duplicate `B_` among outputs.
- **Insert-before-sign**: input `Y`s are inserted into the spent-secret ledger (PRIMARY KEY on `Y`) and outputs recorded *inside one DB transaction*; a conflict aborts everything with `TOKEN_ALREADY_SPENT` and no signature is released. Concurrent redemptions of the same proof: exactly one succeeds.

Response `{ "signatures": [BlindSignature…] }`.

### `POST /v1/checkstate`

Request `{ "Ys": ["02…", …] }` — `Y = hash_to_curve(secret)` values, never secrets. Response `{ "states": [ { "y": "02…", "state": "UNSPENT" | "SPENT" } ] }` (`PENDING` reserved for melt).

### `POST /v1/melt/quote` · `GET /v1/melt/quote/{id}` · `POST /v1/melt`

Melt burns proofs and pays out USDC.e from the vault.

`POST /v1/melt/quote` request `{ "amount": 500000, "unit": "usdc.e-base", "to": "0x…" }` → response `{ "melt_id": "<32 bytes hex>", "amount", "unit", "to", "state": "UNPAID", "expires_at" }`. The melt id is 32 bytes and is passed on-chain as the vault's `bytes32 meltId` — the vault enforces **one payout per melt id, forever**.

`POST /v1/melt` request `{ "melt_id": "…", "inputs": [Proof…] }`. Rules:

- Every input verifies like a swap input; `sum(inputs) == amount` exactly (`AMOUNT_MISMATCH`; no fees in v0.1 — the payout gas is the operator's).
- **Insert-before-pay**: input `Y`s enter the spent-secret ledger inside one DB transaction *before* any on-chain payout is attempted. A conflict aborts with `TOKEN_ALREADY_SPENT` and nothing is paid.
- Then the mint calls `vault.withdraw(to, amount, meltId)` as operator. On success → `{ "state": "PAID", "tx_hash": "0x…" }`.
- If the chain call fails, the melt is recorded as `OWED` (`PAYOUT_FAILED`, HTTP 502): the tokens are consumed and the debt is durable. **Retry by re-POSTing the same `melt_id` with the same inputs** — the mint verifies the input set matches (hash), skips re-spending, and re-attempts the payout. The vault's per-meltId guard makes double-payout impossible even across retries.
- A `PAID` melt replayed with the same inputs returns the same result idempotently; different inputs → `MELT_ALREADY_PAID`.

State machine: `UNPAID → PENDING → PAID`, with `OWED` as the retryable failure branch. `GET /v1/melt/quote/{id}` polls state.

## Fake vault (build step 4 only)

With `PICOCASH_FAKE_VAULT=1` the mint runs an in-memory deposit oracle and exposes `POST /dev/deposit { "quote_id", "amount" }` to simulate an on-chain deposit. The real vault watcher (step 5) implements the same oracle interface; the API above does not change.

## Open questions for RFC

Quote expiry semantics (currently 15 min, unpaid quotes garbage-collected), fee schedule surface, checkstate batching limits, idempotency-key convention for `/v1/swap`.
