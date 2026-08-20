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

/** The wire method definition (Method.from): name, intent, schemas. */
export const picocashMethod = Method.from({
  name: 'picocash',
  intent: 'charge',
  schema: {
    request: z.object({
      /** Base units as a decimal string, mppx convention. */
      amount: z.string(),
      unit: z.string(),
      /** 32-byte hex; PC-BIND secrets commit to it. Inject per-challenge via `request` hook or `defaults`. */
      nonce: z.string(),
      mints: z.array(z.object({ url: z.string(), keyset_ids: z.array(z.string()) })),
    }),
    credential: {
      payload: z.object({
        mint: z.string(),
        keyset_id: z.string(),
        proofs: z.array(proofSchema),
      }),
    },
  },
});

type MppxChallenge = Challenge.Challenge<z.output<(typeof picocashMethod)['schema']['request']>, 'charge', 'picocash'>;

function toPicocashChallenge(challenge: MppxChallenge): PicocashChallenge {
  return {
    method: 'picocash',
    realm: challenge.realm,
    challenge_id: challenge.id,
    nonce: challenge.request.nonce,
    amount: Number(challenge.request.amount),
    unit: challenge.request.unit,
    mints: challenge.request.mints,
    // mppx enforces expiry itself (HMAC-bound `expires`); mirror it for the acceptor.
    expiry: challenge.expires ? Math.floor(Date.parse(challenge.expires) / 1000) : Math.floor(Date.now() / 1000) + 300,
  };
}

function toPicocashCredential(challengeId: string, payload: z.output<(typeof picocashMethod)['schema']['credential']['payload']>): PicocashCredential {
  return { method: 'picocash', challenge_id: challengeId, mint: payload.mint, keyset_id: payload.keyset_id, proofs: payload.proofs };
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
          payload: { mint: credential.mint, keyset_id: credential.keyset_id, proofs: credential.proofs },
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
        timestamp: new Date(receipt.accepted_at * 1000).toISOString(),
        reference: receipt.challenge_id,
        // method-specific extension fields (preserved by Receipt schema)
        settlement: receipt.settlement,
        amount: String(receipt.amount),
      };
    },
  });
}
