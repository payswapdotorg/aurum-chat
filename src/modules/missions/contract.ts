// ============================================================================
// missions — the ONLY public surface of the missions module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W011 — Learning Missions:
// "Implement first-class missions with knowledge objective, affected goals,
//  information value, urgency, target confidence, budget, candidate
//  sources/people, rewards and completion criteria."
//
// A LearningMission is the loop's knowledge-investment vehicle
// (ARCHITECTURE.md §6, lock 8): the tenant declares what knowledge is
// missing, why it matters, how sure it needs to become, what that may
// cost, where the knowledge may come from and when the mission is done.
// Mission planning chooses the next best information-gathering action
// rather than blindly querying every sources — that planner is W012; this
// module owns the mission records it plans over, and W013's cognition and
// W051's goal-gap discovery drive these operations through THIS contract
// only.
//
//   createMission     — define a mission: appends the identity row plus
//      version 1 ('created', status minted 'active').
//   reviseMission     — append the next version. Omitted fields carry over
//      unchanged; arrays replace wholesale; there is NO status in a
//      revision — lifecycle transitions are dedicated operations. The
//      merged snapshot passes the same validation as a fresh create
//      (including the confidence gap rule target > current).
//   completeMission   — the one-way active → completed transition: a
//      surgical version carrying the completion record (achieved
//      confidence + outcome). Terminal.
//   abandonMission    — the one-way active → abandoned transition: a
//      surgical version carrying a required reason. Terminal.
//   getMission        — the current view (identity + current version's
//      content + audit summary of the change that produced it).
//   getMissionVersion — one audit record (full self-contained snapshot).
//   listMissionVersions — the mission's audit trail, ascending by version.
//   listMissions      — current views, filtered (status, urgency, affected
//      goal, unknown, candidate source/person, title/objective search),
//      ordered by urgency rank.
//
// There is deliberately NO operation to update a version in place, delete a
// mission or rewrite history: missions are versioned and auditable —
// revising appends, completing/abandoning are terminal versioned
// transitions, and PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on
// mission_versions (and DELETE/TRUNCATE on missions) via migration 001
// triggers. Terminal states are dead ends by design: a mission is a
// bounded investigation, so a returning need is a NEW mission (see
// types.ts), which is what keeps mission resolution measurable (W055).
//
// Cross-module references: affected goals and candidate sources/people are
// opaque forward references owned by their modules (goals W008, people
// W002, world W005, sources W036, agents W021+) — no cross-module foreign
// keys, no contract imports (MODULE-DEPENDENCY-MAP.md sanctions
// `world + epistemics → missions`). Epistemic unknown references are the
// one validated cross-module link: they are checked readable through the
// epistemics contract at write time (create and unknown-changing
// revisions), exactly like epistemics checks observations.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's missions
// (including revisions, transitions and version lookups) is reported as
// `mission_not_found` / `mission_version_not_found` — no existence leak.
// ============================================================================

export {
  abandonMission,
  completeMission,
  createMission,
  getMission,
  getMissionVersion,
  listMissionVersions,
  listMissions,
  reviseMission,
} from './service';

export { MissionsError } from './errors';
export type { MissionsErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  MAX_AFFECTED_GOALS,
  MAX_BUDGET_AMOUNT,
  MAX_CANDIDATE_SOURCES,
  MAX_COMPLETION_CRITERIA_LENGTH,
  MAX_KNOWLEDGE_OBJECTIVE_LENGTH,
  MAX_LIST_LIMIT,
  MAX_PARTY_LABEL_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_REWARD_TERMS_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_UNKNOWN_REFS,
  MISSION_CANDIDATE_KINDS,
  MISSION_CHANGE_KINDS,
  MISSION_PARTY_KINDS,
  MISSION_STATUSES,
  MISSION_URGENCIES,
  escapeLike,
  isMissionCandidateKind,
  isMissionChangeKind,
  isMissionPartyKind,
  isMissionStatus,
  isMissionUrgency,
  isUuid,
} from './validation';

export type {
  ValidatedAbandonmentInput,
  ValidatedBudget,
  ValidatedCandidate,
  ValidatedCompletionInput,
  ValidatedCreateMissionInput,
  ValidatedGoalRef,
  ValidatedHistoryQuery,
  ValidatedListQuery,
  ValidatedMissionContent,
  ValidatedParty,
  ValidatedRevisionInput,
  ValidatedRevisionPatch,
  ValidatedVersionQuery,
} from './validation';

export type {
  AbandonMissionInput,
  CompleteMissionInput,
  CreateMissionInput,
  GetMissionVersionQuery,
  ListMissionVersionsQuery,
  ListMissionsQuery,
  Mission,
  MissionActor,
  MissionActorInput,
  MissionBudget,
  MissionBudgetInput,
  MissionCandidate,
  MissionCandidateInput,
  MissionCandidateKind,
  MissionChangeKind,
  MissionCompletion,
  MissionCompletionInput,
  MissionContent,
  MissionGoalRef,
  MissionGoalRefInput,
  MissionParty,
  MissionPartyKind,
  MissionStatus,
  MissionUrgency,
  MissionVersion,
  ReviseMissionInput,
} from './types';
