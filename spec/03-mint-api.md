# 03 — Mint HTTP API

**Status: draft skeleton** — to be specified alongside the mint server (build step 4). Endpoint surface is settled; request/response schemas land with the implementation.

Base path `/v1`. JSON bodies. Every error response includes machine-readable `code` and a `recovery` hint telling the calling agent what to do next.

| Endpoint | Purpose |
|---|---|
| `GET /v1/info` | Mint metadata: name, unit, keysets, limits, vault contract address, method support |
| `GET /v1/keys` · `GET /v1/keys/{keyset_id}` | Active (or named) keyset pubkeys per denomination, with state (`active` / `swap-only` / `redeem-only`) and expiry |
| `POST /v1/mint/quote` | amount → quote id + vault deposit instructions (contract address, memo binding quote id) |
| `POST /v1/mint` | blinded messages + quote id (deposit observed on-chain) → blind signatures + DLEQ |
| `POST /v1/swap` | spend proofs → new blind signatures (change-making, denomination management, keyset refresh) |
| `POST /v1/melt/quote` | amount → melt quote (fees if any, expiry) |
| `POST /v1/melt` | proofs + destination address → vault withdrawal |
| `POST /v1/checkstate` | `Y` values (NOT secrets) → spent/unspent/pending per token |

## Security invariants (settled, non-negotiable)

- **Insert-before-sign**: the spent-secret `Y` is inserted into the ledger (UNIQUE constraint) *inside the same DB transaction* that authorizes signing; no signature is ever produced outside that transaction. This ledger is the entire runtime security model.
- Rate-limit `/v1/mint` per depositor address. Melt requires **no identity** (that is the point) but per-request size caps apply.
- Deposits bind to mint quotes via `transferWithMemo` memo = quote id.

Open questions for the RFC: quote expiry semantics, fee schedule surface, pagination for checkstate, idempotency-key convention.
