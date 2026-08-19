export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_EXPIRED'
  | 'PAYMENT_REQUIRED'
  | 'QUOTE_ALREADY_ISSUED'
  | 'TOKEN_ALREADY_SPENT'
  | 'OUTPUT_ALREADY_SIGNED'
  | 'KEYSET_UNKNOWN'
  | 'KEYSET_INACTIVE'
  | 'AMOUNT_MISMATCH'
  | 'INVALID_PROOF'
  | 'AMOUNT_LIMIT'
  | 'MELT_ALREADY_PAID'
  | 'PAYOUT_FAILED'
  | 'NOT_IMPLEMENTED';

/** Every API error carries a mandatory `recovery` hint for the calling agent. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly recovery: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody() {
    return { error: { code: this.code, message: this.message, recovery: this.recovery } };
  }
}
