# CLAUDE.md — picocash

Orientation for agents working in this repo. Facts here are the ones you cannot derive from the code or git log. `architecture.md` is the authoritative design doc; its strategy and build order are settled — do not relitigate.

## What this is

Chaumian eCash for AI-agent payments, backed 1:1 by a TIP-20 stablecoin on Tempo, shipped as an MPP `charge` payment method. Owner: Arun (`starbackr-dev`, solo). Four repos, all under the `picocash` GitHub org, all Apache-2.0:

| Repo | Local path | Contents |
|---|---|---|
| `picocash/picocash` (this) | `~/source/picocash` | `packages/crypto` (BDHKE, DLEQ, P2PK), `packages/mint` (Hono mint + Cloudflare Worker), `packages/sdk` (stateless wallet), `packages/mppx-method` (acceptor + agent + mppx binding), `apps/wallet-demo`, `spec/` (post drafts only) |
| `picocash/picocash-contracts` | `~/source/picocash-contracts` | Foundry: `PicocashVault` (v3), `PicocashVaultFactory`, `src/emergency/*` on-chain proof verifier |
| `picocash/pips` | `~/source/pips` | The specs, PIP-00 … PIP-08, with test vectors. Code and docs cite PIP numbers. |
| `picocash/picocash.dev` | `~/source/picocash-website` | Static site (`index.html`, `demo/`), GitHub Pages |

Terminology is fixed: **mint** = off-chain server that issues eCash; **vault** = on-chain custody (provably cannot mint); **factory** = vault deployer. Don't blur them.

## Commands

```sh
npm install && npm run build          # from repo ROOT — `npm run build -w packages/mint` silently no-ops inside the package
npm test                              # mint tests run serially (PGlite instances OOM in parallel)
npm run dev -w @picocash/mint         # local mint; PICOCASH_VAULT=tempo|fake selects the oracle
npm run deploy:cf -w @picocash/mint   # Cloudflare Worker → https://mint.picocash.dev (run build first)
cd ~/source/picocash-contracts && forge test   # 38 tests; solc pinned 0.8.35, via_ir — don't change (verification surface)
```

Scripts in `packages/mint/scripts/`: `setup-testnet.ts` (fresh keys), `publish-solvency.ts` (attestation; cron every 10 min locally and on the Worker), `register-keyset.ts` (after any keyset change — emergency redemption needs it), `emergency-redeem.ts` (holder CLI), `testnet-e2e.ts`.

Git identity is not configured globally here: `export GIT_AUTHOR_NAME=Arun GIT_AUTHOR_EMAIL=arun@flext.energy GIT_COMMITTER_NAME=Arun GIT_COMMITTER_EMAIL=arun@flext.energy` before committing. Commit and push only when asked. In multi-repo shell blocks, `cd` explicitly before every git command.

## Live deployments (Tempo Moderato, chain 42431)

- RPC `https://rpc.moderato.tempo.xyz` (Worker uses a keyed Conduit RPC in secret `PICOCASH_TEMPO_RPC`); explorer `https://explore.testnet.tempo.xyz`; pathUSD `0x20c0…0000` (6 decimals); faucet proxied at `/dev/faucet`.
- Factory v3 `0xE49A8fEA32448bd7cBFF7Aa0A3509e473D4CC377`, shared verifier `0x7b64972Dd8027f64a2186E5831272774e2f0eC84`.
- Hosted vault `0x4380094eeEF8AB12B868bFBB46c7e7B90a713a83` ↔ `https://mint.picocash.dev` (status page at `/`, `GET /v1/status`). Dev vault `0xA46E150426959dbd40A3bAD372C8ABbBE57b8396` ↔ local mint.
- Every earlier vault is RETIRED on-chain (`setMintInfo("RETIRED …")`, deposits paused). Do this for any future migration too.
- Verification: `forge verify-contract` falsely reports "already verified" on Tempo; POST std-json to the Sourcify v2 API with `"0.8.35+commit.47b9dedd"`. Upload custom selectors to OpenChain after deploys.

Secrets live in gitignored files only: `packages/mint/.env` (dev mint + deployer), `packages/mint/.env.hosted` (hosted identity). Worker secrets are set with `wrangler secret put`. Never commit, print, or paste them.

## Settled design decisions (don't reopen)

- Unit = `tip20:<chain_id>:<token_address>`; keyset ids derive from it; one vault per currency; mint refuses to start if `vault.token()` ≠ unit.
- Deposits are `transferWithMemo(vault, amount, quoteId)`; the memo is **indexed** on Tempo — a non-indexed ABI makes deposits vanish silently.
- Spent-secret ledger is insert-before-sign in one transaction. DLEQ on every signature; nonce = `HMAC(k, "picocash-dleq-nonce"||B_)`.
- Melt: melter pays the payout gas as a flat fee (`PICOCASH_MELT_FEE`, ≤ vault `maxMeltFee`); burn-before-pay with durable `OWED` + same-inputs retry; vault enforces one payout per melt id.
- MPP method (`picocashCharge`) is **settle-first by default**; `mode:'accept-then-settle'` is explicit opt-in. Replay state sits behind `AcceptorStore`; `MemoryAcceptorStore` is single-instance only (Postgres store is a TODO).
- P2PK (PIP-08): BIP-340 witness over `sha256(secret)`; enforced on swap and melt; proofs locked to the service's `challenge.pubkey` count as bound. `SIG_ALL`/HTLC deferred.
- Vault v3 custody = *slow, visible, rate-limited, escapable*: timelocked ops, on-chain attestation policy, withdrawal breaker (latches → emergency mode), `emergencyRedeem` with on-chain DLEQ/P2PK verification capped at last attested outstanding. Known limits are in `SECURITY.md` — keep that table current when anything changes.
- Cloudflare DO keeps stale config across deploys → it aborts itself when env `PICOCASH_DEPOSIT_ADDRESS` ≠ config. In the DO, never touch `this` before `super()`.

## Wording rules for anything public

- Say **eCash**, never "Cashu", in positioning copy (README lead, site, posts). Attribution to Cashu NUTs belongs in PIP-00 and test-vector provenance only. (Open question with Arun: README "Relationship to Cashu" section and the PIP-08 header still name it.)
- "~47 ms" (latest measurement) = **merchant-side offline verification**, never "payment latency".
- "operator-attested liabilities", not "proof of liabilities". "Payouts are never contract-pausable" (operator liveness caveat). "No per-payment on-chain fee", not "feeless". "Designed to be backed 1:1", not "backed 1:1". The breaker **rate-limits**; it does not bound total loss.
- Headline phrasing is "for AI agent payments". Never claim auto-exit; unilateral exit (emergency redemption) is live and may be claimed.
- Buzz (Block) uses "mint" for persona cards — in Buzz-facing copy say "the picocash mint service".

## Where things stand (2026-10-31)

- **Standards track is closed-for-now, by adoption not design.** mpp-specs PR #342 and issue #327 were closed 2026-10-25 ("network too small … upstream later once it gets more popularity"). Do not reopen or re-argue. The method draft (`draft-picocash-charge-00`) lives on in our fork branch; traction is the path back.
- **Adoption vectors, both live:** (1) AgentCash — fork `starbackr-dev/agentcash-router@add-picocash-method` adds picocash as a third MPP charge mode, verified E2E, consumes the published npm packages, mergeable; Merit issue #324 open, nudged 2026-10-31, awaiting reply. (2) **Buzz agent wallet — built.** See below.
- **npm:** `@picocash/{crypto,sdk,mppx-method}@0.1.0` published (owner npm user `starbuilder`, org `picocash`; release steps in memory `npm-packages`). **Not yet published:** `@picocash/mcp`, and `@picocash/sdk` has grown new exports since 0.1.0 (nostr, store, engram, nip44, relay) — a coordinated 0.2.0 release is needed before `npx @picocash/mcp` works as the README claims. Arun's call.
- **Buzz wallet (plan `~/.claude/plans/modular-munching-spindle.md`) — implemented end to end, all in-process tested:** `packages/sdk` nostr adapter (parity-robust `signerFromNsec`), `ProofStore` (reserve→commit|release) with file + NIP-AE engram backends (byte-exact vs Buzz's pinned vectors), `packages/mcp` (`picocash-mcp` stdio server, six tools; `picocash-owner` reads an agent's wallet with the owner key), `apps/paid-llm` (OpenAI-compatible proxy charging picocash per request, underpay guard, merchant-locked budgets). Spec: `pips/PIP-09`. **Not yet done:** smoke test against a *real* Buzz relay (needs a relay URL + member nsec from Arun; this box has no Buzz install), running under `buzz-acp`/Hermes, a live-inference run (no provider API key on this box), treasury agent (phase 2).
- **Direction change (2026-10-31, after Tempo usage research — memory `tempo-market-research`):** Tempo is an enterprise payout rail (~$500/tx, 39% memo transfers; MPP agent volume ≈ $1.6K total). Agent eCash is PARKED. New priority #1 is **`apps/reserves`** — an independent TIP-20 stablecoin reserve/supply reconciliation monitor (Bridge public transparency feed + DefiLlama vs on-chain), **running as a container on this box** (`~/reserves/docker-compose.yml`, port 8790, state in `~/reserves/data`, secret in `~/reserves/.env`); **live at https://reserves.a9n9.net** via the household Cloudflare Tunnel (ingress + DNS are managed from Arun's Mac session, not here). Cloudflare Workers is NOT used for new sites (daily limits). Ship changes with `git pull` + `docker compose up -d --build`. See its README and memory `tempo-reserves-monitor`. Priority #2, not started: memo-attributed payout reconciliation for payout fintechs.
- **Known product constraint:** merchant-locked budgets pay only exact subset-sums (agent can't re-denominate them) → fund in units of the merchant's prices; wallet falls back to open balance otherwise. Protocol fix proposed in PIP-08 open questions (lock-preserving unsigned re-denomination).
- Mainnet: `spec/mainnet-plan.md` (reviewed; gates = legal, audit of custody AND issuance, mint signing-key custody). Deferred: a9n9 + credits keyset, Base port.
- Housekeeping for Arun: re-add `_github-pages-challenge-picocash` TXT in Cloudflare DNS; confirm SSL Full (strict); rotate the Conduit RPC key; the hosted mint's solvency cron lapsed once (republished manually 2026-09-15) — check the Worker cron.

## Local-environment quirks

- This box's resolver caches old Squarespace IPs for `picocash.dev` — use `curl --resolve mint.picocash.dev:443:<cf-ip>` or Chromium `--host-resolver-rules`.
- Headless browser checks: `playwright-core` gets pruned by `npm install`; reinstall with `--no-save`; cached `headless_shell` in `~/.cache/ms-playwright`.
- `pkill` returning 144 aborts `&&` chains — run follow-ups as separate commands.
- Memory for this project lives in `~/.claude/projects/-home-ubuntu-source-picocash/memory/` — read `MEMORY.md` there first; it is keyed to this exact path.
