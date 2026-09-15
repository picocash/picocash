# AgentCash × picocash demo

A standalone demo: an **AgentCash-style agent paying a picocash-gated API**, over
`mppx`, against the live testnet mint at `https://mint.picocash.dev`.

The point is that **picocash is a normal `mppx` payment method**. The server
wires it into `Mppx.create({ methods: [...] })` — the same call
[`@agentcash/router`](https://github.com/Merit-Systems/agentcash-router) makes in
`src/init/mppx.ts`, where it lists `tempo.charge` / `tempo.session`. Adding
picocash there is one more array entry. The agent pays with `mppx`'s
payment-aware `Fetch`, the same client an AgentCash agent uses for tempo/x402.

What it shows, end to end on Tempo Moderato:

- **One on-chain deposit** funds many calls. The agent deposits pathUSD to the
  vault once, then pays per call with **no on-chain transaction on the request
  path** and **no payer address on the wire**.
- **Settle-first**: the server verifies each credential offline, then swaps the
  proofs at the mint before returning `200` with a `settled` receipt.

## Run it

From the repo root (packages must be built: `npm run build`):

```sh
# terminal 1 — the paid API
npx tsx apps/agentcash-demo/server.ts

# terminal 2 — the agent (needs PICOCASH_E2E_PAYER_KEY in packages/mint/.env,
# a faucet-funded testnet wallet; funds one $0.05 deposit)
npx tsx apps/agentcash-demo/agent.ts
```

Sample run (3 calls, one deposit):

```
[agent] minted 50000 tip20:42431:0x20c0…0000 in 2.1s
[agent] call 1: 200 in 897ms
        “A bearer token in a log file is worth nothing to the finder.”
        receipt: settlement=settled ref=UOF4PTeL… amount=10000
        wallet balance: 40000 …
[agent] done — one deposit funded 3 offline-verified calls, no on-chain tx per call.
```

## How the pieces map to the router

| This demo | `@agentcash/router` |
|---|---|
| `Mppx.create({ methods: [charge({…})] })` in `server.ts` | `Mppx.create({ methods: [tempo.charge(…)] })` in `src/init/mppx.ts` |
| `charge()` from `@picocash/mppx-method/mppx` | `tempo.charge` from `mppx/server` |
| `KvAcceptorStore` (Upstash-shaped) for replay | the router's `mpp:`-prefixed KV replay store |
| settle-first (`onAccepted` fires after the mint swap) | the router's `settleBeforeHandler` route flag |

Wiring picocash into the router itself means adding the method to that array and
teaching the MPP settlement strategy to dispatch picocash credentials to the
method's own `broadcast` (rather than tempo's tx/hash/session modes). This demo
is the proof that the method half already works on their substrate.

## Config

| Env | Default | Meaning |
|---|---|---|
| `MINT_URL` | `https://mint.picocash.dev` | Mint both sides use |
| `PORT` / `SERVER_URL` | `8402` / `http://localhost:8402` | Demo server |
| `PRICE` | `10000` | Per-call price, pathUSD base units ($0.01) |
| `FUND_AMOUNT` | `50000` | One-time deposit ($0.05) |
| `CALLS` | `3` | Paid calls the agent makes |
| `PICOCASH_E2E_PAYER_KEY` | — | Faucet-funded testnet key (in `packages/mint/.env`) |

Testnet only, unaudited. pathUSD has no value.
