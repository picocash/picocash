import { bytesToHex, hashToCurve, hexToBytes, verifyProof } from '@picocash/crypto';
import { Hono } from 'hono';
import type { MintContext } from '../context.js';
import { ApiError } from '../errors.js';
import { signAndRecord, sumAmounts, validateOutputs } from '../signing.js';
import { parseBody, swapRequestSchema, type ProofInput } from '../validation.js';

interface VerifiedInput extends ProofInput {
  y: string;
}

/** Crypto-verify each input against the keyset and compute its ledger key Y. */
function verifyInputs(ctx: MintContext, inputs: ProofInput[]): VerifiedInput[] {
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    // Single active keyset for now; swap-only keysets join with rotation (spec/02).
    if (input.keyset_id !== ctx.keyset.id) {
      throw new ApiError(400, 'KEYSET_UNKNOWN', `input ${index}: unknown keyset ${input.keyset_id}`, `fetch GET /v1/keys; this mint's keyset is ${ctx.keyset.id}`);
    }
    const key = ctx.keyset.keys.get(input.amount);
    if (!key) {
      throw new ApiError(400, 'INVALID_REQUEST', `input ${index}: ${input.amount} is not a valid denomination`, 'denominations are powers of 2; see GET /v1/keys');
    }
    const secret = hexToBytes(input.secret);
    if (!verifyProof(secret, hexToBytes(input.C), key.privkey)) {
      throw new ApiError(400, 'INVALID_PROOF', `input ${index}: signature does not verify`, 'the proof is not a valid token from this mint/keyset; check secret encoding (raw bytes, hex) and C');
    }
    const y = bytesToHex(hashToCurve(secret).toRawBytes(true));
    if (seen.has(y)) {
      throw new ApiError(400, 'INVALID_REQUEST', `input ${index}: duplicate proof in request`, 'each proof may appear once per swap');
    }
    seen.add(y);
    return { ...input, y };
  });
}

export function swapRoutes(ctx: MintContext): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = await parseBody(c, swapRequestSchema);
    const inputs = verifyInputs(ctx, body.inputs);
    validateOutputs(body.outputs, ctx.keyset);
    if (sumAmounts(inputs) !== sumAmounts(body.outputs)) {
      throw new ApiError(400, 'AMOUNT_MISMATCH', `inputs sum to ${sumAmounts(inputs)}, outputs to ${sumAmounts(body.outputs)}`, 'input and output amounts must be equal (no fees in v0.1)');
    }

    // Insert-before-sign, all inside one transaction: a spent-ledger conflict
    // rolls everything back and no signature ever leaves the mint.
    const signatures = await ctx.db.tx(async (q) => {
      for (const input of inputs) {
        const inserted = await q.query(
          'INSERT INTO spent_secrets (y, keyset_id, amount) VALUES ($1, $2, $3) ON CONFLICT (y) DO NOTHING RETURNING y',
          [input.y, input.keyset_id, input.amount],
        );
        if (inserted.rows.length === 0) {
          throw new ApiError(409, 'TOKEN_ALREADY_SPENT', `token with Y ${input.y.slice(0, 16)}… is already spent`, 'drop this proof (it is worthless) and check remaining tokens via POST /v1/checkstate');
        }
      }
      const signed = [];
      for (const output of body.outputs) signed.push(await signAndRecord(q, ctx.keyset, output, null));
      return signed;
    });
    return c.json({ signatures });
  });

  return app;
}
