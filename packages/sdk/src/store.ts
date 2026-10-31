/**
 * Proof storage (picocash × Buzz, plan component 2).
 *
 * `Wallet` is deliberately stateless — every method takes and returns proofs.
 * Anything long-lived (an MCP wallet beside an agent, a treasury) needs a
 * durable place to keep them, and the failure that matters is a crash between
 * "proofs sent to the mint/merchant" and "change written back": without a
 * record of the in-flight spend, the agent either double-spends (and gets
 * refused) or forgets change (and loses money). So the store models a spend as
 * reserve → commit | release, and persists the reservation.
 *
 * A proof's identity is `Y = hash_to_curve(secret)` — the same key the mint's
 * spent ledger uses — so a store can be reconciled against `/v1/checkstate`.
 */
import { yOfSecret } from './blinding.js';
import type { Proof } from './types.js';

export type HistoryKind = 'receive' | 'send' | 'pay' | 'mint' | 'melt' | 'refund';

export interface HistoryEntry {
  /** Unix seconds. */
  at: number;
  kind: HistoryKind;
  /** Signed base units: positive in, negative out. */
  delta: number;
  /** Free-form correlation: merchant realm, challenge id, melt id, npub, memo … */
  ref?: string;
}

export interface WalletSnapshot {
  /** Spendable proofs, excluding reserved ones. */
  proofs: Proof[];
  /** Proofs currently in an uncommitted spend, keyed by reservation id. */
  reserved: Record<string, Proof[]>;
  history: HistoryEntry[];
  /** Monotonic write counter; a store with a remote copy uses it to detect concurrent writers. */
  seq: number;
}

export interface ProofStore {
  load(): Promise<WalletSnapshot>;
  /** Add proofs (receive / mint / change). Proofs whose Y is already held are ignored. */
  add(proofs: Proof[], entry?: HistoryEntry): Promise<void>;
  /**
   * Move `proofs` out of the spendable set into an in-flight reservation and
   * persist that BEFORE the caller hands them to a mint or merchant. Returns
   * the reservation id. Throws if any proof is not currently spendable.
   */
  reserve(proofs: Proof[]): Promise<string>;
  /** The spend succeeded: drop the reserved proofs, keep `change`, record history. */
  commit(reservationId: string, change: Proof[], entry: HistoryEntry): Promise<void>;
  /** The spend failed before anything left the wallet: return reserved proofs to spendable. */
  release(reservationId: string): Promise<void>;
}

export const EMPTY_SNAPSHOT: WalletSnapshot = { proofs: [], reserved: {}, history: [], seq: 0 };

/** Base-unit sum of a proof list. */
export function balanceOf(proofs: Proof[]): number {
  return proofs.reduce((s, p) => s + p.amount, 0);
}

/**
 * Pure state transitions shared by every store implementation — a store only
 * has to persist the snapshot these return. Keeping the logic here means the
 * file store and the relay-backed engram store cannot drift.
 */
export const transitions = {
  add(s: WalletSnapshot, proofs: Proof[], entry?: HistoryEntry): WalletSnapshot {
    const held = new Set([...s.proofs, ...Object.values(s.reserved).flat()].map((p) => yOfSecret(p.secret)));
    const fresh = proofs.filter((p) => {
      const y = yOfSecret(p.secret);
      if (held.has(y)) return false;
      held.add(y);
      return true;
    });
    return {
      ...s,
      proofs: [...s.proofs, ...fresh],
      history: entry && fresh.length ? [...s.history, entry] : s.history,
      seq: s.seq + 1,
    };
  },

  reserve(s: WalletSnapshot, proofs: Proof[], id: string): WalletSnapshot {
    const want = new Set(proofs.map((p) => yOfSecret(p.secret)));
    const spendable = new Map(s.proofs.map((p) => [yOfSecret(p.secret), p]));
    for (const y of want) if (!spendable.has(y)) throw new Error(`proof ${y.slice(0, 12)}… is not spendable (unknown, reserved, or already spent)`);
    return {
      ...s,
      proofs: s.proofs.filter((p) => !want.has(yOfSecret(p.secret))),
      reserved: { ...s.reserved, [id]: [...want].map((y) => spendable.get(y)!) },
      seq: s.seq + 1,
    };
  },

  commit(s: WalletSnapshot, id: string, change: Proof[], entry: HistoryEntry): WalletSnapshot {
    if (!(id in s.reserved)) throw new Error(`no reservation ${id}`);
    const { [id]: _spent, ...rest } = s.reserved;
    const withChange = transitions.add({ ...s, reserved: rest }, change);
    return { ...withChange, history: [...withChange.history, entry], seq: s.seq + 1 };
  },

  release(s: WalletSnapshot, id: string): WalletSnapshot {
    if (!(id in s.reserved)) throw new Error(`no reservation ${id}`);
    const { [id]: back, ...rest } = s.reserved;
    return { ...s, proofs: [...s.proofs, ...back!], reserved: rest, seq: s.seq + 1 };
  },
};

function newReservationId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * In-memory store. Reservations are honoured but nothing survives the process —
 * for tests and short-lived scripts only.
 */
export class MemoryProofStore implements ProofStore {
  protected snapshot: WalletSnapshot;
  constructor(initial: WalletSnapshot = EMPTY_SNAPSHOT) {
    this.snapshot = structuredClone(initial);
  }
  async load(): Promise<WalletSnapshot> {
    return structuredClone(this.snapshot);
  }
  async add(proofs: Proof[], entry?: HistoryEntry): Promise<void> {
    await this.persist(transitions.add(this.snapshot, proofs, entry));
  }
  async reserve(proofs: Proof[]): Promise<string> {
    const id = newReservationId();
    await this.persist(transitions.reserve(this.snapshot, proofs, id));
    return id;
  }
  async commit(id: string, change: Proof[], entry: HistoryEntry): Promise<void> {
    await this.persist(transitions.commit(this.snapshot, id, change, entry));
  }
  async release(id: string): Promise<void> {
    await this.persist(transitions.release(this.snapshot, id));
  }
  /** Subclasses override to write through; MUST not return before the write is durable. */
  protected async persist(next: WalletSnapshot): Promise<void> {
    this.snapshot = next;
  }
}

/**
 * JSON-file store with atomic writes (write temp, fsync, rename): a crash
 * mid-write leaves the previous snapshot intact rather than a truncated file.
 * One process per file — there is no cross-process lock; the engram store is
 * the multi-session answer.
 */
export class FileProofStore extends MemoryProofStore {
  private loaded = false;
  constructor(private readonly path: string) {
    super();
  }

  override async load(): Promise<WalletSnapshot> {
    if (!this.loaded) {
      const { readFile } = await import('node:fs/promises');
      try {
        const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<WalletSnapshot>;
        this.snapshot = {
          proofs: parsed.proofs ?? [],
          reserved: parsed.reserved ?? {},
          history: parsed.history ?? [],
          seq: parsed.seq ?? 0,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // missing file = empty wallet; anything else is real
      }
      this.loaded = true;
    }
    return structuredClone(this.snapshot);
  }

  protected override async persist(next: WalletSnapshot): Promise<void> {
    const { mkdir, open, rename } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(next));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.path);
    this.snapshot = next;
  }

  override async add(proofs: Proof[], entry?: HistoryEntry): Promise<void> {
    await this.load();
    return super.add(proofs, entry);
  }
  override async reserve(proofs: Proof[]): Promise<string> {
    await this.load();
    return super.reserve(proofs);
  }
  override async commit(id: string, change: Proof[], entry: HistoryEntry): Promise<void> {
    await this.load();
    return super.commit(id, change, entry);
  }
  override async release(id: string): Promise<void> {
    await this.load();
    return super.release(id);
  }
}

/**
 * Run a spend against a store with reserve → commit | release semantics.
 * `spend` receives the reserved proofs and returns the change to keep. If it
 * throws, the reservation is released (the caller must only throw if nothing
 * irrevocable happened; a spend that reached the mint and then errored should
 * be left reserved and reconciled via checkstate).
 */
export async function withSpend(
  store: ProofStore,
  proofs: Proof[],
  entry: Omit<HistoryEntry, 'at'>,
  spend: (reserved: Proof[]) => Promise<Proof[]>,
): Promise<Proof[]> {
  const id = await store.reserve(proofs);
  let change: Proof[];
  try {
    change = await spend(proofs);
  } catch (err) {
    await store.release(id);
    throw err;
  }
  await store.commit(id, change, { ...entry, at: Math.floor(Date.now() / 1000) });
  return change;
}
