// Typed errors of the migration module. Consumers catch `MigrationError`
// and branch on `code`; messages are for humans/logs, never for control
// flow.
//
// The REFUSALS are not errors: a surfaced identity conflict, a surfaced
// comparison divergence and a surfaced transform issue are first-class,
// expected outcomes of honest migration — recorded as data (conflict
// rows, comparison entries, record issues) and returned on the records.
// Errors are reserved for caller mistakes, missing state, wiring gaps and
// non-canonical incumbent results:
//
//   * `round_not_pending_phase` — the requested round transition does not
//     follow the forward-only snapshot → transform → staged → review →
//     commit chain (or the round is already abandoned);
//   * `migration_not_pending_status` — the requested checkpoint
//     transition does not follow the retirement chain, or the migration
//     is terminal (sequestered / retired);
//   * `round_open`              — a round is already open for the
//     migration (abandon it first; an abandoned round never becomes a
//     delta base, so its window is re-read — no silent data loss);
//   * `reader_unavailable`      — no incumbent reader is wired; the
//     import lifecycle refuses to fake a snapshot (the deep-actions
//     transport discipline);
//   * `native_reader_unavailable` — no native-state reader is wired; the
//     comparison refuses to fake native Aurum state;
//   * `invalid_reader_result`   — the incumbent reader returned a
//     non-canonical value (a provider object cannot cross — lock 16);
//   * `compare_clean_required`  — the retirement checkpoint chain was
//     walked out of order or without its justifying evidence (a clean
//     comparison round).
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`migration_not_found` / `round_not_found` / `conflict_not_found`
// / `comparison_not_found`) — the existence of another tenant's
// migrations, rounds, records, map entries, conflicts or comparison
// reports must never leak (ADR-0001).

export type MigrationErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'forbidden'
  | 'migration_not_found'
  | 'migration_not_pending_status'
  | 'migration_already_final'
  | 'live_migration_exists'
  | 'system_not_found'
  | 'capability_not_offered'
  | 'connection_not_found'
  | 'connection_not_connected'
  | 'kit_not_found'
  | 'kit_integration_not_declared'
  | 'round_not_found'
  | 'round_not_pending_phase'
  | 'round_open'
  | 'conflict_not_found'
  | 'conflict_not_open'
  | 'comparison_not_found'
  | 'compare_clean_required'
  | 'reader_unavailable'
  | 'native_reader_unavailable'
  | 'invalid_reader_result'
  | 'snapshot_too_large';

export class MigrationError extends Error {
  constructor(
    public readonly code: MigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}
