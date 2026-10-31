/**
 *   UPSTREAM_URL=https://openrouter.ai/api UPSTREAM_API_KEY=sk-… \
 *   PAID_LLM_LOCK_KEY=<32-byte hex> MPP_SECRET_KEY=<≥32 bytes> \
 *   npx tsx apps/paid-llm/src/server.ts
 *
 * Then point any OpenAI-compatible client at http://localhost:8403/v1 with a
 * picocash-paying fetch (the @picocash/mcp `fetch_paid` tool, or mppx's client).
 */
import { serve } from '@hono/node-server';
import { hexToBytes } from '@picocash/crypto';
import { createPaidLlmApp } from './app.js';

try {
  process.loadEnvFile();
} catch {
  /* env only */
}

const PORT = Number(process.env.PORT ?? 8403);
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const { app, lockPubkey, keyset } = await createPaidLlmApp({
  mintUrl: (process.env.PICOCASH_MINT_URL ?? 'https://mint.picocash.dev').replace(/\/$/, ''),
  realm: process.env.PAID_LLM_REALM ?? `http://localhost:${PORT}`,
  secretKey: need('MPP_SECRET_KEY'),
  upstreamUrl: need('UPSTREAM_URL'),
  upstreamApiKey: need('UPSTREAM_API_KEY'),
  lockKey: hexToBytes(need('PAID_LLM_LOCK_KEY')),
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[paid-llm] http://localhost:${info.port}/v1/chat/completions · unit ${keyset.unit}`);
  console.log(`[paid-llm] lock budgets to pubkey ${lockPubkey}`);
  console.log(`[paid-llm] upstream ${process.env.UPSTREAM_URL} (key held server-side; agents never see it)`);
});
