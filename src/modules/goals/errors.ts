// Typed errors of the goals module. Consumers catch `GoalsError` and branch
// on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`goal_not_found` / `goal_version_not_found`) — the existence of
// another tenant's goals must never leak (ADR-0001), on reads AND on
// revisions: revising a foreign-tenant goal id is reported as
// `goal_not_found`, never as a transition error.

export type GoalsErrorCode =
  | 'invalid_context'
  | 'invalid_goal_input'
  | 'invalid_revision_input'
  | 'invalid_query'
  | 'invalid_transition'
  | 'goal_conflict'
  | 'goal_not_found'
  | 'goal_version_not_found';

export class GoalsError extends Error {
  constructor(
    public readonly code: GoalsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalsError';
  }
}
