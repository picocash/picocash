/**
 * Proof of liabilities (spec/05): read outstanding supply from the running
 * mint's public /v1/solvency endpoint, verify the invariant against the
 * vault's on-chain balance, and publish it via vault.publishOutstandingSupply.
 *
 * The vault carries a deploy-time publication policy (drift threshold and/or
 * block interval); this script polls vault.isPublicationDue() and publishes
 * only when the policy calls for it — so run it from cron as often as you
 * like (every minute is fine), and transactions happen exactly when they
 * carry information.
 *
 *   npx tsx scripts/publish-solvency.ts          # publish if due
 *   npx tsx scripts/publish-solvency.ts --force  # publish regardless
 *   npx tsx scripts/publish-solvency.ts --check  # report only, never publish
 *
 * Env: MINT_URL (default http://localhost:3338), PICOCASH_OPERATOR_KEY +
 * PICOCASH_TEMPO_RPC from .env for publishing.
 */
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

try {
  process.loadEnvFile();
} catch {
  /* env vars only */
}

const MINT_URL = process.env.MINT_URL ?? 'http://localhost:3338';
const res = await fetch(`${MINT_URL}/v1/solvency`);
if (!res.ok) throw new Error(`GET /v1/solvency → ${res.status}`);
const solvency = (await res.json()) as {
  keyset_id: string;
  unit: string;
  outstanding: number;
  vault: { chain_id: number; address: `0x${string}`; token: `0x${string}` } | 'fake';
};
if (solvency.vault === 'fake') throw new Error('mint is on the fake vault; nothing to publish');

const chain = defineChain({
  id: solvency.vault.chain_id,
  name: `tempo-${solvency.vault.chain_id}`,
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: [process.env.PICOCASH_TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'] } },
});
const publicClient = createPublicClient({ chain, transport: http() });
const vaultBalance = await publicClient.readContract({
  address: solvency.vault.token,
  abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
  functionName: 'balanceOf',
  args: [solvency.vault.address],
});

const [due, overdue] = await Promise.all([
  publicClient.readContract({ address: solvency.vault.address, abi: parseAbi(['function isPublicationDue() view returns (bool)']), functionName: 'isPublicationDue' }),
  publicClient.readContract({ address: solvency.vault.address, abi: parseAbi(['function isPublicationOverdue() view returns (bool)']), functionName: 'isPublicationOverdue' }),
]);

const solvent = vaultBalance >= BigInt(solvency.outstanding);
console.log(`keyset ${solvency.keyset_id} (${solvency.unit})`);
console.log(`outstanding tokens : ${solvency.outstanding} base units ($${(solvency.outstanding / 1e6).toFixed(6)})`);
console.log(`vault balance      : ${vaultBalance} base units ($${(Number(vaultBalance) / 1e6).toFixed(6)})`);
console.log(`solvency invariant : vault ≥ outstanding → ${solvent ? 'HOLDS' : 'VIOLATED'}`);
console.log(`publication policy : due=${due} overdue=${overdue}`);
if (!solvent) {
  console.error('SOLVENCY VIOLATION — refusing to publish; investigate immediately');
  process.exit(2);
}
if (process.argv.includes('--check')) process.exit(0);
if (!due && !process.argv.includes('--force')) {
  console.log('not due per the vault policy — nothing to publish (use --force to override)');
  process.exit(0);
}

const operatorKey = process.env.PICOCASH_OPERATOR_KEY as `0x${string}` | undefined;
if (!operatorKey) throw new Error('PICOCASH_OPERATOR_KEY required to publish');
const wallet = createWalletClient({ account: privateKeyToAccount(operatorKey), chain, transport: http() });
const hash = await wallet.writeContract({
  address: solvency.vault.address,
  abi: parseAbi(['function publishOutstandingSupply(bytes8 keysetId, uint256 outstanding)']),
  functionName: 'publishOutstandingSupply',
  args: [`0x${solvency.keyset_id}` as `0x${string}`, BigInt(solvency.outstanding)],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
console.log(`published on-chain: tx ${hash} (${receipt.status})`);
