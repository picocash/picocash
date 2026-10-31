/**
 * MCP surface over WalletService. Tool names and descriptions are written from
 * the agent's side of the screen — what it is doing, not how the system works.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WalletService } from './wallet-service.js';

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] };
}

export function createMcpServer(service: WalletService): McpServer {
  const server = new McpServer({ name: 'picocash', version: '0.1.0' });

  server.registerTool(
    'balance',
    {
      title: 'Wallet balance',
      description: 'How much eCash this agent can spend right now (base units of the mint unit, e.g. 10000 = $0.01 for a 6-decimal stablecoin), plus anything reserved by an in-flight payment or locked to another key.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await service.balance());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'fetch_paid',
    {
      title: 'Fetch a URL, paying if required',
      description: 'GET/POST a URL. If the service answers 402 with a picocash challenge, pay it from the wallet automatically and return the paid response. No on-chain transaction, no payer address revealed. Returns status, body, the payment receipt, and what it cost.',
      inputSchema: {
        url: z.string().url(),
        method: z.enum(['GET', 'POST']).optional(),
        headers: z.record(z.string()).optional(),
        body: z.string().optional().describe('Request body for POST'),
      },
    },
    async ({ url, method, headers, body }) => {
      try {
        return text(await service.fetchPaid(url, { ...(method ? { method } : {}), ...(headers ? { headers } : {}), ...(body ? { body } : {}) }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'send',
    {
      title: 'Send eCash to someone',
      description: 'Create a token for `amount` base units LOCKED to the recipient\'s npub, so only they can claim it (safe to paste anywhere, even a public channel). By default any unclaimed amount refunds to this wallet after `locktime`. Only pass unlocked=true if you are sending over a private DM and the recipient has no npub — an unlocked token is cash to whoever sees it.',
      inputSchema: {
        amount: z.number().int().positive(),
        to_npub: z.string().optional().describe('Recipient npub (or x-only hex). Omit ONLY with unlocked=true.'),
        locktime: z.number().int().positive().optional().describe('Unix seconds after which the refund key may reclaim the token'),
        memo: z.string().max(512).optional(),
        unlocked: z.boolean().optional().describe('Explicit opt-in to an unlocked bearer token'),
      },
    },
    async ({ amount, to_npub, locktime, memo, unlocked }) => {
      try {
        return text(
          await service.send(amount, {
            ...(to_npub ? { toNpub: to_npub } : {}),
            ...(locktime !== undefined ? { locktime } : {}),
            ...(memo ? { memo } : {}),
            ...(unlocked ? { unlocked } : {}),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'receive',
    {
      title: 'Receive eCash',
      description: 'Claim a picocash token string or short link that was sent to this agent. Verifies it offline; if it was locked to this agent (or unlocked) it is swapped into fresh proofs so the sender can no longer spend it. If it is a budget locked to a MERCHANT (spendable only there), it is held as-is and shows under locked_to_merchants; fetch_paid uses it automatically at that merchant.',
      inputSchema: { token: z.string().min(1).describe('A picoA token string or a https://…/t/… link') },
    },
    async ({ token }) => {
      try {
        return text(await service.receive(token));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'melt',
    {
      title: 'Withdraw to an on-chain address',
      description: 'Redeem `amount` base units of eCash for the backing stablecoin, paid on-chain to `to`. The mint\'s melt fee is taken from the wallet on top of `amount`.',
      inputSchema: {
        amount: z.number().int().positive(),
        to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 20-byte 0x address'),
      },
    },
    async ({ amount, to }) => {
      try {
        return text(await service.melt(amount, to));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'history',
    {
      title: 'Recent wallet activity',
      description: 'Most recent payments, receipts, sends and withdrawals, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) => {
      try {
        return text(await service.history(limit ?? 20));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}
