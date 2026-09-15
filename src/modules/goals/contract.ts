// ============================================================================
// goals — the ONLY public surface of the goals module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W008 — Goals and Desired State:
// "Implement versioned management goals, desired state, metrics, thresholds,
//  horizon, owner and priority. Verify goal changes are auditable."
//
// A goal is the tenant's declared direction (ARCHITECTURE.md §5, lock 13):
// what management is trying to achieve, the desired state to reach, the
// metrics/thresholds that define meeting it, the horizon, the accountable
// owner, the priority, the expected evidence sources and the success
// criteria. The goal model is the basis for prioritizing Aurum's learning
// effort — W011 missions and W013 cognition reference goals through THIS
// contract only.
//
//   createGoal        — define a goal: appends the identity row plus
//      version 1 ('created', status minted 'active').
//   reviseGoal        — append the next version. Omitted fields carry over
//      unchanged; arrays replace wholesale; a `status` change must be the
//      only change (surgical lifecycle); an archived goal accepts nothing
//      but reactivation. The merged snapshot passes the same validation as
//      a fresh create.
//   getGoal           — the current view (identity + current version's
//      content + audit summary of the change that produced it).
//   getGoalVersion    — one audit record (full self-contained snapshot).
//   listGoalVersions  — the goal's audit trail, ascending by version.
//   listGoals         — current views, filtered (status, priority, owner,
//      horizon window, title search), ordered by priority rank.
//
// There is deliberately NO operation to update a version in place, delete a
// goal or rewrite history: goals are versioned and auditable (§5) — revising
// appends, archiving retires (versioned status change, no erasure), and
// PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on goal_versions (and
// DELETE/TRUNCATE on goals) via migration 001 triggers.
//
// Auditing model (the W008 acceptance): every version records WHO (actor
// party + the authenticated TenantContext principal — both system-captured,
// the latter not caller-suppliable), WHEN (service-clock recorded_at), WHAT
// (service-derived change_kind + a full content snapshot — any version
// decodes alone, and diffs between consecutive versions reconstruct the
// exact change) and WHY (rationale). In-module append-only audit chain, per
// the W006 freshness precedent — assembling cross-cutting decision evidence
// is W046's scope, reading it through this contract.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's goals
// (including revisions and version lookups) is reported as `goal_not_found`
// / `goal_version_not_found` — no existence leak.
// ============================================================================

export {
  createGoal,
  getGoal,
  getGoalVersion,
  listGoalVersions,
  listGoals,
  reviseGoal,
} from './service';

export { GoalsError } from './errors';
export type { GoalsErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  GOAL_CHANGE_KINDS,
  GOAL_EVIDENCE_SOURCE_KINDS,
  GOAL_METRIC_DIRECTIONS,
  GOAL_PARTY_KINDS,
  GOAL_PRIORITIES,
  GOAL_STATUSES,
  MAX_EVIDENCE_SOURCES,
  MAX_LIST_LIMIT,
  MAX_METRICS_PER_GOAL,
  isGoalChangeKind,
  isGoalEvidenceSourceKind,
  isGoalMetricDirection,
  isGoalPartyKind,
  isGoalPriority,
  isGoalStatus,
  isUuid,
} from './validation';

export type {
  ValidatedCreateGoalInput,
  ValidatedEvidenceSource,
  ValidatedGoalContent,
  ValidatedListQuery,
  ValidatedMetric,
  ValidatedParty,
  ValidatedRevisionInput,
  ValidatedRevisionPatch,
  ValidatedVersionQuery,
  ValidatedHistoryQuery,
} from './validation';

export type {
  CreateGoalInput,
  GetGoalVersionQuery,
  Goal,
  GoalActor,
  GoalActorInput,
  GoalChangeKind,
  GoalContent,
  GoalEvidenceSource,
  GoalEvidenceSourceInput,
  GoalEvidenceSourceKind,
  GoalHorizon,
  GoalMetric,
  GoalMetricDirection,
  GoalMetricInput,
  GoalOwner,
  GoalOwnerInput,
  GoalParty,
  GoalPartyKind,
  GoalPriority,
  GoalStatus,
  GoalVersion,
  ListGoalsQuery,
  ListGoalVersionsQuery,
  ReviseGoalInput,
} from './types';
