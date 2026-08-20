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
import { Wallet, type Proof } from '@picocash/sdk';

export const TEST_MINT_URL = 'http://mint.test';

export async function makeTestMint() {
  const db = createPgliteDb();
  await migrate(db);
  const config: MintConfig = {
    name: 'mppx test mint',
    unit: tip20Unit(42431, '0x20c0000000000000000000000000000000000000'),
    seed: sha256(utf8ToBytes('picocash-mppx-test-seed')),
    port: 0,
    databaseUrl: undefined,
    vault: 'fake',
    fakeVault: true,
    maxMintAmount: 100_000_000,
    maxOutstanding: 0,
    quoteTtlSeconds: 900,
  };
  const keyset = deriveKeyset(config.seed, config.unit);
  await db.query('INSERT INTO keysets (id, unit) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [keyset.id, keyset.unit]);
  const fakeVault = new FakeVault();
  const app = buildApp({ db, config, oracle: fakeVault, keyset, payout: new FakePayout(), fakeVault });
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    app.request(String(input).replace(TEST_MINT_URL, ''), init)) as typeof fetch;
  return { app, fakeVault, fetchImpl, config };
}

export async function fundedWallet(mint: Awaited<ReturnType<typeof makeTestMint>>, amount: number): Promise<{ wallet: Wallet; proofs: Proof[] }> {
  const wallet = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl: mint.fetchImpl });
  const quote = await wallet.requestMintQuote(amount);
  mint.fakeVault.simulateDeposit(quote.quote_id, amount);
  const proofs = await wallet.mintProofs(quote.quote_id, amount);
  return { wallet, proofs };
}
