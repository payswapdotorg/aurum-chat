// Typed errors of the capability-grants module. Consumers catch
// `CapabilityGrantsError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// The DENIALS are not errors: a denied write invocation is a first-class,
// expected outcome of progressive authority (the gate's verdict, recorded
// in the append-only invocation ledger and returned as data). Errors are
// reserved for caller mistakes, missing state and authority failures:
//
//   * `access_not_established` — the connection has no read-only envelope
//     yet; `establishConnectionAccess` first (the safe start is mandatory
//     and visible);
//   * `request_pending`        — an ask for overlapping scope is already
//     sitting in the W009 gate; decide it before asking again (no
//     duplicate gate history);
//   * `access_stale`           — the connection was re-bound to a different
//     inventory system after the envelope was established; re-establish.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`*_not_found`) — the existence of another tenant's access,
// grants, requests or invocations must never leak (ADR-0001).

export type CapabilityGrantsErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'forbidden'
  | 'access_not_found'
  | 'access_not_established'
  | 'access_stale'
  | 'connection_not_bound'
  | 'connection_not_connected'
  | 'connection_not_found'
  | 'system_not_found'
  | 'grant_not_found'
  | 'grant_request_not_found'
  | 'grant_request_not_pending'
  | 'request_pending'
  | 'invocation_not_found'
  | 'capability_not_offered';

export class CapabilityGrantsError extends Error {
  constructor(
    public readonly code: CapabilityGrantsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityGrantsError';
  }
}
