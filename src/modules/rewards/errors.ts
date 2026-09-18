// Typed errors of the rewards module. Consumers catch `RewardsError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`reward_not_found` / `mission_not_found`) — the existence of
// another tenant's rewards, policies or settlements must never leak
// (ADR-0001), on reads AND on writes: applying against a foreign-tenant
// contribution anchor, mission or reward id is reported as the uniform
// missing-record error, never as a state error. The acquisition-plan anchor
// is uniformly `invalid_contribution_ref` for missing, malformed,
// foreign-tenant and non-answer plans alike (the knowledge-acquisition
// module's remap precedent).

export type RewardsErrorCode =
  | 'invalid_context'
  | 'forbidden'
  | 'invalid_policy_input'
  | 'invalid_reward_input'
  | 'invalid_settlement_input'
  | 'invalid_query'
  | 'policy_not_configured'
  | 'mission_not_found'
  | 'mission_not_rewardable'
  | 'invalid_contribution_ref'
  | 'currency_mismatch'
  | 'budget_exceeded'
  | 'reward_not_found'
  | 'reward_conflict'
  | 'reward_not_proposed'
  | 'reward_still_proposed'
  | 'reward_already_settled';

export class RewardsError extends Error {
  constructor(
    public readonly code: RewardsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RewardsError';
  }
}
