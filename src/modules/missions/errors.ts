// Typed errors of the missions module. Consumers catch `MissionsError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`mission_not_found` / `mission_version_not_found`) — the
// existence of another tenant's missions must never leak (ADR-0001), on
// reads AND on writes: revising, completing or abandoning a foreign-tenant
// mission id is reported as `mission_not_found`, never as a transition
// error. Unknown references validated through the epistemics contract are
// uniformly `invalid_unknown_ref` for the same reason (missing, malformed
// and foreign-tenant unknown ids are indistinguishable).

export type MissionsErrorCode =
  | 'invalid_context'
  | 'invalid_mission_input'
  | 'invalid_revision_input'
  | 'invalid_completion_input'
  | 'invalid_abandonment_input'
  | 'invalid_query'
  | 'invalid_transition'
  | 'invalid_unknown_ref'
  | 'mission_conflict'
  | 'mission_not_found'
  | 'mission_version_not_found';

export class MissionsError extends Error {
  constructor(
    public readonly code: MissionsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MissionsError';
  }
}
