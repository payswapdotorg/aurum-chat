// Typed errors of the cognition module. Consumers catch `CognitionError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`execution_not_found` / `step_not_found`) — the existence of
// another tenant's cognitive executions must never leak (ADR-0001), on
// reads AND on writes: advancing, suspending or abandoning a
// foreign-tenant execution id is reported as `execution_not_found`,
// never as a transition error. Stage-referenced records that are not
// readable in this tenant (observations, goals, missions, beliefs,
// action requests, acquisition plans) are uniformly `invalid_reference`;
// a causing execution that is not readable is `invalid_start_input` —
// no existence leaks anywhere.

export type CognitionErrorCode =
  | 'invalid_context'
  | 'invalid_start_input'
  | 'invalid_stage_input'
  | 'invalid_query'
  | 'stage_mismatch'
  | 'invalid_reference'
  | 'observation_rejected'
  | 'stage_write_rejected'
  | 'invalid_transition'
  | 'execution_conflict'
  | 'execution_not_found'
  | 'step_not_found';

export class CognitionError extends Error {
  constructor(
    public readonly code: CognitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CognitionError';
  }
}
