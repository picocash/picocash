import { Hono } from 'hono';
import type { MintContext } from '../context.js';
import { ApiError } from '../errors.js';
import { signAndRecord, spendInputs, sumAmounts, validateOutputs, verifyInputs } from '../signing.js';
import { parseBody, swapRequestSchema } from '../validation.js';

export function swapRoutes(ctx: MintContext): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = await parseBody(c, swapRequestSchema);
    const inputs = verifyInputs(ctx.keyset, body.inputs);
    validateOutputs(body.outputs, ctx.keyset);
    if (sumAmounts(inputs) !== sumAmounts(body.outputs)) {
      throw new ApiError(400, 'AMOUNT_MISMATCH', `inputs sum to ${sumAmounts(inputs)}, outputs to ${sumAmounts(body.outputs)}`, 'input and output amounts must be equal (no fees in v0.1)');
    }

    // Insert-before-sign, all inside one transaction: a spent-ledger conflict
    // rolls everything back and no signature ever leaves the mint.
    const signatures = await ctx.db.tx(async (q) => {
      await spendInputs(q, inputs);
      const signed = [];
      for (const output of body.outputs) signed.push(await signAndRecord(q, ctx.keyset, output, null));
      return signed;
    });
    return c.json({ signatures });
  });

  return app;
}
