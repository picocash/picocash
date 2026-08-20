/**
 * Cloudflare Workers deployment of the picocash mint.
 *
 * One Durable Object (SQLite-backed) hosts the entire Hono mint: its
 * single-threaded execution plus storage.transaction() give the spent-secret
 * ledger the serialization and atomicity the design requires. The Worker
 * routes every request to that one object, adds a faucet proxy for the
 * self-serve testnet demo, and runs the solvency publisher on a Cron Trigger.
 *
 * Config arrives as Worker vars/secrets (same names as the env-based config).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Hono } from 'hono';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildApp } from '../app.js';
import { loadConfig, type MintConfig } from '../config.js';
import { migrate, type Db } from '../db-core.js';
import { deriveKeyset, type Keyset } from '../keyset.js';
import { TempoPayout } from '../payout.js';
import { computeOutstanding } from '../solvency.js';
import { TempoVault, verifyTokenBinding } from '../vault-tempo.js';
import { createDoDb } from './db-do.js';

export interface Env {
  MINT: DurableObjectNamespace<MintDO>;
  [key: string]: unknown;
}

const FAUCET = 'https://tempo.xyz/developers/api/faucet';

export class MintDO extends DurableObject<Env> {
  private readonly db: Db;
  private readonly ready: Promise<void>;
  private verified: Promise<void> | null = null;
  private config!: MintConfig;
  private keyset!: Keyset;
  private app!: Hono;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDoDb(ctx.storage);
    // Schema + keyset derivation only: pure CPU and local storage, no network.
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db);
      this.config = loadConfig(env as unknown as NodeJS.ProcessEnv);
      if (this.config.vault !== 'tempo' || !this.config.tempo) {
        throw new Error('the hosted mint requires PICOCASH_VAULT=tempo and the Tempo bindings');
      }
      this.keyset = deriveKeyset(this.config.seed, this.config.unit);
      await this.db.query('INSERT INTO keysets (id, unit) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [this.keyset.id, this.keyset.unit]);
      const tempo = this.config.tempo;
      this.app = buildApp({
        db: this.db,
        config: this.config,
        oracle: new TempoVault(tempo),
        keyset: this.keyset,
        payout: tempo.operatorKey ? new TempoPayout(tempo) : undefined,
      });
    });
  }

  /** Unit ↔ token ↔ vault binding check: external I/O, so once and lazily, never in the constructor gate. */
  private verifyOnce(): Promise<void> {
    this.verified ??= verifyTokenBinding(this.config.tempo!, this.config.meltFee).then(() => undefined);
    return this.verified;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    try {
      await this.verifyOnce();
    } catch (err) {
      this.verified = null; // retry on the next request
      return Response.json(
        { error: { code: 'BINDING_UNVERIFIED', message: String(err instanceof Error ? err.message : err), recovery: 'the mint refuses to serve until its unit/token/vault binding verifies; retry shortly or contact the operator' } },
        { status: 503 },
      );
    }
    return this.app.fetch(request);
  }

  /** Proof of liabilities on a schedule: publish when the vault's policy says it's due. */
  async publishSolvency(): Promise<string> {
    await this.ready;
    const tempo = this.config.tempo!;
    if (!tempo.operatorKey) return 'skipped: no operator key';
    const chain = defineChain({
      id: tempo.chainId,
      name: `tempo-${tempo.chainId}`,
      nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
      rpcUrls: { default: { http: [tempo.rpcUrl] } },
    });
    const publicClient = createPublicClient({ chain, transport: http(tempo.rpcUrl) });
    const vaultAbi = parseAbi([
      'function isPublicationDue() view returns (bool)',
      'function publishOutstandingSupply(bytes8 keysetId, uint256 outstanding)',
    ]);
    const due = await publicClient.readContract({ address: tempo.depositAddress, abi: vaultAbi, functionName: 'isPublicationDue' });
    if (!due) return 'not due';

    const outstanding = await computeOutstanding(this.db, this.keyset.id);
    const balance = await publicClient.readContract({
      address: tempo.tokenAddress,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [tempo.depositAddress],
    });
    if (balance < BigInt(outstanding)) {
      console.error(`SOLVENCY VIOLATION: vault ${balance} < outstanding ${outstanding} — not publishing`);
      return `VIOLATION vault=${balance} outstanding=${outstanding}`;
    }
    const wallet = createWalletClient({ account: privateKeyToAccount(tempo.operatorKey), chain, transport: http(tempo.rpcUrl) });
    const hash = await wallet.writeContract({
      address: tempo.depositAddress,
      abi: vaultAbi,
      functionName: 'publishOutstandingSupply',
      args: [`0x${this.keyset.id}` as `0x${string}`, BigInt(outstanding)],
    });
    return `published outstanding=${outstanding} tx=${hash}`;
  }
}

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Faucet proxy for the self-serve demo: the page generates a throwaway
    // testnet wallet and asks us to fund it (testnet money, public faucet).
    if (url.pathname === '/dev/faucet') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
      if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: corsHeaders });
      const body = (await request.json().catch(() => ({}))) as { address?: string };
      if (!body.address || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
        return Response.json({ error: { code: 'INVALID_REQUEST', message: 'address required', recovery: 'send {"address":"0x…"}' } }, { status: 400, headers: corsHeaders });
      }
      const upstream = await fetch(FAUCET, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: body.address }),
      });
      return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', ...corsHeaders } });
    }
    return env.MINT.getByName('mint').fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      env.MINT.getByName('mint')
        .publishSolvency()
        .then((result) => console.log(`[solvency] ${result}`))
        .catch((err) => console.error('[solvency] failed:', err)),
    );
  },
};
