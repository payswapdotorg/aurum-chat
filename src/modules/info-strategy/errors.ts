// Typed errors of the info-strategy module. Consumers catch
// `InfoStrategyError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`strategy_not_found`, `strategy_version_not_found`; a goal,
// fingerprint or unknown that is missing or foreign reads uniformly as
// its own `*_not_found` code) — the existence of another tenant's
// strategy state must never leak (ADR-0001).
//
// `strategy_already_defined` and `strategy_retired` are domain-conflict
// codes, not crashes: one ACTIVE strategy per (tenant, goal,
// fingerprint) scope keeps "the strategy for this context" unambiguous,
// and a retired strategy is terminal — the returning need is a NEW
// strategy definition (the missions module's dead-end discipline).

export type InfoStrategyErrorCode =
  | 'invalid_context'
  | 'invalid_strategy_input'
  | 'invalid_adjustment_input'
  | 'invalid_retire_input'
  | 'invalid_query'
  | 'goal_not_found'
  | 'fingerprint_not_found'
  | 'unknown_not_found'
  | 'strategy_not_found'
  | 'strategy_version_not_found'
  | 'strategy_already_defined'
  | 'strategy_retired';

export class InfoStrategyError extends Error {
  constructor(
    public readonly code: InfoStrategyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InfoStrategyError';
  }
}
