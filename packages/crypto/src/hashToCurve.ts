import { sha256 } from '@noble/hashes/sha2';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { GroupPoint, Point } from './points.js';

const DOMAIN_SEPARATOR = utf8ToBytes('Secp256k1_HashToCurve_Cashu_');
const MAX_ITERATIONS = 2 ** 16;

/**
 * Map arbitrary bytes to a secp256k1 point with unknown discrete log.
 * Byte-compatible with Cashu NUT-00: try 0x02 || SHA256(msg_hash || counter_le32)
 * for counter = 0, 1, 2, ... until it parses as a valid compressed point.
 */
export function hashToCurve(message: Uint8Array): GroupPoint {
  const msgHash = sha256(concatBytes(DOMAIN_SEPARATOR, message));
  const counterBytes = new Uint8Array(4);
  const view = new DataView(counterBytes.buffer);
  for (let counter = 0; counter < MAX_ITERATIONS; counter++) {
    view.setUint32(0, counter, true);
    const candidate = concatBytes(new Uint8Array([0x02]), sha256(concatBytes(msgHash, counterBytes)));
    try {
      return Point.fromHex(candidate);
    } catch {
      // x not on curve for this counter; keep searching
    }
  }
  throw new Error('hash_to_curve: no valid point found (probability ~2^-65536)');
}
