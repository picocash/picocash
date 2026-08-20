import { sha256 } from '@noble/hashes/sha2';
import {
  blindMessage,
  bytesToHex,
  hashToCurve,
  hexToBytes,
  randomScalarBytes,
  unblindSignature,
  utf8ToBytes,
} from '@picocash/crypto';
import type { Hono } from 'hono';
import { buildApp } from '../src/app.js';
import { tip20Unit } from '../src/config.js';
import type { MintConfig } from '../src/config.js';
import { createPgliteDb, type Db } from '../src/db.js';
import { migrate } from '../src/db.js';
import { deriveKeyset, type Keyset } from '../src/keyset.js';
import { FakePayout } from '../src/payout.js';
import { FakeVault } from '../src/vault.js';

export interface TestMint {
  app: Hono;
  db: Db;
  keyset: Keyset;
  fakeVault: FakeVault;
  payout: FakePayout;
  config: MintConfig;
  get(path: string): Promise<{ status: number; body: any }>;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
}

export async function makeMint(): Promise<TestMint> {
  const db = createPgliteDb();
  await migrate(db);
  const config: MintConfig = {
    name: 'test mint',
    unit: tip20Unit(42431, '0x20c0000000000000000000000000000000000000'),
    seed: sha256(utf8ToBytes('picocash-test-seed')),
    port: 0,
    databaseUrl: undefined,
    vault: 'fake',
    fakeVault: true,
    maxMintAmount: 100_000_000,
    maxOutstanding: 0,
    meltFee: 0,
    quoteTtlSeconds: 900,
  };
  const keyset = deriveKeyset(config.seed, config.unit);
  await db.query('INSERT INTO keysets (id, unit) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [keyset.id, keyset.unit]);
  const fakeVault = new FakeVault();
  const payout = new FakePayout();
  const app = buildApp({ db, config, oracle: fakeVault, keyset, payout, fakeVault });

  const request = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init);
    return { status: res.status, body: await res.json() };
  };
  return {
    app,
    db,
    keyset,
    fakeVault,
    payout,
    config,
    get: (path) => request(path),
    post: (path, body) =>
      request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

// --- wallet-lite for tests --------------------------------------------------

export interface PendingOutput {
  amount: number;
  secret: Uint8Array;
  r: Uint8Array;
  B_: string;
}

export interface TestProof {
  amount: number;
  keyset_id: string;
  secret: string;
  C: string;
}

export function decompose(amount: number): number[] {
  const parts: number[] = [];
  for (let pow = 30; pow >= 0; pow--) {
    const denomination = 2 ** pow;
    if (amount >= denomination) {
      parts.push(denomination);
      amount -= denomination;
    }
  }
  if (amount !== 0) throw new Error('decompose: non-integer remainder');
  return parts;
}

/** Fresh secrets + blinding per denomination; returns wire outputs and the pending client state. */
export function makeOutputs(keysetId: string, amounts: number[]): { outputs: any[]; pending: PendingOutput[] } {
  const pending = amounts.map((amount) => {
    const secret = randomScalarBytes();
    const { B_, r } = blindMessage(secret);
    return { amount, secret, r, B_: bytesToHex(B_) };
  });
  return {
    outputs: pending.map((p) => ({ amount: p.amount, keyset_id: keysetId, B_: p.B_ })),
    pending,
  };
}

/** Unblind returned signatures into spendable proofs. */
export function toProofs(mint: TestMint, pending: PendingOutput[], signatures: any[]): TestProof[] {
  return signatures.map((sig, i) => {
    const p = pending[i]!;
    const pubkey = mint.keyset.keys.get(p.amount)!.pubkey;
    const C = unblindSignature(hexToBytes(sig.C_), p.r, pubkey);
    return { amount: p.amount, keyset_id: mint.keyset.id, secret: bytesToHex(p.secret), C: bytesToHex(C) };
  });
}

export function yOf(proof: TestProof): string {
  return bytesToHex(hashToCurve(hexToBytes(proof.secret)).toRawBytes(true));
}

/** Full happy path: quote → fake deposit → mint. Returns spendable proofs. */
export async function mintTokens(mint: TestMint, amount: number): Promise<TestProof[]> {
  const quote = await mint.post('/v1/mint/quote', { amount, unit: mint.config.unit });
  if (quote.status !== 200) throw new Error(`quote failed: ${JSON.stringify(quote.body)}`);
  const quoteId = quote.body.quote_id;
  const deposit = await mint.post('/dev/deposit', { quote_id: quoteId, amount });
  if (deposit.status !== 200) throw new Error(`deposit failed: ${JSON.stringify(deposit.body)}`);
  const { outputs, pending } = makeOutputs(mint.keyset.id, decompose(amount));
  const minted = await mint.post('/v1/mint', { quote_id: quoteId, outputs });
  if (minted.status !== 200) throw new Error(`mint failed: ${JSON.stringify(minted.body)}`);
  return toProofs(mint, pending, minted.body.signatures);
}
