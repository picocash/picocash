/**
 * mppx bindings for the `picocash` payment method (spec/04).
 *
 * mppx owns the envelope: it issues HMAC-bound challenges, moves credentials
 * in the `Authorization: Payment …` header, and drives the validate/broadcast
 * split. This adapter maps that onto the acceptor: `validate` is the
 * non-mutating offline pre-check, `broadcast` is the terminal offline accept
 * (still no mint round-trip — settlement stays async via acceptor.settle()).
 *
 * Import from '@picocash/mppx-method/mppx'; requires the `mppx` peer.
 */
import { Challenge, Credential, Method } from 'mppx';
import { randomSecretHex, sumProofs, type Proof, type Wallet } from '@picocash/sdk';
import { z } from 'zod/mini';
import { payChallenge } from './agent.js';
import type { PicocashAcceptor } from './acceptor.js';
import type { PicocashChallenge, PicocashCredential, PicocashReceipt } from './types.js';

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

export interface PicocashChargeOptions {
  acceptor: PicocashAcceptor;
  /** Called after a terminal accept, e.g. to schedule acceptor.settle(). */
  onAccepted?: (receipt: PicocashReceipt) => void;
}

/** Server-side method: validate = offline pre-check, broadcast = terminal offline accept. */
export function picocashCharge(options: PicocashChargeOptions) {
  return Method.toServer(picocashMethod, {
    async validate({ credential, request }) {
      const challenge = credential.challenge as MppxChallenge;
      const pc = toPicocashChallenge(challenge);
      options.acceptor.precheckCredential(toPicocashCredential(challenge.id, credential.payload), pc);
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
      const receipt = options.acceptor.verifyCredential(toPicocashCredential(challenge.id, credential.payload), pc);
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
