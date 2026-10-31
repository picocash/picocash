/**
 * The public dashboard. One HTML string, DOM-built from `/v1/tokens` (no
 * innerHTML with data). Every number on the page comes with the statement it
 * supports: a green or red sentence with the gap, never a bare figure.
 */
export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tempo Stablecoin Reserves</title>
<meta name="description" content="Independent, live reconciliation of every TIP-20 stablecoin on Tempo: on-chain supply and flows against issuer-reported reserves, with history and drift checks.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{color-scheme:light dark;--bg:#F7F8F7;--panel:#EDF0EE;--ink:#131917;--muted:#5D6B66;--rule:#D8DEDB;--accent:#2F4A9E;--accent-ink:#223B85;--good:#1D7A4A;--bad:#B3341F;--warn:#A5611B;--grey:#7A8580;--chip:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0F1412;--panel:#171D1A;--ink:#E6ECE9;--muted:#98A59F;--rule:#2A332F;--accent:#8EA3E6;--accent-ink:#AEBFF0;--good:#5FC78A;--bad:#F07A62;--warn:#E09A4E;--grey:#8E9994;--chip:#0F1412}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif;padding-block:28px 80px;padding-inline:20px}
main{max-width:1040px;margin:0 auto;display:flex;flex-direction:column;gap:28px}
h1{font-size:1.6rem;font-weight:600;margin:0;letter-spacing:-.01em}
h2{font-size:1.05rem;font-weight:600;margin:0}
p{margin:0}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
header{display:flex;flex-direction:column;gap:8px}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.85rem;color:var(--muted)}
.meta a{color:var(--accent-ink);text-decoration:none}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.stat{background:var(--panel);padding:14px 16px;display:flex;flex-direction:column;gap:2px;border-top:3px solid var(--accent)}
.stat b{font:500 1.55rem/1.15 "IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.stat span{font-size:.82rem;color:var(--muted)}
.rows{display:flex;flex-direction:column;border-top:1px solid var(--rule)}
.row{border-bottom:1px solid var(--rule)}
.row summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:minmax(150px,1.2fr) minmax(130px,1fr) minmax(130px,1fr) minmax(120px,1fr) 110px;gap:12px;align-items:center;padding:12px 6px}
.row summary::-webkit-details-marker{display:none}
.row summary:hover{background:var(--panel)}
.row summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.sym{display:flex;flex-direction:column}
.sym b{font-weight:600}
.sym small{font-size:.78rem;color:var(--muted)}
.num{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;font-size:.95rem}
.num small{display:block;font-size:.74rem;color:var(--muted);font-family:"IBM Plex Sans",sans-serif}
.chip{justify-self:end;font-size:.72rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:4px 8px;border-radius:3px;color:#fff;white-space:nowrap}
.chip.ok{background:var(--good)}.chip.attention{background:var(--bad)}.chip.unattested{background:var(--grey)}
.detail{padding:4px 6px 18px;display:grid;grid-template-columns:1fr;gap:14px}
@media (min-width:860px){.detail{grid-template-columns:3fr 2fr}}
.checks{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.checks li{display:grid;grid-template-columns:18px 1fr;gap:8px;font-size:.9rem}
.checks .mark{font-weight:700}
.checks li.ok .mark{color:var(--good)}.checks li.bad .mark{color:var(--bad)}.checks li.na .mark{color:var(--grey)}
.checks .d{display:block;font-size:.82rem;color:var(--muted);font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;word-break:break-word}
.facts{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:.85rem;align-content:start}
.facts dt{color:var(--muted)}.facts dd{margin:0;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;word-break:break-all}
.spark{width:100%;height:56px;display:block}
.tier{font-size:.74rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:14px 6px 6px;border-bottom:1px solid var(--rule)}
.sym .why{display:inline-flex;gap:4px;margin-top:2px}
.sym .why span{font-size:.66rem;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);border:1px solid var(--rule);padding:1px 5px;border-radius:2px}
.sym .why span.collision{color:var(--bad);border-color:var(--bad)}
.foot{font-size:.82rem;color:var(--muted);display:flex;flex-direction:column;gap:6px;max-width:72ch}
.foot a{color:var(--accent-ink)}
.err{font-size:.8rem;color:var(--warn)}
@media (max-width:700px){.row summary{grid-template-columns:1fr 1fr;grid-auto-rows:auto}.chip{justify-self:start}}
</style>
</head>
<body>
<main>
<header>
<h1>Tempo Stablecoin Reserves</h1>
<p class="muted">Every TIP-20 stablecoin on Tempo mainnet, reconciled live: what the chain says exists, what the issuer says backs it, and whether the two agree. Independent of any issuer.</p>
<div class="meta" id="meta"><span>loading latest snapshot…</span></div>
</header>
<section class="strip" id="strip" aria-live="polite"></section>
<section style="display:flex;flex-direction:column;gap:10px">
<h2>Tokens by on-chain supply</h2>
<div class="rows" id="rows"></div>
<p class="err" id="errors" hidden></p>
</section>
<footer class="foot">
<p><strong>How to read it.</strong> <em>On-chain supply</em> is <span class="mono">totalSupply()</span> read directly from each TIP-20 contract on Tempo. <em>Issuer reserves</em> and <em>issuer supply</em> are the issuer's own figures from Bridge's public transparency feed, which Bridge describes as not an independent attestation; this page is the independent comparison. For coins that also live on other chains, those legs come from DefiLlama so the issuer's single total can be reconciled against all chains together. Flows are a recent sample window extrapolated to a day.</p>
<p>Grey means we have no public attestation source for that token — not that something is wrong. Red states the gap in dollars. Checks tolerate 0.01% on single-chain comparisons and 0.1% across chains.</p>
<p>JSON: <a href="/v1/tokens">/v1/tokens</a> · <a href="/v1/history/0x20c0000000000000000000000000000000000000">/v1/history/:address</a> · Source: picocash. Not financial advice; a monitor, not a guarantee.</p>
</footer>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') n.className = v; else if (k === 'html') n.textContent = v; else n.setAttribute(k, v); } for (const c of kids) if (c !== null && c !== undefined) n.append(c); return n; };
  const money = (micros, dec = 6) => { const v = BigInt(micros); const neg = v < 0n; const a = neg ? -v : v; const w = a / 10n ** BigInt(dec); const f = (a % 10n ** BigInt(dec)).toString().padStart(dec, '0').slice(0, 2); return (neg ? '−' : '') + '$' + w.toLocaleString('en-US') + '.' + f; };
  const compact = (micros) => { const n = Number(BigInt(micros)) / 1e6; return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(0) + 'K' : '$' + n.toFixed(2); };
  const ago = (iso) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 90 ? Math.round(s) + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'; };
  const explorer = 'https://explore.tempo.xyz';

  function spark(points) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('viewBox', '0 0 300 56'); svg.setAttribute('class', 'spark'); svg.setAttribute('role', 'img');
    if (!points || points.length < 2) { svg.setAttribute('aria-label', 'history: not enough points yet'); const t = document.createElementNS(svgNS, 'text'); t.setAttribute('x', '0'); t.setAttribute('y', '34'); t.setAttribute('fill', 'currentColor'); t.setAttribute('font-size', '11'); t.textContent = 'history builds hourly — ' + (points ? points.length : 0) + ' point(s) so far'; svg.append(t); return svg; }
    const vals = points.map((p) => Number(BigInt(p.tempoSupply)) / 1e6); const res = points.map((p) => p.reportedReserves ? Number(BigInt(p.reportedReserves)) / 1e6 : null);
    const all = vals.concat(res.filter((x) => x !== null)); const lo = Math.min(...all), hi = Math.max(...all); const span = hi - lo || 1;
    const x = (i) => (i / (points.length - 1)) * 296 + 2; const y = (v) => 50 - ((v - lo) / span) * 44;
    const path = (arr) => arr.map((v, i) => v === null ? null : (i === 0 || arr[i - 1] === null ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(v).toFixed(1)).filter(Boolean).join(' ');
    const p1 = document.createElementNS(svgNS, 'path'); p1.setAttribute('d', path(vals)); p1.setAttribute('fill', 'none'); p1.setAttribute('stroke', 'var(--accent)'); p1.setAttribute('stroke-width', '1.8'); svg.append(p1);
    if (res.some((r) => r !== null)) { const p2 = document.createElementNS(svgNS, 'path'); p2.setAttribute('d', path(res)); p2.setAttribute('fill', 'none'); p2.setAttribute('stroke', 'var(--good)'); p2.setAttribute('stroke-width', '1.4'); p2.setAttribute('stroke-dasharray', '3 3'); svg.append(p2); }
    svg.setAttribute('aria-label', 'on-chain supply (solid) and issuer reserves (dashed), ' + points.length + ' hourly points');
    return svg;
  }

  async function render() {
    const res = await fetch('/v1/tokens', { cache: 'no-store' });
    if (!res.ok) { $('meta').replaceChildren(el('span', {}, 'No snapshot yet — the first refresh is running. Reload in a minute.')); return; }
    const d = await res.json();
    const tokens = d.tokens;
    const attested = tokens.filter((t) => t.issuer);
    const sum = (arr, f) => arr.reduce((s, t) => s + BigInt(f(t)), 0n);
    const total = sum(tokens, (t) => t.tempoSupply);
    const attestedSupply = sum(attested, (t) => t.tempoSupply);
    const failing = tokens.filter((t) => t.status === 'attention').length;

    const recognized = tokens.filter((t) => t.tracked.some((r) => r !== 'active'));
    const merelyActive = tokens.filter((t) => !t.tracked.some((r) => r !== 'active'));
    const recognizedSupply = sum(recognized, (t) => t.tempoSupply);

    $('meta').replaceChildren(
      el('span', {}, 'Tempo mainnet · chain ' + d.chainId),
      el('span', {}, 'block ', el('a', { href: explorer + '/block/' + d.block, target: '_blank', rel: 'noopener', class: 'mono' }, String(d.block).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','))),
      el('span', {}, 'refreshed ' + ago(d.refreshedAt) + ' ago · every 10 min'),
      el('span', {}, d.universe.registered.toLocaleString('en-US') + ' TIP-20 tokens ever created · ' + d.universe.activeInWindow + ' moved in the last ' + Math.round(d.universe.activityWindowBlocks * 0.55 / 60) + ' min'),
    );
    $('strip').replaceChildren(
      el('div', { class: 'stat' }, el('b', { class: 'mono' }, compact(recognizedSupply)), el('span', {}, 'supply of recognized stablecoins on Tempo (on-chain, live)')),
      el('div', { class: 'stat' }, el('b', { class: 'mono' }, recognizedSupply ? (Number(attestedSupply * 10000n / recognizedSupply) / 100).toFixed(1) + '%' : '—'), el('span', {}, 'of that has a public issuer attestation (' + attested.length + ' of ' + recognized.length + ' tokens)')),
      el('div', { class: 'stat', style: failing ? 'border-top-color:var(--bad)' : 'border-top-color:var(--good)' }, el('b', { class: 'mono' }, String(failing)), el('span', {}, failing === 1 ? 'token with a failing check' : 'tokens with a failing check')),
      el('div', { class: 'stat' }, el('b', { class: 'mono' }, String(recognized.length)), el('span', {}, 'recognized stablecoins · ' + merelyActive.length + ' other tokens active')),
    );
    void total;

    const rowFor = (t) => {
      const sup = BigInt(t.tempoSupply);
      const issuerCell = t.issuer
        ? el('div', { class: 'num' }, money(t.issuer.reportedReserves), el('small', {}, 'issuer reserves · ' + ago(t.issuer.lastUpdated) + ' old'))
        : el('div', { class: 'num muted' }, '—', el('small', {}, 'no public attestation'));
      const flows = t.flows ? (() => { const perDay = (x) => BigInt(x) * 86400n / BigInt(Math.max(1, t.flows.seconds)); const memoPct = t.flows.transfers ? Math.round(100 * t.flows.memoTransfers / t.flows.transfers) : 0; return el('div', { class: 'num' }, compact(perDay(t.flows.transferVolume).toString()) + '/day', el('small', {}, Math.round(t.flows.transfers * 86400 / Math.max(1, t.flows.seconds)).toLocaleString('en-US') + ' transfers/day · ' + memoPct + '% with memo')); })() : el('div', { class: 'num muted' }, '—', el('small', {}, sup > 0n ? 'below flow-sampling floor' : 'no supply'));
      const summary = el('summary', {},
        el('div', { class: 'sym' }, el('b', {}, t.symbol || '(no symbol)'), el('small', {}, (t.name || '') + (t.currency ? ' · ' + t.currency : '')), el('div', { class: 'why' }, ...t.tracked.map((r) => el('span', { class: r }, r === 'collision' ? 'look-alike' : r)))),
        el('div', { class: 'num' }, money(t.tempoSupply, t.decimals), el('small', {}, 'on-chain supply (Tempo)' + (t.otherChains.length ? ' + ' + t.otherChains.length + ' other chain' + (t.otherChains.length > 1 ? 's' : '') : ''))),
        issuerCell,
        flows,
        el('span', { class: 'chip ' + t.status }, t.status === 'ok' ? 'reconciled' : t.status === 'attention' ? 'attention' : 'unattested'),
      );
      const checks = el('ul', { class: 'checks' }, ...t.checks.map((c) => el('li', { class: c.ok === null ? 'na' : c.ok ? 'ok' : 'bad' }, el('span', { class: 'mark' }, c.ok === null ? '·' : c.ok ? '✓' : '✗'), el('span', {}, c.label, el('span', { class: 'd' }, c.detail)))));
      const facts = el('dl', { class: 'facts' },
        el('dt', {}, 'contract'), el('dd', {}, el('a', { href: explorer + '/address/' + t.address, target: '_blank', rel: 'noopener' }, t.address)),
        el('dt', {}, 'created'), el('dd', {}, t.createdBlock ? 'block ' + t.createdBlock.toLocaleString('en-US') : '—'),
        el('dt', {}, 'supply cap'), el('dd', {}, BigInt(t.supplyCap) >= 2n ** 120n ? 'unlimited (default)' : money(t.supplyCap, t.decimals)),
        el('dt', {}, 'transfer policy'), el('dd', {}, '#' + t.transferPolicyId + (t.paused ? ' · PAUSED' : '')),
        ...(t.otherChains.length ? [el('dt', {}, 'other chains'), el('dd', {}, t.otherChains.map((c) => c.chain + ' $' + Math.round(c.usd).toLocaleString('en-US')).join(' · '))] : []),
        ...(t.issuer ? [el('dt', {}, 'issuer feed'), el('dd', {}, el('a', { href: 'https://transparency.bridge.xyz/v0/stablecoins/' + t.issuer.slug, target: '_blank', rel: 'noopener' }, 'bridge / ' + t.issuer.slug)), el('dt', {}, 'issuer supply'), el('dd', {}, money(t.issuer.reportedSupply) + ' (all chains)'), el('dt', {}, 'breakdown'), el('dd', {}, t.issuer.breakdown.map((b) => b.type + ' ' + money(b.amount)).join(' · '))] : []),
        ...(t.flows ? [el('dt', {}, 'minted / burned'), el('dd', {}, money(t.flows.minted) + ' / ' + money(t.flows.burned) + ' in sample (' + (t.flows.seconds / 3600).toFixed(1) + ' h)')] : []),
      );
      const sparkHolder = el('div', {}, el('small', { class: 'muted' }, '90-day history — supply (solid) vs issuer reserves (dashed)'), el('div', { class: 'sparkslot' }));
      const details = el('details', { class: 'row' }, summary, el('div', { class: 'detail' }, el('div', {}, checks), el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, facts, sparkHolder)));
      details.addEventListener('toggle', async () => { if (!details.open || details.dataset.loaded) return; details.dataset.loaded = '1'; try { const h = await (await fetch('/v1/history/' + t.address)).json(); sparkHolder.querySelector('.sparkslot').replaceChildren(spark(h)); } catch { sparkHolder.querySelector('.sparkslot').replaceChildren(el('small', { class: 'muted' }, 'history unavailable')); } });
      return details;
    };
    const tierLabel = (txt) => el('div', { class: 'tier' }, txt);
    $('rows').replaceChildren(
      tierLabel('Recognized stablecoins — issuer-attested, market-listed, or bridged majors'),
      ...recognized.map(rowFor),
      ...(merelyActive.length ? [tierLabel('Other TIP-20 tokens that moved recently — yield wrappers, vault shares, look-alikes and tests; no public attestation'), ...merelyActive.map(rowFor)] : []),
    );
    const errBox = $('errors'); if (d.errors && d.errors.length) { errBox.hidden = false; errBox.textContent = 'Partial refresh: ' + d.errors.slice(0, 4).join(' · ') + (d.errors.length > 4 ? ' · +' + (d.errors.length - 4) + ' more' : ''); } else errBox.hidden = true;
  }
  render().catch((e) => { $('meta').replaceChildren(el('span', { class: 'err' }, 'Could not load snapshot: ' + e.message)); });
  setInterval(() => render().catch(() => {}), 60_000);
})();
</script>
</body>
</html>`;
}
