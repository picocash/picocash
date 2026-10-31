/**
 * Node adapter: the same app as the Worker, as a long-running process for a
 * container or systemd. State is a directory of JSON files; the 10-minute
 * schedule is in-process. Configuration is by environment:
 *
 *   PORT (8790)  HOST (0.0.0.0)  DATA_DIR (./data)  REFRESH_TOKEN
 *   TEMPO_RPC  TEMPO_CHAIN_ID (4217)  TIP20_FACTORY
 *   REFRESH_INTERVAL_MS (600000)  SEED_FILE (./tip20-registry.json)
 *
 * On first boot with an empty data dir, the registry and metadata are seeded
 * from SEED_FILE if it exists, so the first refresh does not have to walk the
 * whole factory history on a rate-limited public RPC.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { handleRequest, runRefresh, type ChainConfig } from './app.js';
import { FileKv } from './file-kv.js';
import { metaFromScan, registryFromScan, type ScanRow } from './seed.js';
import { Store } from './store.js';

const env = process.env;
const PORT = Number(env.PORT ?? 8790);
const HOST = env.HOST ?? '0.0.0.0';
const DATA_DIR = env.DATA_DIR ?? './data';
const INTERVAL = Number(env.REFRESH_INTERVAL_MS ?? 600_000);
const SEED_FILE = env.SEED_FILE ?? './tip20-registry.json';
const chain: ChainConfig = {
  rpcUrl: env.TEMPO_RPC ?? 'https://rpc.tempo.xyz',
  chainId: Number(env.TEMPO_CHAIN_ID ?? 4217),
  factory: env.TIP20_FACTORY ?? '0x20fc000000000000000000000000000000000000',
};

const log = (m: string) => console.log(`${new Date().toISOString()} [reserves] ${m}`);
const kv = new FileKv(DATA_DIR);
const store = new Store(kv);

async function seedIfEmpty(): Promise<void> {
  if ((await kv.get('registry')) !== null) return;
  let rows: ScanRow[];
  try {
    rows = JSON.parse(await readFile(SEED_FILE, 'utf8')) as ScanRow[];
  } catch {
    log(`no seed file at ${SEED_FILE}; discovery will walk the factory history over several refreshes`);
    return;
  }
  await store.putRegistry(registryFromScan(rows));
  await store.putMeta(metaFromScan(rows));
  log(`seeded registry + metadata for ${rows.length} tokens from ${SEED_FILE}`);
}

// One refresh at a time; a trigger during a run is a no-op (the run in flight is fresh enough).
let inFlight: Promise<unknown> | null = null;
function triggerRefresh(): void {
  if (inFlight) return;
  inFlight = runRefresh(kv, chain, log)
    .then((r) => log(r.ok ? `refresh ok in ${r.ms} ms, ${r.tokens} tokens, ${r.errors?.length ?? 0} errors` : `refresh FAILED after ${r.ms} ms: ${r.error}`))
    .finally(() => (inFlight = null));
}

function toRequest(req: IncomingMessage): Request {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? `${HOST}:${PORT}`;
  const url = `${proto}://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const method = req.method ?? 'GET';
  // Only the refresh endpoint is a POST and it carries no body; nothing else reads one.
  return new Request(url, { method, headers });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer((req, res) => {
  // Behind the tunnel the origin sees plain HTTP; the edge says what the client used.
  // A proxied request that arrived over http is redirected; direct LAN requests carry no such header.
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  if (proto === 'http' && req.headers.host) {
    res.writeHead(301, { location: `https://${req.headers.host}${req.url ?? '/'}`, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  handleRequest(toRequest(req), { kv, refreshToken: env.REFRESH_TOKEN, triggerRefresh })
    .then((r) => send(res, r))
    .catch((err) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end('{"error":"internal"}');
    });
});

await seedIfEmpty();
server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}, data in ${DATA_DIR}, refresh every ${INTERVAL / 1000} s`));

// Refresh now if the snapshot is missing or older than one interval, then on the interval.
const snap = await store.getSnapshot();
if (!snap || Date.now() - Date.parse(snap.refreshedAt) > INTERVAL) triggerRefresh();
const timer = setInterval(triggerRefresh, INTERVAL);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
