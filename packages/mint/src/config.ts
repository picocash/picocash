import { sha256 } from '@noble/hashes/sha2';
import { hexToBytes, utf8ToBytes } from '@picocash/crypto';

export interface TempoConfig {
  rpcUrl: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  /** Where deposits go and what the oracle watches: the vault contract. */
  depositAddress: `0x${string}`;
  /** Signs vault.withdraw() for melts. Melt is disabled when absent. */
  operatorKey?: `0x${string}` | undefined;
  confirmations: number;
  lookbackBlocks: bigint;
}

export interface MintConfig {
  name: string;
  unit: string;
  seed: Uint8Array;
  port: number;
  databaseUrl: string | undefined;
  vault: 'fake' | 'tempo';
  fakeVault: boolean;
  tempo?: TempoConfig;
  /** Max amount per mint quote, base units. */
  maxMintAmount: number;
  /** Global outstanding-supply cap, base units; 0 = uncapped. Reference mints MUST set this. */
  maxOutstanding: number;
  /** Flat melt fee, base units: burned with the inputs but not paid out, so it
   *  accrues in the vault and reimburses the operator's payout gas. */
  meltFee: number;
  /** PIP-07 token-link relay (optional capability). */
  relay: { enabled: boolean; maxBytes: number; ttlSeconds: number; uiUrl: string | undefined };
  quoteTtlSeconds: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Canonical unit identifier: the unit IS the TIP-20 token contract it is
 * backed by, scoped by chain. Keyset keys derive from this string, so keys
 * for one token/chain can never be confused with another's (PIP-01).
 */
export function tip20Unit(chainId: number, tokenAddress: string): string {
  return `tip20:${chainId}:${tokenAddress.toLowerCase()}`;
}

function parseTokenBinding(env: NodeJS.ProcessEnv): { chainId: number; tokenAddress: `0x${string}` } {
  const tokenAddress = env.PICOCASH_TEMPO_TOKEN ?? '0x20c0000000000000000000000000000000000000'; // pathUSD on Moderato
  if (!ADDRESS_RE.test(tokenAddress)) throw new Error('PICOCASH_TEMPO_TOKEN must be a 0x… address');
  return { chainId: Number(env.PICOCASH_TEMPO_CHAIN_ID ?? 42431), tokenAddress: tokenAddress as `0x${string}` };
}

function loadTempoConfig(env: NodeJS.ProcessEnv): TempoConfig {
  const depositAddress = env.PICOCASH_DEPOSIT_ADDRESS;
  if (!depositAddress || !ADDRESS_RE.test(depositAddress)) {
    throw new Error('PICOCASH_DEPOSIT_ADDRESS (0x…, 20 bytes) is required for PICOCASH_VAULT=tempo');
  }
  const { chainId, tokenAddress } = parseTokenBinding(env);
  return {
    rpcUrl: env.PICOCASH_TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz',
    chainId,
    tokenAddress,
    depositAddress: depositAddress as `0x${string}`,
    operatorKey: /^0x[0-9a-fA-F]{64}$/.test(env.PICOCASH_OPERATOR_KEY ?? '')
      ? (env.PICOCASH_OPERATOR_KEY as `0x${string}`)
      : undefined,
    confirmations: Number(env.PICOCASH_TEMPO_CONFIRMATIONS ?? 1),
    lookbackBlocks: BigInt(env.PICOCASH_TEMPO_LOOKBACK ?? 5_000),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MintConfig {
  const vault = env.PICOCASH_VAULT === 'tempo' ? 'tempo' : 'fake';
  const fakeVault = vault === 'fake';
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
  const binding = parseTokenBinding(env);
  return {
    name: env.PICOCASH_MINT_NAME ?? 'picocash dev mint',
    unit: tip20Unit(binding.chainId, binding.tokenAddress),
    seed,
    port: Number(env.PORT ?? 3338),
    databaseUrl: env.DATABASE_URL,
    vault,
    fakeVault,
    ...(vault === 'tempo' ? { tempo: loadTempoConfig(env) } : {}),
    maxMintAmount: Number(env.PICOCASH_MAX_MINT_AMOUNT ?? 100_000_000), // $100
    maxOutstanding: Number(env.PICOCASH_MAX_OUTSTANDING ?? 0),
    meltFee: Number(env.PICOCASH_MELT_FEE ?? 10_000), // $0.01: ~2–20x observed payout gas on Moderato
    relay: {
      enabled: env.PICOCASH_RELAY !== '0',
      maxBytes: Number(env.PICOCASH_RELAY_MAX_BYTES ?? 16_384),
      ttlSeconds: Number(env.PICOCASH_RELAY_TTL_SECONDS ?? 86_400),
      uiUrl: env.PICOCASH_RELAY_UI, // e.g. https://picocash.dev/demo/ — browser hits on /t/:id redirect here
    },
    quoteTtlSeconds: Number(env.PICOCASH_QUOTE_TTL_SECONDS ?? 900),
  };
}
