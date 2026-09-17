// Typed errors of the automation module. Consumers catch `AutomationError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`opportunity_not_found` / `opportunity_version_not_found` /
// `measurement_not_found`) — the existence of another tenant's automation
// candidates must never leak (ADR-0001). This includes versions and
// measurements: a version of a foreign-tenant opportunity reads the same as
// a missing one, measuring a foreign-tenant opportunity reads the same as a
// missing one, and so does citing a foreign-tenant process, finding or
// capability on registration/revision (`invalid_process_ref` /
// `invalid_capability_ref` — the learning module's uniform-origin-ref
// discipline: missing, malformed and foreign-tenant references are the same
// error, no existence leak).

export type AutomationErrorCode =
  | 'invalid_context'
  | 'invalid_registration'
  | 'invalid_revision'
  | 'invalid_measurement'
  | 'invalid_query'
  // The cited process, process finding or capability reference is not
  // available in this tenant to this principal — missing, malformed,
  // foreign-tenant, or (for findings) not a finding of the cited process.
  | 'invalid_process_ref'
  | 'invalid_capability_ref'
  // A lifecycle change was not surgical, a frozen status was handed
  // content changes, an illegal transition was attempted, or a measurement
  // was recorded against an opportunity that is not accepted (the
  // capabilities module's transition discipline).
  | 'invalid_transition'
  | 'opportunity_not_found'
  | 'opportunity_version_not_found'
  | 'measurement_not_found'
  // Two different principals raced to register the same opportunity name;
  // the loser re-reads and revises the winner's opportunity (the processes
  // module's name-conflict discipline — the name is the immutable graph key).
  | 'opportunity_name_conflict'
  // A version-append race on an opportunity (optimistic pointer guard);
  // the loser re-reads and retries (history is never rewritten).
  | 'opportunity_conflict';

export class AutomationError extends Error {
  constructor(
    public readonly code: AutomationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}
