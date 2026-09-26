// Typed errors of the migration-continuity module. Consumers catch
// `MigrationContinuityError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// The SURFACED STATES are not errors: a conflict row, an ambiguous
// mapping, a refused back-write and a blocked retirement window are
// first-class, expected outcomes of dual-run continuity — recorded as
// durable evidence and returned as data. Errors are reserved for
// caller mistakes, missing state, wiring gaps, non-canonical transport
// results and INTEGRITY MISMATCHES (the no-silent-data-loss refusal:
// a manifest that disagrees with the landed rows is a hard failure):
//
//   * `migration_not_pending_phase` — the requested transition does not
//     follow the lifecycle (e.g. importing a dual-running migration);
//   * `transport_unavailable`      — no deep-action transport is wired;
//     the module refuses to fake incumbent reads (the W084 discipline);
//   * `invalid_transport_result`   — the transport returned a
//     non-canonical value (a provider object cannot cross — lock 16);
//   * `connection_not_active`      — the broker connection the
//     migration rides is not 'connected' (an honest outage surface);
//   * `read_capability_denied`     — the W083 gate denied the read
//     (the capability left the surface); verification is impossible;
//   * `import_integrity_mismatch`  — manifest vs landed rows disagree
//     (counts or checksums) — the hard no-silent-data-loss failure;
//   * `retirement_not_clean`       — the kind's latest comparison
//     report is not clean (progressive retirement is gated);
//   * `retirement_conflicts_open`  — the kind still holds open
//     conflicts (progressive retirement is gated);
//   * `window_not_open`            — no open retirement window for the
//     kind to complete;
//   * `nothing_to_rollback`        — the migration is at its initial
//     state; there is no transition to reverse.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`migration_not_found` / `mapping_not_found` /
// `conflict_not_found`) — the existence of another tenant's migrations
// must never leak (ADR-0001).

export type MigrationContinuityErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'forbidden'
  | 'migration_not_found'
  | 'migration_not_pending_phase'
  | 'transport_unavailable'
  | 'invalid_transport_result'
  | 'connection_not_active'
  | 'read_capability_denied'
  | 'import_batch_not_found'
  | 'import_integrity_mismatch'
  | 'retirement_not_clean'
  | 'retirement_conflicts_open'
  | 'window_not_open'
  | 'nothing_to_rollback'
  | 'mapping_not_found'
  | 'mapping_not_ambiguous'
  | 'conflict_not_found'
  | 'conflict_not_open';

export class MigrationContinuityError extends Error {
  constructor(
    public readonly code: MigrationContinuityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationContinuityError';
  }
}
