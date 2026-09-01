# picocash: testnet → Tempo mainnet plan

Status: draft 2026-09-01. Target chain: Tempo mainnet, chain id **4217** (verified via `cast chain-id` against `rpc.tempo.xyz`). Everything below assumes the current stack: vault v3 + factory (Sourcify-verified on Moderato), Cloudflare Worker/DO mint at mint.picocash.dev, PIP-00…08, RFC #327 / PR #342 open.

The ordering principle: **gates before code, code before deploy, deploy before traffic, caps before growth.** Real dollars change the failure modes, not the architecture.

---

## Phase 0 — Go/no-go gates (nothing else matters until these pass)

**0.1 Legal.** A picocash mint custodies customer USD-stablecoin and issues redeemable claims. In most jurisdictions that is money transmission / e-money issuance (US: state MTL + FinCEN MSB; EU: MiCA e-money). This needs a real legal opinion before any public mainnet mint — options short of full licensing: operate caps-limited as a technology demonstration with own funds only (no third-party deposits), partner with a licensed custodian, or geo-fence. **Decision owner: Arun. No third-party deposits on mainnet until this is answered in writing.**

**0.2 Tempo compliance layer.** Verify on mainnet, empirically, that: (a) the canonical USDC/USDT TIP-20 contracts allow a permissionless contract (our vault) to receive and send without allowlisting; (b) TIP-403 transfer policies don't block `transferWithMemo` to/from contracts; (c) fees are payable in the same TIP-20 the vault holds (operator gas float = same asset as backing — good). Test with $10 before believing docs.

**0.3 Security audit.** The vault (custody, breaker, emergency redemption with on-chain secp256k1) and the mint's spend path get an external audit. Emergency-redemption math is the highest-consequence code we ship. Budget/scope now; the audit happens on the exact commit that deploys (phase 2 params frozen first). Interim: a public audit-contest (Sherlock/Code4rena-style) is acceptable for a caps-limited beta; a solo review is not enough for uncapped custody.

**0.4 Entity + disclosures.** Terms of service, risk disclosure ("operator-attested liabilities; see SECURITY.md"), privacy policy, and a named legal entity behind mint.picocash.dev. The status page and /v1/info must stop saying "do not use with real funds" only when 0.1–0.3 say so.

## Phase 1 — Code hardening (all shippable now, testnet-verifiable)

1. **Durable acceptor store** (known gap, stated in RFC): Postgres/DO-SQLite `AcceptorStore` with the atomic accept semantics; the memory store demoted to tests.
2. **Mint DB durability**: DO SQLite point-in-time backups + a tested restore runbook; the spent-secrets table is the mint's crown jewels — losing it means over-issuance, corrupting it means frozen funds.
3. **Keyset rotation**: implement and drill rotation (new keyset, old one melt-only, vault `registerKeyset` for both) — rotation liabilities are a listed SECURITY.md gap and mainnet can't wait for a v2 of this.
4. **Abuse controls**: per-IP/quote rate limits, quote TTLs, relay quota; deposit dust threshold.
5. **Config safety**: mint refuses to start if unit ≠ vault token/chain (exists), plus explicit `PICOCASH_NETWORK=mainnet` flag that flips copy, caps, and disables `/dev/*` and faucet paths at compile of config, not by prayer.
6. **mppx schema alignment** (`currency` + `methodDetails.chainId`, standard receipt fields) — ship before merchants integrate, so nobody integrates against the flat testnet shape twice.
7. **Monitoring**: the status page checks re-emitted as alerts (backing drift, attestation freshness, breaker utilisation, DB/chain divergence) to email/phone; a dead-man switch on the solvency cron.

## Phase 2 — Mainnet deployment (parameters are the product)

Deploy the same audited bytecode via the factory; verify on Sourcify (v2 API, exact-match); register keyset; publish first attestation. Proposed launch parameters — deliberately tighter than testnet:

| Parameter | Testnet today | Mainnet launch | Rationale |
|---|---|---|---|
| Backing token | pathUSD (6d) | Canonical USDC on 4217 | confirm address in 0.2 |
| `rotationTimelock` | 2 days | 7 days | custody changes should outlast a long weekend |
| `publishIntervalBlocks` | ~loose | ≈ 6 h of blocks | fresh attestation or deposits close |
| `publishThresholdBps` | 200 (2%) | 100 (1%) | tighter drift tolerance |
| `maxMeltFee` | $0.01 | $0.05 ceiling, fee $0.01 | headroom without repricing custody |
| Breaker `meltLimitBps` / epoch | 5000 / ~1 h | **1000 (10%) / 24 h** | a rogue operator gets ≤10%/day, visibly |
| `emergencyGraceBlocks` | short | ≈ 48 h | operator outage ≠ instant fire drill, but bounded |
| `maxMintAmount` | $100 | **$10 per quote** | beta cap |
| Global outstanding cap (mint-side) | none | **$1,000** | total honeypot ≤ what we'd shrug off |

Then **drill on mainnet with our own money** before any announcement: full mint→pay→melt cycle; breaker trip + timelocked reset on a rehearsal vault; emergency redemption exercised once on a sacrificial vault (as done on Moderato). The drills are the acceptance test for the parameters.

## Phase 3 — Key and ops hygiene

- **Operator key**: moves out of `.env` into an HSM/KMS signer (the Worker calls a signing service; the raw key never lands in Cloudflare env). Deployer key ≠ operator key ≠ sweep destination.
- **Gas float**: operator wallet holds a small USDC float for melt payouts and attestations, topped up manually; alert under threshold.
- **Runbooks**: breaker tripped; attestation overdue; mint DB restore; keyset compromise (rotate + pause deposits + public notice); vault migration (retire-and-pause procedure — now scripted, learned on testnet).
- **On-call reality**: solo operator ⇒ the breaker/emergency parameters *are* the on-call rota. That's the honest pitch: the system is designed so holders survive operator absence — say it in the launch post.

## Phase 4 — Cutover topology and launch

- **URLs**: `mint.picocash.dev` becomes mainnet; testnet moves to `testnet.mint.picocash.dev` (new Worker + DO, same code, `PICOCASH_NETWORK=testnet`). The browser demo stays pointed at **testnet** — faucet flows make no sense on mainnet; add a separate, sober "use with real funds" page later.
- **Website**: split copy — demo/testnet path unchanged; mainnet section leads with caps, status page, SECURITY.md, and the risk disclosure. Kill every "faucet" mention on the mainnet path.
- **Status page**: identical, plus network badge and the global-cap gauge.
- **Launch sequence**: silent (own funds, 2 weeks) → capped beta ($1k outstanding, invite) → raise caps only with audit closed, monitoring quiet, and 0.1 resolved. Announce in #327 as "reference deployment now on mainnet under hard caps" — it strengthens the method draft.

## Explicit non-goals for v1 mainnet

No accept-then-settle mode, no multi-keyset units, no third-party mints in the allowlist, no removal of per-quote caps, no bridging instructions. Each is a separate decision with its own gate.

## Cost estimate (steady state)

Cloudflare Workers paid plan ~$5/mo; mainnet gas: attestations 4×/day + melts, all paid in USDC, expected < $5/mo at beta volume; audit is the real cost item (five figures) — the audit-contest option trades cost for caps.

---

**The one-sentence version:** the code path to mainnet is short (params + hardening we already know about); the actual gates are legal status, an audit of the emergency path, and key custody — and until those pass, mainnet means *our own dollars only, capped at $1k*.
