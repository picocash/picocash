import { decompose, lockOf, pcBindSecretHex, type Proof, type Wallet } from '@picocash/sdk';
import type { PicocashChallenge, PicocashCredential } from './types.js';

/**
 * Agent side: answer a challenge by swapping held proofs into challenge-bound
 * (PC-BIND) proofs of the exact amount, and emit the credential. The returned
 * `change` proofs replace the spent inputs in the caller's store.
 *
 * PIP-08: if the held proofs are P2PK-locked to the challenge's `pubkey`
 * (tokens a human pre-locked to this merchant), they cannot be swapped by the
 * agent — an exact-amount subset is presented as-is instead.
 */
export async function payChallenge(
  wallet: Wallet,
  proofs: Proof[],
  challenge: PicocashChallenge,
): Promise<{ credential: PicocashCredential; change: Proof[] }> {
  if (challenge.method !== 'picocash') throw new Error(`not a picocash challenge: ${challenge.method}`);
  if (challenge.expiry < Math.floor(Date.now() / 1000)) throw new Error('challenge is already expired');

  const keyset = await wallet.getKeyset();
  if (keyset.unit !== challenge.unit) {
    throw new Error(`unit mismatch: wallet holds ${keyset.unit}, challenge wants ${challenge.unit}`);
  }
  const allowed = challenge.mints.some((m) => m.url === wallet.mintUrl && m.keyset_ids.includes(keyset.id));
  if (!allowed) {
    throw new Error(`this wallet's mint (${wallet.mintUrl}, keyset ${keyset.id}) is not in the challenge allowlist`);
  }

  if (challenge.pubkey) {
    const locked = proofs.filter((p) => { try { return lockOf(p)?.data === challenge.pubkey; } catch { return false; } });
    if (locked.length) {
      const picked = pickExact(locked, challenge.amount);
      if (!picked) throw new Error(`holding ${locked.length} proof(s) locked to this service but no subset sums to ${challenge.amount}; lock in matching denominations`);
      const pickedSet = new Set(picked);
      return {
        credential: { method: 'picocash', challenge_id: challenge.challenge_id, mint: wallet.mintUrl, keyset_id: keyset.id, proofs: picked },
        change: proofs.filter((p) => !pickedSet.has(p)),
      };
    }
  }

  const secrets = decompose(challenge.amount).map(() => pcBindSecretHex(challenge.nonce, challenge.realm));
  const { bundle, change } = await wallet.send(proofs, challenge.amount, secrets);
  return {
    credential: {
      method: 'picocash',
      challenge_id: challenge.challenge_id,
      mint: wallet.mintUrl,
      keyset_id: bundle.keyset_id,
      proofs: bundle.proofs,
    },
    change,
  };
}

/** Exact-sum subset (greedy by descending amount; power-of-two denominations make greedy exact when a subset exists). */
function pickExact(proofs: Proof[], amount: number): Proof[] | null {
  const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
  const picked: Proof[] = [];
  let left = amount;
  for (const p of sorted) {
    if (p.amount <= left) { picked.push(p); left -= p.amount; }
    if (left === 0) break;
  }
  return left === 0 ? picked : null;
}
