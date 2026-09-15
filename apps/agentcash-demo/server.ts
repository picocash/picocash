/**
 * A paid API in the AgentCash-router shape — but accepting picocash eCash.
 *
 * The point of the demo: picocash is a normal `mppx` method. The server wires
 * it into `Mppx.create({ methods: [...] })` exactly as @agentcash/router does
 * in `src/init/mppx.ts` (which today lists `tempo.charge` / `tempo.session`),
 * then gates a route with the resulting Hono middleware. Nothing here is
 * picocash-router glue — it is the same substrate their 1,000+ endpoints run on.
 *
 *   npx tsx apps/agentcash-demo/server.ts     # from the repo root
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Mppx } from 'mppx/hono';
import { Wallet } from '@picocash/sdk';
import { PicocashAcceptor } from '@picocash/mppx-method';
import { charge } from '@picocash/mppx-method/mppx';

const MINT_URL = process.env.MINT_URL ?? 'https://mint.picocash.dev';
const PORT = Number(process.env.PORT ?? 8402);
const PRICE = process.env.PRICE ?? '0.01'; // dollars; charge() converts to base units
// mppx requires a >=32-byte challenge-signing secret. Demo-only; rotate in prod.
const SECRET_KEY = process.env.MPP_SECRET_KEY ?? 'picocash-agentcash-demo-secret-key-32b+';

const FORTUNES = [
  'A bearer token in a log file is worth nothing to the finder.',
  'The mint that cannot link issuance to redemption keeps your strategy yours.',
  'One deposit, many payments; the chain sleeps between calls.',
  'Verify offline, settle once, reveal no address.',
];

// The service wallet receives the swapped proofs at settlement. It needs no
// balance of its own — a swap is even-value.
const serviceWallet = new Wallet({ mintUrl: MINT_URL });
const keyset = await serviceWallet.getKeyset();
const [, chainId, currency] = keyset.unit.split(':');
console.log(`[server] mint ${MINT_URL} · keyset ${keyset.id} · unit ${keyset.unit}`);

const acceptor = new PicocashAcceptor({
  realm: `localhost:${PORT}`,
  mints: [{ url: MINT_URL, keyset }],
});

// Identical construction to @agentcash/router's getMppxRequestContext:
// a methods array, a secretKey, a realm. picocash is just another entry.
const mppx = Mppx.create({
  methods: [
    charge({
      acceptor,
      wallet: serviceWallet,
      currency: currency!,
      chainId: Number(chainId),
      mints: [{ url: MINT_URL, keysetIds: [keyset.id] }],
      onAccepted: (r) =>
        console.log(`[server] settled ${r.challenge_id.slice(0, 12)}… · ${r.settlement} · ref ${r.checkstate_ref ?? '—'}`),
    }),
  ],
  secretKey: SECRET_KEY,
  realm: `localhost:${PORT}`,
});

const app = new Hono();
app.get('/', (c) => c.json({ service: 'picocash fortune', price: PRICE, unit: keyset.unit, pay: 'GET /fortune' }));
app.get('/fortune', mppx.charge({ amount: PRICE }), (c) =>
  c.json({ fortune: FORTUNES[Math.floor(Math.random() * FORTUNES.length)], paid: PRICE, unit: keyset.unit }),
);

serve({ fetch: app.fetch, port: PORT }, (info) =>
  console.log(`[server] paid fortune API on http://localhost:${info.port}/fortune (price ${PRICE} ${keyset.unit})`),
);
