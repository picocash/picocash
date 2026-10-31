# Tempo Stablecoin Reserves

Independent, live reconciliation of every TIP-20 stablecoin on Tempo mainnet:
**what the chain says exists** (`totalSupply()` read from each token contract),
**what the issuer says backs it** (Bridge's public transparency feed), and
whether the two agree — with 90 days of hourly history and drift checks.

Why it exists: reserve reporting is now a legal requirement for branded
stablecoins, Bridge publishes issuer-reported figures that it describes as *not
an independent attestation*, and nobody reconciles those numbers against the
chains, continuously, in public. This does. It never holds funds.

## What it shows

The TIP-20 factory is permissionless and has produced **~4,500 tokens**, almost
all of them tests with absurd supplies — and several that copy a real symbol
(three tokens call themselves `USDC.e`). So the monitor works in tiers:

- **Universe** — every TIP-20 ever created, discovered from the factory's
  `TokenCreated` events (not a hand-maintained list), plus pathUSD, which is
  a genesis precompile with no creation event. Static metadata is read once
  per token and cached; discovery is incremental and bounded per run.
- **Recognized** — tokens with a public issuer attestation (Bridge), a market
  listing on Tempo (DefiLlama), or a bridged major pinned **by address**
  (USDC.e, USDT0, EURC.e). These get live supply, cap, pause state, flows,
  checks, and hourly history.
- **Active** — any other token that moved in the last ~90 minutes (found with
  one unfiltered `Transfer` log query), shown live but marked as such.
- **Look-alikes** — a symbol's recognition goes to the token whose live
  supply is *consistent with a reference figure*: the issuer's own total is a
  hard upper bound (+1%), the market's Tempo figure a soft one (2×, since
  DefiLlama lags a day and a young coin can grow fast). Never "largest supply
  wins" — the factory already holds a lone `USDT` with a $1B supply, and it is
  held to the same test as a crowd. Everything else sharing the symbol loses
  symbol-bound recognition and carries a red "not the asset its symbol names"
  check. Same-ticker DefiLlama coins with no Tempo leg are treated as
  different assets (Sky's USDS is not Arq's USDS on Tempo).
- **Per token**: on-chain supply (Tempo + other chains via DefiLlama for
  multi-chain coins like OUSD), issuer-reported supply and reserves, reserve
  breakdown, a 24-h-extrapolated flow sample (transfers/day, volume/day, share
  with memos, minted/burned), and a status chip.
- **Checks**, each a sentence that should hold, red with the gap in dollars
  when it doesn't, grey when there is no data (never "fine"):
  1. issuer reserves ≥ issuer supply
  2. issuer supply = on-chain supply (across all chains for multi-chain coins)
  3. issuer reserves ≥ on-chain supply
  4. issuer feed updated within 24 h
  5. issuer's breakdown sums to its total *(it often doesn't — the breakdown
     appears to describe a pooled account; shown as grey "cannot verify the
     composition" with the numbers, not as a failure, since checks 1–3 use the total)*
  6. supply within on-chain cap · 7. not paused
- **History** — hourly points per token: supply vs reserves, sparkline.

Tolerances: 0.01% for single-chain comparisons (pathUSD reconciles to the
micro-unit), 0.1% across chains (DefiLlama pricing/timing).

## Data sources

| Source | What | Auth |
|---|---|---|
| `rpc.tempo.xyz` | supply, metadata, factory + token logs | none (rate-limited; the client backs off) |
| `transparency.bridge.xyz/v0/stablecoins/{slug}` | issuer supply, reserves, breakdown, `last_updated` | **none** — public |
| `stablecoins.llama.fi` | other-chain legs for multi-chain coins | none |

Issuer coverage today = Bridge-issued coins (OUSD, USDB, pathUSD, DLUSD, …).
USDC.e / USDT0 and others show as *unattested* until a public source exists.

## Run

The same code runs two ways: as a plain Node process (container / systemd —
how it is deployed, at `https://reserves.a9n9.net`) or as a Cloudflare Worker
with KV and a cron. `src/app.ts` is the shared surface; `server.ts` and
`worker.ts` are adapters.

```sh
# unit tests (pure)            / live integration (network)
npx vitest run --root apps/reserves test/units.test.ts
LIVE=1 npx vitest run --root apps/reserves test/live.test.ts

# Node process: state is a directory of JSON files, schedule is in-process.
# On first boot with an empty DATA_DIR it seeds itself from tip20-registry.json.
cd apps/reserves && npm run build
PORT=8790 DATA_DIR=./data REFRESH_TOKEN=$(openssl rand -hex 24) npm start

# container (what the home server runs; compose file in this directory)
docker compose up -d --build        # → http://localhost:8790 ; state in ./data ; REFRESH_TOKEN in ./.env

# local preview with Miniflare (no Cloudflare login needed)
cd apps/reserves
npx wrangler kv namespace create RESERVES            # once; paste the id into wrangler.toml
node scripts/seed-registry.mjs tip20-registry.json registry > /tmp/kv-registry.json
node scripts/seed-registry.mjs tip20-registry.json meta     > /tmp/kv-meta.json
npx wrangler kv key put registry --binding RESERVES --local --path /tmp/kv-registry.json
npx wrangler kv key put meta     --binding RESERVES --local --path /tmp/kv-meta.json
echo 'REFRESH_TOKEN=dev-token' > .dev.vars              # gitignored
npx wrangler dev                                      # http://localhost:8787
curl -X POST -H 'Authorization: Bearer dev-token' localhost:8787/v1/refresh   # then watch /healthz → lastRun

# production (same seeding without --local, then)
npx wrangler login
npx wrangler secret put REFRESH_TOKEN
npx wrangler deploy                                   # cron refreshes every 10 min
```

A full run over the seeded registry takes ~6 s in Node and ~15 s in
Miniflare, peaks around 45 MB of heap, and makes ~110 RPC calls — well inside
a Worker's limits.

### Production (home server)

`~/reserves/docker-compose.yml` on the Ubuntu box builds from this directory,
publishes `0.0.0.0:8790`, bind-mounts `./data`, and reads `REFRESH_TOKEN` from
`./.env` (mode 600, not in git). Public HTTPS is the household's existing
Cloudflare Tunnel (`home-30`, ingress managed remotely from the Mac):
`reserves.a9n9.net → http://10.0.1.101:8790`, plus a proxied CNAME to the
tunnel. Cloudflare terminates TLS; the origin sees plain HTTP. To ship a
change: `git pull` in `~/source/picocash`, then `cd ~/reserves && docker
compose up -d --build`. Logs: `docker compose logs -f`. Health:
`/livez` (process up) and `/healthz` (has a snapshot; `lastRun` shows the
last refresh's outcome and timing).

Seeding the registry once offline matters: the first full factory scan is
~470 log queries plus metadata for every token, more than one cron invocation
should spend on a rate-limited public RPC. After seeding, discovery is
incremental from `lastScannedBlock`.

## API

- `GET /v1/tokens` — latest snapshot (all tokens, checks, flows, issuer data, errors)
- `GET /v1/tokens/:address` — one token
- `GET /v1/history/:address` — hourly points, up to 90 days
- `GET /healthz` — 200 once a snapshot exists; includes registry size and `lastRun`
- `GET /livez` — process is up (container healthcheck)
- `POST /v1/refresh` (`Authorization: Bearer $REFRESH_TOKEN`) — force a refresh

Amounts are strings in micro-units (6 decimals) — no floats on money.

Not financial advice. A monitor, not a guarantee: it reconciles published
numbers; it cannot see inside a bank account.
