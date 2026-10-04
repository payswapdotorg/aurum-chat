// Typed errors of the coverage module. Consumers catch `CoverageError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`surface_not_found`, `source_not_found`, `claim_not_found`,
// `snapshot_not_found`) — the existence of another tenant's coverage
// state must never leak (ADR-0001).
//
// Duplicate registration (`surface_already_registered`,
// `source_already_registered`) is a domain-conflict code, not a crash: the
// registry is idempotent-by-rejection — the second registration of the
// same (tenant, key) / (tenant, registry, ref) is refused so the registry
// stays the single authority on what is tracked.

export type CoverageErrorCode =
  | 'invalid_context'
  | 'invalid_surface_input'
  | 'invalid_source_input'
  | 'invalid_claim_input'
  | 'invalid_query'
  | 'surface_not_found'
  | 'source_not_found'
  | 'claim_not_found'
  | 'snapshot_not_found'
  | 'surface_already_registered'
  | 'source_already_registered';

export class CoverageError extends Error {
  constructor(
    public readonly code: CoverageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CoverageError';
  }
}
