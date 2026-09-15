// Public domain types of the goals module (W008 — Goals and Desired State).
//
// A Goal is what management is trying to achieve — the DIRECTION of the
// company intelligence loop (ARCHITECTURE.md §5, lock 13). It is deliberately
// NOT a belief (epistemics W007), NOT attention policy (W033) and NOT
// evidence (observations W004): it is the tenant's declared desired state
// against which the loop evaluates what matters, what is unknown and what
// must be learned. The goal model is the basis for prioritizing Aurum's
// learning effort (§5) — W011 missions and W013 cognition will reference
// goals through this module's contract.
//
// Per §5, a goal definition carries: objective, desired state,
// metric/threshold, horizon, owner, priority, evidence sources and success
// criteria. Every one of those fields is VERSIONED CONTENT: a goal is an
// identity (uuid) plus an append-only chain of full-snapshot versions
// (goal_versions). Changing a goal appends the next version — history is
// never rewritten — and every version records the audit quartet (actor,
// recorded_at, change_kind + full content, rationale), which is what makes
// goal changes auditable (the W008 acceptance).
//
// Provider neutrality (lock 16): owner, actor and evidence sources are
// opaque party references — kind + uuid id and/or human label — owned by
// their respective modules (people W002, world W005 teams, agents W021+,
// sources W036). None of those modules is a dependency of goals, so the
// references are deliberately unverified here (the events/observations
// precedent); no provider object ever crosses this contract.

/** Management priority of a goal (TEXT + CHECK in storage, §8 conventions). */
export type GoalPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Lifecycle status of a goal. Lifecycle is VERSIONED content like every
 * other field: archiving/re-activating appends a version, so lifecycle
 * changes are auditable too. ADR-0017 derives candidate unknowns from
 * "active goals"; there is deliberately no 'draft' — management defines
 * goals (they are active upon definition) and approval workflows, when they
 * arrive, belong to the policy layer (W009), not to the goal record.
 */
export type GoalStatus = 'active' | 'archived';

/**
 * What kind of change one goal version represents — service-derived, never
 * caller-supplied:
 *  * 'created'      — version 1 (goal definition);
 *  * 'revised'      — content change on an active goal;
 *  * 'archived'     — lifecycle transition active → archived;
 *  * 'reactivated'  — lifecycle transition archived → active.
 */
export type GoalChangeKind = 'created' | 'revised' | 'archived' | 'reactivated';

/** Kinds of parties that can own a goal or make a goal change. */
export type GoalPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module (people for `person`, world for `team`, agents
 * for `agent`), a human-readable `label`, or both. At least one must be
 * present — the owner/actor of a goal change must be traceable.
 */
export interface GoalParty {
  kind: GoalPartyKind;
  id?: string | null;
  label?: string | null;
}

/** The accountable party of a goal (`GoalParty`; separate name for readers). */
export type GoalOwner = GoalParty;

/** The party that made one goal change (`GoalParty`). */
export type GoalActor = GoalParty;

/**
 * Kinds of references a goal may record as its evidence sources — the
 * vocabulary of the observations module's source kinds (W004 contract),
 * reused so goal evidence references stay comparable with observation
 * provenance once W013/W036 join them up.
 */
export type GoalEvidenceSourceKind = 'source' | 'person' | 'agent' | 'system' | 'external';

/**
 * One evidence-source reference of a goal (§5 "evidence sources"): where
 * evidence about this goal is expected to come from. Same traceability rule
 * as parties — id (opaque uuid owned by the sources/people/agents module)
 * and/or label.
 */
export interface GoalEvidenceSource {
  kind: GoalEvidenceSourceKind;
  id?: string | null;
  label?: string | null;
}

/**
 * How a metric's measured value relates to its threshold(s).
 *  * 'at_least' — success is value >= threshold (growth goals);
 *  * 'at_most'  — success is value <= threshold (reduction goals);
 *  * 'in_range' — success is lowerBound <= value <= upperBound
 *                 (stability goals; [x, x] means exactly x).
 */
export type GoalMetricDirection = 'at_least' | 'at_most' | 'in_range';

/**
 * One metric/threshold definition of a goal (§5 "metric/threshold"): the
 * measurable quantity and the bound(s) that define meeting it. Values are
 * finite numbers; money/quantities follow the §8 convention (integer minor
 * units + unit) by convention of the `unit` field — the module stores
 * numbers, not formatted amounts.
 */
export interface GoalMetric {
  /**
   * Canonical machine key, unique within the goal version (e.g.
   * `monthly-recurring-revenue`). Stable keys make version diffs and
   * downstream evaluation (W013) unambiguous.
   */
  name: string;
  /** Optional unit label, e.g. `EUR-cent`, `count`, `ratio`, `days`. */
  unit: string | null;
  direction: GoalMetricDirection;
  /** Required for `at_least`/`at_most`; absent for `in_range`. */
  threshold: number | null;
  /** Required for `in_range`; absent otherwise. */
  lowerBound: number | null;
  /** Required for `in_range`; absent otherwise. */
  upperBound: number | null;
}

/** The time window over which a goal applies (§5 "horizon"). */
export interface GoalHorizon {
  /** When the horizon opens; null = no explicit start. */
  start: string | null;
  /** When the horizon ends (the deadline). Always present. */
  end: string;
}

/**
 * The full versioned content of a goal — everything §5 puts in a goal
 * definition. Identical shape on create input, on every stored version and
 * on reads, so any version is self-contained.
 */
export interface GoalContent {
  /** Short human name, e.g. "Q4 churn reduction". */
  title: string;
  /** What management is trying to achieve (the goal statement). */
  objective: string;
  /** The desired state to reach (§5 "desired state"). */
  desiredState: string;
  /** Metric/threshold definitions; may be empty for qualitative goals. */
  metrics: GoalMetric[];
  horizon: GoalHorizon;
  owner: GoalOwner;
  priority: GoalPriority;
  /** Where evidence about this goal comes from (§5 "evidence sources"). */
  evidenceSources: GoalEvidenceSource[];
  /** What constitutes success (§5 "success criteria"). */
  successCriteria: string;
  /** Lifecycle status (always 'active' on creation; versioned afterwards). */
  status: GoalStatus;
}

/** Input shape of `createGoal` — the initial definition (status is minted 'active'). */
export interface CreateGoalInput {
  title: string;
  objective: string;
  desiredState: string;
  /** Defaults to `[]`. Replacement semantics (a whole metric set). */
  metrics?: GoalMetricInput[];
  /** When the horizon opens; null/omitted = no explicit start. */
  horizonStart?: string | null;
  /** When the horizon ends (required — a goal without a deadline has no horizon). */
  horizonEnd: string;
  owner: GoalOwnerInput;
  priority: GoalPriority;
  /** Defaults to `[]`. */
  evidenceSources?: GoalEvidenceSourceInput[];
  successCriteria: string;
  /** Who is defining the goal (audit trail, version 1). */
  actor: GoalActorInput;
  /** Why — optional, recorded on version 1. */
  rationale?: string | null;
}

/**
 * Input shape of `reviseGoal` — a PATCH against the current version:
 * omitted fields carry over unchanged; present fields replace (arrays
 * wholesale). A patch that sets `status` must set NOTHING else — lifecycle
 * transitions are surgical, so the audit trail never conflates a content
 * revision with an archive/reactivation. `horizonStart` is tri-state:
 * omitted = unchanged, null = cleared, string = set.
 */
export interface ReviseGoalInput {
  goalId: string;
  title?: string;
  objective?: string;
  desiredState?: string;
  /** Replacement (wholesale), like the world module's attributes. */
  metrics?: GoalMetricInput[];
  horizonStart?: string | null;
  horizonEnd?: string;
  owner?: GoalOwnerInput;
  priority?: GoalPriority;
  /** Replacement (wholesale). */
  evidenceSources?: GoalEvidenceSourceInput[];
  successCriteria?: string;
  /** Lifecycle transition; must be the ONLY changed field when present. */
  status?: GoalStatus;
  /** Who is making this change (audit trail). */
  actor: GoalActorInput;
  /** Why — optional, recorded on the new version. */
  rationale?: string | null;
}

/** Metric input (`unit` and the unused bounds default to null). */
export interface GoalMetricInput {
  name: string;
  unit?: string | null;
  direction: GoalMetricDirection;
  threshold?: number | null;
  lowerBound?: number | null;
  upperBound?: number | null;
}

export interface GoalOwnerInput {
  kind: GoalPartyKind;
  id?: string | null;
  label?: string | null;
}

export interface GoalActorInput {
  kind: GoalPartyKind;
  id?: string | null;
  label?: string | null;
}

export interface GoalEvidenceSourceInput {
  kind: GoalEvidenceSourceKind;
  id?: string | null;
  label?: string | null;
}

/** One append-only version of a goal — the audit record (self-contained). */
export interface GoalVersion {
  /** Version-row id (distinct from the goal identity). */
  id: string;
  tenantId: string;
  goalId: string;
  /** 1-based, strictly increasing per goal; service-minted. */
  version: number;
  changeKind: GoalChangeKind;
  /** The full content snapshot this version asserts. */
  content: GoalContent;
  /** Who made this change (domain provenance). */
  actor: GoalActor;
  /** The authenticated TenantContext principal that committed the change. */
  changedByPrincipal: string;
  /** Why this change was made, if stated. */
  rationale: string | null;
  /** ISO 8601 — when Aurum committed this version (service clock). */
  recordedAt: string;
}

/**
 * The current view of a goal: identity + the current version's content and
 * audit summary. `version`/`updatedAt`/`lastChange` always reflect the
 * version `goals.current_version` points at.
 */
export interface Goal {
  id: string;
  tenantId: string;
  /** Current version number. */
  version: number;
  content: GoalContent;
  /** ISO 8601 — when the goal identity was created (version 1 commit). */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  updatedAt: string;
  /** Audit summary of the change that produced the current version. */
  lastChange: {
    kind: GoalChangeKind;
    actor: GoalActor;
    changedByPrincipal: string;
    rationale: string | null;
    recordedAt: string;
  };
}

/** Query shape of `getGoalVersion`. */
export interface GetGoalVersionQuery {
  goalId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listGoalVersions`. */
export interface ListGoalVersionsQuery {
  goalId: string;
}

/** Query shape of `listGoals` (over CURRENT versions only). */
export interface ListGoalsQuery {
  status?: GoalStatus;
  priority?: GoalPriority;
  ownerKind?: GoalPartyKind;
  /** Requires `ownerKind` (an id is meaningless without its kind). */
  ownerId?: string;
  /** Inclusive lower bound on horizon end ("due from"). */
  horizonEndFrom?: string;
  /** Inclusive upper bound on horizon end ("due by"). */
  horizonEndTo?: string;
  /** Case-insensitive substring on the goal title. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}
