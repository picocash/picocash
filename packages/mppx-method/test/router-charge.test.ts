import { describe, expect, it } from 'vitest';
import { Mppx } from 'mppx/server';
import { Wallet, type Proof } from '@picocash/sdk';
import { KvAcceptorStore, PicocashAcceptor, type KvClient } from '../src/index.js';
import { charge, picocash } from '../src/mppx.js';
import { fundedWallet, makeTestMint, TEST_MINT_URL } from './helper.js';

/** In-memory KvClient with the router's KvStore semantics (per-key atomic setNxEx). */
function memoryKv(): KvClient & { keys: () => string[] } {
  const map = new Map<string, unknown>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    del: async (k) => void map.delete(k),
    setNxEx: async (k, v) => (map.has(k) ? false : (map.set(k, v), true)),
    keys: () => [...map.keys()],
  };
}

async function makeRouterScene(fundAmount: number) {
  const mint = await makeTestMint();
  const { wallet, proofs } = await fundedWallet(mint, fundAmount);
  const keyset = await wallet.getKeyset();
  const kv = memoryKv();
  const acceptor = new PicocashAcceptor({
    realm: 'router.test',
    mints: [{ url: TEST_MINT_URL, keyset }],
    store: new KvAcceptorStore(kv),
  });
  const serviceWallet = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl: mint.fetchImpl });
  const [, chainId, currency] = keyset.unit.split(':');
  // exactly how @agentcash/router builds its mppx context: methods array + secretKey + realm
  const mppx = Mppx.create({
    methods: [
      charge({
        acceptor,
        wallet: serviceWallet,
        currency: currency!,
        chainId: Number(chainId),
        mints: [{ url: TEST_MINT_URL, keysetIds: [keyset.id] }],
      }),
    ],
    secretKey: 'router-secret-0123456789abcdef0123456789abcdef',
    realm: 'router.test',
  });
  let stored: Proof[] = proofs;
  const clientMethod = picocash({
    wallet,
    getProofs: () => stored,
    onChange: (change) => {
      stored = change;
    },
  });
  return { mppx, clientMethod, kv, keyset };
}

describe('router-style charge (Mppx.create + config defaults)', () => {
  it('challenge → pay → receipt through the middleware, router-style', { timeout: 20000 }, async () => {
    const scene = await makeRouterScene(100_000);
    const middleware = (scene.mppx as any).charge({ amount: '50000' });

    // 1. bare request → 402 challenge advertising picocash
    const first = await middleware(new Request('https://router.test/api/fortune'));
    expect(first.status).toBe(402);
    const wwwAuth = first.challenge.headers.get('WWW-Authenticate') as string;
    expect(wwwAuth).toContain('picocash');
    const challenge = (first.challenge as any).challenges?.[0] ?? (first as any).challengeObject;

    // decode the challenge the way an agent would (from the response headers)
    const { Challenge } = await import('mppx');
    const parsed = Challenge.fromHeaders(first.challenge.headers as Headers);
    expect((parsed.request as any).currency).toBeDefined();
    expect((parsed.request as any).methodDetails.nonce).toMatch(/^[0-9a-f]{64}$/);

    // 2. answer it
    const header = await scene.clientMethod.createCredential({ challenge: parsed as never });
    const paid = await middleware(
      new Request('https://router.test/api/fortune', { headers: { Authorization: header } }),
    );
    expect(paid.status).toBe(200);

    // 3. receipt attaches via withReceipt, settle-first semantics
    const res = paid.withReceipt(new Response('ok'));
    const receiptHeader = res.headers.get('Payment-Receipt');
    expect(receiptHeader).toBeTruthy();
    void challenge;

    // 4. replay refused (shared KV store did the claiming)
    const replay = await middleware(
      new Request('https://router.test/api/fortune', { headers: { Authorization: header } }),
    );
    expect(replay.status).toBe(402);
  });

  it('two nonces differ across challenges (request hook injects fresh)', async () => {
    const scene = await makeRouterScene(1_000);
    const middleware = (scene.mppx as any).charge({ amount: '100' });
    const { Challenge } = await import('mppx');
    const a = await middleware(new Request('https://router.test/a'));
    const b = await middleware(new Request('https://router.test/b'));
    const na = (Challenge.fromHeaders(a.challenge.headers as Headers).request as any).methodDetails.nonce;
    const nb = (Challenge.fromHeaders(b.challenge.headers as Headers).request as any).methodDetails.nonce;
    expect(na).not.toBe(nb);
  });
});

describe('KvAcceptorStore', () => {
  const state = (id: string) =>
    ({
      challenge: {
        method: 'picocash',
        realm: 'kv.test',
        challenge_id: id,
        nonce: 'n',
        amount: 1,
        unit: 'tip20:1:0x0',
        mints: [],
        expiry: Math.floor(Date.now() / 1000) + 300,
      },
    }) as any;

  it('accept claims challenge and Ys atomically per key; replay refused', async () => {
    const kv = memoryKv();
    const store = new KvAcceptorStore(kv);
    expect(await store.accept(state('c1'), ['y1', 'y2'])).toBe(true);
    expect(await store.accept(state('c1'), ['y3'])).toBe(false); // challenge already paid
    expect(await store.accept(state('c2'), ['y2', 'y9'])).toBe(false); // y2 seen
    expect(await store.hasAnyY(['y9'])).toBe(false); // rolled back after the y2 loss
    expect(await store.hasAnyY(['y1', 'zz'])).toBe(true);
    expect((await store.getChallenge('c1'))?.challenge.challenge_id).toBe('c1');
  });
});
