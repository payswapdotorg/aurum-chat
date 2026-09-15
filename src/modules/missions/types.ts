// Public domain types of the missions module (W011 — Learning Missions).
//
// A LearningMission is a persistent objective for acquiring knowledge
// required by a goal, decision, risk or opportunity (ARCHITECTURE.md §6,
// lock 8: "LearningMission is first-class and is goal/decision-driven"). It
// is the loop's investment vehicle: the tenant declares WHAT knowledge is
// missing (the knowledge objective), WHY it matters (affected goals,
// expected information value, urgency), HOW SURE it needs to become
// (current → target confidence), WHAT IT MAY COST (investigation budget,
// reward budget), WHERE the knowledge may come from (candidate sources and
// people) and WHEN IT IS DONE (completion criteria).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W011):
// "Implement first-class missions with knowledge objective, affected goals,
//  information value, urgency, target confidence, budget, candidate
//  sources/people, rewards and completion criteria."
//
// Like a goal (W008), a mission is deliberately NOT a belief (epistemics
// W007) and NOT evidence (observations W004): it is planned work. And like
// a goal, every field above is VERSIONED CONTENT — a mission is an identity
// (uuid) plus an append-only chain of full-snapshot versions
// (mission_versions). Refining a mission appends the next version; history
// is never rewritten; every version records the audit quartet (actor,
// recorded_at, change_kind + full content, why) so mission changes are
// auditable like goal changes. Acquisition itself (W012) and the cognitive
// loop that drives it (W013) reference missions through THIS module's
// contract only.
//
// Provider neutrality (lock 16): actors, candidate people and candidate
// sources are opaque references — kind + uuid id and/or human label —
// owned by their respective modules (people W002, world W005, sources
// W036, agents W021+). Affected goals are opaque forward references to
// goals module (W008) records for the same reason: the module dependency
// map sanctions `world + epistemics → missions` only, so missions imports
// no goals contract and creates no cross-module foreign keys — the goals
// module's own evidence-source precedent. Unknown references are the one
// deliberately validated cross-module link (the sanctioned epistemics
// dependency): they are checked through the epistemics contract at write
// time, exactly like epistemics checks observations.

/** How urgently the knowledge is needed (TEXT + CHECK in storage). */
export type MissionUrgency = 'critical' | 'high' | 'medium' | 'low';

/**
 * Lifecycle of a mission. Lifecycle changes are VERSIONED content like
 * every other field: completing/abandoning appends a surgical version, so
 * lifecycle changes are auditable too.
 *
 * Both terminal states are deliberate dead ends — a mission is a bounded
 * investigation, not a long-lived direction (goals W008 reactivate because
 * goals ARE direction). If the need for the knowledge returns, a NEW
 * mission is defined (possibly referencing the same unknowns); the
 * completed/abandoned mission stays as it was recorded, which is what
 * keeps mission resolution measurable (W055: "mission resolution
 * efficiency") and the audit trail honest.
 */
export type MissionStatus = 'active' | 'completed' | 'abandoned';

/**
 * What kind of change one mission version represents — service-minted,
 * never caller-supplied:
 *  * 'created'    — version 1 (the mission definition);
 *  * 'revised'   — content change on an active mission;
 *  * 'completed' — the one-way active → completed transition;
 *  * 'abandoned' — the one-way active → abandoned transition.
 */
export type MissionChangeKind = 'created' | 'revised' | 'completed' | 'abandoned';

/** Kinds of parties that can create, revise or resolve a mission. */
export type MissionPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * The kinds of knowledge candidates a mission may name (§6 "candidate
 * evidence sources; candidate employees/managers; candidate systems and
 * external sources" + §7's acquisition menu "employees, managers, internal
 * systems, documents, messages, structured business systems, external
 * sources, agents and temporary analyses"). `person` covers employees and
 * managers (the people module's person records); `analysis` covers
 * temporary analyses Aurum may run; the W012 planner chooses among these
 * — this module only records the candidates.
 */
export type MissionCandidateKind =
  | 'person'
  | 'system'
  | 'document'
  | 'external'
  | 'agent'
  | 'analysis';

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module (people for `person`, world for `team`, agents
 * for `agent`), a human-readable `label`, or both. At least one must be
 * present — the party making a mission change must be traceable.
 */
export interface MissionParty {
  kind: MissionPartyKind;
  id?: string | null;
  label?: string | null;
}

/** The party that made one mission change (`MissionParty`). */
export type MissionActor = MissionParty;

/**
 * One affected-goal reference (§6 "affected goals/decisions"): an opaque
 * uuid forward reference to a goals module (W008) record, plus an
 * optional human label. The id is the traceable part; the goals module
 * stays the owner and the verification point (no cross-module FK, no
 * contract import — the goals module's own evidence-source precedent).
 */
export interface MissionGoalRef {
  goalId: string;
  label?: string | null;
}

/**
 * One candidate knowledge source of a mission: a provider-neutral kind
 * plus an opaque uuid `id` and/or a human-readable `label` (at least one —
 * a candidate must be traceable). Candidate refs are deliberately
 * unverified here: the W012 planner validates routes them when it drives
 * acquisition.
 */
export interface MissionCandidate {
  kind: MissionCandidateKind;
  id?: string | null;
  label?: string | null;
}

/**
 * A mission budget (§6 "investigation budget" / "reward budget"): an
 * integer amount in MINOR UNITS of `currency` (IMPLEMENTATION-STACK §8:
 * money as integer minor units + ISO currency code), 0 = nothing may be
 * spent/offered.
 */
export interface MissionBudget {
  amount: number;
  currency: string;
}

/** Input shape of `MissionBudget` (same fields). */
export interface MissionBudgetInput {
  amount: number;
  currency: string;
}

/**
 * The completion record of a mission (§6 "outcome"): the confidence
 * actually achieved when the mission was declared complete, plus what was
 * learned. Recorded once, on the surgical 'completed' version — never on
 * any other version.
 */
export interface MissionCompletion {
  achievedConfidence: number;
  outcome: string | null;
}

/** Input shape of `MissionCompletion` (outcome required on completion). */
export interface MissionCompletionInput {
  achievedConfidence: number;
  outcome: string | null;
}

/**
 * The full versioned content of a mission — everything §6/W011 puts in a
 * mission definition. Identical shape on create input, on every stored
 * version and on reads, so any version is self-contained.
 */
export interface MissionContent {
  /** Short human name, e.g. "Churn root cause". */
  title: string;
  /** The knowledge objective: the question this mission exists to answer (§6). */
  knowledgeObjective: string;
  /** Goals this mission serves (opaque forward references to W008 records). */
  affectedGoals: MissionGoalRef[];
  /**
   * Epistemic unknowns (W007) this mission closes — validated readable
   * through the epistemics contract at write time. May be empty: a
   * mission may target knowledge not yet formalized as an unknown
   * (e.g. a management-requested investigation).
   */
  unknownIds: string[];
  /** Expected information value, a comparable score in [0, 1]. */
  informationValue: number;
  urgency: MissionUrgency;
  /** Current confidence in the answer at this version; starts at 0. */
  currentConfidence: number;
  /** The confidence the mission aims to reach; always > currentConfidence. */
  targetConfidence: number;
  /** What may be spent acquiring the knowledge (minor units + currency). */
  investigationBudget: MissionBudget;
  /** What may be rewarded for qualifying contributions (minor units + currency). */
  rewardBudget: MissionBudget;
  /** What is promised for a qualifying contribution, when stated (§8/W043 reads this). */
  rewardTerms: string | null;
  /** Where the knowledge may come from; the W012 planner's menu. */
  candidateSources: MissionCandidate[];
  /** What constitutes "done" (§6 "completion criteria"). */
  completionCriteria: string;
  /** Lifecycle status (always 'active' on creation; versioned afterwards). */
  status: MissionStatus;
}

/** Input shape of `createMission` (status is minted 'active'). */
export interface CreateMissionInput {
  title: string;
  knowledgeObjective: string;
  /** Defaults to `[]`. Replacement semantics (a whole reference set). */
  affectedGoals?: MissionGoalRefInput[];
  /** Defaults to `[]`; validated through the epistemics contract. */
  unknownIds?: string[];
  informationValue: number;
  urgency: MissionUrgency;
  /** Defaults to 0 (nothing known). */
  currentConfidence?: number;
  targetConfidence: number;
  investigationBudget: MissionBudgetInput;
  rewardBudget: MissionBudgetInput;
  /** Optional; tri-state on revisions. */
  rewardTerms?: string | null;
  /** Defaults to `[]`. */
  candidateSources?: MissionCandidateInput[];
  completionCriteria: string;
  /** Who is defining the mission (audit trail, version 1). */
  actor: MissionActorInput;
  /** Why — optional, recorded on version 1. */
  rationale?: string | null;
}

/**
 * Input shape of `reviseMission` — a PATCH against the current version:
 * omitted fields carry over unchanged; present fields replace (arrays
 * wholesale). There is deliberately NO `status` in a revision: lifecycle
 * transitions are the dedicated `completeMission` / `abandonMission`
 * operations, which append surgical versions carrying structured
 * completion/abandonment data. `rewardTerms` is tri-state: omitted =
 * unchanged, null = cleared, string = set.
 */
export interface ReviseMissionInput {
  missionId: string;
  title?: string;
  knowledgeObjective?: string;
  /** Replacement (wholesale). */
  affectedGoals?: MissionGoalRefInput[];
  /** Replacement (wholesale); validated through the epistemics contract. */
  unknownIds?: string[];
  informationValue?: number;
  urgency?: MissionUrgency;
  currentConfidence?: number;
  targetConfidence?: number;
  investigationBudget?: MissionBudgetInput;
  rewardBudget?: MissionBudgetInput;
  /** Tri-state: omitted = unchanged, null = cleared, string = set. */
  rewardTerms?: string | null;
  /** Replacement (wholesale). */
  candidateSources?: MissionCandidateInput[];
  completionCriteria?: string;
  /** Who is making this change (audit trail). */
  actor: MissionActorInput;
  /** Why — optional, recorded on the new version. */
  rationale?: string | null;
}

/** Input shape of `completeMission` (the active → completed transition). */
export interface CompleteMissionInput {
  missionId: string;
  /**
   * The confidence actually achieved — the mission's final current
   * confidence, recorded on the surgical completion version. May be at,
   * above or below targetConfidence: criteria may be qualitative and the
   * completion is the caller's (policy-gated) assertion; W040/W055
   * compare expected versus realized from exactly this record.
   */
  achievedConfidence: number;
  /** What was learned — the mission's outcome summary (required). */
  outcome: string;
  actor: MissionActorInput;
}

/** Input shape of `abandonMission` (the active → abandoned transition). */
export interface AbandonMissionInput {
  missionId: string;
  /** Required: why the mission is being abandoned — terminal transitions record their why. */
  reason: string;
  actor: MissionActorInput;
}

export interface MissionGoalRefInput {
  goalId: string;
  label?: string | null;
}

export interface MissionCandidateInput {
  kind: MissionCandidateKind;
  id?: string | null;
  label?: string | null;
}

export interface MissionActorInput {
  kind: MissionPartyKind;
  id?: string | null;
  label?: string | null;
}

/** One append-only version of a mission — the audit record (self-contained). */
export interface MissionVersion {
  /** Version-row id (distinct from the mission identity). */
  id: string;
  tenantId: string;
  missionId: string;
  /** 1-based, strictly increasing per mission; service-minted. */
  version: number;
  changeKind: MissionChangeKind;
  /** The full content snapshot this version asserts. */
  content: MissionContent;
  /** The completion record; present on 'completed' versions only. */
  completion: MissionCompletion | null;
  /** Who made this change (domain provenance). */
  actor: MissionActor;
  /** The authenticated TenantContext principal that committed the change. */
  changedByPrincipal: string;
  /** Why this change was made, if stated (abandonment reasons live here). */
  rationale: string | null;
  /** ISO 8601 — when Aurum committed this version (service clock). */
  recordedAt: string;
}

/**
 * The current view of a mission: identity + the current version's content
 * and audit summary. `version`/`updatedAt`/`lastChange` always reflect
 * the version `missions.current_version` points at.
 */
export interface Mission {
  id: string;
  tenantId: string;
  /** Current version number. */
  version: number;
  content: MissionContent;
  /** The completion record; non-null only once the mission is completed. */
  completion: MissionCompletion | null;
  /** ISO 8601 — when the mission identity was created (version 1 commit). */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  updatedAt: string;
  /** Audit summary of the change that produced the current version. */
  lastChange: {
    kind: MissionChangeKind;
    actor: MissionActor;
    changedByPrincipal: string;
    rationale: string | null;
    recordedAt: string;
  };
}

/** Query shape of `getMissionVersion`. */
export interface GetMissionVersionQuery {
  missionId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listMissionVersions`. */
export interface ListMissionVersionsQuery {
  missionId: string;
}

/** Query shape of `listMissions` (over CURRENT versions only). */
export interface ListMissionsQuery {
  status?: MissionStatus;
  urgency?: MissionUrgency;
  /** Missions whose affected goals include this goals-module record id. */
  affectedGoalId?: string;
  /** Missions closing this epistemics unknown. */
  unknownId?: string;
  /** Filter by candidate kind; `candidateId` requires this. */
  candidateKind?: MissionCandidateKind;
  /** Requires `candidateKind` (an id is meaningless without its kind). */
  candidateId?: string;
  /** Case-insensitive substring on title or knowledge objective. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}
