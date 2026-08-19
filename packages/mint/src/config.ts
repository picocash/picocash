import { sha256 } from '@noble/hashes/sha2';
import { hexToBytes, utf8ToBytes } from '@picocash/crypto';

export interface MintConfig {
  name: string;
  unit: string;
  seed: Uint8Array;
  port: number;
  databaseUrl: string | undefined;
  fakeVault: boolean;
  /** Max amount per mint quote, base units. */
  maxMintAmount: number;
  quoteTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MintConfig {
  const fakeVault = env.PICOCASH_FAKE_VAULT !== '0'; // fake until the real vault lands (step 5)
  let seed: Uint8Array;
  if (env.PICOCASH_MINT_SEED) {
    seed = hexToBytes(env.PICOCASH_MINT_SEED);
    if (seed.length !== 32) throw new Error('PICOCASH_MINT_SEED must be 32 bytes of hex');
  } else if (fakeVault) {
    // Dev-only fallback so `npm run dev` works out of the box. Real deployments
    // must set PICOCASH_MINT_SEED (encrypted at rest; never in code or logs).
    console.warn('[mint] PICOCASH_MINT_SEED not set — using the INSECURE fixed dev seed');
    seed = sha256(utf8ToBytes('picocash-insecure-dev-seed'));
  } else {
    throw new Error('PICOCASH_MINT_SEED is required when not running against the fake vault');
  }
  return {
    name: env.PICOCASH_MINT_NAME ?? 'picocash dev mint',
    unit: 'usdc.e-base',
    seed,
    port: Number(env.PORT ?? 3338),
    databaseUrl: env.DATABASE_URL,
    fakeVault,
    maxMintAmount: Number(env.PICOCASH_MAX_MINT_AMOUNT ?? 100_000_000), // $100
    quoteTtlSeconds: Number(env.PICOCASH_QUOTE_TTL_SECONDS ?? 900),
  };
}
