/**
 * Environment → config. Deliberately reuses the variables a Buzz agent already
 * has: `BUZZ_PRIVATE_KEY` is handed to every harness by the desktop/launcher,
 * and `BUZZ_RELAY_URL` is the community relay. Nothing new to provision.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lockKeyFromNpub, privkeyFromNsec } from '@picocash/sdk';

export interface McpConfig {
  mintUrl: string;
  /** 32-byte agent private key (from nsec or hex). */
  privkey: Uint8Array;
  store: { kind: 'file'; path: string } | { kind: 'engram'; relayUrl: string; ownerPubkey: string } | { kind: 'memory' };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const mintUrl = (env.PICOCASH_MINT_URL ?? 'https://mint.picocash.dev').replace(/\/$/, '');
  const key = env.BUZZ_PRIVATE_KEY ?? env.PICOCASH_NSEC;
  if (!key) throw new Error('BUZZ_PRIVATE_KEY (nsec or 32-byte hex) is required — the agent pays with its own Nostr key');
  const privkey = privkeyFromNsec(key);

  const kind = env.PICOCASH_STORE ?? (env.BUZZ_RELAY_URL && env.PICOCASH_OWNER_PUBKEY ? 'engram' : 'file');
  let store: McpConfig['store'];
  if (kind === 'engram') {
    if (!env.BUZZ_RELAY_URL) throw new Error('PICOCASH_STORE=engram needs BUZZ_RELAY_URL');
    if (!env.PICOCASH_OWNER_PUBKEY) throw new Error('PICOCASH_STORE=engram needs PICOCASH_OWNER_PUBKEY (owner npub or x-only hex) — the engram is encrypted to owner⇄agent');
    const relayUrl = env.BUZZ_RELAY_URL.replace(/^http/, 'ws');
    store = { kind: 'engram', relayUrl, ownerPubkey: lockKeyFromNpub(env.PICOCASH_OWNER_PUBKEY).slice(2) };
  } else if (kind === 'memory') {
    store = { kind: 'memory' };
  } else {
    store = { kind: 'file', path: env.PICOCASH_WALLET_FILE ?? join(homedir(), '.picocash', 'wallet.json') };
  }
  return { mintUrl, privkey, store };
}
