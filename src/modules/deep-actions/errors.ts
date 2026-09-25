// Typed errors of the deep-actions module. Consumers catch
// `DeepActionsError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// The REFUSALS are not errors: a W009 gate rejection and a W083 capability
// denial are first-class, expected outcomes of governed execution —
// recorded on the task ('rejected'), linked to the gate evidence and
// returned as data. Errors are reserved for caller mistakes, missing
// state, wiring gaps and non-canonical transport results:
//
//   * `task_not_pending_phase`  — the requested phase transition does not
//     follow the forward-only chain (e.g. executing a task that is not
//     'authorized');
//   * `transport_unavailable`   — no deep-action transport is wired; the
//     pipeline refuses to fake success (the sources/destinations
//     discipline);
//   * `invalid_transport_result` — a transport returned a non-canonical
//     value (a provider object cannot cross the gateway — lock 16);
//   * `operation_rejected`      — re-execution was attempted while an
//     operation carries a permanent provider refusal.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`task_not_found`) — the existence of another tenant's tasks,
// operations, surface or events must never leak (ADR-0001).

export type DeepActionsErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'task_not_found'
  | 'task_not_pending_phase'
  | 'operation_not_found'
  | 'connection_not_found'
  | 'connection_not_connected'
  | 'access_not_established'
  | 'access_stale'
  | 'system_not_found'
  | 'capability_not_offered'
  | 'read_capability_missing'
  | 'gate_not_decided'
  | 'gate_rejected'
  | 'transport_unavailable'
  | 'invalid_transport_result'
  | 'operation_rejected'
  | 'idempotency_conflict';

export class DeepActionsError extends Error {
  constructor(
    public readonly code: DeepActionsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeepActionsError';
  }
}
