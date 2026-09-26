// Typed errors of the computer-use module. Consumers catch
// `ComputerUseError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// The REFUSALS are not errors: an allowlist block (service-side or
// driver-side), a permanent driver refusal and an observed-state
// divergence are first-class, expected outcomes of governed execution —
// recorded on the task ('aborted' / 'mismatched'), linked to their
// evidence and returned as data. Errors are reserved for caller
// mistakes, missing state, wiring gaps and non-canonical driver results:
//
//   * `task_not_pending_phase` — the requested transition does not follow
//     the forward-only lifecycle (e.g. resuming a 'completed' task);
//   * `driver_unavailable`     — no browser driver is wired; the fallback
//     refuses to fake success (the sources/destinations discipline);
//   * `invalid_driver_result`  — the driver returned a non-canonical
//     value (a provider object cannot cross the boundary — lock 16), or
//     an accepted action without an observed state (an unobserved action
//     is never a result).
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`task_not_found`) — the existence of another tenant's tasks,
// steps, sessions or events must never leak (ADR-0001).

export type ComputerUseErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'task_not_found'
  | 'task_not_pending_phase'
  | 'driver_unavailable'
  | 'invalid_driver_result'
  | 'task_not_failed';

export class ComputerUseError extends Error {
  constructor(
    public readonly code: ComputerUseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ComputerUseError';
  }
}
