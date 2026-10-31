import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { p2pkSecretHex } from '@picocash/crypto';
import { npubFromPubkey, pubkeyOf, randomSecretHex, type Proof, type WalletSnapshot } from '@picocash/sdk';
import { formatOwnerView, ownerView } from '../src/owner.js';

const proof = (amount: number, secret = randomSecretHex()): Proof => ({ amount, keyset_id: 'k'.repeat(16), secret, C: '02'.padEnd(66, '0') });

describe('owner view', () => {
  it('splits spendable vs per-merchant budgets by lock, and surfaces reservations', () => {
    const agent = secp256k1.utils.randomPrivateKey();
    const agentX = pubkeyOf(agent);
    const merchant = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true));
    const snap: WalletSnapshot = {
      proofs: [
        proof(100), // unlocked
        proof(200, p2pkSecretHex(`02${agentX}`)), // locked to the agent (02 form)
        proof(300, p2pkSecretHex(merchant)), // merchant budget
        proof(50, p2pkSecretHex(merchant)),
      ],
      reserved: { r1: [proof(7)] },
      history: [{ at: 1_700_000_000, kind: 'mint', delta: 657 }, { at: 1_700_000_100, kind: 'pay', delta: -7, ref: 'llm.test' }],
      seq: 4,
    };
    const v = ownerView(npubFromPubkey(agentX), snap, agentX);
    expect(v.spendable).toBe(300);
    expect(v.reserved).toBe(7);
    expect(v.open_reservations).toBe(1);
    expect(v.locked_to_merchants).toEqual([{ merchant: npubFromPubkey(merchant), amount: 350 }]);
    expect(v.recent[0]!.kind).toBe('pay'); // newest first
    const text = formatOwnerView(v);
    expect(text).toContain('spendable    300');
    expect(text).toContain('budget       350');
    expect(text).toContain('in-flight');
    expect(text).toMatch(/pay\s+-7\s+llm\.test/);
  });
});
