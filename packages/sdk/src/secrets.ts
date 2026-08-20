import { bytesToHex, hexToBytes, randomScalarBytes, utf8ToBytes } from '@picocash/crypto';

/** Fresh 32-byte random secret, hex. */
export function randomSecretHex(): string {
  return bytesToHex(randomScalarBytes());
}

export interface PcBind {
  nonce: string;
  realm: string;
  salt: string;
}

/**
 * Challenge-bound secret per PIP-05: canonical JSON (fixed key order
 * nonce → realm → salt, no whitespace), UTF-8, hex-encoded. The secret itself
 * commits to the challenge, so an intercepted credential replays nowhere.
 */
export function pcBindSecretHex(nonce: string, realm: string, salt?: string): string {
  const bind: PcBind = { nonce, realm, salt: salt ?? bytesToHex(randomScalarBytes()) };
  return bytesToHex(utf8ToBytes(canonicalPcBind(bind)));
}

export function canonicalPcBind(bind: PcBind): string {
  return `["PC-BIND",{"nonce":${JSON.stringify(bind.nonce)},"realm":${JSON.stringify(bind.realm)},"salt":${JSON.stringify(bind.salt)}}]`;
}

/** Parse a hex secret as PC-BIND; null if it is not one (or not canonical). */
export function parsePcBindSecret(secretHex: string): PcBind | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(secretHex));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 'PC-BIND') return null;
  const body = parsed[1] as Record<string, unknown>;
  if (typeof body?.nonce !== 'string' || typeof body?.realm !== 'string' || typeof body?.salt !== 'string') return null;
  const bind: PcBind = { nonce: body.nonce, realm: body.realm, salt: body.salt };
  // Canonical form is part of the commitment: reject re-orderings/whitespace.
  if (canonicalPcBind(bind) !== text) return null;
  return bind;
}
