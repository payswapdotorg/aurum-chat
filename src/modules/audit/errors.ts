// Typed errors of the audit module. Consumers catch `AuditError` and branch
// on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`audit_record_not_found`, `execution_not_found`,
// `action_request_not_found`) — the existence of another tenant's audit
// trail, cognitive executions or action requests must never leak
// (ADR-0001), including through anchor resolution: a foreign
// `executionId` anchor and a nonexistent one are the same error.
//
// Error propagation across module boundaries (documented for consumers):
//  * anchor resolution through the cognition contract maps
//    `execution_not_found` onto this module's `execution_not_found` —
//    same code, one vocabulary; any other CognitionError cannot occur
//    through this contract (the query was validated first) and is never
//    swallowed;
//  * anchor resolution through the actions contract maps
//    `action_request_not_found` likewise;
//  * DEEP-LINK reads inside a reconstruction (an observation the calling
//    principal may not read, a knowledge entry, a claim, ...) are NOT
//    errors: the chain reports them as unreadable in place (a partial
//    view, never a restricted-content leak — the observations module's
//    lineage precedent). A reconstruction never fails because one of its
//    links is restricted; it fails only when the anchor itself is absent.

export type AuditErrorCode =
  | 'invalid_context'
  | 'invalid_record_input'
  | 'invalid_query'
  | 'invalid_anchor'
  | 'execution_not_found'
  | 'action_request_not_found'
  | 'audit_record_not_found';

export class AuditError extends Error {
  constructor(
    public readonly code: AuditErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuditError';
  }
}
