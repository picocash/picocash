# @picocash/mcp

A picocash wallet as an **MCP server**: lets any agent hold and spend eCash with
the Nostr key it already has. Built for [Buzz](https://github.com/block/buzz)
agents — every one of them boots with `BUZZ_PRIVATE_KEY` and no payment rail —
but it works under any MCP host (Claude Code, goose, Codex, Hermes).

The idea in one line: instead of putting an API key in your agent's
environment, **fund it with a budget** — tokens locked to the agent's npub,
refundable to you after a locktime. The agent can spend only that, only where
you allowed, and only until then. The bound is cryptographic, not policy.

## Run

```sh
BUZZ_PRIVATE_KEY=nsec1…            # the agent's Nostr key (nsec or 32-byte hex) — already set by Buzz
PICOCASH_MINT_URL=https://mint.picocash.dev
npx @picocash/mcp
```

Wallet storage, pick one:

| Mode | Env | What it means |
|---|---|---|
| **engram** (recommended on Buzz) | `BUZZ_RELAY_URL`, `PICOCASH_OWNER_PUBKEY` (owner npub) | Proofs live as a NIP-AE memory record on the agent's relay, encrypted to the owner⇄agent key. The relay sees ciphertext; **the owner can read the wallet with their own key**; the wallet follows the agent across harnesses and restarts. |
| file | `PICOCASH_STORE=file`, `PICOCASH_WALLET_FILE` (default `~/.picocash/wallet.json`) | Local JSON, atomic writes, owner-only mode. For non-Buzz agents. |
| memory | `PICOCASH_STORE=memory` | Tests and throwaway sessions. |

If both `BUZZ_RELAY_URL` and `PICOCASH_OWNER_PUBKEY` are present, engram is chosen automatically.

### Wire into a host

**Buzz (`buzz-acp`)** — point `BUZZ_ACP_MCP_COMMAND` at a script that execs `npx @picocash/mcp`; the harness already passes `BUZZ_PRIVATE_KEY` and `BUZZ_RELAY_URL` to the agent process.

**Claude Code / goose / any MCP config:**
```json
{ "mcpServers": { "picocash": {
  "command": "npx", "args": ["@picocash/mcp"],
  "env": { "BUZZ_PRIVATE_KEY": "nsec1…", "PICOCASH_MINT_URL": "https://mint.picocash.dev", "PICOCASH_STORE": "file" } } } }
```

## Tools

| Tool | What the agent does with it |
|---|---|
| `balance` | What it can spend now; anything reserved by an in-flight payment; anything held but locked to someone else. |
| `fetch_paid(url, …)` | Fetch a URL; if it answers `402` with a picocash challenge, pay from the wallet and return the paid response, receipt, and cost. Settle-first: `success` only after the mint swap. No on-chain tx, no payer address. |
| `send(amount, to_npub, locktime?, memo?)` | Make a token **locked to the recipient's npub** — safe to paste anywhere. Refuses an unlocked bearer token unless `unlocked: true` is passed explicitly. |
| `receive(token \| link)` | Claim a token: verify offline, unlock with this key if it was locked to us, swap to fresh proofs. |
| `melt(amount, to)` | Withdraw to an on-chain address. |
| `history(limit?)` | The ledger, newest first, signed deltas. |

Amounts are integer base units of the mint's unit (`10000` = $0.01 for a 6-decimal stablecoin).

## The owner-funds-agent flow

1. **Owner** mints eCash and `send`s it locked to the agent's npub with `locktime` = end of budget and the refund key = owner (any wallet can do this; the owner's own `@picocash/mcp` or the browser demo).
2. **Agent** `receive`s it. Its balance is the budget. Stored in its engram; the owner can read it any time.
3. **Agent** works: `fetch_paid` answers 402s — no vendor key anywhere in its environment.
4. Budget exhausted → agent stops. Key stolen → attacker gets at most the remainder, until the locktime.
5. **Owner** reclaims leftovers with the refund key after the locktime. No agent cooperation needed.

## Safety properties worth knowing

- **Crash-safe spends.** Every payment is `reserve → commit | release` on the store, persisted before anything leaves the wallet. A crash mid-payment leaves a reservation to reconcile (via the mint's `checkstate`), never a silent loss.
- **Two sessions, one agent.** The engram store detects a concurrent writer and refuses (`ConflictError`) rather than overwrite the other session's spend.
- **Parity-correct signing.** Locks derived from an npub are `02`+x; about half of Nostr keys have odd Y. This wallet signs by x-only coordinate, so owner-funded tokens work for every key. (Using `signProofs` from the SDK directly would silently skip odd-parity keys.)
- **Key = identity = wallet.** Whoever holds the nsec spends. That is the Buzz model; the mitigation is the lock model itself — small, time-boxed, merchant-restricted budgets.

Testnet only today (Tempo Moderato, pathUSD has no value). Pre-alpha, unaudited.
