# 02 — Keysets, denominations, rotation

**Version: 0.1-draft** · Status: partially implemented (`packages/mint`); rotation lifecycle still skeleton.

## Denominations

Powers of 2 in **USDC.e base units** (6 decimals): `1, 2, 4, …, 2^30` µUSDC.e (≈ $1073 max single denomination). All amounts are integers; a mint MAY support fewer denominations and MUST publish exactly which via `/v1/keys`.

## Unit

The unit string `"usdc.e-base"` denotes USDC.e base units. The dedicated **credits** instrument (zero-backed, service-redeemable only, never meltable) uses a distinct unit string (`"credit"`) and its own keyset, so backed money and promo credits can never be confused.

## Key derivation

A keyset's per-denomination private keys derive from one 32-byte keyset seed:

```
k_d = first candidate in [1, n) of:
      candidate_i = HMAC-SHA256(seed, "picocash/keyset/v1/" || unit || "/" || decimal(d) || "/" || decimal(i))
      for i = 0, 1, 2, …
```

where `d` is the denomination. The seed is the only secret; it MUST be stored encrypted at rest and MUST NOT appear in code, manifests, or logs.

## Keyset id

```
id = "00" || first 7 bytes, hex, of SHA256( concat of 33-byte compressed pubkeys, ascending by denomination )
```

16 lowercase hex chars total; leading `"00"` is a version byte (NUT-02-style). *(Open question: adopt NUT-02 v2 id derivation — which also hashes unit and expiry — before freeze.)*

## Rotation lifecycle (settled shape, details TBD)

New keyset per epoch. Old keysets degrade: **active** → **swap-only** (grace window; tokens refreshable to the new keyset) → **redeem-only** (melt/settle only) → **archived**. States and expiry timestamps are published in `/v1/keys`. Blind signatures are only ever issued under an **active** keyset; swap inputs are accepted from active and swap-only keysets.

Open questions tracked for the RFC:

1. Keyset id derivation — NUT-02 v2 alignment (above).
2. Grace-window durations — protocol constants or per-mint policy surfaced in `/v1/info`?
3. Maximum denomination / amount-splitting guidance for privacy (uniform token counts).
