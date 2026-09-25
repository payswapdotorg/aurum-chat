// Typed errors of the cellular module. Consumers catch `CellularError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`connection_not_found` / `reach_not_found` / `policy_not_found`)
// — the existence of another tenant's cellular state must never leak
// (ADR-0001), the uniform not-found discipline every sibling module
// applies.

export type CellularErrorCode =
  | 'invalid_context'
  | 'invalid_cellular_input'
  | 'invalid_cellular_query'
  | 'invalid_provider_payload'
  | 'unsupported_provider_event'
  | 'forbidden'
  | 'connection_not_found'
  | 'connection_disabled'
  | 'connection_ambiguous'
  | 'policy_not_found'
  | 'person_not_reachable'
  | 'message_too_long'
  | 'reach_not_found'
  | 'reach_not_retryable'
  | 'provider_unavailable';

export class CellularError extends Error {
  constructor(
    public readonly code: CellularErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CellularError';
  }
}
