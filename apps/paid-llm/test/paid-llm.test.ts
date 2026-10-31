/**
 * The whole owner-budget story, in-process:
 *   owner funds agent (tokens locked to the agent, and separately a budget
 *   locked to the LLM merchant) → the agent's @picocash/mcp WalletService pays
 *   the proxy's 402 → the proxy forwards to an upstream with ITS key → the
 *   agent gets a completion having never held a vendor key.
 * Plus the attacks that matter: underpaying with a cheap challenge, and
 * spending a merchant-locked budget somewhere else.
 */
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { WalletService } from '@picocash/mcp';
import { MemoryProofStore, Wallet, lockKeyFromNpub, npubFromPubkey, pubkeyOf } from '@picocash/sdk';
import { toBaseUnits } from '@picocash/mppx-method/mppx';
import { createPaidLlmApp } from '../src/app.js';
import { DEFAULT_TIERS, priceFor } from '../src/pricing.js';
import { makeTestMint, TEST_MINT_URL } from './helper.js';

const LLM_URL = 'https://llm.test';
const UPSTREAM_URL = 'https://upstream.test';
const UPSTREAM_KEY = 'sk-upstream-secret-DO-NOT-LEAK';

describe('pricing', () => {
  it('is deterministic in (model, max_tokens) and tiered', () => {
    expect(priceFor({ model: 'claude-haiku-4-5', max_tokens: 500 })).toBe('0.0015'); // 0.0005 + 0.001×1
    expect(priceFor({ model: 'claude-haiku-4-5', max_tokens: 1001 })).toBe('0.0025'); // ceil → 2k
    expect(priceFor({ model: 'claude-opus-5', max_tokens: 1000 })).toBe('0.03');
    expect(priceFor({ model: 'some-unknown-model' })).toBe('0.01'); // fallback tier: 0.002 + 0.004×2 (default 1024 → 2k)
    expect(priceFor({ model: 'gpt-5-mini', max_tokens: 100 })).toBe('0.015'); // 'gpt-5' tier matches first
    expect(() => priceFor({})).toThrow(/model/);
    expect(() => priceFor({ model: 'x', max_tokens: -1 })).toThrow(/max_tokens/);
  });
});

describe('paid-llm proxy', () => {
  let mint: Awaited<ReturnType<typeof makeTestMint>>;
  let proxy: Awaited<ReturnType<typeof createPaidLlmApp>>;
  let agent: WalletService;
  let fetchImpl: typeof fetch;
  const upstreamSeen: Array<{ auth: string | null; payment: string | null; body: any }> = [];
  const agentKey = secp256k1.utils.randomPrivateKey();
  const ownerKey = secp256k1.utils.randomPrivateKey();
  const proxyLockKey = secp256k1.utils.randomPrivateKey();
  const cheap = { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
  const dear = { model: 'claude-opus-5', max_tokens: 8000, messages: [{ role: 'user', content: 'write a novel' }] };

  beforeAll(async () => {
    mint = await makeTestMint();

    // Fake OpenAI-compatible upstream: records what it was sent, answers in shape.
    const upstream = new Hono();
    upstream.post('/v1/chat/completions', async (c) => {
      const body = await c.req.json();
      upstreamSeen.push({ auth: c.req.header('authorization') ?? null, payment: c.req.header('authorization')?.startsWith('Payment') ? 'yes' : null, body });
      if (body.stream) {
        return new Response('data: {"choices":[{"delta":{"content":"hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return c.json({ id: 'cmpl_1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: `echo:${body.messages.at(-1).content}` }, finish_reason: 'stop' }] });
    });

    fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(TEST_MINT_URL)) return mint.fetchImpl(input as any, init);
      if (url.startsWith(UPSTREAM_URL)) return upstream.request(url.replace(UPSTREAM_URL, ''), init);
      if (url.startsWith(LLM_URL)) return proxy.app.request(url.replace(LLM_URL, ''), init);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    proxy = await createPaidLlmApp({
      mintUrl: TEST_MINT_URL,
      realm: LLM_URL,
      secretKey: 'paid-llm-test-secret-key-0123456789abcdef0123',
      upstreamUrl: UPSTREAM_URL,
      upstreamApiKey: UPSTREAM_KEY,
      lockKey: proxyLockKey,
      fetchImpl,
    });

    agent = new WalletService({ mintUrl: TEST_MINT_URL, privkey: agentKey, store: new MemoryProofStore(), fetchImpl });
  });

  /** The owner mints and sends `amount` locked to `lockKey` (33-byte compressed), returns the token. */
  async function ownerFunds(amount: number, lockKey: string) {
    const owner = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl });
    const q = await owner.requestMintQuote(amount);
    mint.fakeVault.simulateDeposit(q.quote_id, amount);
    const proofs = await owner.mintProofs(q.quote_id, amount);
    const { token } = await owner.sendLocked(proofs, amount, lockKey, { refund: [lockKeyFromNpub(pubkeyOf(ownerKey))] });
    return token;
  }

  it('advertises its lock key, mint and prices for free', async () => {
    const res = await proxy.app.request('/v1/info');
    const info = await res.json();
    expect(info.pubkey).toBe(proxy.lockPubkey);
    expect(info.npub).toBe(npubFromPubkey(proxy.lockPubkey));
    expect(info.mint).toBe(TEST_MINT_URL);
    expect(info.pricing.tiers).toEqual(DEFAULT_TIERS);
  });

  it('an unpaid request gets a 402 whose challenge amount is the price of THAT body, with the merchant pubkey', async () => {
    const res = await proxy.app.request('/v1/chat/completions', { method: 'POST', body: JSON.stringify(cheap) });
    expect(res.status).toBe(402);
    const www = res.headers.get('WWW-Authenticate')!;
    expect(www).toContain('method="picocash"');
    const req = JSON.parse(Buffer.from(/request="([^"]+)"/.exec(www)![1]!, 'base64url').toString());
    expect(req.amount).toBe(toBaseUnits(priceFor(cheap), 6));
    expect(req.methodDetails.pubkey).toBe(proxy.lockPubkey);
    expect(upstreamSeen).toHaveLength(0); // nothing forwarded without payment
  });

  it('owner funds the agent (locked to the agent); the agent pays the proxy; upstream sees the SERVER key, never a payment header', async () => {
    await agent.receive(await ownerFunds(100_000, lockKeyFromNpub(pubkeyOf(agentKey))));
    expect((await agent.balance()).spendable).toBe(100_000);

    const r = await agent.fetchPaid(`${LLM_URL}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cheap) });
    expect(r.status).toBe(200);
    const completion = JSON.parse(r.body);
    expect(completion.choices[0].message.content).toBe('echo:hi');
    expect(r.paid).toBe(Number(toBaseUnits(priceFor(cheap), 6)));
    expect(r.receipt?.settlement).toBe('settled');

    expect(upstreamSeen).toHaveLength(1);
    expect(upstreamSeen[0]!.auth).toBe(`Bearer ${UPSTREAM_KEY}`); // server-held key
    expect(upstreamSeen[0]!.payment).toBeNull(); // the agent's credential never reaches upstream
    expect(proxy.stats().settled).toBe(1);
  });

  it('underpay attack: a credential minted for a cheap body does not buy an expensive one, and nothing is settled or forwarded', async () => {
    // An attacker with its own funds obtains a credential for `cheap` by hand
    // (mppx client), then presents it with `dear`. Separate proofs so the
    // agent's store is not disturbed.
    const { Fetch } = await import('mppx/client');
    const { picocash } = await import('@picocash/mppx-method/mppx');
    const attackerWallet = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl });
    const aq = await attackerWallet.requestMintQuote(10_000);
    mint.fakeVault.simulateDeposit(aq.quote_id, 10_000);
    let held = await attackerWallet.mintProofs(aq.quote_id, 10_000);
    let credential = '';
    const pay = Fetch.from({
      fetch: async (input, init) => {
        // capture the credential the client would send on retry, then stop
        const h = new Headers(init?.headers as HeadersInit | undefined);
        if (h.get('authorization')?.startsWith('Payment ')) {
          credential = h.get('authorization')!;
          return new Response('captured', { status: 599 });
        }
        return fetchImpl(input, init);
      },
      methods: [picocash({ wallet: attackerWallet, getProofs: () => held, onChange: (c) => { held = c; } })],
      onChallenge: async (_c, { createCredential }) => createCredential(),
    });
    await pay(`${LLM_URL}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(cheap) });
    expect(credential).toMatch(/^Payment /);
    const settledBefore = proxy.stats().settled;
    const forwardedBefore = upstreamSeen.length;

    const res = await proxy.app.request('/v1/chat/completions', { method: 'POST', headers: { authorization: credential }, body: JSON.stringify(dear) });
    expect(res.status).toBe(402);
    expect(res.headers.get('X-Picocash-Reason')).toMatch(/this request costs/);
    const www = res.headers.get('WWW-Authenticate')!;
    const req = JSON.parse(Buffer.from(/request="([^"]+)"/.exec(www)![1]!, 'base64url').toString());
    expect(req.amount).toBe(toBaseUnits(priceFor(dear), 6)); // fresh challenge at the RIGHT price
    expect(proxy.stats().settled).toBe(settledBefore); // nothing settled
    expect(upstreamSeen).toHaveLength(forwardedBefore); // nothing forwarded
  });

  it('merchant-restricted budget: tokens locked to the PROXY key are spent there as-is, and are useless elsewhere', async () => {
    // Owner gives the agent $0.50 that only this merchant can redeem. A
    // merchant-locked token cannot be swapped by the agent (the mint would want
    // the merchant's witness), so a wallet must hold it as-is rather than
    // `receive` (claim-by-swap) it — which is what we do here.
    // Because a locked budget pays only in exact subset-sums, the owner funds it
    // in UNITS of the merchant's price — "three haiku calls" — not one lump.
    const before = await agent.balance();
    const price = Number(toBaseUnits(priceFor(cheap), 6)); // 1500 base units per call
    const owner = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl });
    const q = await owner.requestMintQuote(price * 3);
    mint.fakeVault.simulateDeposit(q.quote_id, price * 3);
    let pool = await owner.mintProofs(q.quote_id, price * 3);
    for (let i = 0; i < 3; i++) {
      const { bundle, change } = await owner.sendLocked(pool, price, proxy.lockPubkey);
      await (agent as any).opts.store.add(bundle.proofs, { at: 1, kind: 'receive', delta: price, ref: 'merchant-locked budget' });
      pool = change;
    }

    const bal = await agent.balance();
    expect(bal.locked_to_merchants).toBe(price * 3);
    expect(bal.spendable).toBe(before.spendable); // not spendable anywhere else

    const spendableBefore = bal.spendable;
    const r = await agent.fetchPaid(`${LLM_URL}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(cheap) });
    expect(r.status).toBe(200);
    expect(r.paid).toBe(price);
    const after = await agent.balance();
    // Paid from the merchant-locked budget (an exact unit), NOT from the open balance.
    expect(after.locked_to_merchants).toBe(price * 2);
    expect(after.spendable).toBe(spendableBefore);

    // A price the locked budget cannot cover (3500 > the 3000 remaining) falls
    // back to the open balance instead of failing the call.
    const bigger = { ...cheap, max_tokens: 2500 }; // 0.0005 + 0.001×3 = 3500 base units
    expect(Number(toBaseUnits(priceFor(bigger), 6))).toBe(3500);
    const r2 = await agent.fetchPaid(`${LLM_URL}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(bigger) });
    expect(r2.status).toBe(200);
    expect(r2.paid).toBe(3500);
    const after2 = await agent.balance();
    expect(after2.locked_to_merchants).toBe(price * 2); // untouched
    expect(after2.spendable).toBe(spendableBefore - 3500);

    // Locked proofs cannot be sent to anyone else: `send` draws only from the open balance.
    await expect(agent.send(spendableBefore + 1, { toNpub: npubFromPubkey(pubkeyOf(ownerKey)) })).rejects.toThrow(/insufficient/);
  });

  it('streams upstream SSE through after payment', async () => {
    const r = await agent.fetchPaid(`${LLM_URL}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ ...cheap, stream: true }) });
    expect(r.status).toBe(200);
    expect(r.body).toContain('data: [DONE]');
    expect(r.paid).toBe(Number(toBaseUnits(priceFor(cheap), 6)));
  });

  it('rejects malformed bodies before asking for money', async () => {
    const bad = await proxy.app.request('/v1/chat/completions', { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
    const noModel = await proxy.app.request('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) });
    expect(noModel.status).toBe(400);
    expect(JSON.parse(await noModel.text()).error.message).toMatch(/model/);
  });

  it('the ledger shows each paid call with the merchant and its cost', async () => {
    const h = await agent.history(10);
    const pays = h.filter((e) => e.kind === 'pay' && e.delta < 0);
    expect(pays.length).toBeGreaterThanOrEqual(3);
    expect(pays.every((e) => e.ref?.startsWith('llm.test'))).toBe(true);
  });
});
