// The PURE migration lifecycle state machine (W094) — no database, no
// clock, no network, no LLM (lock 10 discipline: the lifecycle is a
// computation, not an opinion). Usable without a database exactly like
// the vertical-kits lifecycle surface.
//
// The migration is a LIFECYCLE, not a batch job:
//
//   staged ──import──▶ imported ──start-dual-run──▶ dual-running
//        ──open-window──▶ retiring-incumbent ──complete-all-kinds──▶ retired
//
// and every forward transition is REVERSIBLE (rollback restores the
// previous state's authority surface; the evidence trail is retained —
// rollback is itself a recorded transition).
//
// AUTHORITY DERIVATION (the "no duplicate authority" invariant): during
// staged/imported/dual-running the INCUMBENT is the authority of
// record for migrated entities; a kind's authority transfers to Aurum
// exactly when its retirement window completes, and a rollback restores
// incumbent authority. One system is the authority at a time, and the
// migration records say which.

import type {
  MigrationAuthority,
  MigrationState,
  MigrationTransitionKind,
  RetirementWindowStatus,
} from './types';

/** The canonical lifecycle states (mirrored by the migration CHECK). */
export const MIGRATION_STATES: readonly MigrationState[] = [
  'staged',
  'imported',
  'dual-running',
  'retiring-incumbent',
  'retired',
] as const;

/**
 * Every legal transition, forward and reverse — the machine-readable
 * reversibility contract (rollback rides the same graph, backwards).
 */
export const MIGRATION_TRANSITIONS: readonly {
  from: MigrationState;
  to: MigrationState;
  kind: MigrationTransitionKind;
  operation: string;
}[] = [
  { from: 'staged', to: 'imported', kind: 'forward', operation: 'runImport' },
  { from: 'imported', to: 'staged', kind: 'rollback', operation: 'rollbackMigration' },
  { from: 'imported', to: 'dual-running', kind: 'forward', operation: 'startDualRun' },
  { from: 'dual-running', to: 'imported', kind: 'rollback', operation: 'rollbackMigration' },
  {
    from: 'dual-running',
    to: 'retiring-incumbent',
    kind: 'forward',
    operation: 'openRetirementWindow',
  },
  {
    from: 'retiring-incumbent',
    to: 'dual-running',
    kind: 'rollback',
    operation: 'rollbackMigration',
  },
  { from: 'retiring-incumbent', to: 'retired', kind: 'forward', operation: 'completeRetirement' },
  { from: 'retired', to: 'retiring-incumbent', kind: 'rollback', operation: 'rollbackMigration' },
] as const;

/** The initial lifecycle state. */
export const INITIAL_MIGRATION_STATE: MigrationState = 'staged';

/** Guards (the house validation pattern — re-exported through the contract). */
export function isMigrationState(value: unknown): value is MigrationState {
  return typeof value === 'string' && (MIGRATION_STATES as readonly string[]).includes(value);
}

/** Whether `from -> to` is a legal transition of the lifecycle graph. */
export function canTransitionMigration(
  from: MigrationState,
  to: MigrationState,
): boolean {
  return MIGRATION_TRANSITIONS.some((edge) => edge.from === from && edge.to === to);
}

/** The legal targets of one state (empty at the terminals' far side). */
export function availableMigrationTransitions(
  from: MigrationState,
): { to: MigrationState; kind: MigrationTransitionKind; operation: string }[] {
  return MIGRATION_TRANSITIONS.filter((edge) => edge.from === from).map((edge) => ({
    to: edge.to,
    kind: edge.kind,
    operation: edge.operation,
  }));
}

/**
 * DERIVED AUTHORITY — which system is the authority of record for one
 * entity kind, computed from the migration state and the kind's LATEST
 * retirement window (never stored, never duplicated):
 *   * the whole migration `retired`  → Aurum holds every kind;
 *   * the kind's latest window is `retired` → Aurum holds the kind
 *     (authority transferred at the retirement window — the ONLY path);
 *   * anything else (`open`, `rolled-back`, no window yet) → the
 *     INCUMBENT remains the authority of record.
 */
export function authorityForKind(input: {
  state: MigrationState;
  latestWindowStatus: RetirementWindowStatus | null;
}): MigrationAuthority {
  if (input.state === 'retired') return 'aurum';
  if (input.latestWindowStatus === 'retired') return 'aurum';
  return 'incumbent';
}

/**
 * Whether a state allows dual-run activity (sync passes and
 * comparisons): the two states where incumbent and Aurum both live.
 */
export function isDualRunActive(state: MigrationState): boolean {
  return state === 'dual-running' || state === 'retiring-incumbent';
}

/**
 * The deterministic rollback target of one state (the previous state's
 * authority surface), or null at the initial state.
 */
export function rollbackTargetOf(state: MigrationState): MigrationState | null {
  switch (state) {
    case 'staged':
      return null;
    case 'imported':
      return 'staged';
    case 'dual-running':
      return 'imported';
    case 'retiring-incumbent':
      return 'dual-running';
    case 'retired':
      return 'retiring-incumbent';
  }
}
