import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { pcBindSecretHex, Wallet, type Proof } from '@picocash/sdk';
import { CredentialRejected, payChallenge, PicocashAcceptor } from '../src/index.js';
import { fundedWallet, makeTestMint, TEST_MINT_URL } from './helper.js';

async function makeScene(fundAmount: number) {
  const mint = await makeTestMint();
  const { wallet, proofs } = await fundedWallet(mint, fundAmount);
  const keyset = await wallet.getKeyset();
  const acceptor = new PicocashAcceptor({
    realm: 'echo.test',
    mints: [{ url: TEST_MINT_URL, keyset }],
  });
  const serviceWallet = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl: mint.fetchImpl });
  return { mint, wallet, proofs, keyset, acceptor, serviceWallet };
}

/** The paid echo service: 402 + challenge without a credential, echo with one. */
function makeEchoService(acceptor: PicocashAcceptor, price: number) {
  const app = new Hono();
  app.post('/echo', async (c) => {
    const body = await c.req.json<{ message: string; credential?: any }>();
    if (!body.credential) {
      return c.json({ error: 'payment required', challenge: acceptor.createChallenge(price) }, 402);
    }
    const started = performance.now();
    try {
      const receipt = await acceptor.verifyCredential(body.credential);
      return c.json({ echo: body.message, receipt, verify_ms: performance.now() - started });
    } catch (err) {
      if (err instanceof CredentialRejected) {
        return c.json({ error: err.reason, message: err.message }, 402);
      }
      throw err;
    }
  });
  return app;
}

describe('picocash MPP method', () => {
  it('pays an echo service end to end: 402 → credential → offline-verified 200 → settled', async () => {
    const { wallet, proofs, acceptor, serviceWallet } = await makeScene(100_000);
    const echo = makeEchoService(acceptor, 50_000);

    const unpaid = await echo.request('/echo', { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
    expect(unpaid.status).toBe(402);
    const { challenge } = await unpaid.json();
    expect(challenge.method).toBe('picocash');

    const { credential, change } = await payChallenge(wallet, proofs, challenge);
    const paid = await echo.request('/echo', {
      method: 'POST',
      body: JSON.stringify({ message: 'hi', credential }),
    });
    expect(paid.status).toBe(200);
    const result = await paid.json();
    expect(result.echo).toBe('hi');
    expect(result.receipt.settlement).toBe('pending');
    expect(result.verify_ms).toBeLessThan(100); // the headline claim, measured
    expect(change.reduce((s: number, p: Proof) => s + p.amount, 0)).toBe(50_000);

    // replaying the captured credential buys nothing
    const replay = await echo.request('/echo', {
      method: 'POST',
      body: JSON.stringify({ message: 'again', credential }),
    });
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toBe('CHALLENGE_ALREADY_PAID');

    // async settlement at the mint is the moment of finality
    const settled = await acceptor.settle(challenge.challenge_id, serviceWallet);
    expect(settled.settlement).toBe('settled');
  });

  it('headline demo: one $1 deposit funds 20 offline-verified calls', { timeout: 60_000 }, async () => {
    const { wallet, proofs, acceptor } = await makeScene(1_000_000);
    const price = 50_000; // $0.05/call
    const echo = makeEchoService(acceptor, price);
    let held = proofs;
    const latencies: number[] = [];

    for (let call = 0; call < 20; call++) {
      const challenge = (await (await echo.request('/echo', { method: 'POST', body: JSON.stringify({ message: `${call}` }) })).json()).challenge;
      const { credential, change } = await payChallenge(wallet, held, challenge);
      held = change;
      const res = await echo.request('/echo', { method: 'POST', body: JSON.stringify({ message: `${call}`, credential }) });
      expect(res.status).toBe(200);
      latencies.push((await res.json()).verify_ms);
    }
    expect(held.reduce((s, p) => s + p.amount, 0)).toBe(0); // the dollar is fully spent
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    console.log(`offline verification: mean ${mean.toFixed(2)}ms, max ${Math.max(...latencies).toFixed(2)}ms over 20 calls`);
    expect(Math.max(...latencies)).toBeLessThan(100);
  });

  it('rejects unbound, foreign, tampered, short, and duplicate credentials', async () => {
    const { wallet, proofs, acceptor } = await makeScene(1024);
    const expectReject = (credential: any, reason: string) =>
      expect(acceptor.verifyCredential(credential)).rejects.toThrowError(expect.objectContaining({ reason }));
    let held = proofs;
    const boundCredential = async (challenge: ReturnType<typeof acceptor.createChallenge>) => {
      const { credential, change } = await payChallenge(wallet, held, challenge);
      held = change;
      return credential;
    };

    // unknown challenge id
    const stray = await boundCredential(acceptor.createChallenge(32));
    await expectReject({ ...stray, challenge_id: 'chal_nope' }, 'UNKNOWN_CHALLENGE');

    // mint not in the allowlist (checked before binding)
    const c1 = acceptor.createChallenge(32);
    const cred1 = await boundCredential(c1);
    await expectReject({ ...cred1, mint: 'http://evil.test' }, 'MINT_NOT_ALLOWED');

    // plain (unbound) secrets
    const sent = await wallet.send(held, 32);
    held = [...sent.change, ...(await wallet.receive(sent.bundle))]; // reclaim everything
    const bundle = sent.bundle;
    const c2 = acceptor.createChallenge(32);
    await expectReject(
      { method: 'picocash', challenge_id: c2.challenge_id, mint: TEST_MINT_URL, keyset_id: bundle.keyset_id, proofs: bundle.proofs },
      'BINDING_INVALID',
    );

    // credential for challenge A presented against challenge B (nonce mismatch)
    await expectReject({ ...cred1, challenge_id: c2.challenge_id }, 'BINDING_INVALID');

    // sum short of the challenge amount
    const c3 = acceptor.createChallenge(96); // 64 + 32: two proofs
    const cred3 = await boundCredential(c3);
    await expectReject({ ...cred3, proofs: cred3.proofs.slice(0, 1) }, 'AMOUNT_INVALID');

    // tampered signature (binding and amount intact) → DLEQ catches it
    await expectReject(
      { ...cred3, proofs: [{ ...cred3.proofs[0]!, C: '02' + 'ab'.repeat(32) }, cred3.proofs[1]!] },
      'DLEQ_INVALID',
    );

    // duplicate token inside one credential (right sum, same Y twice)
    const c4 = acceptor.createChallenge(64);
    const [bound32] = await wallet.swap(held.filter((p) => p.amount === 32).slice(0, 1), [
      { amount: 32, secret: pcBindSecretHex(c4.nonce, 'echo.test') },
    ]);
    await expectReject(
      { method: 'picocash', challenge_id: c4.challenge_id, mint: TEST_MINT_URL, keyset_id: bound32!.keyset_id, proofs: [bound32!, bound32!] },
      'DUPLICATE_TOKEN',
    );
  });

  it('accept-then-settle detects a double-spend at settlement', async () => {
    const { wallet, proofs, acceptor, serviceWallet } = await makeScene(32);
    const challenge = acceptor.createChallenge(32);
    const { credential } = await payChallenge(wallet, proofs, challenge);

    const receipt = await acceptor.verifyCredential(credential);
    expect(receipt.settlement).toBe('pending');

    // the paying agent still knows the secrets — it races to re-swap them at
    // the mint before the service settles (the bounded-risk window)
    await wallet.swap(credential.proofs, credential.proofs.map((p) => ({ amount: p.amount })));

    const settled = await acceptor.settle(challenge.challenge_id, serviceWallet);
    expect(settled.settlement).toBe('double-spent');
  });
});

describe('acceptor unit check (review P1-5)', () => {
  it('rejects a keyset whose unit differs from the challenge unit', async () => {
    const { wallet, proofs, keyset } = await makeScene(64);
    // allowlist the real keyset but claim it settles a different TIP-20 token
    const acceptor = new PicocashAcceptor({
      realm: 'echo.test',
      mints: [{ url: TEST_MINT_URL, keyset: { ...keyset, unit: 'tip20:42431:0x00000000000000000000000000000000000000ee' } }],
    });
    // an externally framed challenge (mppx-style) that asks for the real token
    const challenge = { ...acceptor.createChallenge(64), challenge_id: 'chal_external', unit: keyset.unit };
    const { credential } = await payChallenge(wallet, proofs, challenge);
    await expect(acceptor.verifyCredential(credential, challenge)).rejects.toThrowError(expect.objectContaining({ reason: 'UNIT_MISMATCH' }));
  });
});
