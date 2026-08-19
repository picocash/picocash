import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb, createPgliteDb, migrate, type Db } from './db.js';
import { deriveKeyset } from './keyset.js';
import { TempoVault } from './vault-tempo.js';
import { FakeVault, type DepositOracle } from './vault.js';

export async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file — env vars only
  }
  const config = loadConfig();
  const db: Db = config.databaseUrl ? createPgDb(config.databaseUrl) : createPgliteDb('.data/mint-db');
  await migrate(db);

  const keyset = deriveKeyset(config.seed, config.unit);
  await db.query('INSERT INTO keysets (id, unit) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [keyset.id, keyset.unit]);

  let oracle: DepositOracle;
  let fakeVault: FakeVault | undefined;
  let vaultLabel: string;
  if (config.vault === 'tempo') {
    const tempo = config.tempo!;
    oracle = new TempoVault(tempo);
    vaultLabel = `TEMPO chain ${tempo.chainId}, token ${tempo.tokenAddress}, deposits → ${tempo.depositAddress}`;
  } else {
    fakeVault = new FakeVault();
    oracle = fakeVault;
    vaultLabel = 'FAKE VAULT (dev)';
  }

  const app = buildApp({ db, config, oracle, keyset, fakeVault });
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[mint] listening on :${info.port} — keyset ${keyset.id} (${keyset.unit}), ${vaultLabel}`);
  });
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isDirectRun) {
  main().catch((err) => {
    console.error('[mint] fatal:', err);
    process.exit(1);
  });
}
