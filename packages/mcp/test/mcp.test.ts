/**
 * The MCP wallet end to end, in-process: a real McpServer talked to by a real
 * MCP Client over InMemoryTransport, backed by a test mint (fake vault) and a
 * paid Hono route gated by our own mppx charge() — the same substrate the
 * AgentCash router uses. No stdio, no network.
 */
import { Hono } from 'hono';
import { Mppx } from 'mppx/hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { PicocashAcceptor } from '@picocash/mppx-method';
import { charge } from '@picocash/mppx-method/mppx';
import { MemoryProofStore, Wallet, npubFromPubkey, pubkeyOf } from '@picocash/sdk';
import { createMcpServer } from '../src/server.js';
import { WalletService } from '../src/wallet-service.js';
import { makeTestMint, TEST_MINT_URL } from './helper.js';

const API_URL = 'https://api.test';
const PRICE_BASE = 100; // '0.0001' at 6 decimals

/** A private key whose public key has the given parity — to pin the hard case. */
function keyWithParity(parity: 0x02 | 0x03): Uint8Array {
  for (let i = 0; i < 500; i++) {
    const k = secp256k1.utils.randomPrivateKey();
    if (secp256k1.getPublicKey(k, true)[0] === parity) return k;
  }
  throw new Error('unreachable');
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  const txt = r.content[0]!.text;
  let data: unknown;
  try {
    data = JSON.parse(txt);
  } catch {
    data = txt;
  }
  return { isError: !!r.isError, data: data as any, text: txt };
}

describe('@picocash/mcp', () => {
  let mint: Awaited<ReturnType<typeof makeTestMint>>;
  let fetchImpl: typeof fetch;
  let serviceA: WalletService;
  let serviceB: WalletService;
  let client: Client;
  let merchantSettled = 0;
  const keyA = keyWithParity(0x03); // the agent: ODD parity — the case signProofs would get wrong
  const keyB = keyWithParity(0x03); // the recipient: also odd, so receive-after-lock is the hard path

  beforeAll(async () => {
    mint = await makeTestMint();

    // Paid API, built exactly like the AgentCash router builds its MPP context.
    const serviceWallet = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl: mint.fetchImpl });
    const keyset = await serviceWallet.getKeyset();
    const [, chainId, currency] = keyset.unit.split(':');
    const acceptor = new PicocashAcceptor({ realm: 'api.test', mints: [{ url: TEST_MINT_URL, keyset }] });
    const mppx = Mppx.create({
      methods: [
        charge({
          acceptor,
          wallet: serviceWallet,
          currency: currency!,
          chainId: Number(chainId),
          mints: [{ url: TEST_MINT_URL, keysetIds: [keyset.id] }],
          onAccepted: () => {
            merchantSettled++;
          },
        }),
      ],
      secretKey: 'mcp-test-secret-key-0123456789abcdef0123456789',
      realm: 'api.test',
    });
    const api = new Hono();
    api.get('/free', (c) => c.json({ ok: true }));
    api.get('/fortune', mppx.charge({ amount: '0.0001' }), (c) => c.json({ fortune: 'paid by an agent with its Nostr key' }));

    // One fetch that routes to the mint or the API by host.
    fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(TEST_MINT_URL)) return mint.fetchImpl(input as any, init);
      if (url.startsWith(API_URL)) return api.request(url.replace(API_URL, ''), init);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    serviceA = new WalletService({ mintUrl: TEST_MINT_URL, privkey: keyA, store: new MemoryProofStore(), fetchImpl });
    serviceB = new WalletService({ mintUrl: TEST_MINT_URL, privkey: keyB, store: new MemoryProofStore(), fetchImpl });

    // Fund A: one "deposit" → mint → into the store.
    const quote = await serviceA.wallet.requestMintQuote(100_000);
    mint.fakeVault.simulateDeposit(quote.quote_id, 100_000);
    const proofs = await serviceA.wallet.mintProofs(quote.quote_id, 100_000);
    await (serviceA as any).opts.store.add(proofs, { at: 1, kind: 'mint', delta: 100_000 });

    // Real MCP server ⇄ real MCP client, in memory.
    const server = createMcpServer(serviceA);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    client = new Client({ name: 'test-agent', version: '0.0.0' });
    await client.connect(clientT);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('exposes the six wallet tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['balance', 'fetch_paid', 'history', 'melt', 'receive', 'send']);
  });

  it('balance reports the funded amount and the agent npub', async () => {
    const { isError, data } = await callTool(client, 'balance');
    expect(isError).toBe(false);
    expect(data.spendable).toBe(100_000);
    expect(data.reserved).toBe(0);
    expect(data.npub).toBe(npubFromPubkey(pubkeyOf(keyA)));
  });

  it('fetch_paid: a free URL costs nothing; a 402 is paid automatically, settle-first', async () => {
    const free = await callTool(client, 'fetch_paid', { url: `${API_URL}/free` });
    expect(free.isError).toBe(false);
    expect(free.data.status).toBe(200);
    expect(free.data.paid).toBe(0);

    const paid = await callTool(client, 'fetch_paid', { url: `${API_URL}/fortune` });
    expect(paid.isError).toBe(false);
    expect(paid.data.status).toBe(200);
    expect(JSON.parse(paid.data.body).fortune).toMatch(/Nostr key/);
    expect(paid.data.paid).toBe(PRICE_BASE);
    expect(paid.data.receipt.method).toBe('picocash');
    expect(paid.data.receipt.settlement).toBe('settled');
    expect(merchantSettled).toBe(1);

    const bal = await callTool(client, 'balance');
    expect(bal.data.spendable).toBe(100_000 - PRICE_BASE);
    expect(bal.data.reserved).toBe(0); // reservation committed, not leaked
  });

  it('send refuses an unlocked bearer token unless explicitly opted in', async () => {
    const r = await callTool(client, 'send', { amount: 1000 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/UNLOCKED/);
    expect((await callTool(client, 'balance')).data.spendable).toBe(100_000 - PRICE_BASE); // nothing moved
  });

  it('send locked to another npub → only that npub can receive it (odd-parity keys on both sides)', async () => {
    const npubB = npubFromPubkey(pubkeyOf(keyB));
    const sent = await callTool(client, 'send', { amount: 5000, to_npub: npubB, memo: 'bounty' });
    expect(sent.isError).toBe(false);
    expect(sent.data.locked_to).toBe(npubB);
    expect(typeof sent.data.token).toBe('string');

    // A cannot claim its own locked-to-B token back (it is B's now)
    await expect(serviceA.receive(sent.data.token)).rejects.toThrow(/locked/);

    // B claims it with its key — the parity-robust signer path
    const got = await serviceB.receive(sent.data.token);
    expect(got.amount).toBe(5000);
    expect(got.from_lock).toBe(npubB);
    expect((await serviceB.balance()).spendable).toBe(5000);

    // and it cannot be claimed twice
    await expect(serviceB.receive(sent.data.token)).rejects.toThrow();

    expect((await callTool(client, 'balance')).data.spendable).toBe(100_000 - PRICE_BASE - 5000);
  });

  it('melt withdraws on-chain (fake payout) and debits the wallet', async () => {
    const r = await callTool(client, 'melt', { amount: 2000, to: '0x000000000000000000000000000000000000dEaD' });
    expect(r.isError).toBe(false);
    expect(r.data.state).toBe('PAID');
    expect(r.data.amount).toBe(2000);
    expect((await callTool(client, 'balance')).data.spendable).toBe(100_000 - PRICE_BASE - 5000 - 2000);
  });

  it('history lists the ledger newest-first with signed deltas', async () => {
    const { data } = await callTool(client, 'history', { limit: 10 });
    const kinds = (data as Array<{ kind: string; delta: number }>).map((h) => `${h.kind}:${h.delta}`);
    expect(kinds).toEqual(['melt:-2000', 'send:-5000', `pay:-${PRICE_BASE}`, 'pay:0', 'mint:100000']);
  });

  it('rejects malformed tool input at the schema boundary', async () => {
    const r = await callTool(client, 'melt', { amount: 1, to: 'not-an-address' });
    expect(r.isError).toBe(true);
  });
});
