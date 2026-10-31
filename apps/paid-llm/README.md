# paid-llm — inference an agent can buy without an API key

An OpenAI-compatible `POST /v1/chat/completions` that charges **picocash per
request** and forwards to any OpenAI-compatible upstream (OpenAI, OpenRouter,
Anthropic's compat endpoint, a local Ollama) with a key **this server** holds.
The agent never sees a vendor key. It sees a `402`, pays it from its budget, and
gets a completion.

This is the piece that makes the Buzz owner-budget story real: *"give the agent
$5 that only works here, until Friday"* instead of *"give the agent my
Anthropic key"*. See `packages/mcp` for the agent side.

## Run

```sh
UPSTREAM_URL=https://openrouter.ai/api      # any OpenAI-compatible base
UPSTREAM_API_KEY=sk-…                       # held server-side, never forwarded to agents
PAID_LLM_LOCK_KEY=<32-byte hex>             # this merchant's P2PK key; owners lock budgets to its pubkey
MPP_SECRET_KEY=<≥32 bytes>                  # mppx challenge signing
PICOCASH_MINT_URL=https://mint.picocash.dev
npx tsx apps/paid-llm/src/server.ts         # :8403
```

`GET /v1/info` is free and advertises the mint, the price table, and the
**lock pubkey** (33-byte compressed, exactly as it appears in challenges).

Point any OpenAI client at `http://localhost:8403/v1` through a picocash-paying
fetch — the `@picocash/mcp` `fetch_paid` tool, or mppx's client with the
picocash method. Streaming (`stream: true`) is passed through after payment.

## Pricing

Per request, **deterministic in `(model, max_tokens)` only**:

```
dollars = tier.base + tier.per1k × ceil(max_tokens / 1000)
```

Default tiers (override the whole table with `PRICE_TABLE_JSON`):

| model contains | base | per 1k max_tokens |
|---|---|---|
| `opus` | $0.0100 | $0.0200 |
| `gpt-5` | $0.0050 | $0.0100 |
| `sonnet` | $0.0030 | $0.0060 |
| `haiku`, `mini` | $0.0005 | $0.0010 |
| `*` (fallback) | $0.0020 | $0.0040 |

`max_tokens` defaults to 1024 and is capped at 32,768. Flat tiers are a
deliberate v1 (plan §4); metered-by-actual-usage needs a session/channel
intent and is out of scope here.

### Why determinism matters — the underpay guard

The price is computed twice, from the body: once to issue the `402`, once on
the paid retry. A client that obtains a challenge for a cheap body and presents
that credential with a dearer body is caught **before** the mppx middleware
runs — so before any settlement — and gets a fresh `402` at the right price
(`X-Picocash-Reason` says why). Nothing is swapped, nothing is forwarded.

## Merchant-locked budgets (PIP-08)

An owner can lock an agent's budget to **this merchant's pubkey**. Those proofs
are presented to this proxy as-is (no swap) and are worthless anywhere else.

One constraint to know: the agent **cannot re-denominate a merchant-locked
proof** — the mint requires the merchant's witness to swap it — so a locked
budget pays only prices that are an **exact subset-sum of its denominations**.
Therefore fund merchant budgets **in units of the merchant's prices** ("three
haiku calls" = 3 × `$0.0015`), not as one lump. The `@picocash/mcp` wallet
uses the locked budget when an exact subset exists and otherwise falls back to
the agent's open balance rather than failing the call.

The clean protocol fix — letting the mint accept an *unsigned* swap whose
outputs carry byte-identical spending conditions to all inputs (nobody gains
spending power; only denominations change) — is recorded as a PIP-08 v0.2
follow-up.

## What the tests prove (`npm test` in this directory)

In-process, against a test mint and a fake upstream: pricing determinism; the
402 carries the exact price and the merchant pubkey; an owner-funded agent pays
and the upstream sees the **server** key and never a payment header; the
underpay attack is refused with nothing settled or forwarded; a merchant-locked
budget is spent in exact units with fallback to the open balance; SSE streams
through after payment; malformed bodies are rejected before any 402.

Testnet only (Tempo Moderato). Pre-alpha, unaudited.
