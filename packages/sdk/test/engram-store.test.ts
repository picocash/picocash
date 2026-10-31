/**
 * EngramProofStore against an in-process mock relay that REQUIRES NIP-42 AUTH
 * (as Buzz relays may), so the auth-challenge/retry path is exercised, not
 * just the happy path.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ConflictError, EngramProofStore, readWalletAsOwner } from '../src/engram-store.js';
import { pubkeyOf, verifyEvent, type NostrEvent } from '../src/nostr-event.js';
import { Relay, RelayError } from '../src/relay.js';
import { randomSecretHex } from '../src/secrets.js';
import { balanceOf } from '../src/store.js';
import type { Proof } from '../src/types.js';

type Filter = { ids?: string[]; authors?: string[]; kinds?: number[]; '#d'?: string[]; '#p'?: string[] };

/** Tiny NIP-01 relay: stores events, answers REQ/EVENT/CLOSE, demands NIP-42 AUTH first. */
function startMockRelay(opts: { requireAuth: boolean }) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const events: NostrEvent[] = [];
  const matches = (e: NostrEvent, f: Filter) =>
    (!f.ids || f.ids.includes(e.id)) &&
    (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f['#d'] || e.tags.some((t) => t[0] === 'd' && f['#d']!.includes(t[1]!))) &&
    (!f['#p'] || e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]!)));

  wss.on('connection', (ws: WsSocket) => {
    const challenge = randomSecretHex();
    let authed = !opts.requireAuth;
    if (opts.requireAuth) ws.send(JSON.stringify(['AUTH', challenge]));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as unknown[];
      const [type] = msg;
      if (type === 'AUTH') {
        const ev = msg[1] as NostrEvent;
        const ok = ev.kind === 22242 && ev.tags.some((t) => t[0] === 'challenge' && t[1] === challenge) && verifyEvent(ev);
        if (ok) authed = true;
        ws.send(JSON.stringify(['OK', ev.id, ok, ok ? '' : 'auth-required: bad auth event']));
      } else if (type === 'EVENT') {
        const ev = msg[1] as NostrEvent;
        if (!authed) return ws.send(JSON.stringify(['OK', ev.id, false, 'auth-required: authenticate first']));
        if (!verifyEvent(ev)) return ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: bad signature']));
        events.push(ev);
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
      } else if (type === 'REQ') {
        const [, subId, filter] = msg as [string, string, Filter];
        if (!authed) return ws.send(JSON.stringify(['CLOSED', subId, 'auth-required: authenticate first']));
        for (const e of events) if (matches(e, filter)) ws.send(JSON.stringify(['EVENT', subId, e]));
        ws.send(JSON.stringify(['EOSE', subId]));
      }
    });
  });
  return new Promise<{ url: string; events: NostrEvent[]; close: () => void }>((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      const { port } = http.address() as AddressInfo;
      resolve({ url: `ws://127.0.0.1:${port}`, events, close: () => { wss.close(); http.close(); } });
    });
  });
}

function proof(amount: number): Proof {
  return { amount, keyset_id: 'k'.repeat(16), secret: randomSecretHex(), C: '02'.padEnd(66, '0') };
}

describe('EngramProofStore over an auth-required relay', () => {
  let relayServer: Awaited<ReturnType<typeof startMockRelay>>;
  const agentKey = secp256k1.utils.randomPrivateKey();
  const ownerKey = secp256k1.utils.randomPrivateKey();
  const ownerPub = pubkeyOf(ownerKey);
  const agentPub = pubkeyOf(agentKey);
  const relays: Relay[] = [];
  const relayFor = (key: Uint8Array) => {
    const r = new Relay(relayServer.url, { authKey: key, timeoutMs: 5000 });
    relays.push(r);
    return r;
  };

  beforeAll(async () => {
    relayServer = await startMockRelay({ requireAuth: true });
  });
  afterAll(() => {
    for (const r of relays) r.close();
    relayServer.close();
  });

  it('an empty relay is an empty wallet; a write survives a "crash" into a fresh instance', async () => {
    const store = new EngramProofStore({ relay: relayFor(agentKey), agentPrivkey: agentKey, ownerPubkey: ownerPub });
    expect((await store.load()).proofs).toEqual([]);

    const [a, b] = [proof(16), proof(4)];
    await store.add([a, b], { at: 1, kind: 'mint', delta: 20 });
    const id = await store.reserve([a]);

    // new process: fresh store, fresh relay connection
    const again = new EngramProofStore({ relay: relayFor(agentKey), agentPrivkey: agentKey, ownerPubkey: ownerPub });
    const snap = await again.load();
    expect(balanceOf(snap.proofs)).toBe(4);
    expect(snap.reserved[id]!.map((p) => p.secret)).toEqual([a.secret]);
    expect(snap.seq).toBe(2);
    await again.commit(id, [proof(3)], { at: 2, kind: 'pay', delta: -13 });
    expect(balanceOf((await again.load()).proofs)).toBe(7);
  });

  it('the relay only ever sees ciphertext and the fixed alt tag', () => {
    for (const ev of relayServer.events) {
      expect(ev.kind).toBe(30174);
      expect(atob(ev.content).charCodeAt(0)).toBe(2); // NIP-44 v2 payload: version byte 0x02
      expect(ev.content).not.toContain('picocash');
      expect(ev.tags.find((t) => t[0] === 'alt')?.[1]).toBe('encrypted agent memory record');
      expect(ev.tags.some((t) => t[1]?.includes('mem/'))).toBe(false); // slug never in plaintext tags
    }
  });

  it('the owner reads the same wallet with their own key; a stranger cannot', async () => {
    const asOwner = await readWalletAsOwner(relayFor(ownerKey), ownerKey, agentPub);
    expect(asOwner).not.toBeNull();
    expect(balanceOf(asOwner!.proofs)).toBe(7);
    expect(asOwner!.history.map((h) => h.kind)).toEqual(['mint', 'pay']);

    const stranger = secp256k1.utils.randomPrivateKey();
    expect(await readWalletAsOwner(relayFor(stranger), stranger, agentPub)).toBeNull();
  });

  it('two sessions of one agent: the stale writer gets ConflictError, nothing is overwritten', async () => {
    const s1 = new EngramProofStore({ relay: relayFor(agentKey), agentPrivkey: agentKey, ownerPubkey: ownerPub });
    const s2 = new EngramProofStore({ relay: relayFor(agentKey), agentPrivkey: agentKey, ownerPubkey: ownerPub });
    await s1.load();
    await s2.load(); // both have seen the same head
    await s1.add([proof(1)]);
    await expect(s2.add([proof(2)])).rejects.toBeInstanceOf(ConflictError);
    const snap = await s2.load(); // reload resolves it
    expect(balanceOf(snap.proofs)).toBe(8); // s1's write, not s2's
    await s2.add([proof(2)]); // now succeeds
    expect(balanceOf((await s1.load()).proofs)).toBe(10);
  });

  it('a relay that requires auth refuses a client with no authKey', async () => {
    const r = new Relay(relayServer.url, { timeoutMs: 2000 });
    relays.push(r);
    await expect(r.query({ kinds: [30174] })).rejects.toThrow(RelayError);
  });
});
