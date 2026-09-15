// Typed errors of the actions module (W009 — Policy and Action Authority).
// Consumers catch `ActionsError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`action_request_not_found` / `policy_not_found`) — the existence
// of another tenant's action requests or authority policies must never leak
// (ADR-0001), including through the approval-decision paths.
//
// `forbidden` is the authorization failure of the two claim-gated writes:
//  * `setAuthorityPolicy` requires the `actions:administer` claim (the
//    authority matrix is the tenant's security control surface — a plain
//    member must not be able to weaken its own approval gates);
//  * `decideApproval` requires the `actions:approve` claim (or the
//    kind-scoped `actions:approve:<kind>`), and the requesting principal
//    may never decide its own request (separation of duties: Aurum's
//    proposals are decided by humans, not by Aurum — ARCHITECTURE.md §14/
//    §15, GOVERNANCE.md "high-impact actions are policy-gated").
//
// `not_pending` is the approval gate's state error: only a request the
// matrix routed into the approval gate (outcome `approval_required`,
// status `pending`) can be decided; policy-auto-approved and
// policy-rejected requests are terminal the moment they are recorded.

export type ActionsErrorCode =
  | 'invalid_context'
  | 'invalid_policy_input'
  | 'invalid_action_input'
  | 'invalid_query'
  | 'invalid_decision'
  | 'forbidden'
  | 'policy_not_found'
  | 'action_request_not_found'
  | 'not_pending'
  | 'policy_conflict';

export class ActionsError extends Error {
  constructor(
    public readonly code: ActionsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActionsError';
  }
}
