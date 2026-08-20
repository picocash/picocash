import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@picocash/crypto';
import {
  buildApp,
  createPgliteDb,
  deriveKeyset,
  FakePayout,
  FakeVault,
  migrate,
  tip20Unit,
  type MintConfig,
} from '@picocash/mint';

export const TEST_MINT_URL = 'https://mint.test';

/** In-process mint + a fetch bridge, so SDK tests need no HTTP or chain. */
export async function makeTestMint() {
  const db = createPgliteDb();
  await migrate(db);
  const config: MintConfig = {
    name: 'sdk test mint',
    unit: tip20Unit(42431, '0x20c0000000000000000000000000000000000000'),
    seed: sha256(utf8ToBytes('picocash-sdk-test-seed')),
    port: 0,
    databaseUrl: undefined,
    vault: 'fake',
    fakeVault: true,
    maxMintAmount: 100_000_000,
    maxOutstanding: 0,
    meltFee: 0,
    relay: { enabled: true, maxBytes: 16_384, ttlSeconds: 86_400, uiUrl: undefined },
    quoteTtlSeconds: 900,
  };
  const keyset = deriveKeyset(config.seed, config.unit);
  await db.query('INSERT INTO keysets (id, unit) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [keyset.id, keyset.unit]);
  const fakeVault = new FakeVault();
  const payout = new FakePayout();
  const app = buildApp({ db, config, oracle: fakeVault, keyset, payout, fakeVault });

  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(String(input).replace(TEST_MINT_URL, ''), init)) as typeof fetch;

  return { app, db, config, keyset, fakeVault, payout, fetchImpl };
}
