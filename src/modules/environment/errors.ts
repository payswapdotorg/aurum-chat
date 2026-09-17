// Typed errors of the environment module. Consumers catch
// `EnvironmentError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`watchlist_not_found` / `watch_entry_not_found` /
// `watch_signal_not_found` / `watch_escalation_not_found`) — the existence
// of another tenant's watch programme must never leak (ADR-0001),
// including through the cross-module validation paths: a world entity, an
// observation or a cognitive execution that is not readable in this tenant
// is uniformly `invalid_world_ref` / `invalid_observation_ref` /
// `invalid_execution_ref`.
//
// Error propagation across the module boundary (documented for consumers):
//  * the world contract's `WorldError`, the observations contract's
//    `ObservationsError` and the cognition contract's `CognitionError`
//    raised while validating a write-time reference are mapped onto this
//    module's uniform `invalid_*_ref` codes (the attention module's
//    origin-execution precedent); anything else propagates unchanged;
//  * `FreshnessError` raised by the freshness wiring
//    (setWatchFreshnessPolicy / resolveWatchFreshnessPolicy) is mapped
//    onto `invalid_policy_input` / `invalid_watch_query` — the freshness
//    machinery is internal to watches, exactly as belief versioning is
//    internal to the epistemics module.

export type EnvironmentErrorCode =
  | 'invalid_context'
  | 'invalid_watchlist_input'
  | 'invalid_watch_entry_input'
  | 'invalid_watch_query'
  | 'invalid_policy_input'
  | 'invalid_signal_input'
  | 'invalid_world_ref'
  | 'invalid_observation_ref'
  | 'invalid_execution_ref'
  | 'watchlist_not_found'
  | 'watch_entry_not_found'
  | 'watch_signal_not_found'
  | 'watch_escalation_not_found'
  | 'watchlist_name_conflict'
  | 'watch_entry_conflict'
  | 'signal_conflict'
  | 'watchlist_status_conflict'
  | 'watch_entry_status_conflict'
  | 'watchlist_archived'
  | 'watch_entry_inactive'
  | 'escalation_busy';

export class EnvironmentError extends Error {
  constructor(
    public readonly code: EnvironmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}
