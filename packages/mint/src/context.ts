import type { MintConfig } from './config.js';
import type { Db } from './db.js';
import type { Keyset } from './keyset.js';
import type { DepositOracle, FakeVault } from './vault.js';

export interface MintContext {
  db: Db;
  config: MintConfig;
  oracle: DepositOracle;
  keyset: Keyset;
  /** Set only when running against the fake vault; enables POST /dev/deposit. */
  fakeVault?: FakeVault | undefined;
}
