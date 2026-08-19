import type { Context } from 'hono';
import { z } from 'zod';
import { ApiError } from './errors.js';

const MAX_DENOMINATION = 2 ** 30;

export const amountSchema = z.number().int().positive().max(MAX_DENOMINATION);

/** 33-byte SEC1 compressed point, lowercase hex. */
export const pointSchema = z.string().regex(/^0[23][0-9a-f]{64}$/, 'expected 33-byte compressed point hex');

/** Secret: raw bytes hex-encoded, 1..256 bytes. */
export const secretSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{2}){1,256}$/, 'expected lowercase hex of 1..256 bytes');

export const blindedMessageSchema = z.object({
  amount: amountSchema,
  keyset_id: z.string().regex(/^[0-9a-f]{16}$/),
  B_: pointSchema,
});
export type BlindedMessage = z.infer<typeof blindedMessageSchema>;

export const proofSchema = z.object({
  amount: amountSchema,
  keyset_id: z.string().regex(/^[0-9a-f]{16}$/),
  secret: secretSchema,
  C: pointSchema,
});
export type ProofInput = z.infer<typeof proofSchema>;

export const mintQuoteRequestSchema = z.object({
  amount: amountSchema.max(Number.MAX_SAFE_INTEGER),
  unit: z.string(),
});

export const mintRequestSchema = z.object({
  quote_id: z.string().min(1).max(64),
  outputs: z.array(blindedMessageSchema).min(1).max(64),
});

export const swapRequestSchema = z.object({
  inputs: z.array(proofSchema).min(1).max(64),
  outputs: z.array(blindedMessageSchema).min(1).max(64),
});

export const checkstateRequestSchema = z.object({
  Ys: z.array(pointSchema).min(1).max(200),
});

export async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', 'body is not valid JSON', 'send a JSON body matching spec/03-mint-api.md');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ApiError(400, 'INVALID_REQUEST', detail, 'fix the listed fields per spec/03-mint-api.md and resend');
  }
  return result.data;
}
