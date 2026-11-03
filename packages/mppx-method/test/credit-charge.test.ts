import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@picocash/crypto';
import { buildApp, createPgliteDb, CreditLedger, creditUnit, deriveKeyset, migrate, type MintConfig } from '@picocash/mint';
import { Wallet, type Proof } from '@picocash/sdk';
import { Mppx } from 'mppx/server';
import { describe, expect, it } from 'vitest';
import { PicocashAcceptor } from '../src/index.js';
import { charge, picocash, unitOf } from '../src/mppx.js';

const URL_ = 'https://credit.test';
const TOKEN = 'issuer-token-0123456789abcdef0123456789';

async function creditScene(amount: number) {
  const db = createPgliteDb();
  await migrate(db);
  const config: MintConfig = {
    name: 'a9n9 credit', unit: creditUnit('a9n9'), seed: sha256(utf8ToBytes('credit-mppx-seed')), port: 0, databaseUrl: undefined,
    vault: 'credit', fakeVault: false, credit: { issuer: 'a9n9', issueToken: TOKEN },
    maxMintAmount: 100_000_000, maxOutstanding: 0, meltFee: 0, relay: { enabled: false, maxBytes: 0, ttlSeconds: 0, uiUrl: undefined }, quoteTtlSeconds: 900,
  };
  const keyset0 = deriveKeyset(config.seed, config.unit);
  await db.query('INSERT INTO keysets (id, unit) VALUES ($1, $2)', [keyset0.id, keyset0.unit]);
  const app = buildApp({ db, config, oracle: new CreditLedger(db), keyset: keyset0, payout: undefined });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input).replace(URL_, ''), init)) as typeof fetch;
  // the issuer releases credit into the agent's wallet
  const agent = new Wallet({ mintUrl: URL_, fetchImpl });
  const quote = await agent.requestMintQuote(amount);
  const issued = await app.request('/v1/credit/issue', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ quote_id: quote.quote_id, ref: 'release:test' }) });
  expect(issued.status).toBe(200);
  let stored: Proof[] = await agent.mintProofs(quote.quote_id, amount);
  const keyset = await agent.getKeyset();
  const acceptor = new PicocashAcceptor({ realm: 'tools.test', mints: [{ url: URL_, keyset }] });
  const mppx = Mppx.create({
    methods: [charge({ acceptor, wallet: new Wallet({ mintUrl: URL_, fetchImpl }), currency: 'USD', unit: keyset.unit, mints: [{ url: URL_, keysetIds: [keyset.id] }] })],
    secretKey: 'tools-secret-0123456789abcdef0123456789abcdef',
    realm: 'tools.test',
  });
  const client = picocash({ wallet: agent, getProofs: () => stored, onChange: (c) => { stored = c; } });
  return { mppx, client, balance: () => stored.reduce((a, p) => a + p.amount, 0) };
}

describe('closed-loop credit over MPP (explicit unit)', () => {
  it('an agent pays a service with issuer credit; change returns to its wallet', { timeout: 20000 }, async () => {
    const s = await creditScene(1_000_000); // $1.00 released credit
    const mw = (s.mppx as any).charge({ amount: '0.05' });
    const first = await mw(new Request('https://tools.test/v1/search'));
    expect(first.status).toBe(402);
    const { Challenge } = await import('mppx');
    const parsed = Challenge.fromHeaders(first.challenge.headers as Headers);
    expect((parsed.request as any).methodDetails.unit).toBe('credit:a9n9:usd');
    expect((parsed.request as any).methodDetails.chainId).toBeUndefined();
    const header = await s.client.createCredential({ challenge: parsed as never });
    const paid = await mw(new Request('https://tools.test/v1/search', { headers: { Authorization: header } }));
    expect(paid.status).toBe(200);
    expect(s.balance()).toBe(950_000);
  });

  it('unit derivation: tip20 stays derived; explicit tip20 is refused; neither is refused', () => {
    expect(unitOf(42431, '0xABC')).toBe('tip20:42431:0xabc');
    expect(unitOf(undefined, 'USD', 'credit:a9n9:usd')).toBe('credit:a9n9:usd');
    expect(() => unitOf(undefined, 'USD', 'tip20:1:0xabc')).toThrow();
    expect(() => unitOf(undefined, 'USD')).toThrow();
  });
});
