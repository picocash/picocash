/**
 * PIP-07 browser page for `GET /t/{id}` — what a person sees when they click a
 * token link. Self-contained (no external assets; works for any mint).
 *
 * Burn-safety: NOTHING is fetched on load. The relay blob is read only when
 * the user clicks "Reveal", so link-preview bots and prefetchers never consume
 * the one-time link. The AES key lives in the URL fragment and never leaves
 * the browser. The token is rendered as text, never as markup.
 */
export interface RelayPageOptions {
  mintName: string;
  resolveUrl: string;
  /** Optional wallet UI that understands `?link=<pointer>` (fragment carried over). */
  walletUrl?: string | undefined;
  pointer: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function relayPage(o: RelayPageOptions): string {
  // Values reach the script only as JSON literals inside a <script> we control; the `<` escape keeps them from closing the tag.
  const cfg = JSON.stringify({ resolve: o.resolveUrl, wallet: o.walletUrl ?? null, pointer: o.pointer }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>eCash token — ${esc(o.mintName)}</title>
<style>
  :root { color-scheme: light dark;
    --b: #154c9c; --g: #1f9e5a; --ink: #16202e; --dim: #5b6878; --bg: #ffffff; --panel: #f5f8fb; --line: #e3e9f0; --code: #eef2f7; --warn: #9a5b00; --warn-bg: #fff6e5; }
  @media (prefers-color-scheme: dark) { :root {
    --b: #6aa1f0; --g: #3dc47c; --ink: #e7ebf1; --dim: #93a0b0; --bg: #0e1116; --panel: #161b23; --line: #26303d; --code: #1c232d; --warn: #ffcf7a; --warn-bg: #2b2210; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 560px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 28px; }
  .brand { font-weight: 800; letter-spacing: -0.02em; font-size: 18px; margin-bottom: 18px; }
  .brand .b { color: var(--b); } .brand .g { color: var(--g); }
  h1 { font-size: 22px; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { margin: 0 0 14px; color: var(--dim); }
  .mint { font-size: 13px; color: var(--dim); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
  button, a.btn { appearance: none; border: 0; border-radius: 10px; padding: 12px 18px; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-block; }
  .primary { background: var(--b); color: #fff; } .primary:hover { filter: brightness(1.08); }
  .secondary { background: transparent; color: var(--b); border: 1px solid var(--b); }
  button:disabled { opacity: .6; cursor: progress; }
  .notice { background: var(--warn-bg); color: var(--warn); border-radius: 10px; padding: 10px 12px; font-size: 14px; margin-top: 16px; }
  textarea { width: 100%; min-height: 150px; margin-top: 14px; background: var(--code); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 12px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; resize: vertical; }
  .hidden { display: none; }
  .err { color: #c0392b; }
  .ok { color: var(--g); font-weight: 700; }
  .fine { font-size: 13px; margin-top: 16px; }
  .fine a { color: var(--b); }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="b">Pico</span><span class="g">Cash</span></div>

  <section id="intro">
    <h1>Someone sent you an eCash token 🔒</h1>
    <p>This link opens <b>once</b>. Reveal the token here and copy it into your wallet, or hand the link straight to a wallet.</p>
    <p class="mint">Mint: ${esc(o.mintName)}</p>
    <div class="row">
      <button id="reveal" class="primary">Reveal token</button>
      <a id="wallet" class="btn secondary hidden" href="#">Open in wallet</a>
    </div>
    <p id="nokey" class="notice hidden">This link is missing its key (the part after <code>#</code>). Ask the sender to resend the full link — nothing has been consumed.</p>
  </section>

  <section id="result" class="hidden">
    <h1>Your eCash token</h1>
    <p class="ok">Revealed. This link is now used up — copy the token now; it is not stored anywhere else.</p>
    <textarea id="token" readonly spellcheck="false"></textarea>
    <div class="row">
      <button id="copy" class="primary">Copy token</button>
      <a id="walletTok" class="btn secondary hidden" href="#">Paste into wallet</a>
    </div>
    <p class="fine">Whoever holds this string can spend it. Treat it like cash: receive it into a wallet soon (the wallet swaps it for fresh tokens only it knows).</p>
  </section>

  <section id="failed" class="hidden">
    <h1>This link can't be opened</h1>
    <p id="why" class="err"></p>
    <p>If you are the intended recipient and did not reveal it yet, ask the sender to resend — the sender still holds the token, so nothing is lost.</p>
  </section>

  <p class="fine">How this works: the token was encrypted in the sender's browser; the key is in this link's <code>#fragment</code>, which your browser never sends to the server. The relay only ever stored ciphertext. <a href="https://github.com/picocash/pips/blob/main/PIP-07.md">PIP-07</a></p>
</main>
<script>
(() => {
  const cfg = ${cfg};
  const $ = (id) => document.getElementById(id);
  const key = location.hash.replace(/^#/, '');
  const validKey = /^[A-Za-z0-9_-]{43}$/.test(key);
  if (!validKey) { $('nokey').classList.remove('hidden'); $('reveal').disabled = true; }
  if (cfg.wallet && validKey) {
    const w = new URL(cfg.wallet); w.searchParams.set('link', cfg.pointer); w.hash = key;
    $('wallet').href = w.toString(); $('wallet').classList.remove('hidden');
  }
  const unb64url = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4); const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  async function decrypt(ct) {
    const blob = unb64url(ct);
    if (blob.length < 28) throw new Error('payload too short');
    const k = await crypto.subtle.importKey('raw', unb64url(key), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, k, blob.slice(12)).catch(() => { throw new Error('wrong key or tampered payload'); });
    const token = new TextDecoder().decode(plain);
    if (!/^pico[A-Z][A-Za-z0-9_-]+$/.test(token)) throw new Error('decrypted payload is not a token');
    return token;
  }
  function fail(msg) { $('intro').classList.add('hidden'); $('failed').classList.remove('hidden'); $('why').textContent = msg; }
  $('reveal').onclick = async () => {
    $('reveal').disabled = true; $('reveal').textContent = 'Revealing…';
    try {
      const res = await fetch(cfg.resolve, { headers: { accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message || ('relay returned ' + res.status));
      const token = await decrypt(body.ct);
      $('token').value = token;      // text, never markup
      $('intro').classList.add('hidden'); $('result').classList.remove('hidden');
      if (cfg.wallet) { const w = new URL(cfg.wallet); w.hash = 'token=' + token; $('walletTok').href = w.toString(); $('walletTok').classList.remove('hidden'); }
      history.replaceState(null, '', location.pathname); // drop the key from the address bar/history
    } catch (err) { fail(err.message); }
  };
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('token').value); $('copy').textContent = 'Copied ✓'; }
    catch { $('token').select(); document.execCommand('copy'); $('copy').textContent = 'Copied ✓'; }
    setTimeout(() => { $('copy').textContent = 'Copy token'; }, 1800);
  };
})();
</script>
</body>
</html>`;
}
