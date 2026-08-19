# Wallet demo

A single static HTML page (`index.html`, no build step) that mints picocash eCash tokens from a real **$1 pathUSD deposit on Tempo Moderato testnet** — an early cut of the build-step-6 launch artifact.

What it does, all client-side in the browser:

1. Connects to a mint and fetches its keyset.
2. Requests a $1 mint quote; the 32-byte quote id doubles as the deposit memo.
3. Sends `transferWithMemo(to, 1000000, memo)` on Tempo testnet — with a pasted **testnet** private key (never leaves the page) or a browser wallet.
4. Polls until the mint's oracle observes the deposit (~2s after confirmation).
5. Blinds fresh secrets, requests blind signatures, **verifies every DLEQ proof in the browser** before trusting them, unblinds, and stores the bearer tokens in `localStorage`.
6. Shows balance and per-token spent state via `/v1/checkstate`.

## Run it

```sh
# 1. start a testnet-connected mint (see packages/mint/README.md)
cd packages/mint && npx tsx scripts/setup-testnet.ts && npm run dev

# 2. serve this page
cd apps/wallet-demo && python3 -m http.server 8080
```

Open http://localhost:8080, connect to `http://localhost:3338`, paste a faucet-funded testnet key (setup-testnet.ts printed its address; the key is in `packages/mint/.env` as `PICOCASH_E2E_PAYER_KEY`), and click **Pay with key & mint**.

Cryptography (hash-to-curve, blinding, DLEQ verification) is implemented in-page against `@noble/curves` from an ESM CDN, mirroring `packages/crypto` — it will move to the SDK (`@picocash/sdk`) when that lands. Testnet only; the page stores bearer tokens in plain `localStorage`, which is exactly as unsafe as it sounds.
