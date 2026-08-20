import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb, createPgliteDb, migrate, type Db } from './db.js';
import { deriveKeyset } from './keyset.js';
import { FakePayout, TempoPayout, type PayoutExecutor } from './payout.js';
import { TempoVault, verifyTokenBinding } from './vault-tempo.js';
import { FakeVault, type DepositOracle } from './vault.js';

// Library surface: lets sibling packages (SDK, MPP method) spin an in-process
// mint for their test suites without HTTP or a chain.
export { buildApp } from './app.js';
export { loadConfig, tip20Unit, type MintConfig } from './config.js';
export { createPgDb, createPgliteDb, migrate, type Db } from './db.js';
export { deriveKeyset, publicKeysJson, type Keyset } from './keyset.js';
export { FakePayout, TempoPayout, type PayoutExecutor } from './payout.js';
export { TempoVault, verifyTokenBinding } from './vault-tempo.js';
export { FakeVault, type DepositOracle } from './vault.js';
export type { MintContext } from './context.js';

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
  let payout: PayoutExecutor | undefined;
  let vaultLabel: string;
  if (config.vault === 'tempo') {
    const tempo = config.tempo!;
    const token = await verifyTokenBinding(tempo);
    oracle = new TempoVault(tempo);
    payout = tempo.operatorKey ? new TempoPayout(tempo) : undefined;
    vaultLabel = `TEMPO chain ${tempo.chainId}, unit ${config.unit} (${token.symbol}, ${token.decimals} dec), vault ${tempo.depositAddress}, melt ${payout ? 'on' : 'OFF (no operator key)'}`;
  } else {
    fakeVault = new FakeVault();
    oracle = fakeVault;
    payout = new FakePayout();
    vaultLabel = 'FAKE VAULT (dev)';
  }

  const app = buildApp({ db, config, oracle, keyset, payout, fakeVault });
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
