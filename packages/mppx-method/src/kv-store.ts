import type { AcceptorStore, ChallengeState } from './acceptor.js';

/**
 * The subset of an Upstash-style REST KV client this store needs. Matches the
 * `KvStore` interface of @agentcash/router's kv-store (and any Redis-backed
 * equivalent): per-key operations only, with `setNxEx` as the one atomic
 * claim primitive.
 */
export interface KvClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic set-if-absent with a TTL in seconds. Returns false if the key exists. */
  setNxEx(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
}

export interface KvAcceptorStoreOptions {
  /** Key prefix; keep distinct per service realm. Default `picocash:`. */
  prefix?: string;
  /**
   * Retention for spent-proof Y claims, seconds. PIP-05 requires Ys be held at
   * least until the mint settles them; with P2PK (service-bound) proofs the
   * replay window is not bounded by challenge expiry, so keep this long.
   * Default 30 days.
   */
  yTtlSeconds?: number;
  /** Retention for challenge state past its expiry, seconds. Default 1 hour. */
  challengeGraceSeconds?: number;
}

/**
 * Shared replay store over a Redis/Upstash-style KV (PIP-05 §Replay state):
 * safe for multi-instance services, unlike `MemoryAcceptorStore`.
 *
 * Atomicity model: KV stores of this shape have no multi-key transactions, so
 * `accept` is built from per-key atomic claims (`setNxEx`), ordered to fail
 * CLOSED: the challenge-paid marker is claimed first, then every Y. On a lost
 * race, claims made so far are rolled back; if the process dies mid-rollback,
 * the orphaned claims refuse future spends of the same proofs — never the
 * reverse. A double-paid challenge or a replayed proof cannot slip through; a
 * crash can at worst strand a claim until its TTL.
 */
export class KvAcceptorStore implements AcceptorStore {
  private readonly prefix: string;
  private readonly yTtl: number;
  private readonly grace: number;

  constructor(
    private readonly kv: KvClient,
    options?: KvAcceptorStoreOptions,
  ) {
    this.prefix = options?.prefix ?? 'picocash:';
    this.yTtl = options?.yTtlSeconds ?? 30 * 24 * 3600;
    this.grace = options?.challengeGraceSeconds ?? 3600;
  }

  private chalKey(id: string): string {
    return `${this.prefix}chal:${id}`;
  }
  private paidKey(id: string): string {
    return `${this.prefix}paid:${id}`;
  }
  private yKey(y: string): string {
    return `${this.prefix}y:${y}`;
  }

  private challengeTtl(state: ChallengeState): number {
    return Math.max(60, state.challenge.expiry - Math.floor(Date.now() / 1000) + this.grace);
  }

  async getChallenge(id: string): Promise<ChallengeState | undefined> {
    const raw = await this.kv.get(this.chalKey(id));
    return (raw as ChallengeState | null) ?? undefined;
  }

  async putChallenge(state: ChallengeState): Promise<void> {
    await this.kv.set(this.chalKey(state.challenge.challenge_id), state);
  }

  async hasAnyY(ys: string[]): Promise<boolean> {
    const seen = await Promise.all(ys.map((y) => this.kv.get(this.yKey(y))));
    return seen.some((v) => v !== null && v !== undefined);
  }

  async accept(state: ChallengeState, ys: string[]): Promise<boolean> {
    const id = state.challenge.challenge_id;
    // 1. Claim the challenge: at most one credential ever pays it.
    const chalClaimed = await this.kv.setNxEx(this.paidKey(id), 1, this.challengeTtl(state) + this.yTtl);
    if (!chalClaimed) return false;

    // 2. Claim every Y. Any loss means a concurrent (or past) spend of the
    //    same proof — roll back our claims and refuse.
    const claimed: string[] = [];
    for (const y of ys) {
      const ok = await this.kv.setNxEx(this.yKey(y), id, this.yTtl);
      if (!ok) {
        await Promise.allSettled(claimed.map((prev) => this.kv.del(this.yKey(prev))));
        await this.kv.del(this.paidKey(id)).catch(() => undefined);
        return false;
      }
      claimed.push(y);
    }

    await this.putChallenge(state);
    return true;
  }
}
