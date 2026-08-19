import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb, createPgliteDb, migrate, type Db } from './db.js';
import { deriveKeyset } from './keyset.js';
import { FakeVault } from './vault.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const db: Db = config.databaseUrl ? createPgDb(config.databaseUrl) : createPgliteDb('.data/mint-db');
  await migrate(db);

  const keyset = deriveKeyset(config.seed, config.unit);
  await db.query('INSERT INTO keysets (id, unit) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [keyset.id, keyset.unit]);

  if (!config.fakeVault) {
    throw new Error('the real vault oracle arrives at build step 5; run with PICOCASH_FAKE_VAULT=1 for now');
  }
  const fakeVault = new FakeVault();
  const app = buildApp({ db, config, oracle: fakeVault, keyset, fakeVault });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[mint] listening on :${info.port} — keyset ${keyset.id} (${keyset.unit}), FAKE VAULT (dev)`);
  });
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isDirectRun) {
  main().catch((err) => {
    console.error('[mint] fatal:', err);
    process.exit(1);
  });
}
