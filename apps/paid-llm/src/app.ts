/**
 * The paid LLM proxy: OpenAI-compatible `/v1/chat/completions`, gated by a
 * picocash MPP charge (settle-first), forwarding to any OpenAI-compatible
 * upstream with a key the SERVER holds. The agent never sees a vendor key —
 * it sees a 402 and pays it from its budget.
 *
 * Pricing is per request from (model, max_tokens). Because the price is
 * recomputed on the paid retry from the body actually sent, a client cannot
 * obtain a cheap challenge with one body and spend it on a dearer one: the
 * credential's challenge amount is checked against the price of THIS body
 * before the mppx middleware (and therefore before any settlement) runs.
 *
 * The proxy advertises its P2PK public key so an owner can lock an agent's
 * budget to this merchant specifically (PIP-08): those proofs are presented
 * as-is, no swap, and are worthless anywhere else.
 */
import { Hono } from 'hono';
import { Mppx } from 'mppx/hono';
import { Credential } from 'mppx';
import { Wallet, npubFromPubkey } from '@picocash/sdk';
import { PicocashAcceptor, type AcceptorStore } from '@picocash/mppx-method';
import { charge, toBaseUnits } from '@picocash/mppx-method/mppx';
import { p2pkPublicKey } from '@picocash/crypto';
import { loadTiers, priceFor, PricingError, type PriceTier } from './pricing.js';

export interface PaidLlmOptions {
  mintUrl: string;
  /** Public origin used as the MPP realm, e.g. https://llm.example.com */
  realm: string;
  /** ≥32-byte secret for mppx challenge signing. */
  secretKey: string;
  /** OpenAI-compatible upstream base, e.g. https://openrouter.ai/api */
  upstreamUrl: string;
  /** The vendor key — held HERE, never sent to agents. */
  upstreamApiKey: string;
  /** The proxy's P2PK private key (32 bytes). Owners lock budgets to its public key. */
  lockKey: Uint8Array;
  tiers?: PriceTier[];
  acceptorStore?: AcceptorStore;
  /** Injected for tests: routes mint and upstream calls in-process. */
  fetchImpl?: typeof fetch;
  decimals?: number;
}

export async function createPaidLlmApp(opts: PaidLlmOptions) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const decimals = opts.decimals ?? 6;
  const tiers = opts.tiers ?? loadTiers();

  const serviceWallet = new Wallet({ mintUrl: opts.mintUrl, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const keyset = await serviceWallet.getKeyset();
  const [, chainId, currency] = keyset.unit.split(':');
  const realmHost = new URL(opts.realm).host;

  const acceptor = new PicocashAcceptor({
    realm: realmHost,
    mints: [{ url: opts.mintUrl, keyset }],
    lockKey: opts.lockKey,
    ...(opts.acceptorStore ? { store: opts.acceptorStore } : {}),
  });
  const lockPubkey = p2pkPublicKey(opts.lockKey);

  let settled = 0;
  const mppx = Mppx.create({
    methods: [
      charge({
        acceptor,
        wallet: serviceWallet,
        currency: currency!,
        chainId: Number(chainId),
        mints: [{ url: opts.mintUrl, keysetIds: [keyset.id] }],
        pubkey: lockPubkey,
        decimals,
        onAccepted: () => {
          settled++;
        },
      }),
    ],
    secretKey: opts.secretKey,
    realm: realmHost,
  });

  const app = new Hono();

  // Discovery: what to lock budgets to, what things cost, which mint.
  app.get('/v1/info', (c) =>
    c.json({
      service: 'picocash paid-llm',
      realm: opts.realm,
      mint: opts.mintUrl,
      unit: keyset.unit,
      /** Lock budgets to THIS key (33-byte compressed, exactly as advertised in challenges). */
      pubkey: lockPubkey,
      npub: npubFromPubkey(lockPubkey),
      pricing: { tiers, note: 'dollars per request = base + per1k × ceil(max_tokens/1000)' },
      endpoints: ['POST /v1/chat/completions'],
      settled_requests: settled,
    }),
  );

  app.post('/v1/chat/completions', async (c) => {
    const raw = await c.req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: { message: 'body must be JSON', type: 'invalid_request_error' } }, 400);
    }
    let price: string;
    try {
      price = priceFor(body, tiers);
    } catch (err) {
      if (err instanceof PricingError) return c.json({ error: { message: err.message, type: 'invalid_request_error' } }, 400);
      throw err;
    }
    const priceBase = toBaseUnits(price, decimals);

    // Underpay guard: a presented credential must have been issued for THIS
    // body's price. Runs before the mppx middleware, so before any settlement.
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Payment ')) {
      let challengeAmount: string | undefined;
      try {
        const cred = Credential.fromRequest(c.req.raw);
        challengeAmount = (cred?.challenge?.request as { amount?: string } | undefined)?.amount;
      } catch {
        challengeAmount = undefined;
      }
      if (challengeAmount !== priceBase) {
        // Re-dispatch the same request WITHOUT the credential through the app:
        // the route then issues a fresh challenge for the correct price instead
        // of settling the wrong one. Nothing is verified or swapped on this path.
        const headers = new Headers(c.req.raw.headers);
        headers.delete('authorization');
        const fresh = await app.fetch(new Request(c.req.raw.url, { method: 'POST', headers, body: raw }));
        const out = new Response(fresh.body, { status: fresh.status, headers: new Headers(fresh.headers) });
        out.headers.set('X-Picocash-Reason', `credential was for ${challengeAmount ?? 'unknown'} base units; this request costs ${priceBase}`);
        return out;
      }
    }

    // Gate: 402 with a challenge for this exact price, or verify+settle and continue.
    const gated = await mppx.charge({ amount: price })(c, async () => {
      const upstream = await fetchImpl(`${opts.upstreamUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.upstreamApiKey}`,
          ...(typeof body.stream === 'boolean' && body.stream ? { accept: 'text/event-stream' } : {}),
        },
        body: raw,
      });
      // Pass the upstream response through (streaming included); never leak upstream auth headers.
      const headers = new Headers();
      for (const h of ['content-type', 'x-request-id', 'openai-processing-ms']) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
      }
      headers.set('X-Picocash-Price', price);
      c.res = new Response(upstream.body, { status: upstream.status, headers });
    });
    return gated ?? c.res;
  });

  return { app, acceptor, lockPubkey, keyset, stats: () => ({ settled }) };
}
