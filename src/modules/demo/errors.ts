// Errors of the demo module (W068).
//
// House style (organizations/errors.ts): one error class, a closed code
// vocabulary, `code` on every instance.

export type DemoErrorCode =
  /** The gate refused: a production-like database backend is configured. */
  | 'production_backend'
  /** The gate refused: NODE_ENV=production. */
  | 'production_runtime'
  /** The gate refused: neither the test memory mode nor the explicit opt-in is set. */
  | 'opt_in_required'
  /** A seeding step failed (the underlying module error is the cause). */
  | 'seed_failed'
  /** Malformed harness input/context. */
  | 'invalid_input';

export class DemoError extends Error {
  readonly code: DemoErrorCode;

  constructor(code: DemoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DemoError';
    this.code = code;
  }
}
