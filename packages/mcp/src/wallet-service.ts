/**
 * The wallet behind the MCP tools — plain async methods so the logic is
 * testable without a transport, and reusable by the phase-2 treasury agent.
 *
 * Invariants this layer owns:
 *  - Every spend goes through reserve → commit | release on the ProofStore, so
 *    a crash mid-payment leaves a reservation to reconcile, never a silent loss.
 *  - Proofs are always pre-signed with the parity-robust Nostr signer before
 *    they are handed to the mint. Owner-funded tokens are locked to the agent's
 *    npub; the mint requires a witness to swap or melt them; `signProofs` would
 *    skip odd-parity keys (see sdk/nostr.ts), so we never call it here.
 *  - `send` refuses to mint an UNLOCKED bearer token unless the caller opts in
 *    explicitly: a token pasted into a Buzz channel is public, and an npub-locked
 *    token is worthless to everyone but its recipient.
 */
import { Fetch } from 'mppx/client';
import { picocash } from '@picocash/mppx-method/mppx';
import {
  Wallet,
  balanceOf,
  lockKeyFromNpub,
  lockOf,
  npubFromPubkey,
  parseToken,
  parseTokenLink,
  resolveTokenLink,
  signerFromNsec,
  verifyProofOffline,
  withSpend,
  type HistoryEntry,
  type NostrSigner,
  type Proof,
  type ProofStore,
  type WalletSnapshot,
} from '@picocash/sdk';
import { bytesToHex } from '@picocash/crypto';

export interface WalletServiceOptions {
  mintUrl: string;
  privkey: Uint8Array;
  store: ProofStore;
  fetchImpl?: typeof fetch;
}

export interface BalanceReport {
  mint: string;
  unit: string;
  npub: string;
  /** Base units spendable now (unlocked, or locked to this key). */
  spendable: number;
  /** Base units in uncommitted spends (crash recovery pending). */
  reserved: number;
  /** Base units locked to specific merchants (an owner-set budget) — spendable only there. */
  locked_to_merchants: number;
  proof_count: number;
}

export interface PaidFetchResult {
  status: number;
  body: string;
  /** Decoded Payment-Receipt, if the response carried one. */
  receipt: Record<string, unknown> | null;
  /** Base units this call cost (0 if the resource was free). */
  paid: number;
}

export class WalletService {
  readonly wallet: Wallet;
  readonly signer: NostrSigner;
  readonly npub: string;

  constructor(private readonly opts: WalletServiceOptions) {
    this.wallet = new Wallet({ mintUrl: opts.mintUrl, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    this.signer = signerFromNsec(bytesToHex(opts.privkey));
    this.npub = this.signer.npub;
  }

  private get store(): ProofStore {
    return this.opts.store;
  }

  /** Proofs we can spend anywhere: unlocked, or locked (by x-only) to our key. */
  private spendableOf(proofs: Proof[]): Proof[] {
    const mine = this.signer.lockKey.slice(2);
    return proofs.filter((p) => {
      const lock = lockOf(p);
      if (!lock) return true;
      const xOnly = (k: string) => k.slice(-64);
      return xOnly(lock.data) === mine || lock.pubkeys.some((k) => xOnly(k) === mine) || lock.refund.some((k) => xOnly(k) === mine);
    });
  }

  /**
   * Proofs locked to a specific merchant key — the owner-funded,
   * merchant-restricted budget. Spendable ONLY at that merchant (the mint will
   * not swap them for anyone else), so they are presented only when a
   * challenge from that exact key arrives.
   */
  private lockedTo(proofs: Proof[], merchantPubkey: string): Proof[] {
    return proofs.filter((p) => lockOf(p)?.data === merchantPubkey);
  }

  async balance(): Promise<BalanceReport> {
    const [snap, keyset] = await Promise.all([this.store.load(), this.wallet.getKeyset()]);
    const spendable = this.spendableOf(snap.proofs);
    const merchantLocked = snap.proofs.filter((p) => !spendable.includes(p));
    return {
      mint: this.opts.mintUrl,
      unit: keyset.unit,
      npub: this.npub,
      spendable: balanceOf(spendable),
      reserved: balanceOf(Object.values(snap.reserved).flat()),
      locked_to_merchants: balanceOf(merchantLocked),
      proof_count: snap.proofs.length,
    };
  }

  async history(limit = 20): Promise<HistoryEntry[]> {
    return (await this.store.load()).history.slice(-limit).reverse();
  }

  /**
   * Fetch a URL, paying any picocash 402 along the way. The whole spendable
   * set is reserved for the call's duration (tool calls are serialized per
   * agent, so this is simple and correct); change comes back as the commit.
   */
  async fetchPaid(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<PaidFetchResult> {
    const snap = await this.store.load();
    const spendable = this.spendableOf(snap.proofs);
    // Reserve everything we might present: anywhere-spendable proofs AND every
    // merchant-locked proof (which merchant is only known once the 402 arrives).
    const merchantLocked = snap.proofs.filter((p) => !spendable.includes(p));
    const all = [...spendable, ...merchantLocked];
    const before = balanceOf(all);

    // Explicit reserve → commit | release rather than withSpend: the history
    // entry's delta is only known after the call, once we see what was paid.
    const reservationId = await this.store.reserve(all);
    let held: Proof[] = this.signer.sign(all);
    let presented: Proof[] = [];
    let res: Response;
    try {
      const pay = Fetch.from({
        fetch: this.opts.fetchImpl ?? globalThis.fetch,
        methods: [
          picocash({
            wallet: this.wallet,
            getProofs: () => presented,
            onChange: (change) => {
              // `change` is what payChallenge hands back from the presented set;
              // everything we did not present is still held untouched.
              const shown = new Set(presented);
              held = [...held.filter((p) => !shown.has(p)), ...change];
            },
          }),
        ],
        onChallenge: async (challenge, { createCredential }) => {
          // Decide what to present for THIS challenge. A merchant-locked budget
          // cannot be re-denominated by us (the mint wants the merchant's
          // witness to swap it), so it pays only in exact subset-sums: use it
          // when such a subset exists, otherwise fall back to the open balance
          // rather than failing the whole payment. Never present proofs locked
          // to a different merchant.
          const req = challenge.request as { amount?: string; methodDetails?: { pubkey?: string } };
          const amount = Number(req.amount ?? 0);
          const merchant = req.methodDetails?.pubkey;
          const open = this.spendableOf(held);
          const locked = merchant ? this.lockedTo(held, merchant) : [];
          presented = locked.length && pickExactSubset(locked, amount) ? locked : open;
          return createCredential();
        },
      });
      res = await pay(url, init as RequestInit);
    } catch (err) {
      // Nothing left the wallet unless a swap happened; if `held` changed, a
      // swap DID happen and the change is real — keep it rather than release.
      if (balanceOf(held) !== before) {
        await this.store.commit(reservationId, held, { at: Math.floor(Date.now() / 1000), kind: 'pay', delta: balanceOf(held) - before, ref: `${new URL(url).host} · failed: ${err instanceof Error ? err.message : String(err)}` });
      } else {
        await this.store.release(reservationId);
      }
      throw err;
    }

    const body = await res.text();
    const receiptHeader = res.headers.get('Payment-Receipt');
    let receipt: Record<string, unknown> | null = null;
    if (receiptHeader) {
      try {
        receipt = JSON.parse(Buffer.from(receiptHeader.split(' ').pop()!, 'base64url').toString()) as Record<string, unknown>;
      } catch {
        receipt = { raw: receiptHeader };
      }
    }
    const paid = before - balanceOf(held);
    await this.store.commit(reservationId, held, {
      at: Math.floor(Date.now() / 1000),
      kind: 'pay',
      delta: -paid,
      ref: `${new URL(url).host}${receipt?.reference ? ` · ${String(receipt.reference)}` : ''}`,
    });
    return { status: res.status, body, receipt, paid };
  }

  /**
   * Send `amount` as a token locked to `toNpub` (default). Returns the token
   * string. Refuses an unlocked bearer token unless `unlocked: true`.
   */
  async send(amount: number, options: { toNpub?: string; locktime?: number; refundToSelf?: boolean; memo?: string; unlocked?: boolean } = {}): Promise<{ token: string; locked_to: string | null; amount: number }> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer of base units');
    if (!options.toNpub && !options.unlocked) {
      throw new Error('refusing to create an UNLOCKED bearer token: anyone who sees it can spend it. Pass toNpub to lock it to the recipient, or unlocked:true only if you are sending it over a private channel.');
    }
    const snap = await this.store.load();
    const spendable = this.spendableOf(snap.proofs);
    if (balanceOf(spendable) < amount) throw new Error(`insufficient balance: have ${balanceOf(spendable)}, need ${amount}`);

    let token = '';
    const lockKey = options.toNpub ? lockKeyFromNpub(options.toNpub) : null;
    await withSpend(this.store, spendable, { kind: 'send', delta: -amount, ref: options.toNpub ?? 'unlocked' }, async (reserved) => {
      const inputs = this.signer.sign(reserved);
      const r = lockKey
        ? await this.wallet.sendLocked(inputs, amount, lockKey, {
            ...(options.locktime !== undefined ? { locktime: options.locktime } : {}),
            ...(options.refundToSelf !== false ? { refund: [this.signer.lockKey] } : {}),
            ...(options.memo ? { memo: options.memo } : {}),
          })
        : await this.wallet.send(inputs, amount, undefined, options.memo);
      token = r.token;
      return r.change;
    });
    return { token, locked_to: options.toNpub ?? null, amount };
  }

  /**
   * Claim a token or token link: verify DLEQ offline, unlock with our key if it
   * is locked to us, swap to fresh proofs (the moment of ownership), store.
   */
  async receive(tokenOrLink: string): Promise<{ amount: number; from_lock: string | null; held_locked: boolean }> {
    const token = parseTokenLink(tokenOrLink) ? await resolveTokenLink(tokenOrLink, this.opts.fetchImpl ?? globalThis.fetch) : tokenOrLink;
    const { bundle } = parseToken(token);
    const lock = bundle.proofs[0] ? lockOf(bundle.proofs[0]) : null;
    const mine = this.signer.lockKey.slice(2);
    const lockedToUs = !lock || [lock.data, ...lock.pubkeys, ...lock.refund].some((k) => k.slice(-64) === mine);

    if (!lockedToUs) {
      // A merchant-locked budget: we cannot swap it (the mint wants the lock
      // holder's witness), so verify it offline, make sure the mint has not
      // seen it spent, and hold it AS-IS. It becomes spendable only at a
      // merchant whose challenge advertises that key. Until then the sender
      // still holds identical proofs — a merchant-locked token is a claim you
      // accept from someone you trust (the owner), not bearer cash.
      const keyset = await this.wallet.getKeyset();
      if (bundle.unit !== keyset.unit) throw new Error(`token unit ${bundle.unit} does not match this mint's ${keyset.unit}`);
      for (const [i, p] of bundle.proofs.entries()) {
        if (!verifyProofOffline(p, keyset)) throw new Error(`proof ${i} failed offline DLEQ verification — refusing to accept`);
      }
      const states = await this.wallet.checkstate(bundle.proofs);
      if (states.some((s) => s.state !== 'UNSPENT')) throw new Error('token contains proofs the mint has already seen spent');
      const amount = balanceOf(bundle.proofs);
      const merchant = npubFromPubkey(lock!.data);
      await this.store.add(bundle.proofs, { at: Math.floor(Date.now() / 1000), kind: 'receive', delta: amount, ref: `budget locked to ${merchant} (held unswapped)` });
      return { amount, from_lock: merchant, held_locked: true };
    }

    const signed = { ...bundle, proofs: this.signer.sign(bundle.proofs) };
    const fresh = await this.wallet.receive(signed);
    const amount = balanceOf(fresh);
    await this.store.add(fresh, { at: Math.floor(Date.now() / 1000), kind: 'receive', delta: amount, ref: lock ? `locked:${npubFromPubkey(lock.data)}` : 'unlocked' });
    return { amount, from_lock: lock ? npubFromPubkey(lock.data) : null, held_locked: false };
  }

  /** Melt `amount` base units to an on-chain address (fee is taken on top from the wallet). */
  async melt(amount: number, to: string): Promise<{ melt_id: string; state: string; tx_hash: string | null; amount: number; fee: number }> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer of base units');
    const info = await this.wallet.info();
    const fee = Number(info?.fees?.melt ?? 0);
    const snap = await this.store.load();
    const spendable = this.spendableOf(snap.proofs);
    if (balanceOf(spendable) < amount + fee) throw new Error(`insufficient balance: need ${amount} + fee ${fee}, have ${balanceOf(spendable)}`);

    let quote!: Awaited<ReturnType<Wallet['meltProofs']>>;
    await withSpend(this.store, spendable, { kind: 'melt', delta: -(amount + fee), ref: to }, async (reserved) => {
      const inputs = this.signer.sign(reserved);
      // Split off exactly amount+fee, then melt that bundle; the rest is change.
      const { bundle, change } = await this.wallet.send(inputs, amount + fee);
      quote = await this.wallet.meltProofs(to, bundle.proofs);
      return change;
    });
    return { melt_id: quote.melt_id, state: quote.state, tx_hash: quote.tx_hash, amount: quote.amount, fee: quote.fee };
  }

  /** Raw snapshot, for owner tooling / debugging. */
  async snapshot(): Promise<WalletSnapshot> {
    return this.store.load();
  }
}

/**
 * Exact-sum subset, greedy by descending amount. Denominations are powers of
 * two, so greedy is exact whenever any subset sums to `amount`. Mirrors the
 * picker inside payChallenge; used here only to DECIDE whether a merchant-
 * locked budget can pay a given price before presenting it.
 */
function pickExactSubset(proofs: Proof[], amount: number): Proof[] | null {
  const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
  const picked: Proof[] = [];
  let remaining = amount;
  for (const p of sorted) {
    if (p.amount <= remaining) {
      picked.push(p);
      remaining -= p.amount;
      if (remaining === 0) return picked;
    }
  }
  return null;
}
