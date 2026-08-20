import { parseToken, TokenFormatError } from './token.js';

/**
 * PIP-07 token links: `<relay-origin>/t/<id>#<key>`.
 * The relay stores only AES-256-GCM ciphertext; the key rides in the URL
 * fragment and is never sent to any server. Burn-after-read on the relay side.
 */

const subtle = () => globalThis.crypto.subtle;
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length); // backed by a plain ArrayBuffer: what WebCrypto's BufferSource wants
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypt a token string for a relay. Returns the blob to upload and the fragment key. */
export async function encryptToken(token: string): Promise<{ ct: string; key: string }> {
  const keyBytes = rand(32);
  const iv = rand(12);
  const key = await subtle().importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(token) as BufferSource));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  return { ct: b64url(blob), key: b64url(keyBytes) };
}

export async function decryptToken(ct: string, keyB64: string): Promise<string> {
  const blob = unb64url(ct);
  if (blob.length < 12 + 16) throw new TokenFormatError('link payload too short');
  const key = await subtle().importKey('raw', unb64url(keyB64) as BufferSource, 'AES-GCM', false, ['decrypt']);
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12));
  } catch {
    throw new TokenFormatError('link could not be decrypted — wrong key or tampered payload');
  }
  const token = new TextDecoder().decode(plain);
  parseToken(token); // must be a valid PIP-06 token, or this was not a token link
  return token;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export function isAllowedRelayUrl(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
}

export interface ParsedLink {
  origin: string;
  id: string;
  key: string;
}

/** Recognize and parse a token link. Returns null for anything that isn't one. */
export function parseTokenLink(input: string): ParsedLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // The key travels in the fragment: only https (or a local dev relay) may carry it.
  if (!isAllowedRelayUrl(url)) return null;
  const m = url.pathname.match(/^\/t\/([A-Za-z0-9_-]{22})$/);
  const key = url.hash.replace(/^#/, '');
  if (!m || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  return { origin: url.origin, id: m[1]!, key };
}

/** Upload an encrypted token to a relay and return the shareable link. */
export async function createTokenLink(token: string, relayOrigin: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const origin = new URL(relayOrigin);
  if (!isAllowedRelayUrl(origin)) throw new TokenFormatError('relay must be https (http is allowed only for localhost)');
  const { ct, key } = await encryptToken(token);
  const res = await fetchImpl(`${relayOrigin.replace(/\/$/, '')}/v1/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ct }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`relay refused the upload: ${body?.error?.code ?? res.status} — ${body?.error?.recovery ?? ''}`);
  // Build the link from the origin we actually talked to — never trust a server-supplied host.
  return `${relayOrigin.replace(/\/$/, "")}/t/${body.id}#${key}`;
}

/** Fetch (burn-after-read) and decrypt a token link. */
export async function resolveTokenLink(link: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const parsed = parseTokenLink(link);
  if (!parsed) throw new TokenFormatError('not a token link (expected <origin>/t/<id>#<key>)');
  const res = await fetchImpl(`${parsed.origin}/v1/relay/${parsed.id}`);
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`relay: ${body?.error?.code ?? res.status} — ${body?.error?.recovery ?? 'link unavailable'}`);
  return decryptToken(body.ct, parsed.key);
}
