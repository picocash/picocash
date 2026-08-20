import { bytesToHex, createDleqProof, hashToCurve, hexToBytes, signBlindedMessage, verifyProof } from '@picocash/crypto';
import type { Queryable } from './db.js';
import { ApiError } from './errors.js';
import type { Keyset } from './keyset.js';
import type { BlindedMessage, ProofInput } from './validation.js';

export interface VerifiedInput extends ProofInput {
  y: string;
}

/** Crypto-verify spend inputs against the keyset and compute their ledger key Y. */
export function verifyInputs(keyset: Keyset, inputs: ProofInput[]): VerifiedInput[] {
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    // Single active keyset for now; swap-only keysets join with rotation (PIP-01).
    if (input.keyset_id !== keyset.id) {
      throw new ApiError(400, 'KEYSET_UNKNOWN', `input ${index}: unknown keyset ${input.keyset_id}`, `fetch GET /v1/keys; this mint's keyset is ${keyset.id}`);
    }
    const key = keyset.keys.get(input.amount);
    if (!key) {
      throw new ApiError(400, 'INVALID_REQUEST', `input ${index}: ${input.amount} is not a valid denomination`, 'denominations are powers of 2; see GET /v1/keys');
    }
    const secret = hexToBytes(input.secret);
    if (!verifyProof(secret, hexToBytes(input.C), key.privkey)) {
      throw new ApiError(400, 'INVALID_PROOF', `input ${index}: signature does not verify`, 'the proof is not a valid token from this mint/keyset; check secret encoding (raw bytes, hex) and C');
    }
    const y = bytesToHex(hashToCurve(secret).toRawBytes(true));
    if (seen.has(y)) {
      throw new ApiError(400, 'INVALID_REQUEST', `input ${index}: duplicate proof in request`, 'each proof may appear once per request');
    }
    seen.add(y);
    return { ...input, y };
  });
}

/** Insert input Ys into the spent-secret ledger; conflict aborts the transaction. */
export async function spendInputs(q: Queryable, inputs: VerifiedInput[]): Promise<void> {
  for (const input of inputs) {
    const inserted = await q.query(
      'INSERT INTO spent_secrets (y, keyset_id, amount) VALUES ($1, $2, $3) ON CONFLICT (y) DO NOTHING RETURNING y',
      [input.y, input.keyset_id, input.amount],
    );
    if (inserted.rows.length === 0) {
      throw new ApiError(409, 'TOKEN_ALREADY_SPENT', `token with Y ${input.y.slice(0, 16)}… is already spent`, 'drop this proof (it is worthless) and check remaining tokens via POST /v1/checkstate');
    }
  }
}

export interface SignatureResponse {
  amount: number;
  keyset_id: string;
  C_: string;
  dleq: { e: string; s: string };
}

/** Outputs must target the active keyset with valid denominations and unique B_. */
export function validateOutputs(outputs: BlindedMessage[], keyset: Keyset): void {
  const seen = new Set<string>();
  for (const output of outputs) {
    if (output.keyset_id !== keyset.id) {
      throw new ApiError(400, 'KEYSET_UNKNOWN', `keyset ${output.keyset_id} is not this mint's active keyset`, `fetch GET /v1/keys and use keyset ${keyset.id}`);
    }
    if (!keyset.keys.has(output.amount)) {
      throw new ApiError(400, 'INVALID_REQUEST', `${output.amount} is not a valid denomination`, 'denominations are powers of 2; see GET /v1/keys');
    }
    if (seen.has(output.B_)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'duplicate B_ among outputs', 'every blinded message must use a fresh blinding factor');
    }
    seen.add(output.B_);
  }
}

export function sumAmounts(items: { amount: number }[]): number {
  return items.reduce((total, item) => total + item.amount, 0);
}

/**
 * Sign one blinded message and record it. The PRIMARY KEY on b makes every B_
 * globally single-use; the signature is only ever returned after the row is in
 * (and the surrounding transaction commits).
 */
export async function signAndRecord(
  q: Queryable,
  keyset: Keyset,
  output: BlindedMessage,
  quoteId: string | null,
): Promise<SignatureResponse> {
  const key = keyset.keys.get(output.amount)!;
  const B_ = hexToBytes(output.B_);
  const C_ = bytesToHex(signBlindedMessage(B_, key.privkey));
  const dleq = createDleqProof(B_, key.privkey);
  const e = bytesToHex(dleq.e);
  const s = bytesToHex(dleq.s);
  const inserted = await q.query(
    `INSERT INTO blind_signatures (b, keyset_id, amount, c, dleq_e, dleq_s, quote_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (b) DO NOTHING RETURNING b`,
    [output.B_, output.keyset_id, output.amount, C_, e, s, quoteId],
  );
  if (inserted.rows.length === 0) {
    throw new ApiError(409, 'OUTPUT_ALREADY_SIGNED', `blinded message ${output.B_.slice(0, 16)}… was already signed`, 'blind with a fresh blinding factor and resend; a B_ is never signed twice');
  }
  return { amount: output.amount, keyset_id: output.keyset_id, C_, dleq: { e, s } };
}

/**
 * Idempotent replay for /v1/mint: if the stored signatures for a quote match
 * the requested output set exactly, return them in request order; otherwise null.
 */
export async function loadIssuedSignatures(
  q: Queryable,
  quoteId: string,
  outputs: BlindedMessage[],
): Promise<SignatureResponse[] | null> {
  const stored = await q.query<{ b: string; keyset_id: string; amount: string | number; c: string; dleq_e: string; dleq_s: string }>(
    'SELECT b, keyset_id, amount, c, dleq_e, dleq_s FROM blind_signatures WHERE quote_id = $1',
    [quoteId],
  );
  if (stored.rows.length !== outputs.length) return null;
  const byB = new Map(stored.rows.map((row) => [row.b, row]));
  const replay: SignatureResponse[] = [];
  for (const output of outputs) {
    const row = byB.get(output.B_);
    if (!row) return null;
    replay.push({ amount: Number(row.amount), keyset_id: row.keyset_id, C_: row.c, dleq: { e: row.dleq_e, s: row.dleq_s } });
  }
  return replay;
}
