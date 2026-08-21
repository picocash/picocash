/**
 * PIP-04 §Emergency redemption: register the mint's keyset public keys on its
 * vault so holders can redeem at the vault directly if the mint ever goes dark.
 *
 *   MINT_URL=https://mint.picocash.dev VAULT_ADDRESS=0x… PICOCASH_OPERATOR_KEY=0x… npx tsx scripts/register-keyset.ts
 *
 * Reads GET /v1/keys (the same keys every wallet already trusts), so what the
 * vault stores is exactly what the mint serves. Append-only on-chain; safe to re-run.
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

try {
  process.loadEnvFile();
} catch {
  /* env vars only */
}

const MINT_URL = process.env.MINT_URL ?? 'http://localhost:3338';
const VAULT = (process.env.VAULT_ADDRESS ?? process.env.PICOCASH_DEPOSIT_ADDRESS) as `0x${string}`;
const KEY = process.env.PICOCASH_OPERATOR_KEY as `0x${string}`;
if (!VAULT || !KEY) throw new Error('VAULT_ADDRESS (or PICOCASH_DEPOSIT_ADDRESS) and PICOCASH_OPERATOR_KEY are required');

const info = (await (await fetch(`${MINT_URL}/v1/info`)).json()) as { vault: { chain_id: number } | 'fake' };
if (info.vault === 'fake') throw new Error('mint is on the fake vault');
const keys = (await (await fetch(`${MINT_URL}/v1/keys`)).json()) as { keysets: Array<{ id: string; unit: string; keys: Record<string, string> }> };
const keyset = keys.keysets[0]!;
const amounts = Object.keys(keyset.keys).map(Number).sort((a, b) => a - b);
const pubkeys = amounts.map((a) => `0x${keyset.keys[String(a)]}` as `0x${string}`);

const chain = defineChain({
  id: info.vault.chain_id,
  name: `tempo-${info.vault.chain_id}`,
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: [process.env.PICOCASH_TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'] } },
});
const abi = parseAbi([
  'function registerKeyset(bytes8 keysetId, uint256[] amounts, bytes[] pubkeys)',
  'function keysetKey(bytes8 keysetId, uint256 amount) view returns (bytes)',
  'function emergencyInfo() view returns (bool mode, uint64 graceBlocks, uint256 redeemed, uint256 cap, address verifier)',
]);
const publicClient = createPublicClient({ chain, transport: http() });
const account = privateKeyToAccount(KEY);
const wallet = createWalletClient({ account, chain, transport: http() });
const keysetId = `0x${keyset.id}` as `0x${string}`;

const already = await publicClient.readContract({ address: VAULT, abi, functionName: 'keysetKey', args: [keysetId, BigInt(amounts[amounts.length - 1]!)] });
if (already !== '0x') {
  console.log(`keyset ${keyset.id}: ${amounts.length} denominations already registered on ${VAULT}`);
} else {
  const hash = await wallet.writeContract({ address: VAULT, abi, functionName: 'registerKeyset', args: [keysetId, amounts.map(BigInt), pubkeys] });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`registered keyset ${keyset.id} (${amounts.length} denominations, unit ${keyset.unit}) on ${VAULT}: ${hash} (${rc.status}, gas ${rc.gasUsed})`);
}
const [mode, grace, redeemed, cap, verifier] = await publicClient.readContract({ address: VAULT, abi, functionName: 'emergencyInfo' });
console.log(`emergency: mode=${mode} graceBlocks=${grace} redeemed=${redeemed} cap=${cap} verifier=${verifier}`);
