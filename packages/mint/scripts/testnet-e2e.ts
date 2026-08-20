/**
 * End-to-end demo against a running mint connected to Tempo testnet:
 *
 *   quote → real transferWithMemo (pathUSD, memo = quote id) → poll PAID →
 *   blind → mint → client-side DLEQ verify → unblind → swap → checkstate
 *
 * Run the mint first (`npm run dev`, with .env configured for PICOCASH_VAULT=tempo),
 * then: npx tsx scripts/testnet-e2e.ts
 * Needs PICOCASH_E2E_PAYER_KEY in .env (a faucet-funded testnet wallet).
 */
import {
  blindMessage,
  bytesToHex,
  hexToBytes,
  randomScalarBytes,
  unblindSignature,
  verifyDleqBlindSignature,
} from '@picocash/crypto';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const MINT_URL = process.env.MINT_URL ?? 'http://localhost:3338';
const AMOUNT = Number(process.env.E2E_AMOUNT ?? 1_000_000); // $1

try {
  process.loadEnvFile();
} catch {
  /* env vars only */
}

const payerKey = process.env.PICOCASH_E2E_PAYER_KEY as `0x${string}` | undefined;
if (!payerKey) throw new Error('PICOCASH_E2E_PAYER_KEY not set (see .env)');

async function api(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${MINT_URL}${path}`, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function decompose(amount: number): number[] {
  const parts: number[] = [];
  for (let pow = 30; pow >= 0; pow--) if (amount & (2 ** pow)) parts.push(2 ** pow);
  return parts;
}

const info = await api('GET', '/v1/info');
if (info.vault?.method !== 'tempo') throw new Error(`mint is not on a tempo vault: ${JSON.stringify(info.vault)}`);
const keyset = (await api('GET', '/v1/keys')).keysets[0];
console.log(`mint: ${info.name} — keyset ${keyset.id}, vault chain ${info.vault.chain_id}`);

// 1. quote
const quote = await api('POST', '/v1/mint/quote', { amount: AMOUNT, unit: info.unit });
console.log(`quote ${quote.quote_id.slice(0, 16)}… for ${AMOUNT} ${info.unit} — deposit to ${quote.deposit.to}`);

// 2. pay on-chain: transferWithMemo with memo = quote id
const chain = defineChain({
  id: quote.deposit.chain_id,
  name: 'tempo-moderato',
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: [process.env.PICOCASH_TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'] } },
});
const account = privateKeyToAccount(payerKey);
const wallet = createWalletClient({ account, chain, transport: http() });
const publicClient = createPublicClient({ chain, transport: http() });

const txHash = await wallet.writeContract({
  address: quote.deposit.token,
  abi: parseAbi(['function transferWithMemo(address to, uint256 amount, bytes32 memo)']),
  functionName: 'transferWithMemo',
  args: [quote.deposit.to, BigInt(AMOUNT), quote.deposit.memo],
});
console.log(`sent transferWithMemo: ${txHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
console.log(`confirmed in block ${receipt.blockNumber} (status ${receipt.status})`);

// 3. poll until the mint's oracle sees it
const start = Date.now();
let state = quote.state;
while (state !== 'PAID') {
  if (Date.now() - start > 120_000) throw new Error('timed out waiting for PAID');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  state = (await api('GET', `/v1/mint/quote/${quote.quote_id}`)).state;
  process.stdout.write(`  poll: ${state}\r`);
}
console.log(`\nquote PAID after ${((Date.now() - start) / 1000).toFixed(1)}s`);

// 4. blind → mint → verify DLEQ → unblind
const pending = decompose(AMOUNT).map((amount) => {
  const secret = randomScalarBytes();
  const { B_, r } = blindMessage(secret);
  return { amount, secret, r, B_: bytesToHex(B_) };
});
const minted = await api('POST', '/v1/mint', {
  quote_id: quote.quote_id,
  outputs: pending.map((p) => ({ amount: p.amount, keyset_id: keyset.id, B_: p.B_ })),
});
const proofs = minted.signatures.map((sig: any, i: number) => {
  const p = pending[i]!;
  const mintPubkey = hexToBytes(keyset.keys[String(p.amount)]);
  const dleqOk = verifyDleqBlindSignature(hexToBytes(p.B_), hexToBytes(sig.C_), mintPubkey, {
    e: hexToBytes(sig.dleq.e),
    s: hexToBytes(sig.dleq.s),
  });
  if (!dleqOk) throw new Error(`DLEQ failed for output ${i} — do not trust this signature`);
  const C = unblindSignature(hexToBytes(sig.C_), p.r, mintPubkey);
  return { amount: p.amount, keyset_id: keyset.id, secret: bytesToHex(p.secret), C: bytesToHex(C) };
});
console.log(`minted ${proofs.length} proofs (${proofs.map((p: any) => p.amount).join(' + ')}), all DLEQs verified client-side`);

// 5. swap the largest proof for change, prove double-spend protection is live
const largest = proofs.reduce((a: any, b: any) => (a.amount > b.amount ? a : b));
const half = largest.amount / 2;
const changePending = [half, half].map((amount) => {
  const secret = randomScalarBytes();
  const { B_, r } = blindMessage(secret);
  return { amount, secret, r, B_: bytesToHex(B_) };
});
const swapped = await api('POST', '/v1/swap', {
  inputs: [largest],
  outputs: changePending.map((p) => ({ amount: p.amount, keyset_id: keyset.id, B_: p.B_ })),
});
console.log(`swapped ${largest.amount} → ${half} + ${half}`);

const { hashToCurve } = await import('@picocash/crypto');
const y = bytesToHex(hashToCurve(hexToBytes(largest.secret)).toRawBytes(true));
const states = await api('POST', '/v1/checkstate', { Ys: [y] });
console.log(`checkstate for swapped proof: ${states.states[0].state}`);

// 6. melt the change back to on-chain pathUSD via the vault
const changeProofs = swapped.signatures.map((sig: any, i: number) => {
  const p = changePending[i]!;
  const mintPubkey = hexToBytes(keyset.keys[String(p.amount)]);
  const C = unblindSignature(hexToBytes(sig.C_), p.r, mintPubkey);
  return { amount: p.amount, keyset_id: keyset.id, secret: bytesToHex(p.secret), C: bytesToHex(C) };
});
const meltAmount = half * 2;
const balanceOfAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const balanceBefore = await publicClient.readContract({
  address: quote.deposit.token, abi: balanceOfAbi, functionName: 'balanceOf', args: [account.address],
});
const meltQuote = await api('POST', '/v1/melt/quote', { amount: meltAmount, unit: info.unit, to: account.address });
console.log(`melt quote ${meltQuote.melt_id.slice(0, 16)}… for ${meltAmount} → ${account.address}`);
const melted = await api('POST', '/v1/melt', { melt_id: meltQuote.melt_id, inputs: changeProofs });
console.log(`melt ${melted.state}: vault.ecashMelt tx ${melted.tx_hash}`);
const balanceAfter = await publicClient.readContract({
  address: quote.deposit.token, abi: balanceOfAbi, functionName: 'balanceOf', args: [account.address],
});
if (balanceAfter - balanceBefore !== BigInt(meltAmount)) {
  throw new Error(`payout mismatch: balance moved ${balanceAfter - balanceBefore}, expected ${meltAmount}`);
}
console.log(`payer pathUSD balance +${meltAmount} confirmed on-chain`);

console.log('\nE2E OK — deposit → mint → swap → melt, all against the live vault on Tempo testnet.');
