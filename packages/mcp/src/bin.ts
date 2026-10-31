#!/usr/bin/env node
/**
 * stdio entry point — what a harness launches:
 *
 *   BUZZ_PRIVATE_KEY=nsec1… PICOCASH_MINT_URL=https://mint.picocash.dev picocash-mcp
 *
 * Add BUZZ_RELAY_URL + PICOCASH_OWNER_PUBKEY (or PICOCASH_STORE=engram) to keep
 * the wallet as an owner-readable engram on the agent's relay instead of a file.
 * Logs go to stderr; stdout is the MCP channel.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { createMcpServer } from './server.js';
import { buildStore } from './store-factory.js';
import { WalletService } from './wallet-service.js';

const config = configFromEnv();
const service = new WalletService({ mintUrl: config.mintUrl, privkey: config.privkey, store: buildStore(config) });
const server = createMcpServer(service);
await server.connect(new StdioServerTransport());
console.error(`[picocash-mcp] ${service.npub} · mint ${config.mintUrl} · store ${config.store.kind}`);
