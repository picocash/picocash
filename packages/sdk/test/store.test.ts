import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomSecretHex } from '../src/secrets.js';
import { balanceOf, FileProofStore, MemoryProofStore, transitions, withSpend, EMPTY_SNAPSHOT } from '../src/store.js';
import type { Proof } from '../src/types.js';

function proof(amount: number): Proof {
  return { amount, keyset_id: 'k'.repeat(16), secret: randomSecretHex(), C: '02'.padEnd(66, '0') };
}
const entry = { at: 1, kind: 'pay' as const, delta: -1 };

describe('store transitions (pure)', () => {
  it('add dedupes by Y, including against reserved proofs', () => {
    const a = proof(4);
    let s = transitions.add(EMPTY_SNAPSHOT, [a, a]);
    expect(s.proofs).toHaveLength(1);
    s = transitions.reserve(s, [a], 'r1');
    s = transitions.add(s, [a]); // re-adding a reserved proof must not resurrect it as spendable
    expect(s.proofs).toHaveLength(0);
    expect(s.reserved.r1).toHaveLength(1);
  });

  it('reserve refuses unknown or already-reserved proofs', () => {
    const a = proof(1);
    const s = transitions.add(EMPTY_SNAPSHOT, [a]);
    expect(() => transitions.reserve(s, [proof(1)], 'x')).toThrow(/not spendable/);
    const r = transitions.reserve(s, [a], 'r1');
    expect(() => transitions.reserve(r, [a], 'r2')).toThrow(/not spendable/);
  });

  it('commit drops spent, keeps change, appends history; release restores', () => {
    const [a, b, change] = [proof(8), proof(2), proof(3)];
    const s = transitions.add(EMPTY_SNAPSHOT, [a, b]);
    const r = transitions.reserve(s, [a], 'r1');
    const c = transitions.commit(r, 'r1', [change], entry);
    expect(balanceOf(c.proofs)).toBe(5); // b + change
    expect(c.reserved).toEqual({});
    expect(c.history.at(-1)).toEqual(entry);
    const back = transitions.release(r, 'r1');
    expect(balanceOf(back.proofs)).toBe(10);
    expect(() => transitions.release(back, 'r1')).toThrow(/no reservation/);
  });

  it('seq strictly increases on every transition', () => {
    const a = proof(1);
    const s1 = transitions.add(EMPTY_SNAPSHOT, [a]);
    const s2 = transitions.reserve(s1, [a], 'r');
    const s3 = transitions.release(s2, 'r');
    expect([s1.seq, s2.seq, s3.seq]).toEqual([1, 2, 3]);
  });
});

describe('FileProofStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'picocash-store-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('a missing file is an empty wallet; a corrupt file is an error, not silent loss', async () => {
    const path = join(dir, 'nested', 'wallet.json');
    expect((await new FileProofStore(path).load()).proofs).toEqual([]);
    await writeFile(join(dir, 'bad.json'), '{not json');
    await expect(new FileProofStore(join(dir, 'bad.json')).load()).rejects.toThrow();
  });

  it('a reservation survives a "crash": a fresh instance sees it and can release or commit', async () => {
    const path = join(dir, 'wallet.json');
    const [a, b] = [proof(16), proof(4)];
    const store = new FileProofStore(path);
    await store.add([a, b], { at: 1, kind: 'mint', delta: 20 });
    const id = await store.reserve([a]);
    // process dies here — nothing else written. New process:
    const again = new FileProofStore(path);
    const snap = await again.load();
    expect(balanceOf(snap.proofs)).toBe(4);
    expect(snap.reserved[id]!.map((p) => p.secret)).toEqual([a.secret]);
    await again.release(id);
    expect(balanceOf((await new FileProofStore(path).load()).proofs)).toBe(20);
  });

  it('writes are atomic: the file is always a complete, parseable snapshot', async () => {
    const path = join(dir, 'wallet.json');
    const store = new FileProofStore(path);
    await store.add([proof(1)]);
    const text = await readFile(path, 'utf8');
    expect(JSON.parse(text).seq).toBe(1);
    expect(text.endsWith('}')).toBe(true);
    // the temp file must not linger
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('file mode is owner-only (proofs are bearer value)', async () => {
    const path = join(dir, 'wallet.json');
    await new FileProofStore(path).add([proof(1)]);
    const { stat } = await import('node:fs/promises');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('withSpend', () => {
  it('commits change on success and releases on a pre-flight failure', async () => {
    const store = new MemoryProofStore();
    const [a, b] = [proof(8), proof(8)];
    await store.add([a, b]);

    const change = await withSpend(store, [a], { kind: 'pay', delta: -5, ref: 'merchant' }, async () => [proof(3)]);
    expect(balanceOf(change)).toBe(3);
    let snap = await store.load();
    expect(balanceOf(snap.proofs)).toBe(11);
    expect(snap.history.at(-1)).toMatchObject({ kind: 'pay', delta: -5, ref: 'merchant' });

    await expect(withSpend(store, [b], { kind: 'pay', delta: -8 }, async () => { throw new Error('402'); })).rejects.toThrow('402');
    snap = await store.load();
    expect(balanceOf(snap.proofs)).toBe(11); // b is back
    expect(snap.reserved).toEqual({});
  });
});
