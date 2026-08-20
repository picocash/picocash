picocash — Architecture Plan
Chaumian ecash for machine payments: private, instant bearer tokens with no per-payment on-chain fee backed 1:1 by USDC.e on Tempo, integrated with MPP (https://mpp.dev) as a custom payment method. Owner: Arun (solo). Domains: picocash.dev (docs/spec), picocash.app (reference mint). Sister project: agent-factory / a9n9.net, which becomes the first service to accept picocash.
Why this exists (settled strategy — don't relitigate)
Tempo settlement is transparent; an agent's transaction graph is strategy leakage. picocash adds the privacy layer: the mint cannot link issuance to redemption (blind signatures), and service operators see valid tokens, not payer identity.
Positioning to Stripe/Tempo: volume-ADDITIVE to MPP. Mint deposits and periodic net settlement still land on Tempo. picocash is a complement, not a competing rail.
Business model: open-source protocol + SDK; revenue via cloud-operator model (run mints for businesses/communities) + consulting. Arun's own reference mint stays small-value showcase ONLY (see Regulatory).
Coupling: a9n9 free tier issues picocash credit tokens; every free user exercises the ecash rails. The freemium ladder IS the adoption funnel.
Prior art (adapt, don't fork)
Cashu NUTs are the closest spec family: BDHKE blind signing (NUT-00), keysets (NUT-01/02), swap (NUT-03), mint/melt quotes (NUT-04/05), DLEQ proofs (NUT-12). picocash diverges: EVM/USDC.e-denominated (not Lightning), vault-contract backing on Tempo, and an MPP payment-method binding instead of Lightning invoices. Read Cashu specs for the crypto; do not import Lightning assumptions.
Components
1. Crypto core (packages/crypto) — BUILD FIRST
Blind Diffie-Hellman Key Exchange on secp256k1 via @noble/curves.
hash_to_curve(secret) -> point Y (domain-separated, per Cashu NUT-00 method for compatibility of audit surface)
Client: blind B_ = Y + rG; Mint: sign C_ = kB_; Client: unblind C = C_ - rK. Token = (secret, C) against mint pubkey K.
DLEQ proof on every signature (NUT-12 style) so clients can verify the mint used the advertised keyset key WITHOUT contacting the mint — required for offline token transfer between agents.
Deliverable: library + published test vectors (test vectors are a reputation artifact; other implementers will use them).
This is the current prototype priority (DLEQ + hash-to-curve first).
2. Vault contract (contracts/) — Solidity, Foundry, Tempo
Holds USDC.e backing 1:1 for outstanding tokens. Prior v0.2-draft interface is the starting point; harden it:
deposit(amount, mintQuoteId): pulls USDC.e (TIP-20 0x20C0000000000000000000000000000000000000 on mainnet; confirm current addr), emits event the mint watches to release blind signatures.
withdraw(to, amount, meltId): mint-operator-signed release for melts.
Invariant: vault balance >= outstanding token supply per keyset. Publish outstanding supply on-chain per epoch -> anyone can verify solvency. "Proof of liabilities" beats "trust me."
Timelocked operator key rotation; pausable deposits (never pausable withdrawals — users must always be able to exit).
Use transferWithMemo pattern (as a9n9 does) so deposits bind to mint quotes via memo.
3. Mint server (packages/mint) — TypeScript + Hono + Postgres
HTTP API (v0.2-draft spec is the base):
GET /v1/info — mint metadata, keysets, limits
GET /v1/keys[/{keyset}] — active keyset pubkeys per denomination
POST /v1/mint/quote — quote: amount -> vault deposit instructions
POST /v1/mint — blinded messages + proof of deposit -> blind sigs
POST /v1/swap — spend proofs, receive new blind sigs (change, denomination management, token refresh)
POST /v1/melt/quote — tokens -> USDC.e withdrawal quote
POST /v1/melt — burn proofs, trigger vault withdraw
POST /v1/checkstate — spent/unspent check (Y values, not secrets) Postgres: spent-secrets table (the double-spend ledger — UNIQUE on Y, insert-before-sign inside one transaction; this table is the entire security model at runtime), keysets, mint/melt quotes, vault event log. Monthly partitions on spent-secrets if volume warrants (meter_data pattern). Denominations: powers of 2 in base units (1, 2, 4 ... USDC.e 6-decimals). Keyset rotation: new keyset per epoch; old keysets accept swap-only for a grace window, then redeem-only, then archived.
4. MPP payment method (spec/ + packages/mppx-method)
The method spec is a public deliverable on picocash.dev.
Challenge (method: "picocash"): realm, amount, currency (mint URL + keyset id stand in for token address), mint allowlist, challenge id/nonce, expiry.
Credential: serialized token bundle (proofs summing to amount) bound to the challenge nonce — bind by requiring secrets to commit to the challenge id (P2PK-style tag or secret format), so intercepted credentials can't be replayed elsewhere.
Receipt: server's redemption acknowledgment incl. mint checkstate ref.
Server side verifies OFFLINE via DLEQ (is this a valid token from an allowlisted mint?) then redeems/swaps at the mint async. Accept-then- settle gives sub-100ms payment acceptance — the headline demo number.
Implement as an mppx custom method (mppx exposes the interface; consult the MPP docs MCP server: claude mcp add --transport http mpp https://mpp.dev/api/mcp).
5. Client SDK (packages/sdk)
Wallet-lite for agents: mint quote -> deposit (push mode, reuse a9n9's prebuilt-transaction pattern) -> blind -> store tokens; pay(challenge) -> select proofs -> bind -> emit Credential; swap for change; melt to exit. Token storage is caller's responsibility; SDK stays stateless-capable.
6. Reference deployment + a9n9 integration
picocash.app runs the reference mint. HARD CAPS: per-wallet and global outstanding limits (e.g. $5 / $500) — showcase, not a bank.
a9n9 gate adds "picocash" to accepted methods next to tempo.
a9n9 free tier: registration mints N credit tokens from a dedicated zero-backed "credits" keyset (distinct keyset = credits are not USDC.e-redeemable, only service-redeemable — cleanly separates promo credits from backed money, which also sidesteps a chunk of regulatory surface). Each free call redeems one credit token.
Security musts
Insert-then-sign on spent-secrets (double-spend); no signing outside the DB transaction.
Mint private keys: encrypted at rest, never in code/manifests/logs; derive per-denomination keys from one keyset seed (HD-style).
DLEQ on every issuance; publish keysets with expiry.
Rate-limit /v1/mint per depositor address; melt requires no identity (that's the point) but per-request size caps apply.
Solvency: on-chain outstanding-supply publication per epoch.
All amounts in base units (integers) end to end; no floats anywhere.
Regulatory guardrail (non-negotiable)
Operating a custodial mint at scale = money-transmission exposure. The reference mint stays under strict small-value caps and is labeled a technology demonstration. The commercial path is CLOUD OPERATOR: the customer entity holds the vault funds and redemption liability; picocash (Arun) operates software. Never take custody of a customer mint's backing funds. Credits-keyset tokens (non-redeemable for money) are the preferred free-tier instrument for the same reason.
Repo layout
picocash/ README.md # leads with MPP-method story + headline demo LICENSE # Apache-2.0 SECURITY.md # disclosure contact CONTRIBUTING.md spec/ # protocol + MPP method spec + TEST VECTORS # (published to picocash.dev; version-bump before code) packages/crypto # BDHKE, hash-to-curve, DLEQ packages/mint # Hono server packages/sdk # agent wallet-lite packages/mppx-method contracts/ # Foundry: vault apps/wallet-demo # static HTML wallet: mint / melt / transfer (step 6) apps/reference # picocash.app deployment config
Stack
TypeScript, @noble/curves + @noble/hashes (audited, zero-dep), Hono, Postgres (pg-boss if async jobs needed), Foundry for Solidity, viem for chain interaction. Same conventions as agent-factory. Nights are scarce: nothing novel in infra.
Build order (do not reorder — launch-oriented, public from day one)
The repo is PUBLIC from step 1. Rationale for the ordering: the crypto core is the heart and gets proven first; the mint runs against a fake vault so the Solidity (most expensive layer to change) is written last against a running, proven interface; the MPP method spec is in the repo from day one because it is the differentiator (without it this reads as a Cashu clone); community asks are staged — spec feedback early when input is cheap to incorporate, participation asks only once something runs.
Public GitHub repo (org name must match picocash.dev/.app — verify spelling before anything links to it) + README + spec/ skeleton including the MPP payment-method spec DRAFT + launch hygiene: Apache-2.0 LICENSE, SECURITY.md with disclosure contact, CONTRIBUTING.md, and a "status: pre-alpha, spec under RFC" banner. README leads with the MPP-method story and the headline demo definition, NOT the Cashu-adjacent internals.
crypto core + published test vectors (DLEQ, hash_to_curve, blind/unblind round-trip) — pure library, no network. Test vectors live in spec/, versioned, referenced from README: they are a first-class public artifact and the participation magnet for second implementers. CURRENT STEP.
STAGE-ONE COMMUNITY POST: spec RFC to the Tempo community forum and mpp-specs discussions. Framed as request-for-comment on the method spec — asking for design feedback, not contribution.
Mint server minimal: keysets, mint/swap/checkstate against a FAKE vault (in-memory deposit oracle). Double-spend tests including concurrent redemption races.
Vault contract on Tempo testnet + real deposit watching; melt path. Interface is dictated by the already-running mint, not guessed.
HTML wallet demo (static page, viem + SDK) against the testnet mint: mint, melt, and transfer, human-clickable. This is the human-legible launch artifact.
STAGE-TWO COMMUNITY POST: participation ask to Tempo community, demo link first. "Here's a working thing, come extend it" — never ask for participation from an empty repo.
MPP method implementation (mppx custom method); pay a local echo service end to end with tokens.
a9n9 accepts picocash on one service; credits keyset + free tier.
Reference mint to mainnet behind caps; spec + test vectors published to picocash.dev; announcement post (the machine-side demo — a9n9 accepting picocash — completes the story).
Definition of the headline demo
An agent deposits $1 USDC.e once, receives tokens, then makes 20 paid a9n9 calls with sub-100ms payment acceptance, no on-chain tx per call, and the service operator never learns the payer address. That demo is the Stripe pitch, the mint-customer pitch, and the launch post, in one.
Conventions
No secrets/keys in code, manifests, or this file.
Every API error tells the calling agent how to recover (a9n9 standard).
Spec changes version-bump spec/ before code changes implement them.

