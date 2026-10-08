// Typed errors of the context module. Consumers catch `ContextError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`fingerprint_not_found`; a goal that is missing, archived or
// foreign reads uniformly as `goal_not_found`) — the existence of another
// tenant's context state must never leak (ADR-0001).

export type ContextErrorCode =
  | 'invalid_context'
  | 'invalid_derivation_input'
  | 'invalid_query'
  | 'goal_not_found'
  | 'fingerprint_not_found';

export class ContextError extends Error {
  constructor(
    public readonly code: ContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ContextError';
  }
}
