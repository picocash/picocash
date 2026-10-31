/**
 * The HTTP surface and the refresh runner, independent of where they run.
 * `worker.ts` (Cloudflare) and `server.ts` (Node/container) are thin adapters
 * over these two functions.
 */
import { Rpc } from './chain.js';
import { page } from './page.js';
import { refresh } from './refresh.js';
import { Store, type KvLike } from './store.js';

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
  factory: string;
}

export interface AppDeps {
  kv: KvLike;
  refreshToken?: string | undefined;
  /** Start a refresh in the background (the caller decides how to keep it alive). */
  triggerRefresh: () => void;
}

export interface LastRun {
  ok: boolean;
  at: string;
  ms: number;
  tokens?: number;
  errors?: string[];
  error?: string;
}

const json = (data: unknown, status = 200, cache = 'public, max-age=60') =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'access-control-allow-origin': '*' } });

/** Run one refresh and record the outcome under `last_run`, so a failing schedule is visible in /healthz instead of silent. */
export async function runRefresh(kv: KvLike, chain: ChainConfig, log: (m: string) => void = () => {}): Promise<LastRun> {
  const store = new Store(kv);
  const started = Date.now();
  let result: LastRun;
  try {
    const snap = await refresh({ rpc: new Rpc(chain.rpcUrl), store, chainId: chain.chainId, factory: chain.factory, log });
    result = { ok: true, at: new Date().toISOString(), ms: Date.now() - started, tokens: snap.tokens.length, errors: snap.errors };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log(`refresh failed: ${message}`);
    result = { ok: false, at: new Date().toISOString(), ms: Date.now() - started, error: message };
  }
  await kv.put('last_run', JSON.stringify(result));
  return result;
}

export async function handleRequest(request: Request, deps: AppDeps): Promise<Response> {
  const url = new URL(request.url);
  const store = new Store(deps.kv);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return new Response(page(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } });
  }
  if (url.pathname === '/livez') return json({ ok: true }, 200, 'no-store');
  if (url.pathname === '/v1/tokens') {
    const snap = await store.getSnapshot();
    return snap ? json(snap) : json({ error: 'no snapshot yet; refresh pending' }, 503, 'no-store');
  }
  const tokenMatch = url.pathname.match(/^\/v1\/tokens\/(0x[0-9a-fA-F]{40})$/);
  if (tokenMatch) {
    const snap = await store.getSnapshot();
    const t = snap?.tokens.find((x) => x.address === tokenMatch[1]!.toLowerCase());
    return t ? json({ ...t, block: snap!.block, refreshedAt: snap!.refreshedAt }) : json({ error: 'unknown token' }, 404, 'no-store');
  }
  const histMatch = url.pathname.match(/^\/v1\/history\/(0x[0-9a-fA-F]{40})$/);
  if (histMatch) return json(await store.getHistory(histMatch[1]!), 200, 'public, max-age=300');
  if (url.pathname === '/v1/refresh' && request.method === 'POST') {
    const auth = request.headers.get('authorization') ?? '';
    if (!deps.refreshToken || auth !== `Bearer ${deps.refreshToken}`) return json({ error: 'unauthorized' }, 401, 'no-store');
    deps.triggerRefresh();
    return json({ started: true }, 202, 'no-store');
  }
  if (url.pathname === '/healthz') {
    const [snap, lastRunRaw, registry] = await Promise.all([store.getSnapshot(), deps.kv.get('last_run'), store.getRegistry()]);
    const lastRun = lastRunRaw ? (JSON.parse(lastRunRaw) as LastRun) : null;
    return json(
      { ok: !!snap, refreshedAt: snap?.refreshedAt ?? null, block: snap?.block ?? null, tokens: snap?.tokens.length ?? 0, registry: { tokens: registry.tokens.length, lastScannedBlock: registry.lastScannedBlock }, lastRun },
      snap ? 200 : 503,
      'no-store',
    );
  }
  return json({ error: 'not found', routes: ['/', '/v1/tokens', '/v1/tokens/:address', '/v1/history/:address', '/healthz', '/livez'] }, 404, 'no-store');
}
