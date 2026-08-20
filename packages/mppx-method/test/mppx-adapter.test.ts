import { Challenge, Credential, Method } from 'mppx';
import { describe, expect, it } from 'vitest';
import { Wallet, type Proof } from '@picocash/sdk';
import { PicocashAcceptor } from '../src/index.js';
import { freshNonce, picocash, picocashCharge } from '../src/mppx.js';
import { fundedWallet, makeTestMint, TEST_MINT_URL } from './helper.js';

async function makeMppxScene(fundAmount: number, price: number) {
  const mint = await makeTestMint();
  const { wallet, proofs } = await fundedWallet(mint, fundAmount);
  const keyset = await wallet.getKeyset();
  const acceptor = new PicocashAcceptor({ realm: 'mppx.test', mints: [{ url: TEST_MINT_URL, keyset }] });

  // the mppx server frames the challenge; the acceptor adopts it at verify time
  const challenge = Challenge.from({
    realm: 'mppx.test',
    method: 'picocash',
    intent: 'charge',
    expires: new Date(Date.now() + 300_000),
    secretKey: 'test-secret',
    request: {
      amount: String(price),
      unit: keyset.unit,
      nonce: freshNonce(),
      mints: [{ url: TEST_MINT_URL, keyset_ids: [keyset.id] }],
    },
  });

  let stored: Proof[] = proofs;
  const clientMethod = picocash({
    wallet,
    getProofs: () => stored,
    onChange: (change) => {
      stored = change;
    },
  });
  const serverMethod = picocashCharge({ acceptor });
  return { mint, wallet, keyset, acceptor, challenge, clientMethod, serverMethod, held: () => stored };
}

describe('mppx adapter', () => {
  it('createCredential → validate (non-mutating) → broadcast → receipt', async () => {
    const scene = await makeMppxScene(100_000, 50_000);

    const header = await scene.clientMethod.createCredential({ challenge: scene.challenge as never });
    expect(header).toMatch(/^Payment /);
    expect(scene.held().reduce((s, p) => s + p.amount, 0)).toBe(50_000); // change stored

    // validate is non-mutating: run it twice, both pass
    const first = await Method.validateCredential([scene.serverMethod], header);
    const second = await Method.validateCredential([scene.serverMethod], header);
    expect(first.method).toBe('picocash');
    expect((first.details as any).offline).toBe(true);
    expect(second.method).toBe('picocash');

    // broadcast is terminal
    const receipt = await Method.broadcastCredential([scene.serverMethod], header);
    expect(receipt.status).toBe('success');
    expect(receipt.reference).toBe(scene.challenge.id);
    expect((receipt as any).settlement).toBe('pending');

    // replay: both validate and broadcast now refuse
    await expect(Method.broadcastCredential([scene.serverMethod], header)).rejects.toThrow(/single-use/);
    await expect(Method.validateCredential([scene.serverMethod], header)).rejects.toThrow(/single-use/);
  });

  it('rejects a credential whose proofs are bound to a different challenge', async () => {
    const scene = await makeMppxScene(100_000, 50_000);
    const header = await scene.clientMethod.createCredential({ challenge: scene.challenge as never });

    // graft the credential's payload onto a fresh challenge (stolen-credential replay)
    const parsed = Credential.deserialize(header);
    const otherChallenge = Challenge.from({
      realm: 'mppx.test',
      method: 'picocash',
      intent: 'charge',
      expires: new Date(Date.now() + 300_000),
      secretKey: 'test-secret',
      request: { ...(scene.challenge.request as object), nonce: freshNonce() },
    });
    const grafted = Credential.serialize(Credential.from({ challenge: otherChallenge, payload: parsed.payload }));
    await expect(Method.broadcastCredential([scene.serverMethod], grafted)).rejects.toThrow(/PC-BIND/);
  });

  it('settles the accepted payment at the mint afterwards', async () => {
    const scene = await makeMppxScene(64, 64);
    const header = await scene.clientMethod.createCredential({ challenge: scene.challenge as never });
    await Method.broadcastCredential([scene.serverMethod], header);

    const serviceWallet = new Wallet({ mintUrl: TEST_MINT_URL, fetchImpl: scene.mint.fetchImpl });
    const receipt = await scene.acceptor.settle(scene.challenge.id, serviceWallet);
    expect(receipt.settlement).toBe('settled');
  });
});
