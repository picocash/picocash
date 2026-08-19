# 02 — Keysets, denominations, rotation

**Status: draft skeleton** — to be specified alongside the mint server (build step 4).

Settled design points (from the architecture; details TBD here):

- **Denominations** are powers of 2 in USDC.e base units (1, 2, 4, 8, … µUSDC.e). All amounts integers.
- A **keyset** is a set of per-denomination public keys derived HD-style from one keyset seed; keyset id is a hash of the ordered pubkeys (format TBD, NUT-02-adjacent).
- **Rotation**: a new keyset per epoch. Old keysets degrade gracefully: *swap-only* for a grace window (tokens can be refreshed to the new keyset), then *redeem-only* (melt/settle only), then archived. Published with expiry timestamps in `/v1/keys`.
- Keyset metadata binds to the **unit** (`usdc.e-base`) and to the mint URL, so tokens cannot be confused across mints or units.
- A dedicated **credits keyset** (zero-backed, service-redeemable only, never meltable to USDC.e) is a first-class concept for promo/free-tier credit — distinct keyset id, distinct unit, so backed money and credits never mix.

Open questions tracked for the RFC:

1. Keyset id derivation — adopt NUT-02 hash format verbatim or bind mint URL into the id?
2. Grace-window durations — protocol constants or per-mint policy surfaced in `/v1/info`?
3. Maximum denomination / amount-splitting guidance for privacy (uniform token counts).
