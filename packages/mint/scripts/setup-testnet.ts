/**
 * One-shot local testnet setup: generates a mint seed, operator wallet, and
 * e2e payer wallet into .env (never printed, never committed), then funds both
 * wallets from the Tempo Moderato faucet. Refuses to overwrite an existing .env.
 *
 *   npx tsx scripts/setup-testnet.ts
 *   npm run dev
 *   npx tsx scripts/testnet-e2e.ts
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const ENV_PATH = new URL('../.env', import.meta.url).pathname;
const FAUCET = 'https://tempo.xyz/developers/api/faucet';

if (existsSync(ENV_PATH)) {
  console.error(`.env already exists at ${ENV_PATH} — refusing to overwrite key material`);
  process.exit(1);
}

const operatorKey = generatePrivateKey();
const payerKey = generatePrivateKey();
const operator = privateKeyToAccount(operatorKey);
const payer = privateKeyToAccount(payerKey);

writeFileSync(
  ENV_PATH,
  [
    '# picocash mint — Tempo Moderato testnet config (TESTNET ONLY; gitignored, never commit)',
    'PICOCASH_VAULT=tempo',
    `PICOCASH_MINT_SEED=${randomBytes(32).toString('hex')}`,
    `PICOCASH_DEPOSIT_ADDRESS=${operator.address}`,
    `PICOCASH_OPERATOR_KEY=${operatorKey}`,
    'PICOCASH_TEMPO_RPC=https://rpc.moderato.tempo.xyz',
    'PICOCASH_TEMPO_CHAIN_ID=42431',
    'PICOCASH_TEMPO_TOKEN=0x20c0000000000000000000000000000000000000',
    'PICOCASH_TEMPO_CONFIRMATIONS=1',
    '# test payer wallet for scripts/testnet-e2e.ts',
    `PICOCASH_E2E_PAYER_KEY=${payerKey}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`wrote ${ENV_PATH}`);
console.log(`operator/deposit address: ${operator.address}`);
console.log(`e2e payer address:        ${payer.address}`);

for (const [label, address] of [['operator', operator.address], ['payer', payer.address]] as const) {
  const res = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const body = (await res.json()) as { data?: unknown; error?: unknown };
  if (!res.ok || body.error) {
    console.error(`faucet failed for ${label}: ${JSON.stringify(body)} — retry later or use https://tempo.xyz/developers/docs/quickstart/faucet`);
  } else {
    console.log(`faucet funded ${label} (${address})`);
  }
}
console.log('done — start the mint with: npm run dev');
console.log('note: PICOCASH_DEPOSIT_ADDRESS is the operator EOA for a quick start; for the full');
console.log('vault flow, deploy PicocashVault (github.com/picocash/picocash-contracts) with this');
console.log('operator and token, then set PICOCASH_DEPOSIT_ADDRESS to the vault address.');
