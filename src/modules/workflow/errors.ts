// Typed errors of the workflow module (W080 — Durable Agent Runtime
// Adapter). Consumers catch `WorkflowError` and branch on `code`;
// messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`definition_not_found` / `run_not_found` / `schedule_not_found`
// / `event_not_found`) — the existence of another tenant's workflow
// state must never leak (ADR-0001), including through the pump, the
// signal paths and the schedule evaluation sweep.
//
// `invalid_reference` marks a trigger/reference that is not readable in
// this tenant through its owning module's contract (a domain event id
// validated through the events module, the missions/epistemics
// precedent) — the module never stores unverified cross-module links.
//
// `not_cancellable` and `not_waiting_employee_response` are the
// lifecycle state errors of the cooperative surfaces: only live runs
// can be cancelled, and only an employee-response wait accepts an
// external resume signal (approval waits are released by the actions
// module's decisions, timer waits by the clock).

export type WorkflowErrorCode =
  | 'invalid_context'
  | 'invalid_definition_input'
  | 'invalid_run_input'
  | 'invalid_cancel_input'
  | 'invalid_resume_input'
  | 'invalid_event_input'
  | 'invalid_schedule_input'
  | 'invalid_query'
  | 'definition_not_found'
  | 'definition_not_active'
  | 'run_not_found'
  | 'step_not_found'
  | 'schedule_not_found'
  | 'event_not_found'
  | 'not_cancellable'
  | 'not_waiting_employee_response'
  | 'invalid_reference'
  | 'wait_not_satisfiable';

export class WorkflowError extends Error {
  constructor(
    public readonly code: WorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/**
 * Thrown by a step executor to report a DETERMINISTIC failure — a
 * rejection retrying cannot change (invalid input, unreadable
 * references, a rejected precondition). The engine dead-letters the
 * step immediately (the worker.ts discipline); any other thrown value
 * is treated as transient and consumes the retry budget.
 *
 * `code` is executor-supplied (recorded on the step/run evidence);
 * `retryable` is always false for this class.
 */
export class WorkflowStepError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowStepError';
  }
}
