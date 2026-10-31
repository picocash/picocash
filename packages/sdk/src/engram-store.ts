/**
 * EngramProofStore — the wallet as a NIP-AE memory record on the agent's relay.
 *
 * The snapshot lives in a `kind:30174` event authored by the agent, encrypted
 * (NIP-44 v2) under the owner⇄agent conversation key, at slug
 * `mem/picocash/wallet`. Consequences that are the point of the design:
 *   - the relay stores ciphertext; balances and history are opaque to it;
 *   - the OWNER can read the wallet with their own key (`readWalletAsOwner`) —
 *     Buzz's audit property, applied to money;
 *   - the wallet follows the agent across harnesses and restarts, so a reaped
 *     remote agent does not take its reservations with it.
 *
 * Concurrency: two sessions of one agent are the realistic race. Every mutation
 * re-reads the head first and refuses (ConflictError) if its `seq` moved past
 * the one we last saw; NIP-AE's monotonic `created_at` plus a post-publish head
 * re-check catches the remaining window. A loser gets a conflict, never a
 * silent overwrite of the other session's spend.
 *
 * Size: NIP-44 caps a body at 65,535 bytes — on the order of a couple of
 * hundred proofs with DLEQ. A wallet that grows past that must consolidate
 * (swap small denominations into fewer) before it can be saved; the error says so.
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { conversationKey, decrypt, encrypt } from './nip44.js';
import { finalizeEvent, pubkeyOf, verifyEvent, type NostrEvent } from './nostr-event.js';
import type { Relay } from './relay.js';
import { EMPTY_SNAPSHOT, transitions, type HistoryEntry, type ProofStore, type WalletSnapshot } from './store.js';
import type { Proof } from './types.js';

export const ENGRAM_KIND = 30174;
export const WALLET_SLUG = 'mem/picocash/wallet';
const D_TAG_DOMAIN = utf8ToBytes('agent-memory/v1/d-tag');
const MAX_BODY_BYTES = 65535;
/** A head whose created_at is this far ahead of wall-clock is treated as clock-poisoned (NIP-AE §Writing 2). */
const CLOCK_POISON_SECONDS = 24 * 3600;

export class ConflictError extends Error {}

/** NIP-AE §Addressing: `d = HMAC-SHA256(K_c, domain ‖ 0x00 ‖ slug)`. */
export function engramDTag(convKey: Uint8Array, slug: string): string {
  return bytesToHex(hmac(sha256, convKey, concatBytes(D_TAG_DOMAIN, new Uint8Array([0]), utf8ToBytes(slug))));
}

interface Head {
  event: NostrEvent;
  snapshot: WalletSnapshot;
}

/**
 * Select the head for one slug per NIP-AE §Head selection: validate envelope
 * and signature, decrypt, check the body re-derives to `d`, then pick greatest
 * `created_at` (ties → lowest id). Tombstones count as absent.
 */
function selectHead(events: NostrEvent[], params: { agentPubkey: string; ownerPubkey: string; convKey: Uint8Array; d: string; slug: string }): Head | null {
  let best: Head | null = null;
  for (const ev of events) {
    if (ev.kind !== ENGRAM_KIND || ev.pubkey !== params.agentPubkey) continue;
    const dTags = ev.tags.filter((t) => t[0] === 'd');
    const pTags = ev.tags.filter((t) => t[0] === 'p');
    if (dTags.length !== 1 || pTags.length !== 1 || dTags[0]![1] !== params.d || pTags[0]![1] !== params.ownerPubkey) continue;
    if (!verifyEvent(ev)) continue;
    let body: { slug?: unknown; value?: unknown };
    try {
      body = JSON.parse(decrypt(ev.content, params.convKey));
    } catch {
      continue;
    }
    if (typeof body !== 'object' || body === null || body.slug !== params.slug) continue;
    if (engramDTag(params.convKey, body.slug) !== params.d) continue;
    if (body.value === null) {
      // tombstone: a valid head that says "absent" — it still wins ordering
      if (!best || ev.created_at > best.event.created_at || (ev.created_at === best.event.created_at && ev.id < best.event.id)) {
        best = { event: ev, snapshot: EMPTY_SNAPSHOT };
      }
      continue;
    }
    if (typeof body.value !== 'string') continue;
    let snapshot: WalletSnapshot;
    try {
      const parsed = JSON.parse(body.value) as Partial<WalletSnapshot>;
      snapshot = { proofs: parsed.proofs ?? [], reserved: parsed.reserved ?? {}, history: parsed.history ?? [], seq: parsed.seq ?? 0 };
    } catch {
      continue;
    }
    if (!best || ev.created_at > best.event.created_at || (ev.created_at === best.event.created_at && ev.id < best.event.id)) {
      best = { event: ev, snapshot };
    }
  }
  return best;
}

export interface EngramStoreOptions {
  relay: Relay;
  /** The agent's 32-byte private key (its Nostr identity). */
  agentPrivkey: Uint8Array;
  /** The owner's x-only public key (hex) — the other half of the conversation key. */
  ownerPubkey: string;
  slug?: string;
}

export class EngramProofStore implements ProofStore {
  private readonly agentPubkey: string;
  private readonly convKey: Uint8Array;
  private readonly d: string;
  private readonly slug: string;
  private lastHead: Head | null = null;

  constructor(private readonly opts: EngramStoreOptions) {
    this.agentPubkey = pubkeyOf(opts.agentPrivkey);
    this.convKey = conversationKey(opts.agentPrivkey, opts.ownerPubkey);
    this.slug = opts.slug ?? WALLET_SLUG;
    this.d = engramDTag(this.convKey, this.slug);
  }

  private async fetchHead(): Promise<Head | null> {
    const events = await this.opts.relay.query({
      kinds: [ENGRAM_KIND],
      authors: [this.agentPubkey],
      '#d': [this.d],
      '#p': [this.opts.ownerPubkey],
    });
    const head = selectHead(events, { agentPubkey: this.agentPubkey, ownerPubkey: this.opts.ownerPubkey, convKey: this.convKey, d: this.d, slug: this.slug });
    this.lastHead = head;
    return head;
  }

  async load(): Promise<WalletSnapshot> {
    return structuredClone((await this.fetchHead())?.snapshot ?? EMPTY_SNAPSHOT);
  }

  /**
   * Read-modify-write with optimistic concurrency: refetch the head, refuse if
   * another writer advanced `seq` past what this instance last saw, apply the
   * transition, publish with a strictly newer `created_at`, then confirm we are
   * the head.
   */
  private async mutate(fn: (s: WalletSnapshot) => WalletSnapshot): Promise<void> {
    const seen = this.lastHead?.snapshot.seq;
    const head = await this.fetchHead();
    const current = head?.snapshot ?? EMPTY_SNAPSHOT;
    if (seen !== undefined && current.seq !== seen) {
      throw new ConflictError(`wallet changed under us (seq ${seen} → ${current.seq}); reload and retry`);
    }
    const next = fn(current);

    const value = JSON.stringify(next);
    const body = JSON.stringify({ slug: this.slug, value });
    const bodyBytes = utf8ToBytes(body).length;
    if (bodyBytes > MAX_BODY_BYTES) {
      throw new Error(`wallet snapshot is ${bodyBytes} bytes; NIP-44 allows ${MAX_BODY_BYTES}. Consolidate proofs (swap small denominations into fewer) before saving.`);
    }

    const now = Math.floor(Date.now() / 1000);
    const headAt = head?.event.created_at ?? 0;
    if (headAt > now + CLOCK_POISON_SECONDS) throw new ConflictError(`head created_at ${headAt} is implausibly far in the future; refusing to write past it`);
    const event = finalizeEvent(
      {
        kind: ENGRAM_KIND,
        created_at: Math.max(now, headAt + 1),
        tags: [
          ['d', this.d],
          ['p', this.opts.ownerPubkey],
          ['alt', 'encrypted agent memory record'],
        ],
        content: encrypt(body, this.convKey),
      },
      this.opts.agentPrivkey,
    );
    await this.opts.relay.publish(event);

    // Post-publish verification (NIP-AE §Writing 4): are we the head?
    const after = await this.fetchHead();
    if (!after || after.event.id !== event.id) {
      throw new ConflictError('another writer won the head after publish; reload and retry');
    }
  }

  async add(proofs: Proof[], entry?: HistoryEntry): Promise<void> {
    await this.mutate((s) => transitions.add(s, proofs, entry));
  }
  async reserve(proofs: Proof[]): Promise<string> {
    const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await this.mutate((s) => transitions.reserve(s, proofs, id));
    return id;
  }
  async commit(reservationId: string, change: Proof[], entry: HistoryEntry): Promise<void> {
    await this.mutate((s) => transitions.commit(s, reservationId, change, entry));
  }
  async release(reservationId: string): Promise<void> {
    await this.mutate((s) => transitions.release(s, reservationId));
  }
}

/**
 * The owner's view: same head, same slug, conversation key computed from the
 * owner's side. Returns null if the agent has never saved a wallet.
 */
export async function readWalletAsOwner(relay: Relay, ownerPrivkey: Uint8Array, agentPubkey: string, slug = WALLET_SLUG): Promise<WalletSnapshot | null> {
  const ownerPubkey = pubkeyOf(ownerPrivkey);
  const convKey = conversationKey(ownerPrivkey, agentPubkey);
  const d = engramDTag(convKey, slug);
  const events = await relay.query({ kinds: [ENGRAM_KIND], authors: [agentPubkey], '#d': [d], '#p': [ownerPubkey] });
  return selectHead(events, { agentPubkey, ownerPubkey, convKey, d, slug })?.snapshot ?? null;
}
