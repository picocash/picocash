/**
 * An AgentCash-style agent paying a picocash-gated API.
 *
 * The agent uses mppx's payment-aware fetch (the same `Fetch.from` an
 * AgentCash agent uses for tempo/x402) with the picocash client method
 * plugged in. On a 402 it mints challenge-bound proofs from its wallet and
 * retries — no on-chain transaction on the request path, no payer address on
 * the wire.
 *
 * Funding is the one on-chain step: a faucet-funded key deposits pathUSD to the
 * mint's vault once, and that single deposit funds every call below.
 *
 *   npx tsx apps/agentcash-demo/agent.ts       # from the repo root
 *
 * Needs PICOCASH_E2E_PAYER_KEY (a faucet-funded testnet wallet) in
 * packages/mint/.env, and the server from server.ts running.
 */
import { Fetch } from 'mppx/client';
import { Wallet, sumProofs, type Proof } from '@picocash/sdk';
import { picocash } from '@picocash/mppx-method/mppx';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

try {
  process.loadEnvFile('packages/mint/.env');
} catch {
  /* rely on process env */
}

const MINT_URL = process.env.MINT_URL ?? 'https://mint.picocash.dev';
const SERVER = process.env.SERVER_URL ?? 'http://localhost:8402';
const FUND = Number(process.env.FUND_AMOUNT ?? 50_000); // $0.05
const CALLS = Number(process.env.CALLS ?? 3);
const payerKey = process.env.PICOCASH_E2E_PAYER_KEY as `0x${string}` | undefined;

const wallet = new Wallet({ mintUrl: MINT_URL });
const keyset = await wallet.getKeyset();
let proofs: Proof[] = [];

/** One on-chain deposit → mint eCash. Reuses the testnet-e2e deposit path. */
async function fund(amount: number): Promise<void> {
  if (!payerKey) throw new Error('PICOCASH_E2E_PAYER_KEY not set (packages/mint/.env)');
  const quote = await wallet.requestMintQuote(amount);
  const dep = (quote as unknown as { deposit: { chain_id: number; token: `0x${string}`; to: `0x${string}`; memo: `0x${string}` } }).deposit;
  console.log(`[agent] funding: deposit ${amount} to vault ${dep.to.slice(0, 10)}… (memo = quote id)`);

  const chain = defineChain({
    id: dep.chain_id,
    name: 'tempo-moderato',
    nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
    rpcUrls: { default: { http: [process.env.PICOCASH_TEMPO_RPC ?? 'https://rpc.moderato.tempo.xyz'] } },
  });
  const account = privateKeyToAccount(payerKey);
  const wc = createWalletClient({ account, chain, transport: http() });
  const pub = createPublicClient({ chain, transport: http() });
  const txHash = await wc.writeContract({
    address: dep.token,
    abi: parseAbi(['function transferWithMemo(address to, uint256 amount, bytes32 memo)']),
    functionName: 'transferWithMemo',
    args: [dep.to, BigInt(amount), dep.memo],
  });
  await pub.waitForTransactionReceipt({ hash: txHash });
  console.log(`[agent] deposit tx ${txHash.slice(0, 18)}… confirmed; waiting for the mint oracle…`);

  const start = Date.now();
  let state = (quote as { state?: string }).state;
  while (state !== 'PAID') {
    if (Date.now() - start > 120_000) throw new Error('timed out waiting for PAID');
    await new Promise((r) => setTimeout(r, 1500));
    state = (await wallet.getMintQuote((quote as { quote_id: string }).quote_id)).state;
  }
  proofs = await wallet.mintProofs((quote as { quote_id: string }).quote_id, amount);
  console.log(`[agent] minted ${sumProofs(proofs)} ${keyset.unit} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

await fund(FUND);

// Payment-aware fetch: the picocash client method answers 402s from the wallet.
const pay = Fetch.from({
  methods: [
    picocash({
      wallet,
      getProofs: () => proofs,
      onChange: (change) => {
        proofs = change;
      },
    }),
  ],
  onChallenge: async (_challenge, { createCredential }) => createCredential(),
});

for (let i = 1; i <= CALLS; i++) {
  const t0 = performance.now();
  const res = await pay(`${SERVER}/fortune`);
  const ms = performance.now() - t0;
  const body = (await res.json()) as { fortune?: string; error?: unknown };
  const receipt = res.headers.get('Payment-Receipt');
  const decoded = receipt ? JSON.parse(Buffer.from(receipt.split(' ').pop()!, 'base64url').toString()) : null;
  console.log(
    `\n[agent] call ${i}: ${res.status} in ${ms.toFixed(0)}ms\n` +
      `        “${body.fortune ?? JSON.stringify(body.error)}”\n` +
      `        receipt: settlement=${decoded?.settlement} ref=${decoded?.reference?.slice?.(0, 12) ?? '—'} amount=${decoded?.amount}\n` +
      `        wallet balance: ${sumProofs(proofs)} ${keyset.unit}`,
  );
}
console.log(`\n[agent] done — one deposit funded ${CALLS} offline-verified calls, no on-chain tx per call.`);
