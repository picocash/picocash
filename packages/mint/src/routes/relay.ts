import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { MintContext } from '../context.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../validation.js';
import { relayPage } from './relay-page.js';

/**
 * PIP-07 token-link relay — an OPTIONAL capability. The relay stores only
 * client-side-encrypted blobs; the AES key travels in the link's URL fragment
 * and never reaches this server. Burn-after-read, TTL-purged, size-capped.
 * It cannot spend, decrypt, or link anything it stores.
 */

const B64URL = /^[A-Za-z0-9_-]+$/;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export function relayRoutes(ctx: MintContext): Hono {
  const app = new Hono();
  const { relay } = ctx.config;

  const requireEnabled = () => {
    if (!relay.enabled) {
      throw new ApiError(404, 'RELAY_DISABLED', 'this mint does not run a token-link relay', 'share the picoA… token string directly, or use another relay (PIP-07)');
    }
  };

  const uploadSchema = z.object({
    // generous hard ceiling for abuse; the precise PAYLOAD_TOO_LARGE check runs below
    ct: z.string().min(1).max(1_000_000).regex(B64URL, 'ct must be base64url'),
  });

  app.post('/v1/relay', async (c) => {
    requireEnabled();
    const body = await parseBody(c, uploadSchema);
    const decodedBytes = Math.floor((body.ct.length * 3) / 4);
    if (decodedBytes > relay.maxBytes) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `ciphertext is ${decodedBytes} bytes; limit is ${relay.maxBytes}`, 'split the payment into smaller tokens or share the token string directly');
    }
    const id = b64url(randomBytes(16));
    const expiresAt = nowSeconds() + relay.ttlSeconds;
    // opportunistic purge keeps the table bounded without a scheduler
    await ctx.db.query('DELETE FROM relay_blobs WHERE expires_at < $1', [nowSeconds()]);
    await ctx.db.query('INSERT INTO relay_blobs (id, ct, expires_at) VALUES ($1, $2, $3)', [id, body.ct, expiresAt]);
    const origin = new URL(c.req.url).origin;
    return c.json({ id, url: `${origin}/t/${id}`, expires_at: expiresAt });
  });

  app.get('/v1/relay/:id', async (c) => {
    requireEnabled();
    const id = c.req.param('id');
    if (!B64URL.test(id) || id.length !== 22) {
      throw new ApiError(404, 'RELAY_NOT_FOUND', 'no such link', 'the link may have been used, expired, or mistyped — ask the sender for a fresh one');
    }
    // Burn-after-read: the DELETE ... RETURNING is the single atomic read.
    const taken = await ctx.db.query<{ ct: string; expires_at: string | number }>(
      'DELETE FROM relay_blobs WHERE id = $1 RETURNING ct, expires_at',
      [id],
    );
    const row = taken.rows[0];
    if (!row || Number(row.expires_at) < nowSeconds()) {
      throw new ApiError(404, 'RELAY_NOT_FOUND', 'no such link (already read, expired, or never existed)', 'ask the sender for a fresh link — the sender still holds the token');
    }
    return c.json({ ct: row.ct });
  });

  /**
   * A person opened the link in a browser: serve the reveal page (PIP-07).
   * Nothing is fetched server-side here — the blob is read only when the user
   * clicks Reveal, so previews/prefetchers never burn the link. Non-browser
   * clients get the JSON pointer.
   */
  app.get('/t/:id', (c) => {
    requireEnabled();
    const id = c.req.param('id');
    const origin = new URL(c.req.url).origin;
    const pointer = `${origin}/t/${id}`;
    const resolve = `${origin}/v1/relay/${id}`;
    if (B64URL.test(id) && id.length === 22 && (c.req.header('accept') ?? '').includes('text/html')) {
      c.header('cache-control', 'no-store');
      c.header('referrer-policy', 'no-referrer');
      c.header('x-robots-tag', 'noindex');
      c.header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
      return c.html(relayPage({ mintName: ctx.config.name, resolveUrl: resolve, walletUrl: relay.uiUrl, pointer }));
    }
    return c.json({ link: pointer, resolve, note: 'PIP-07 token link: fetch the ciphertext, decrypt with the key in the URL fragment' });
  });

  return app;
}
