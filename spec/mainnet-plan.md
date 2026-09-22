# picocash: testnet → Tempo mainnet plan

Status: draft 2026-09-01. Target chain: Tempo mainnet, chain id **4217** (verified via `cast chain-id` against `rpc.tempo.xyz`). Everything below assumes the current stack: vault v3 + factory (Sourcify-verified on Moderato), Cloudflare Worker/DO mint at mint.picocash.dev, PIP-00…08, RFC #327 / PR #342 open.

The ordering principle: **gates before code, code before deploy, deploy before traffic, caps before growth.** Real dollars change the failure modes, not the architecture.

---

## Phase 0 — Go/no-go gates (nothing else matters until these pass)

**0.1 Legal.** A picocash mint custodies customer USD-stablecoin and issues redeemable claims. In most jurisdictions that is money transmission / e-money issuance (US: state MTL + FinCEN MSB; EU: MiCA e-money). This needs a real legal opinion before any public mainnet mint — options short of full licensing: operate caps-limited as a technology demonstration with own funds only (no third-party deposits), partner with a licensed custodian, or geo-fence. **Decision owner: Arun. No third-party deposits on mainnet until this is answered in writing.**

**0.2 Tempo compliance layer + backing-token properties.** Verify on mainnet, empirically, that: (a) the canonical USDC/USDT TIP-20 contracts allow a permissionless contract (our vault) to receive and send without allowlisting; (b) TIP-403 transfer policies don't block `transferWithMemo` to/from contracts; (c) fees are payable in the same TIP-20 the vault holds (operator gas float = same asset as backing — good). Pin the **exact** USDC contract address on 4217 (not "USDC" generically) and confirm it is **non-rebasing and non-fee-on-transfer** — the vault assumes `balanceOf` tracks deposits 1:1, and either property silently breaks the solvency invariant. Also fix the deposit **confirmation depth** for the mainnet oracle: a deposit credited then reorged out = over-issuance (a listed SECURITY.md gap). Tempo's near-instant finality likely makes this shallow, but state the depth explicitly and confirm finality behaviour here rather than assuming EVM reorg semantics. Test with $10 before believing docs.

**0.3 Security audit.** External audit covering both consequence-critical halves: (i) **custody** — the vault's breaker and emergency redemption with on-chain secp256k1; (ii) **issuance** — `@picocash/crypto` (BDHKE blind signing, DLEQ) and the mint's signing/quote path, where over-issuance bugs live. "Spend path" alone is not enough: a flaw that mints unbacked tokens is the same-consequence class as a flaw in the emergency verifier. Budget/scope now; the audit happens on the exact commit that deploys (phase 2 params frozen first). Interim: a public audit-contest (Sherlock/Code4rena-style) is acceptable for a caps-limited beta; a solo review is not enough for uncapped custody.

**0.5 Mint signing-key custody (the top over-issuance risk).** The `PICOCASH_MINT_SEED` blind-signing key is the most dangerous secret we hold — more than the operator key. Compromise of the *operator* key is bounded by the breaker (≤10%/day of payouts) and visible on-chain. Compromise of the *signing* key is unbounded and invisible: the attacker mints unlimited unbacked tokens and redeems them as an ordinary "holder", which the breaker's rogue-*operator* framing does not catch, and in an emergency those forged tokens compete with real holders for the capped pool. It is also the hard custody problem — BDHKE signing is not a standard KMS/HSM primitive, so this cannot be solved by the same "move the key to a signer service" step as the operator key. **Decision owner: Arun. Before third-party deposits: a written answer for how this key is generated, stored, and rotated, and an explicit statement in SECURITY.md that its compromise is the top over-issuance risk.**

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

Two properties of these numbers to state plainly rather than let the table imply away. **The global cap is enforced mint-side only** — the vault does not know it — so it bounds honest-operator exposure but is void if the mint (or its signing key, 0.5) is compromised; it is a blast-radius limit, not a guarantee. And the **attestation interval is a shortfall window**: between attestations the mint can issue beyond the last attested outstanding, so if the operator vanishes mid-interval those most-recent holders sit above the emergency-redemption cap. The 6 h interval and $1k cap bound the window; it does not vanish.

Then **drill on mainnet with our own money** before any announcement: full mint→pay→melt cycle; breaker trip + timelocked reset on a rehearsal vault; emergency redemption exercised once on a sacrificial vault (as done on Moderato). The drills are the acceptance test for the parameters.

## Phase 3 — Key and ops hygiene

- **Operator key**: moves out of `.env` into an HSM/KMS signer (the Worker calls a signing service; the raw key never lands in Cloudflare env). Deployer key ≠ operator key ≠ sweep destination.
- **Mint signing key** (`PICOCASH_MINT_SEED`, per 0.5): the harder, higher-consequence custody problem — resolve it here per the 0.5 gate, don't let it ride in Worker env. If it cannot be externalised before launch, that is itself a reason to stay in the own-funds-only phase.
- **Gas float**: operator wallet holds a small USDC float for melt payouts and attestations, topped up manually; alert under threshold.
- **Runbooks**: breaker tripped; attestation overdue; mint DB restore; keyset compromise (rotate + pause deposits + public notice); vault migration (retire-and-pause procedure — now scripted, learned on testnet).
- **On-call reality**: solo operator ⇒ the breaker/emergency parameters *are* the on-call rota. That's the honest pitch: the system is designed so holders survive operator absence — say it in the launch post.
- **Disclosure + bounty**: keep `security@picocash.dev` as the intake, and run a standing bug bounty for the caps-limited beta — either a small self-funded reward or the audit-contest platform (0.3) left open. A capped honeypot with a public bounty is a coherent security posture; a capped honeypot with no way to report is not.

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

**The one-sentence version:** the code path to mainnet is short (params + hardening we already know about); the actual gates are legal status, an audit of **both** the emergency path and the issuance path, and custody of the **mint signing key** (not just the operator key) — and until those pass, mainnet means *our own dollars only, capped at $1k*.
