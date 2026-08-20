import { decompose, pcBindSecretHex, type Proof, type Wallet } from '@picocash/sdk';
import type { PicocashChallenge, PicocashCredential } from './types.js';

/**
 * Agent side: answer a challenge by swapping held proofs into challenge-bound
 * (PC-BIND) proofs of the exact amount, and emit the credential. The returned
 * `change` proofs replace the spent inputs in the caller's store.
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
