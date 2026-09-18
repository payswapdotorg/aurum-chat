// Typed errors of the briefings module. Consumers catch `BriefingsError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`briefing_not_found` / `policy_not_found`) — the existence of
// another tenant's briefings or policies must never leak (ADR-0001), the
// uniform not-found discipline every sibling module applies.

export type BriefingsErrorCode =
  | 'invalid_context'
  | 'invalid_briefing_input'
  | 'invalid_briefing_query'
  | 'invalid_policy_input'
  | 'invalid_policy_query'
  | 'forbidden'
  | 'policy_not_found'
  | 'policy_conflict'
  | 'briefing_not_found'
  | 'delivery_failed';

export class BriefingsError extends Error {
  constructor(
    public readonly code: BriefingsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BriefingsError';
  }
}
