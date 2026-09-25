// Typed errors of the unified-identity module. Consumers catch
// `UnifiedIdentityError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`unified_identity_not_found` / `ambiguity_not_found`) — the
// existence of another tenant's unification state must never leak
// (ADR-0001), the uniform not-found discipline every sibling module
// applies.

export type UnifiedIdentityErrorCode =
  | 'invalid_context'
  | 'forbidden'
  | 'invalid_unified_input'
  | 'invalid_unified_query'
  | 'unsupported_modality'
  | 'unified_identity_not_found'
  | 'unified_identity_already_linked'
  | 'unified_identity_not_verified'
  | 'ambiguity_not_found'
  | 'ambiguity_already_resolved';

export class UnifiedIdentityError extends Error {
  constructor(
    public readonly code: UnifiedIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnifiedIdentityError';
  }
}
