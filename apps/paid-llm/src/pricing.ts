/**
 * Per-request pricing. Deterministic in (model, max_tokens) and NOTHING else,
 * because the price is computed twice — once to build the 402 challenge and
 * once on the paid retry — and the two must agree exactly.
 *
 * Flat tiers to start (plan §4): a base price per model tier plus an increment
 * per 1k of `max_tokens`. Override the whole table with PRICE_TABLE_JSON.
 */
export interface PriceTier {
  /** Substring match on the model id, first match wins; "*" is the fallback. */
  match: string;
  /** Dollars per request. */
  base: string;
  /** Dollars per 1,000 max_tokens (rounded up to the next 1k). */
  per1k: string;
}

export const DEFAULT_TIERS: PriceTier[] = [
  { match: 'opus', base: '0.0100', per1k: '0.0200' },
  { match: 'gpt-5', base: '0.0050', per1k: '0.0100' },
  { match: 'sonnet', base: '0.0030', per1k: '0.0060' },
  { match: 'haiku', base: '0.0005', per1k: '0.0010' },
  { match: 'mini', base: '0.0005', per1k: '0.0010' },
  { match: '*', base: '0.0020', per1k: '0.0040' },
];

const DEFAULT_MAX_TOKENS = 1024;
const HARD_MAX_TOKENS = 32_768;

/** Decimal-string arithmetic in micro-dollars so we never touch floats. */
function toMicros(dollars: string): bigint {
  const [w, f = ''] = dollars.split('.');
  if (f.length > 6) throw new Error(`price ${dollars} has more than 6 decimals`);
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, '0'));
}
function fromMicros(m: bigint): string {
  const w = m / 1_000_000n;
  const f = (m % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

export function loadTiers(env: NodeJS.ProcessEnv = process.env): PriceTier[] {
  if (!env.PRICE_TABLE_JSON) return DEFAULT_TIERS;
  const parsed = JSON.parse(env.PRICE_TABLE_JSON) as PriceTier[];
  if (!Array.isArray(parsed) || !parsed.some((t) => t.match === '*')) throw new Error('PRICE_TABLE_JSON must be an array with a "*" fallback tier');
  return parsed;
}

/** Normalise the request's max_tokens: default if absent, clamp, reject nonsense. */
export function effectiveMaxTokens(body: { max_tokens?: unknown; max_completion_tokens?: unknown }): number {
  const raw = body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new PricingError('max_tokens must be a positive integer');
  return Math.min(n, HARD_MAX_TOKENS);
}

export class PricingError extends Error {}

/** Price in dollars (decimal string) for one request. */
export function priceFor(body: { model?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown }, tiers: PriceTier[] = DEFAULT_TIERS): string {
  if (typeof body.model !== 'string' || !body.model) throw new PricingError('model is required');
  const model = body.model.toLowerCase();
  const tier = tiers.find((t) => t.match !== '*' && model.includes(t.match.toLowerCase())) ?? tiers.find((t) => t.match === '*')!;
  const thousands = BigInt(Math.ceil(effectiveMaxTokens(body) / 1000));
  return fromMicros(toMicros(tier.base) + toMicros(tier.per1k) * thousands);
}
