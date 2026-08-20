import { decompose, finalizeSignatures, prepareOutputs, sumProofs, type OutputSpec } from './blinding.js';
import { createTokenLink, parseTokenLink, resolveTokenLink } from './link.js';
import { parseToken, serializeToken } from './token.js';
import { verifyProofOffline } from './verify.js';
import {
  MintApiError,
  type KeysetInfo,
  type MeltQuote,
  type MintQuote,
  type Proof,
  type TokenBundle,
} from './types.js';

export interface WalletOptions {
  mintUrl: string;
  /** Override fetch (tests inject an in-process app here). */
  fetchImpl?: typeof fetch;
}

/**
 * Wallet-lite for agents (architecture component 5). Stateless-capable: it
 * holds no proofs — every method takes and returns them, and storage is the
 * caller's responsibility.
 */
export class Wallet {
  readonly mintUrl: string;
  private readonly fetchImpl: typeof fetch;
  private keyset: KeysetInfo | null = null;

  constructor(options: WalletOptions) {
    this.mintUrl = options.mintUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.mintUrl}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    const json = (await res.json()) as any;
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new MintApiError(res.status, e.code ?? 'UNKNOWN', e.message ?? `HTTP ${res.status}`, e.recovery ?? '');
    }
    return json as T;
  }

  async info(): Promise<any> {
    return this.api('GET', '/v1/info');
  }

  /** Fetch (and cache) the mint's active keyset. */
  async getKeyset(refresh = false): Promise<KeysetInfo> {
    if (!this.keyset || refresh) {
      const res = await this.api<{ keysets: KeysetInfo[] }>('GET', '/v1/keys');
      const keyset = res.keysets[0];
      if (!keyset) throw new Error('mint advertises no keysets');
      this.keyset = keyset;
    }
    return this.keyset;
  }

  async requestMintQuote(amount: number): Promise<MintQuote> {
    const keyset = await this.getKeyset();
    return this.api('POST', '/v1/mint/quote', { amount, unit: keyset.unit });
  }

  async getMintQuote(quoteId: string): Promise<MintQuote> {
    return this.api('GET', `/v1/mint/quote/${quoteId}`);
  }

  /** Once the quote is PAID: blind, mint, DLEQ-verify, unblind. */
  async mintProofs(quoteId: string, amount: number, secrets?: string[]): Promise<Proof[]> {
    const keyset = await this.getKeyset();
    const amounts = decompose(amount);
    const specs: OutputSpec[] = amounts.map((a, i) =>
      secrets?.[i] !== undefined ? { amount: a, secret: secrets[i]! } : { amount: a },
    );
    const { outputs, pending } = prepareOutputs(keyset.id, specs);
    const res = await this.api<{ signatures: any[] }>('POST', '/v1/mint', { quote_id: quoteId, outputs });
    return finalizeSignatures(keyset, pending, res.signatures);
  }

  /** Spend `inputs`, receive fresh proofs per `outputSpecs` (sums must match). */
  async swap(inputs: Proof[], outputSpecs: OutputSpec[]): Promise<Proof[]> {
    const keyset = await this.getKeyset();
    const { outputs, pending } = prepareOutputs(keyset.id, outputSpecs);
    const res = await this.api<{ signatures: any[] }>('POST', '/v1/swap', {
      inputs: inputs.map(wireProof),
      outputs,
    });
    return finalizeSignatures(keyset, pending, res.signatures);
  }

  async requestMeltQuote(amount: number, to: string): Promise<MeltQuote> {
    const keyset = await this.getKeyset();
    return this.api('POST', '/v1/melt/quote', { amount, unit: keyset.unit, to });
  }

  async melt(meltId: string, inputs: Proof[]): Promise<MeltQuote> {
    return this.api('POST', '/v1/melt', { melt_id: meltId, inputs: inputs.map(wireProof) });
  }

  /**
   * Convenience: melt exactly these proofs to `to`. The mint's melt fee comes
   * out of the proofs — the on-chain payout is `sum(proofs) − fee`.
   */
  async meltProofs(to: string, proofs: Proof[]): Promise<MeltQuote> {
    const info = await this.info();
    const fee = Number(info?.fees?.melt ?? 0);
    const total = sumProofs(proofs);
    if (total <= fee) throw new Error(`proofs sum to ${total}, which does not cover the melt fee of ${fee}`);
    const quote = await this.requestMeltQuote(total - fee, to);
    if (quote.total !== total) throw new Error(`melt quote wants ${quote.total}, proofs sum to ${total} — fee changed between info and quote?`);
    return this.melt(quote.melt_id, proofs);
  }

  async checkstate(proofs: Proof[]): Promise<Array<{ y: string; state: 'UNSPENT' | 'SPENT' | 'PENDING' }>> {
    const { yOfSecret } = await import('./blinding.js');
    const res = await this.api<{ states: any[] }>('POST', '/v1/checkstate', { Ys: proofs.map((p) => yOfSecret(p.secret)) });
    return res.states;
  }

  /**
   * Prepare an exact-amount payment: swaps `proofs` into a bundle of `amount`
   * (optionally with caller-chosen secrets, e.g. PC-BIND) plus change.
   */
  async send(
    proofs: Proof[],
    amount: number,
    secretsForAmount?: string[],
    memo?: string,
  ): Promise<{ bundle: TokenBundle; token: string; change: Proof[] }> {
    const keyset = await this.getKeyset();
    const total = sumProofs(proofs);
    if (total < amount) throw new Error(`insufficient proofs: have ${total}, need ${amount}`);
    const sendAmounts = decompose(amount);
    if (secretsForAmount && secretsForAmount.length !== sendAmounts.length) {
      throw new Error(`amount ${amount} splits into ${sendAmounts.length} denominations; got ${secretsForAmount.length} secrets`);
    }
    const specs: OutputSpec[] = [
      ...sendAmounts.map((a, i) =>
        secretsForAmount?.[i] !== undefined ? { amount: a, secret: secretsForAmount[i]! } : { amount: a },
      ),
      ...(total > amount ? decompose(total - amount).map((a) => ({ amount: a })) : []),
    ];
    const fresh = await this.swap(proofs, specs);
    const bundle: TokenBundle = { mint: this.mintUrl, unit: keyset.unit, keyset_id: keyset.id, proofs: fresh.slice(0, sendAmounts.length) };
    return { bundle, token: serializeToken(bundle, memo), change: fresh.slice(sendAmounts.length) };
  }

  /**
   * Claim a received bundle: verify every proof offline (DLEQ), then swap the
   * lot into fresh proofs only this wallet knows — the moment of ownership.
   */
  /**
   * Turn a token into a short PIP-07 link using this mint's relay (if it runs
   * one). The relay only ever sees ciphertext; the key is in the fragment.
   */
  async createLink(token: string): Promise<string> {
    const info = await this.info();
    if (!info?.relay?.enabled) throw new Error('this mint runs no token-link relay; share the token string instead');
    return createTokenLink(token, this.mintUrl, this.fetchImpl);
  }

  async receive(input: TokenBundle | string): Promise<Proof[]> {
    let bundle: TokenBundle;
    if (typeof input === 'string') {
      const token = parseTokenLink(input) ? await resolveTokenLink(input, this.fetchImpl) : input;
      bundle = parseToken(token).bundle;
    } else {
      bundle = input;
    }
    const keyset = await this.getKeyset();
    if (bundle.unit !== keyset.unit) throw new Error(`token unit ${bundle.unit} does not match this mint's ${keyset.unit}`);
    for (const [i, proof] of bundle.proofs.entries()) {
      if (!verifyProofOffline(proof, keyset)) {
        throw new Error(`bundle proof ${i} failed offline DLEQ verification — refusing to accept`);
      }
    }
    const specs: OutputSpec[] = decompose(sumProofs(bundle.proofs)).map((a) => ({ amount: a }));
    return this.swap(bundle.proofs, specs);
  }
}

function wireProof(proof: Proof): { amount: number; keyset_id: string; secret: string; C: string } {
  // The mint neither needs nor wants the DLEQ payload; strip it on the wire.
  return { amount: proof.amount, keyset_id: proof.keyset_id, secret: proof.secret, C: proof.C };
}
