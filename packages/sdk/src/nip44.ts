/**
 * NIP-44 v2 encryption — the cipher NIP-AE uses for agent memory, and the one
 * the Buzz relay's owner⇄agent channel is keyed with.
 *
 *   conversation_key = HKDF-extract(IKM = shared_x, salt = "nip44-v2")
 *   per message:  HKDF-expand(conversation_key, info = nonce, 76 bytes)
 *                 → chacha_key[32] ‖ chacha_nonce[12] ‖ hmac_key[32]
 *   payload = base64( 0x02 ‖ nonce[32] ‖ ChaCha20(padded) ‖ HMAC(nonce ‖ ciphertext) )
 *
 * IKM is the *raw* 32-byte x-coordinate of the ECDH point — not hashed. That is
 * the first thing independent implementations get wrong (NIP-AE §gotchas).
 */
import { chacha20 } from '@noble/ciphers/chacha';
import { secp256k1 } from '@noble/curves/secp256k1';
import { expand, extract } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';

const VERSION = 2;
const SALT = utf8ToBytes('nip44-v2');
const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 65535;
const MIN_PAYLOAD = 99; // 1 + 32 + 34 (smallest padded block) + 32
const MAX_PAYLOAD = 65603;

export class Nip44Error extends Error {}

/** Symmetric key between two parties; either side computes the same value. */
export function conversationKey(privkey: Uint8Array, counterpartyXOnly: Uint8Array | string): Uint8Array {
  const x = typeof counterpartyXOnly === 'string' ? hexToBytes(counterpartyXOnly) : counterpartyXOnly;
  if (x.length !== 32) throw new Nip44Error('counterparty key must be 32-byte x-only');
  // getSharedSecret returns the compressed shared point; strip the parity byte for raw shared_x.
  const sharedX = secp256k1.getSharedSecret(privkey, concatBytes(new Uint8Array([2]), x)).slice(1, 33);
  return extract(sha256, sharedX, SALT);
}

function messageKeys(convKey: Uint8Array, nonce: Uint8Array) {
  const keys = expand(sha256, convKey, nonce, 76);
  return { chachaKey: keys.slice(0, 32), chachaNonce: keys.slice(32, 44), hmacKey: keys.slice(44, 76) };
}

export function calcPaddedLen(unpadded: number): number {
  if (unpadded <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpadded - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpadded - 1) / chunk) + 1);
}

function pad(plaintext: Uint8Array): Uint8Array {
  const len = plaintext.length;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) throw new Nip44Error(`plaintext length ${len} out of range`);
  const out = new Uint8Array(2 + calcPaddedLen(len));
  out[0] = len >> 8;
  out[1] = len & 0xff;
  out.set(plaintext, 2);
  return out;
}

function unpad(padded: Uint8Array): Uint8Array {
  const len = (padded[0]! << 8) | padded[1]!;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT || padded.length !== 2 + calcPaddedLen(len)) {
    throw new Nip44Error('invalid padding');
  }
  return padded.slice(2, 2 + len);
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Encrypt UTF-8 text. `nonce` is injectable ONLY so test vectors can be reproduced; never pass one in production. */
export function encrypt(plaintext: string, convKey: Uint8Array, nonce: Uint8Array = randomBytes(32)): string {
  if (nonce.length !== 32) throw new Nip44Error('nonce must be 32 bytes');
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(utf8ToBytes(plaintext)));
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  return b64encode(concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, mac));
}

export function decrypt(payload: string, convKey: Uint8Array): string {
  if (payload.startsWith('#')) throw new Nip44Error('unsupported encryption version');
  const data = b64decode(payload);
  if (data.length < MIN_PAYLOAD || data.length > MAX_PAYLOAD) throw new Nip44Error('invalid payload length');
  if (data[0] !== VERSION) throw new Nip44Error(`unknown version ${data[0]}`);
  const nonce = data.slice(1, 33);
  const ciphertext = data.slice(33, data.length - 32);
  const mac = data.slice(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  if (!constantTimeEqual(hmac(sha256, hmacKey, concatBytes(nonce, ciphertext)), mac)) throw new Nip44Error('invalid MAC');
  return new TextDecoder('utf-8', { fatal: true }).decode(unpad(chacha20(chachaKey, chachaNonce, ciphertext)));
}
