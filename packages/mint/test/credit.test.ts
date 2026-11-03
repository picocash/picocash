import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@picocash/crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { creditUnit, loadConfig, type MintConfig } from '../src/config.js';
import { createPgliteDb, migrate } from '../src/db.js';
import { deriveKeyset } from '../src/keyset.js';
import { CreditLedger } from '../src/vault-credit.js';
import { decompose, makeOutputs, type TestMint } from './helpers.js';

const TOKEN = 'issuer-token-0123456789abcdef0123456789';

async function makeCreditMint() {
  const db = createPgliteDb();
  await migrate(db);
  const config: MintConfig = {
    name: 'a9n9 credit', unit: creditUnit('a9n9'), seed: sha256(utf8ToBytes('credit-test-seed')), port: 0, databaseUrl: undefined,
    vault: 'credit', fakeVault: false, credit: { issuer: 'a9n9', issueToken: TOKEN },
    maxMintAmount: 100_000_000, maxOutstanding: 0, meltFee: 0,
    relay: { enabled: false, maxBytes: 0, ttlSeconds: 0, uiUrl: undefined }, quoteTtlSeconds: 900,
  };
  const keyset = deriveKeyset(config.seed, config.unit);
  await db.query('INSERT INTO keysets (id, unit) VALUES ($1, $2)', [keyset.id, keyset.unit]);
  const app = buildApp({ db, config, oracle: new CreditLedger(db), keyset, payout: undefined });
  const req = async (path: string, init?: RequestInit) => { const r = await app.request(path, init); return { status: r.status, body: await r.json() as any }; };
  const post = (path: string, body: unknown, auth?: string) => req(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
  return { app, db, config, keyset, get: (p: string) => req(p), post } as unknown as TestMint & { post: typeof post };
}

describe('closed-loop credit mint', () => {
  it('advertises credit, no cash redemption, no melt', async () => {
    const m = await makeCreditMint();
    const info = await m.get('/v1/info');
    expect(info.body.unit).toBe('credit:a9n9:usd');
    expect(info.body.vault).toMatchObject({ method: 'credit', issuer: 'a9n9', redeemable_for_cash: false });
    expect(info.body.melt).toBe(false);
    expect(m.keyset.id).not.toBe(deriveKeyset(m.config.seed, 'tip20:42431:0x20c0000000000000000000000000000000000000').id);
  });

  it('only the issuer can fund a quote; issuance is idempotent per ref and mints once', async () => {
    const m = await makeCreditMint();
    const amount = 6_400_000; // $6.40 released credit
    const q = await m.post('/v1/mint/quote', { amount, unit: m.config.unit });
    expect(q.body.deposit.method).toBe('credit');
    const id = q.body.quote_id;
    const { outputs } = makeOutputs(m.keyset.id, decompose(amount));

    expect((await m.post('/v1/mint', { quote_id: id, outputs })).status).toBe(402);
    expect((await m.post('/v1/credit/issue', { quote_id: id, ref: 'release:x' })).status).toBe(401);
    expect((await m.post('/v1/credit/issue', { quote_id: id, ref: 'release:x' }, TOKEN.slice(0, -1) + 'X')).status).toBe(401);

    const ok = await m.post('/v1/credit/issue', { quote_id: id, ref: 'release:x' }, TOKEN);
    expect(ok.body).toMatchObject({ amount, replay: false });
    const again = await m.post('/v1/credit/issue', { quote_id: id, ref: 'release:x' }, TOKEN);
    expect(again.body).toMatchObject({ amount, replay: true });

    // the same release cannot fund a second quote
    const q2 = await m.post('/v1/mint/quote', { amount, unit: m.config.unit });
    expect((await m.post('/v1/credit/issue', { quote_id: q2.body.quote_id, ref: 'release:x' }, TOKEN)).body.error.code).toBe('REF_ALREADY_ISSUED');
    // a second ref cannot re-fund a funded quote
    expect((await m.post('/v1/credit/issue', { quote_id: id, ref: 'release:y' }, TOKEN)).status).toBe(409);

    const minted = await m.post('/v1/mint', { quote_id: id, outputs });
    expect(minted.status).toBe(200);
    const solv = await m.get('/v1/solvency');
    expect(solv.body).toMatchObject({ outstanding: amount, issued: amount, spent_at_issuer: 0 });
    expect((await m.post('/v1/melt/quote', { amount: 1000, unit: m.config.unit, to: '0x' + '1'.repeat(40) })).status).not.toBe(200);
  });

  it('config refuses credit mode without issuer and a strong token', () => {
    const seed = 'ab'.repeat(32);
    expect(() => loadConfig({ PICOCASH_VAULT: 'credit', PICOCASH_MINT_SEED: seed })).toThrow(/ISSUER/);
    expect(() => loadConfig({ PICOCASH_VAULT: 'credit', PICOCASH_MINT_SEED: seed, PICOCASH_CREDIT_ISSUER: 'a9n9', PICOCASH_CREDIT_ISSUE_TOKEN: 'short' })).toThrow(/TOKEN/);
    const c = loadConfig({ PICOCASH_VAULT: 'credit', PICOCASH_MINT_SEED: seed, PICOCASH_CREDIT_ISSUER: 'a9n9', PICOCASH_CREDIT_ISSUE_TOKEN: TOKEN });
    expect(c.unit).toBe('credit:a9n9:usd');
    expect(c.tempo).toBeUndefined();
  });
});
