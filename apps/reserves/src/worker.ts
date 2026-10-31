/**
 * Cloudflare Worker adapter: serves the dashboard and JSON API from KV; the
 * cron refreshes it. `POST /v1/refresh` with the REFRESH_TOKEN secret forces a
 * refresh (used right after deploy and in ops).
 */
import { handleRequest, runRefresh } from './app.js';

export interface Env {
  RESERVES: KVNamespace;
  TEMPO_RPC: string;
  TEMPO_CHAIN_ID: string;
  TIP20_FACTORY: string;
  REFRESH_TOKEN?: string;
}

const chainOf = (env: Env) => ({ rpcUrl: env.TEMPO_RPC, chainId: Number(env.TEMPO_CHAIN_ID), factory: env.TIP20_FACTORY });
const log = (m: string) => console.log('[reserves]', m);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, {
      kv: env.RESERVES,
      refreshToken: env.REFRESH_TOKEN,
      triggerRefresh: () => ctx.waitUntil(runRefresh(env.RESERVES, chainOf(env), log)),
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRefresh(env.RESERVES, chainOf(env), log));
  },
};
