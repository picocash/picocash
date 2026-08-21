/**
 * PIP-04 §Emergency redemption — holder-side CLI. Redeems picocash proofs at
 * the vault DIRECTLY, with no mint involved. Works only while the vault is in
 * emergency mode (attestation overdue past the grace period).
 *
 *   VAULT_ADDRESS=0x… REDEEMER_KEY=0x… npx tsx scripts/emergency-redeem.ts proofs.json [--to 0x…] [--unlock-key 0x…]
 *
 * proofs.json: a picoA token string, or a JSON array of proofs {amount, keyset_id, secret, C, dleq{e,s,r}, witness?}.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseToken, parseP2pkSecret, signProofs, type Proof } from '@picocash/sdk';

try {
  process.loadEnvFile();
} catch {
  /* env vars only */
}
const VAULT = process.env.VAULT_ADDRESS as Hex;
const KEY = (process.env.REDEEMER_KEY ?? process.env.PICOCASH_E2E_PAYER_KEY) as Hex;
const file = process.argv[2];
if (!VAULT || !KEY || !file) throw new Error('usage: VAULT_ADDRESS=0x… REDEEMER_KEY=0x… emergency-redeem.ts <token-or-proofs.json> [--to 0x…] [--unlock-key 0x…]');
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

const raw = readFileSync(file, 'utf8').trim();
let proofs: Proof[] = raw.startsWith('pico') ? parseToken(raw).bundle.proofs : (JSON.parse(raw) as Proof[]);
const unlock = arg('--unlock-key');
if (unlock) proofs = signProofs(proofs, Buffer.from(unlock.replace(/^0x/, ''), 'hex'));

const chain = defineChain({ id: Number(process.env.CHAIN_ID ?? 42431), name: 'tempo', nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: { default: { http: [process.env.PICOCASH_TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'] } } });
const abi = parseAbi([
  'struct P2pk { bool present; string nonce; string data; string[][] tags; }',
  'struct Proof { uint256 amount; bytes8 keysetId; bytes secret; bytes C; bytes32 e; bytes32 s; bytes32 r; P2pk p2pk; bytes[] signatures; }',
  'function emergencyRedeem(Proof[] proofs, address to)',
  'function emergencyInfo() view returns (bool mode, uint64 graceBlocks, uint256 redeemed, uint256 cap, address verifier)',
  'event EmergencyRedeemed(bytes32 indexed y, bytes8 indexed keysetId, uint256 amount, address indexed to)',
]);
const pub = createPublicClient({ chain, transport: http() });
const account = privateKeyToAccount(KEY);
const wallet = createWalletClient({ account, chain, transport: http() });
const to = (arg('--to') ?? account.address) as Hex;

const [mode, grace, redeemed, cap] = await pub.readContract({ address: VAULT, abi, functionName: 'emergencyInfo' });
console.log(`vault ${VAULT}: emergencyMode=${mode} grace=${grace} redeemed=${redeemed} cap=${cap}`);
if (!mode) throw new Error('vault is not in emergency mode — use the mint\'s normal melt path');

const onchain = proofs.map((p) => {
  if (!p.dleq) throw new Error('proof has no DLEQ payload; cannot be redeemed on-chain');
  const c = parseP2pkSecret(p.secret);
  const sigs = p.witness ? (JSON.parse(p.witness).signatures as string[]).map((s) => `0x${s}` as Hex) : [];
  return {
    amount: BigInt(p.amount), keysetId: `0x${p.keyset_id}` as Hex, secret: `0x${p.secret}` as Hex, C: `0x${p.C}` as Hex,
    e: `0x${p.dleq.e}` as Hex, s: `0x${p.dleq.s}` as Hex, r: `0x${p.dleq.r}` as Hex,
    p2pk: c ? { present: true, nonce: c.nonce, data: c.data, tags: c.tags } : { present: false, nonce: '', data: '', tags: [] as string[][] },
    signatures: sigs,
  };
});
const total = proofs.reduce((s, p) => s + p.amount, 0);
console.log(`redeeming ${proofs.length} proof(s), ${total} base units, to ${to}`);
const hash = await wallet.writeContract({ address: VAULT, abi, functionName: 'emergencyRedeem', args: [onchain, to] });
const rc = await pub.waitForTransactionReceipt({ hash });
console.log(`tx ${hash}: ${rc.status} (gas ${rc.gasUsed}); ${rc.logs.length} event(s)`);
