/**
 * mppx bindings for the `picocash` payment method (PIP-05).
 *
 * mppx owns the envelope: it issues HMAC-bound challenges, moves credentials
 * in the `Authorization: Payment …` header, and drives the validate/broadcast
 * split. This adapter maps that onto the acceptor: `validate` is the
 * non-mutating offline pre-check; `broadcast` accepts offline and then, by
 * default, SETTLES at the mint before returning `success` (settle-first). A
 * service that explicitly prefers lower latency over finality can opt into
 * accept-then-settle, where `success` means "offline-accepted, settlement
 * pending" and the double-spend exposure is the service's (review P0-2).
 *
 * Import from '@picocash/mppx-method/mppx'; requires the `mppx` peer.
 */
import { Challenge, Credential, Method } from 'mppx';
import { randomSecretHex, sumProofs, type Proof, type Wallet } from '@picocash/sdk';
import { z } from 'zod/mini';
import { payChallenge } from './agent.js';
import type { PicocashAcceptor } from './acceptor.js';
import { CredentialRejected, type PicocashChallenge, type PicocashCredential, type PicocashReceipt } from './types.js';

const proofSchema = z.object({
  amount: z.number(),
  keyset_id: z.string(),
  secret: z.string(),
  C: z.string(),
  dleq: z.object({ e: z.string(), s: z.string(), r: z.string() }),
});

/**
 * The wire method definition (Method.from): name, intent, schemas.
 *
 * The request follows the shared MPP `charge` shape (draft-picocash-charge-00):
 * `amount` + `currency` (the TIP-20 token address) at the top level, with
 * method-specific data under `methodDetails`. The mint unit is DERIVED as
 * `tip20:${chainId}:${currency.toLowerCase()}`, never carried redundantly.
 */
export const picocashMethod = Method.from({
  name: 'picocash',
  intent: 'charge',
  schema: {
    request: z.object({
      /** Base units as a decimal string, mppx convention. */
      amount: z.string(),
      /** TIP-20 token address backing the accepted proofs. */
      currency: z.string(),
      methodDetails: z.object({
        /** Chain id of the network the backing token lives on. */
        chainId: z.number(),
        /** 32-byte hex; PC-BIND secrets commit to it. Injected per-challenge by the `request` hook. */
        nonce: z.string(),
        mints: z.array(z.object({ url: z.string(), keysetIds: z.array(z.string()) })),
        /** Optional service P2PK lock key (PIP-08 binding). */
        pubkey: z.optional(z.string()),
      }),
    }),
    credential: {
      payload: z.object({
        type: z.literal('proofs'),
        mint: z.string(),
        keysetId: z.string(),
        proofs: z.array(proofSchema),
      }),
    },
  },
});

type MppxChallenge = Challenge.Challenge<z.output<(typeof picocashMethod)['schema']['request']>, 'charge', 'picocash'>;

/** Unit derivation per draft-picocash-charge-00 §6.1.1. */
export function unitOf(chainId: number, currency: string): string {
  return `tip20:${chainId}:${currency.toLowerCase()}`;
}

function toPicocashChallenge(challenge: MppxChallenge): PicocashChallenge {
  const details = challenge.request.methodDetails;
  return {
    method: 'picocash',
    realm: challenge.realm,
    challenge_id: challenge.id,
    nonce: details.nonce,
    amount: Number(challenge.request.amount),
    unit: unitOf(details.chainId, challenge.request.currency),
    mints: details.mints.map((m) => ({ url: m.url, keyset_ids: m.keysetIds })),
    ...(details.pubkey !== undefined ? { pubkey: details.pubkey } : {}),
    // mppx enforces expiry itself (HMAC-bound `expires`); mirror it for the acceptor.
    expiry: challenge.expires ? Math.floor(Date.parse(challenge.expires) / 1000) : Math.floor(Date.now() / 1000) + 300,
  };
}

function toPicocashCredential(challengeId: string, payload: z.output<(typeof picocashMethod)['schema']['credential']['payload']>): PicocashCredential {
  return { method: 'picocash', challenge_id: challengeId, mint: payload.mint, keyset_id: payload.keysetId, proofs: payload.proofs };
}

/** Fresh nonce for a challenge — wire this into the server's `request` hook. */
export function freshNonce(): string {
  return randomSecretHex();
}

export interface PicocashClientOptions {
  wallet: Wallet;
  /** Provide the proofs to spend from; called per payment. */
  getProofs: () => Promise<Proof[]> | Proof[];
  /** Receives the change proofs to store; the inputs are consumed. */
  onChange: (change: Proof[]) => Promise<void> | void;
}

/** Client-side method: answers picocash challenges from a wallet + proof store. */
export function picocash(options: PicocashClientOptions) {
  return Method.toClient(picocashMethod, {
    async createCredential({ challenge }) {
      const pc = toPicocashChallenge(challenge as MppxChallenge);
      const { credential, change } = await payChallenge(options.wallet, await options.getProofs(), pc);
      await options.onChange(change);
      return Credential.serialize(
        Credential.from({
          challenge,
          payload: { type: 'proofs', mint: credential.mint, keysetId: credential.keyset_id, proofs: credential.proofs },
        }),
      );
    },
  });
}

export type PicocashChargeOptions =
  | {
      acceptor: PicocashAcceptor;
      /**
       * Default: settle at the mint inside `broadcast`. `success` is only
       * returned once the proofs are swapped for service-owned ones; a
       * double-spend surfaces as a thrown CredentialRejected('DOUBLE_SPENT').
       */
      mode?: 'settle-first';
      /** The service wallet that receives the swapped proofs. */
      wallet: Wallet;
      onAccepted?: (receipt: PicocashReceipt) => void;
    }
  | {
      acceptor: PicocashAcceptor;
      /**
       * Opt-in: return `success` after the offline checks, with
       * `settlement: 'pending'`. The service MUST schedule acceptor.settle()
       * (e.g. in `onAccepted`) and accepts amount × settlement-lag exposure.
       */
      mode: 'accept-then-settle';
      wallet?: Wallet;
      /** Called after the offline accept — schedule acceptor.settle() here. */
      onAccepted?: (receipt: PicocashReceipt) => void;
    };

/** Server-side method: validate = offline pre-check, broadcast = accept (+ settle by default). */
export function picocashCharge(options: PicocashChargeOptions) {
  const mode = options.mode ?? 'settle-first';
  return Method.toServer(picocashMethod, {
    async validate({ credential, request }) {
      const challenge = credential.challenge as MppxChallenge;
      const pc = toPicocashChallenge(challenge);
      await options.acceptor.precheckCredential(toPicocashCredential(challenge.id, credential.payload), pc);
      return {
        challenge,
        credential,
        details: { offline: true, proofs: credential.payload.proofs.length, sum: sumProofs(credential.payload.proofs) },
        intent: 'charge' as const,
        method: 'picocash' as const,
        request,
      };
    },
    async broadcast({ credential }) {
      const challenge = credential.challenge as MppxChallenge;
      const pc = toPicocashChallenge(challenge);
      let receipt = await options.acceptor.verifyCredential(toPicocashCredential(challenge.id, credential.payload), pc);
      if (mode === 'settle-first') {
        receipt = await options.acceptor.settle(receipt.challenge_id, options.wallet!);
        if (receipt.settlement === 'double-spent') {
          throw new CredentialRejected('DOUBLE_SPENT', 'proofs were already spent at the mint');
        }
      }
      options.onAccepted?.(receipt);
      return {
        method: 'picocash',
        status: 'success' as const,
        // Settle-first: the timestamp is the settlement point (the mint swap),
        // per draft-picocash-charge-00 §Receipt Generation. In the deferred
        // mode it is the offline-accept time and settlement is 'pending'.
        timestamp: mode === 'settle-first' ? new Date().toISOString() : new Date(receipt.accepted_at * 1000).toISOString(),
        reference: receipt.challenge_id,
        // method-specific extension fields (preserved by Receipt schema)
        settlement: receipt.settlement,
        amount: String(receipt.amount),
      };
    },
  });
}

export interface PicocashRouterChargeConfig {
  acceptor: PicocashAcceptor;
  /** The service wallet that receives the swapped proofs (settle-first). */
  wallet: Wallet;
  /** TIP-20 token address backing accepted proofs (`currency` on the wire). */
  currency: string;
  /** Chain id the backing token lives on (Tempo Moderato: 42431). */
  chainId: number;
  /** Mint allowlist advertised in every challenge. */
  mints: Array<{ url: string; keysetIds: string[] }>;
  /**
   * Decimals of the backing token, used to convert the router's decimal-dollar
   * price string into base units (`tempo.charge` does the same). pathUSD = 6.
   * @default 6
   */
  decimals?: number;
  /** Optional service P2PK lock key (PIP-08 binding). */
  pubkey?: string;
  onAccepted?: (receipt: PicocashReceipt) => void;
}

/** Decimal-dollar string → integer base-unit string, no float rounding error. */
export function toBaseUnits(amount: string, decimals: number): string {
  const neg = amount.startsWith('-');
  const [whole, frac = ''] = (neg ? amount.slice(1) : amount).split('.');
  if (frac.length > decimals) throw new Error(`amount ${amount} has more than ${decimals} decimal places`);
  const digits = `${whole}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  return (neg ? '-' : '') + (digits || '0');
}

/**
 * Router-ergonomic server method, mirroring `tempo.charge(config)`: bakes the
 * static offer (`currency`, `methodDetails`) into `defaults`, converts the
 * host's decimal-dollar price to base units, and injects a fresh nonce per
 * challenge — so a host that only supplies a dollar `{ amount }` at challenge
 * time (e.g. @agentcash/router) can offer picocash unchanged. Settle-first
 * only — the router's settle hook is the moment `success` is allowed to exist.
 */
export function charge(config: PicocashRouterChargeConfig): Method.AnyServer {
  const decimals = config.decimals ?? 6;
  const base = picocashCharge({
    acceptor: config.acceptor,
    wallet: config.wallet,
    ...(config.onAccepted ? { onAccepted: config.onAccepted } : {}),
  });
  return {
    ...base,
    defaults: {
      currency: config.currency,
      methodDetails: {
        chainId: config.chainId,
        nonce: '', // placeholder; the request hook below replaces it per challenge
        mints: config.mints,
        ...(config.pubkey !== undefined ? { pubkey: config.pubkey } : {}),
      },
    },
    request: ({ request }: { request: z.input<(typeof picocashMethod)['schema']['request']> }) => ({
      ...request,
      // charge() is dollar-denominated like tempo.charge; the wire amount is base units.
      amount: toBaseUnits(request.amount, decimals),
      methodDetails: { ...request.methodDetails, nonce: freshNonce() },
    }),
  };
}
