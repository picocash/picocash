/** Mint status page (GET /): renders /v1/status. Self-contained; all data rendered as text nodes. */
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function statusPage(o: { name: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.name)} — mint status</title>
<style>
  :root { color-scheme: light dark; --b:#154c9c; --g:#1f9e5a; --r:#c0392b; --a:#b7791f; --ink:#16202e; --dim:#5b6878; --bg:#fff; --panel:#f5f8fb; --line:#e3e9f0; --code:#eef2f7; }
  @media (prefers-color-scheme: dark) { :root { --b:#6aa1f0; --g:#3dc47c; --r:#ef6a5f; --a:#e2b35a; --ink:#e7ebf1; --dim:#93a0b0; --bg:#0e1116; --panel:#161b23; --line:#26303d; --code:#1c232d; } }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 28px 20px 60px; }
  header { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom: 6px; }
  .brand { font-weight:800; font-size:20px; letter-spacing:-.02em; } .brand .b{color:var(--b)} .brand .g{color:var(--g)}
  h1 { font-size: 24px; margin: 0; } .sub { color: var(--dim); margin: 0 0 22px; }
  h2 { font-size: 16px; margin: 26px 0 10px; letter-spacing: .02em; text-transform: uppercase; color: var(--dim); }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border:1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card .k { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; }
  .card .v { font-size: 22px; font-weight: 700; letter-spacing: -.01em; margin-top: 2px; }
  .card .v small { font-size: 13px; font-weight: 500; color: var(--dim); }
  .card .v a, .card .v .mono { font-size: 12px; word-break: break-all; white-space: normal; }
  .card.pos .v { color: var(--g); } .card.neg .v { color: var(--r); }
  .card .note { font-size: 13px; font-weight: 600; margin-top: 4px; } .card.pos .note { color: var(--g); } .card.neg .note { color: var(--r); }
  .row3 { display:grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px; }
  @media (max-width: 720px) { .row3 { grid-template-columns: 1fr; } }
  .checks { display:grid; gap: 8px; }
  .check { display:flex; gap: 12px; align-items:flex-start; background: var(--panel); border:1px solid var(--line); border-radius: 10px; padding: 10px 14px; }
  .check .mark { flex: 0 0 26px; height: 26px; border-radius: 50%; display:inline-flex; align-items:center; justify-content:center; font-weight: 800; color:#fff; font-size: 14px; }
  .ok .mark { background: var(--g);} .bad .mark { background: var(--r);} .na .mark { background: var(--dim);}
  .check b { display:block; } .check span { color: var(--dim); font-size: 13.5px; }
  table { width:100%; border-collapse: collapse; font-size: 13.5px; } th, td { text-align:left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code, .mono { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border-radius: 4px; padding: 1px 5px; }
  a { color: var(--b); } .wrap { overflow-x:auto; }
  .state { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: var(--code); }
  .foot { color: var(--dim); font-size: 13px; margin-top: 28px; }
  #err { color: var(--r); }
</style>
</head>
<body>
<main>
  <header><div class="brand"><span class="b">Pico</span><span class="g">Cash</span></div><h1 id="name">${esc(o.name)}</h1></header>
  <p class="sub" id="sub">Loading the mint's books and the vault's on-chain state…</p>
  <p id="err"></p>

  <h2>Custody at a glance</h2>
  <div class="row3" id="glance1"></div>
  <div class="row3" id="glance2"></div>

  <h2>Checks — what should hold, and whether it does</h2>
  <div class="checks" id="checks"></div>

  <h2>Vault</h2>
  <div class="grid" id="vault"></div>

  <h2>Recent mints (deposits observed on-chain)</h2>
  <div class="wrap"><table><thead><tr><th>when</th><th class="num">amount</th><th>quote id = memo</th><th>deposit tx</th><th>state</th></tr></thead><tbody id="mints"></tbody></table></div>

  <h2>Recent melts (payouts from the vault)</h2>
  <div class="wrap"><table><thead><tr><th>when</th><th class="num">paid out</th><th class="num">fee kept</th><th>melt id</th><th>payout tx</th><th>state</th></tr></thead><tbody id="melts"></tbody></table></div>

  <p class="foot">Every figure on the right-hand side of a check is read from the chain at render time; every figure on the left is the mint's own database.
    The mint is a custodian — this page exists so that any drift between the two is visible immediately. Raw data: <a href="/v1/status">/v1/status</a> · <a href="/v1/info">/v1/info</a> · <a href="/v1/keys">/v1/keys</a> · <a href="/v1/solvency">/v1/solvency</a>.
    Refreshes every 30 s. <a href="https://github.com/picocash/pips/blob/main/PIP-04.md">PIP-04</a></p>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') n.className = v; else n.setAttribute(k, v); } for (const c of kids) n.append(c); return n; };
  let decimals = 6, symbol = '';
  const usd = (x) => (Number(x) / 10 ** decimals).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const money = (x) => el('span', {}, '$' + usd(x), ' ', el('small', {}, String(x) + ' base'));
  const when = (ts) => new Date(ts * 1000).toLocaleString();
  const short = (h) => h ? h.slice(0, 10) + '…' + h.slice(-6) : '—';
  const explorer = (chainId) => chainId === 42431 ? 'https://explore.testnet.tempo.xyz' : null;
  const txLink = (base, tx) => { if (!tx) return el('span', { class: 'mono' }, '—'); const h = tx.split(':')[0]; return base && /^0x[0-9a-fA-F]{64}$/.test(h) ? el('a', { href: base + '/tx/' + h, target: '_blank', rel: 'noopener', class: 'mono' }, short(h)) : el('span', { class: 'mono' }, short(h)); };
  const addrLink = (base, a) => base && a ? el('a', { href: base + '/address/' + a, target: '_blank', rel: 'noopener', class: 'mono' }, a) : el('span', { class: 'mono' }, a || '—');
  const card = (k, v) => el('div', { class: 'card' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));

  async function render() {
    let d;
    try { const r = await fetch('/v1/status', { headers: { accept: 'application/json' } }); d = await r.json(); if (!r.ok) throw new Error(d?.error?.message || r.status); }
    catch (e) { $('err').textContent = 'could not load /v1/status: ' + e.message; return; }
    $('err').textContent = '';
    const base = explorer(d.vault?.chain_id);
    const c = d.chain;
    $('sub').replaceChildren('unit ', el('code', {}, d.mint.unit), ' · keyset ', el('code', {}, d.mint.keyset.id), ' · vault ', d.vault ? addrLink(base, d.vault.address) : el('code', {}, 'fake'), ' · ', d.mint.melt ? 'melt enabled' : 'melt disabled', ' · updated ', when(d.generated_at));

    const _unused = (k, delta, note) => {
      const cls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : '';
      const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
      return el('div', { class: 'card ' + cls }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, sign + '$' + usd(Math.abs(delta)), ' ', el('small', {}, (delta >= 0 ? '' : '-') + Math.abs(delta) + ' base' + (note ? ' · ' + note : ''))));
    };
    const bal = c ? Number(c.balance) : null;
    $('glance1').replaceChildren(
      card('Vault balance (on-chain)', c ? money(c.balance) : '—'),
      card('Minted token balance (outstanding)', money(d.books.outstanding)),
      (() => {
        if (bal === null) return card('Vault − minted', '—');
        const diff = bal - d.books.outstanding;
        const n = el('div', { class: 'card ' + (diff >= 0 ? 'pos' : 'neg') }, el('div', { class: 'k' }, 'Vault − minted'), el('div', { class: 'v' }, (diff >= 0 ? '+' : '−') + '$' + usd(Math.abs(diff)), ' ', el('small', {}, diff + ' base')));
        n.append(el('div', { class: 'note' }, diff >= 0 ? '✓ every token is backed' + (diff > 0 ? ' (surplus = retained melt fees)' : '') : '✗ UNDER-BACKED by $' + usd(Math.abs(diff))));
        return n;
      })(),
    );
    const net = d.books.deposits - d.books.payouts;
    $('glance2').replaceChildren(
      card('Total mint deposits', el('span', {}, money(d.books.deposits), el('small', {}, ' · ' + d.books.deposit_count + ' quotes'))),
      card('Total mint withdrawals', el('span', {}, money(d.books.payouts), el('small', {}, ' · ' + d.books.payout_count + ' melts · fees kept $' + usd(d.books.fees_retained)))),
      (() => {
        const n = el('div', { class: 'card' + (bal === null ? '' : bal - net === 0 ? ' pos' : ' neg') }, el('div', { class: 'k' }, 'Deposits − withdrawals'), el('div', { class: 'v' }, '$' + usd(net), ' ', el('small', {}, net + ' base')));
        if (bal !== null) {
          const diff = bal - net;
          n.append(el('div', { class: 'note' }, diff === 0 ? '✓ equals the vault balance' : '✗ vault balance is $' + usd(Math.abs(diff)) + (diff > 0 ? ' higher' : ' lower') + ' than deposits − withdrawals'));
        }
        return n;
      })(),
    );

    $('checks').replaceChildren(...d.checks.map((k) => el('div', { class: 'check ' + (k.ok === null ? 'na' : k.ok ? 'ok' : 'bad') },
      el('span', { class: 'mark' }, k.ok === null ? '?' : k.ok ? '✓' : '✗'), el('div', {}, el('b', {}, k.label), el('span', {}, k.detail)))));

    const em = c?.emergency;
    $('vault').replaceChildren(
      card('Vault contract', d.vault ? addrLink(base, d.vault.address) : '—'),
      card('Backing token', d.vault ? addrLink(base, d.vault.token) : '—'),
      card('Operator', addrLink(base, c?.operator)),
      card('Publication policy', c ? el('span', {}, (c.publish_interval_blocks ? 'every ' + c.publish_interval_blocks + ' blocks' : '') + (c.publish_threshold_bps ? (c.publish_interval_blocks ? ' or ' : '') + (c.publish_threshold_bps / 100) + '% drift' : '')) : '—'),
      card('Last attested outstanding', c && c.last_outstanding !== null ? money(c.last_outstanding) : 'never'),
      card('Last publication', c?.last_published_at ? el('span', {}, when(c.last_published_at), el('small', {}, ' · block ' + c.last_published_block + ' (now ' + c.block + ')')) : 'never'),
      card('Melt fee / ceiling', c ? el('span', {}, '$' + usd(d.mint.fees.melt), el('small', {}, ' / ' + (c.max_melt_fee !== null ? '$' + usd(c.max_melt_fee) : 'no ceiling (v1)'))) : '$' + usd(d.mint.fees.melt)),
      card('Rotation timelock', c?.rotation_timelock !== null && c?.rotation_timelock !== undefined ? (c.rotation_timelock / 86400).toFixed(1) + ' days' : '—'),
      card('Unilateral exit', em ? el('span', {}, em.mode ? 'EMERGENCY MODE' : 'armed', el('small', {}, ' · grace ' + em.grace_blocks + ' blocks · keyset ' + (c.keyset_registered ? 'registered' : 'NOT registered') + ' · redeemed $' + usd(em.redeemed) + ' / cap $' + usd(em.cap))) : 'not available (v1 vault)'),
    );

    $('mints').replaceChildren(...d.ledger.mints.map((m) => el('tr', {}, el('td', {}, when(m.at)), el('td', { class: 'num' }, '$' + usd(m.amount)), el('td', {}, el('code', {}, short(m.quote_id))), el('td', {}, txLink(base, m.tx)), el('td', {}, el('span', { class: 'state' }, m.state)))));
    if (!d.ledger.mints.length) $('mints').replaceChildren(el('tr', {}, el('td', { colspan: '5' }, 'no deposits yet')));
    $('melts').replaceChildren(...d.ledger.melts.map((m) => el('tr', {}, el('td', {}, when(m.at)), el('td', { class: 'num' }, '$' + usd(m.amount)), el('td', { class: 'num' }, '$' + usd(m.fee)), el('td', {}, el('code', {}, short(m.melt_id))), el('td', {}, txLink(base, m.tx)), el('td', {}, el('span', { class: 'state' }, m.state)))));
    if (!d.ledger.melts.length) $('melts').replaceChildren(el('tr', {}, el('td', { colspan: '6' }, 'no melts yet')));
  }
  render(); setInterval(render, 30000);
})();
</script>
</body>
</html>`;
}
