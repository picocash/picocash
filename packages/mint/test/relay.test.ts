import { describe, expect, it } from 'vitest';
import { makeMint } from './helpers.js';

describe('PIP-07 browser reveal page', () => {
  it('serves HTML to browsers without consuming the blob; JSON pointer to others', async () => {
    const mint = await makeMint();
    const up = await mint.post('/v1/relay', { ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const id = up.body.id;
    const page = await mint.app.request(`/t/${id}`, { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('Reveal token');
    expect(html).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAA'); // ciphertext is not in the page
    // the blob is still there: a later resolve succeeds exactly once
    expect((await mint.get(`/v1/relay/${id}`)).status).toBe(200);
    expect((await mint.get(`/v1/relay/${id}`)).status).toBe(404);
    const json = await mint.app.request(`/t/${id}`, { headers: { accept: 'application/json' } });
    expect((await json.json()).resolve).toContain(`/v1/relay/${id}`);
  });
});
