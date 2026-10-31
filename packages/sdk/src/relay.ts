/**
 * Minimal Nostr relay client: NIP-01 REQ/EVENT/CLOSE plus NIP-42 AUTH.
 *
 * Only what the engram store needs — publish-and-await-OK, query-until-EOSE —
 * against a relay that may demand authentication first (Buzz relays do). When
 * the relay sends `["AUTH", challenge]` we sign a kind-22242 event with the
 * agent key; a publish or query refused with `auth-required:` is retried once
 * after that handshake completes.
 */
import { finalizeEvent, type NostrEvent } from './nostr-event.js';

export interface RelayFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#d'?: string[];
  '#p'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

type WsLike = {
  send(data: string): void;
  close(): void;
  readyState: number;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: any) => void): void;
};
type WsCtor = new (url: string) => WsLike;

export interface RelayOptions {
  /** Private key used to answer NIP-42 AUTH challenges. Omit for unauthenticated relays. */
  authKey?: Uint8Array;
  /** WebSocket constructor; defaults to the global (Node ≥ 22, browsers). */
  WebSocket?: WsCtor;
  /** Default timeout for publish/query, ms. */
  timeoutMs?: number;
}

export class RelayError extends Error {}

export class Relay {
  private ws: WsLike | null = null;
  private readonly pendingOk = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly subs = new Map<string, { onEvent: (e: NostrEvent) => void; onEose: () => void; onClosed: (reason: string) => void }>();
  private authState: 'none' | 'pending' | 'done' = 'none';
  private authWaiters: Array<() => void> = [];
  private readonly timeoutMs: number;
  private subCounter = 0;

  constructor(
    readonly url: string,
    private readonly opts: RelayOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return;
    const Ctor = this.opts.WebSocket ?? ((globalThis as any).WebSocket as WsCtor | undefined);
    if (!Ctor) throw new RelayError('no WebSocket implementation available; pass options.WebSocket');
    const ws = new Ctor(this.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RelayError(`connect to ${this.url} timed out`)), this.timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        reject(new RelayError(`websocket error connecting to ${this.url}: ${ev?.message ?? 'unknown'}`));
      });
      ws.addEventListener('message', (ev) => this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data)));
      ws.addEventListener('close', () => {
        for (const p of this.pendingOk.values()) p.reject(new RelayError('connection closed'));
        this.pendingOk.clear();
        for (const s of this.subs.values()) s.onClosed('connection closed');
        this.subs.clear();
      });
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(frame: unknown[]): void {
    if (!this.ws || this.ws.readyState !== 1) throw new RelayError('not connected');
    this.ws.send(JSON.stringify(frame));
  }

  private onMessage(raw: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [type] = msg;
    if (type === 'OK') {
      const [, id, ok, reason] = msg as [string, string, boolean, string?];
      const p = this.pendingOk.get(id);
      if (!p) return;
      this.pendingOk.delete(id);
      ok ? p.resolve() : p.reject(new RelayError(reason ?? 'rejected'));
    } else if (type === 'EVENT') {
      const [, subId, event] = msg as [string, string, NostrEvent];
      this.subs.get(subId)?.onEvent(event);
    } else if (type === 'EOSE') {
      this.subs.get((msg as [string, string])[1])?.onEose();
    } else if (type === 'CLOSED') {
      const [, subId, reason] = msg as [string, string, string];
      this.subs.get(subId)?.onClosed(reason ?? '');
    } else if (type === 'AUTH') {
      this.handleAuthChallenge((msg as [string, string])[1]);
    }
  }

  private handleAuthChallenge(challenge: string): void {
    if (!this.opts.authKey || this.authState === 'done') return;
    this.authState = 'pending';
    const event = finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['relay', this.url],
          ['challenge', challenge],
        ],
        content: '',
      },
      this.opts.authKey,
    );
    this.awaitOk(event.id)
      .then(() => {
        this.authState = 'done';
        for (const w of this.authWaiters) w();
        this.authWaiters = [];
      })
      .catch(() => {
        this.authState = 'none';
      });
    this.send(['AUTH', event]);
  }

  /** Resolve once the NIP-42 handshake is done; reject if none is in progress and the relay never asked. */
  private waitForAuth(): Promise<void> {
    if (this.authState === 'done') return Promise.resolve();
    if (!this.opts.authKey) return Promise.reject(new RelayError('relay requires auth but no authKey was configured'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RelayError('timed out waiting for AUTH handshake')), this.timeoutMs);
      this.authWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private awaitOk(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOk.delete(id);
        reject(new RelayError(`no OK for ${id.slice(0, 8)}… within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pendingOk.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Publish and resolve on the relay's OK; rejects with the relay's reason otherwise. */
  async publish(event: NostrEvent): Promise<void> {
    await this.connect();
    const attempt = () => {
      const ok = this.awaitOk(event.id);
      this.send(['EVENT', event]);
      return ok;
    };
    try {
      await attempt();
    } catch (err) {
      if (err instanceof RelayError && err.message.startsWith('auth-required')) {
        await this.waitForAuth();
        await attempt();
        return;
      }
      throw err;
    }
  }

  /** Fetch everything matching `filter` up to EOSE, then close the subscription. */
  async query(filter: RelayFilter): Promise<NostrEvent[]> {
    await this.connect();
    const run = () =>
      new Promise<NostrEvent[]>((resolve, reject) => {
        const subId = `s${++this.subCounter}`;
        const events: NostrEvent[] = [];
        const timer = setTimeout(() => {
          this.subs.delete(subId);
          reject(new RelayError(`query ${subId} timed out`));
        }, this.timeoutMs);
        const finish = () => {
          clearTimeout(timer);
          this.subs.delete(subId);
          try {
            this.send(['CLOSE', subId]);
          } catch {
            /* already closed */
          }
        };
        this.subs.set(subId, {
          onEvent: (e) => events.push(e),
          onEose: () => {
            finish();
            resolve(events);
          },
          onClosed: (reason) => {
            finish();
            reject(new RelayError(reason));
          },
        });
        this.send(['REQ', subId, filter]);
      });
    try {
      return await run();
    } catch (err) {
      if (err instanceof RelayError && err.message.startsWith('auth-required')) {
        await this.waitForAuth();
        return run();
      }
      throw err;
    }
  }
}
