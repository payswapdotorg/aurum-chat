// Typed errors of the workforce module. Consumers catch `WorkforceError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`role_not_found` / `role_version_not_found` /
// `assignment_not_found` / `assignment_version_not_found` /
// `signal_not_found` / `assessment_not_found` /
// `assessment_version_not_found` / `decision_not_found`) — the existence of
// another tenant's workforce intelligence must never leak (ADR-0001). This
// includes versions, decisions and registrations against foreign-tenant
// role ids: they all read the same as missing records.
//
// The two governance codes carry the §14/lock-20/21 discipline:
//   'employment_guard'          — an employment-impacting recommendation
//       lacked preserved uncertainty (confidence < 1), alternative
//       explanations (≥ 1), alternatives (≥ 2 distinct kinds) or evidence
//       (≥ 1 reference). Mirrored by a storage CHECK constraint.
//   'ungrounded_recommendation' — a 'termination' / 'performance_action'
//       recommendation was issued without at least one adverse computed
//       finding. Mirrored by a storage CHECK constraint.

export type WorkforceErrorCode =
  | 'invalid_context'
  | 'invalid_role_input'
  | 'invalid_assignment_input'
  | 'invalid_signal_input'
  | 'invalid_assessment_input'
  | 'invalid_decision_input'
  | 'invalid_query'
  // A lifecycle change was not surgical, or a retired record was handed
  // anything but a reactivation, or a role was assigned against a retired
  // role expectation (the goals/capabilities transition discipline).
  | 'invalid_transition'
  // recordDecision without the 'workforce:decide' authority claim.
  | 'forbidden'
  | 'role_not_found'
  | 'role_version_not_found'
  | 'assignment_not_found'
  | 'assignment_version_not_found'
  | 'signal_not_found'
  | 'assessment_not_found'
  | 'assessment_version_not_found'
  | 'decision_not_found'
  // Two different principals raced to register the same role key; the
  // loser re-reads and revises the winner's role (the capabilities module's
  // name-conflict discipline — the key is the immutable graph key).
  | 'role_key_conflict'
  // Two different principals raced to assign the same (role, employee)
  // pair, or a concurrent revision moved an assignment forward
  // mid-transaction; the loser re-reads and retries.
  | 'assignment_conflict'
  // A version-append race on an assessment (optimistic pointer guard); the
  // loser re-reads and retries (history is never rewritten).
  | 'assessment_conflict'
  // A second decision on an assessment version that already carries one —
  // the first human decision wins and is terminal (the actions module's
  // first-decision-wins discipline).
  | 'already_decided'
  // Lock 20 representation guards (see above).
  | 'employment_guard'
  // Adverse-grounding guard for termination/performance_action (see above).
  | 'ungrounded_recommendation';

export class WorkforceError extends Error {
  constructor(
    public readonly code: WorkforceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkforceError';
  }
}
