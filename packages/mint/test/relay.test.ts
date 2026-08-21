import { describe, expect, it } from 'vitest';
import { makeMint, mintTokens } from './helpers.js';

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

describe('mint status (transparency)', () => {
  it('/v1/status composes books, checks, and ledger; / serves the page', async () => {
    const mint = await makeMint();
    const proofs = await mintTokens(mint, 12);
    const q = await mint.post('/v1/melt/quote', { amount: 4, unit: mint.config.unit, to: '0x00000000000000000000000000000000000000A1' });
    await mint.post('/v1/melt', { melt_id: q.body.melt_id, inputs: proofs.filter((p) => p.amount === 4) });
    const st = await mint.get('/v1/status');
    expect(st.status).toBe(200);
    expect(st.body.books.outstanding).toBe(8);
    expect(st.body.books.deposits).toBe(12);
    expect(st.body.books.payouts).toBe(4);
    expect(st.body.ledger.mints).toHaveLength(1);
    expect(st.body.ledger.melts[0].state).toBe('PAID');
    expect(st.body.chain).toBeNull(); // fake vault: no chain
    expect(st.body.checks.find((c: any) => c.id === 'owed').ok).toBe(true);
    expect(st.body.checks.find((c: any) => c.id === 'backing').ok).toBeNull();
    const page = await mint.app.request('/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Checks — what should hold');
  });
});
