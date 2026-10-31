#!/usr/bin/env node
/**
 * The owner's view of an agent's wallet — read straight from the relay with
 * the OWNER's key. No agent cooperation, no API: the engram is encrypted to the
 * owner⇄agent conversation key, so either side can open it.
 *
 *   picocash-owner <agent-npub> --nsec <owner nsec|hex> --relay wss://…
 *   picocash-owner <agent-npub> --nsec … --relay … --json
 *
 * Also reads PICOCASH_OWNER_NSEC / BUZZ_RELAY_URL from the environment.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Relay, balanceOf, lockKeyFromNpub, lockOf, npubFromPubkey, privkeyFromNsec, readWalletAsOwner, type WalletSnapshot } from '@picocash/sdk';

export interface OwnerView {
  agent: string;
  spendable: number;
  reserved: number;
  locked_to_merchants: Array<{ merchant: string; amount: number }>;
  proof_count: number;
  open_reservations: number;
  seq: number;
  recent: WalletSnapshot['history'];
}

/** Pure projection of a snapshot into what an owner wants to see. */
export function ownerView(agentNpub: string, snap: WalletSnapshot, agentXOnly: string, recent = 15): OwnerView {
  const isAgents = (k: string) => k.slice(-64) === agentXOnly;
  const byMerchant = new Map<string, number>();
  let spendable = 0;
  for (const p of snap.proofs) {
    const lock = lockOf(p);
    if (!lock || [lock.data, ...lock.pubkeys, ...lock.refund].some(isAgents)) spendable += p.amount;
    else byMerchant.set(lock.data, (byMerchant.get(lock.data) ?? 0) + p.amount);
  }
  return {
    agent: agentNpub,
    spendable,
    reserved: balanceOf(Object.values(snap.reserved).flat()),
    locked_to_merchants: [...byMerchant].map(([k, amount]) => ({ merchant: npubFromPubkey(k), amount })),
    proof_count: snap.proofs.length,
    open_reservations: Object.keys(snap.reserved).length,
    seq: snap.seq,
    recent: snap.history.slice(-recent).reverse(),
  };
}

export function formatOwnerView(v: OwnerView, unit = 'base units'): string {
  const lines = [
    `agent        ${v.agent}`,
    `spendable    ${v.spendable} ${unit}`,
    `reserved     ${v.reserved} ${unit}${v.open_reservations ? `  (${v.open_reservations} in-flight — reconcile if stale)` : ''}`,
  ];
  for (const m of v.locked_to_merchants) lines.push(`budget       ${m.amount} ${unit} locked to ${m.merchant}`);
  lines.push(`proofs       ${v.proof_count}   seq ${v.seq}`);
  if (v.recent.length) {
    lines.push('', 'recent');
    for (const h of v.recent) {
      const when = new Date(h.at * 1000).toISOString().replace('T', ' ').slice(0, 16);
      lines.push(`  ${when}  ${h.kind.padEnd(7)} ${String(h.delta).padStart(9)}  ${h.ref ?? ''}`);
    }
  }
  return lines.join('\n');
}

async function main(argv: string[]): Promise<void> {
  const args = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) args.set(a.slice(2), a.includes('=') ? a.split('=').slice(1).join('=') : (argv[++i] ?? 'true'));
    else positional.push(a);
  }
  const agentNpub = positional[0];
  const nsec = args.get('nsec') ?? process.env.PICOCASH_OWNER_NSEC;
  const relayUrl = (args.get('relay') ?? process.env.BUZZ_RELAY_URL)?.replace(/^http/, 'ws');
  if (!agentNpub || !nsec || !relayUrl) {
    console.error('usage: picocash-owner <agent-npub> --nsec <owner nsec|hex> --relay <wss://relay> [--json]');
    process.exit(2);
  }
  const ownerKey = privkeyFromNsec(nsec);
  const agentXOnly = lockKeyFromNpub(agentNpub).slice(2);
  const relay = new Relay(relayUrl, { authKey: ownerKey });
  try {
    const snap = await readWalletAsOwner(relay, ownerKey, agentXOnly);
    if (!snap) {
      console.error(`no wallet found for ${agentNpub} on ${relayUrl} (owner key may not match, or the agent has never saved one)`);
      process.exit(1);
    }
    const view = ownerView(agentNpub, snap, agentXOnly);
    console.log(args.has('json') ? JSON.stringify(view, null, 2) : formatOwnerView(view));
  } finally {
    relay.close();
  }
}

// Run only when this file is the entry point — including through the
// `picocash-owner` bin symlink, whose argv[1] is the link, not owner.js.
const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
