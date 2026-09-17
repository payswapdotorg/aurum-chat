// ============================================================================
// agent-teams — the ONLY public surface of the agent-teams module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W023 — Agent Teams:
// "Create agent-team topology, roles, shared objectives, budgets,
//  escalation and team outcomes."
//
// ARCHITECTURE.md §15 (frozen): "AgentTeam is a first-class
// organizational actor composed of agents with roles, topology, shared
// objectives, budget, escalation rules and team-level outcomes."
// Lock 22: "Agent and AgentTeam are organizational actors with explicit
// contracts, budgets, permissions and outcomes." Lock 23: "Agent
// recruitment and termination obey policy/approval."
//
//   The team contract (versioned, auditable — the goals/missions
//   discipline): a team's identity is a stable slug on an identity row;
//   EVERYTHING the team is — the roster (member agents with per-member
//   ROLES and reporting lines = the TOPOLOGY), the SHARED OBJECTIVES
//   (keyed, referenced by outcomes), the team BUDGET envelope (integer
//   minor units + ISO currency) and the ESCALATION rules (thresholded
//   member-failure / budget-threshold triggers and the authority gap,
//   routed to the coordinator, the owner or management) — lives ONLY in
//   append-only full-snapshot version rows. createTeam mints version 1
//   as a 'draft'; reviseTeam appends the next version (omitted fields
//   carry over, arrays replace wholesale; merged content re-validates
//   like a fresh create). There is deliberately NO operation to update
//   a version in place, rewrite history or erase a team: composition
//   changes are auditable (§24), and PostgreSQL itself rejects
//   UPDATE/DELETE/TRUNCATE on versions and DELETE/TRUNCATE on
//   identities (migrations/001 triggers).
//
//   The gated lifecycle (lock 23 — the extensions module's
//   transition shape): activateTeam (draft → active) routes through the
//   W009 authority matrix as an 'agent-recruitment' EXECUTE — a team is
//   recruited as a unit, so the tenant's recruitment policy governs it;
//   dissolveTeam (draft|active → dissolved, terminal) routes as an
//   'agent-termination' EXECUTE with a required reason. The built-in
//   default gates EXECUTE behind human approval: a transition typically
//   returns applied:false with a pending gate request, and re-invoking
//   with the SAME idempotency key after decideApproval replays the gate
//   (now approved) and applies. Policy rejections are loud
//   ('forbidden_by_policy'); the applied transition appends a surgical
//   version carrying the gate's action request id. Activation also
//   enforces the compose-time liveness invariant: every member agent
//   must currently be ACTIVE.
//
//   Team outcomes (append-only evidence): recordTeamOutcome appends a
//   team-level outcome — headline, optional detail, the recorded
//   assessment (met/partial/missed), the shared objective it measures
//   (validated against the CURRENT version) and opaque evidence
//   references. Any tenant member may record outcomes (evidence
//   recording is not administration — the learning module's outcome
//   discipline); nothing may rewrite or erase one. W024 evaluation and
//   W054 capability outcome learning consume these through this
//   contract; the learning module (W040) owns the general
//   expected-versus-realized measurement primitive for its own subject
//   vocabulary — team outcomes deliberately do not duplicate it.
//
//   Reads: getTeam (by id or slug), listTeams (status filter), the
//   version audit trail (listTeamVersions) and the outcome timeline
//   (listTeamOutcomes, objective filter). teamCoordinator is the pure
//   derived view of where coordinator-routed escalations land.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's teams,
// versions and outcomes are indistinguishable from missing ones — no
// existence leak.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W022 → W023;
// MODULE-DEPENDENCY-MAP.md: `agents + extensions → marketplace` puts
// agent-teams in the L4 capability-workforce layer beside `agents`):
// the W022 sequencing predecessor owns AgentRecruitmentProposal (the
// train/reassign/hire/automate/recruit/install DECISION aid) and is
// not present at this base; the functional dependency of team
// composition is the agents module (W021, delivered) — member agent
// ids are validated readable through the agents contract at write time
// and checked active at activation — plus the actions module (W009)
// for the authority gates. Nothing else is imported; no cross-module
// foreign keys exist (the missions affected-goals precedent).
// ============================================================================

export {
  // The team contract (versioned content)
  createTeam,
  reviseTeam,
  // The gated lifecycle
  activateTeam,
  dissolveTeam,
  // Team outcomes (append-only evidence)
  listTeamOutcomes,
  recordTeamOutcome,
  // Reads + derived views
  getTeam,
  listTeams,
  listTeamVersions,
  teamCoordinator,
} from './service';

// Module-owned constants.
export {
  AGENT_TEAM_ACTIVATION_ACTION_KIND,
  AGENT_TEAM_DISSOLUTION_ACTION_KIND,
  AGENT_TEAM_AUTHORITY_LEVEL,
} from './service';

export type {
  ActivateTeamInput,
  CreateTeamInput,
  CreateTeamResult,
  DissolveTeamInput,
  GetTeamQuery,
  ListTeamOutcomesQuery,
  ListTeamsQuery,
  ListTeamVersionsQuery,
  OutcomeAssessment,
  RecordTeamOutcomeInput,
  ReviseTeamInput,
  Team,
  TeamBudget,
  TeamChangeKind,
  TeamContent,
  TeamEscalationRule,
  TeamEvidenceRef,
  TeamLastChange,
  TeamMember,
  TeamObjective,
  TeamOutcome,
  TeamParty,
  TeamPartyKind,
  TeamStatus,
  TeamTopology,
  TeamTransitionResult,
  TeamVersion,
} from './types';

// Pure vocabulary and team policy (no TenantContext needed).
export {
  AGENT_TEAMS_AUTHORITY_ADMINISTER,
  ESCALATION_ROUTES,
  ESCALATION_TRIGGERS,
  OUTCOME_ASSESSMENTS,
  TEAM_CHANGE_KINDS,
  TEAM_PARTY_KINDS,
  TEAM_STATUSES,
  TEAM_TERMINAL_STATUSES,
  TEAM_TOPOLOGIES,
  canAdministerAgentTeams,
  coordinatorOf,
  escalationProblem,
  isEscalationRoute,
  isEscalationTrigger,
  isOutcomeAssessment,
  isTeamChangeKind,
  isTeamPartyKind,
  isTeamStatus,
  isTeamTopology,
  isTerminalTeamStatus,
  isWellFormedBudget,
  topologyProblem,
} from './policy';

export type {
  EscalationRouteWord,
  EscalationTriggerWord,
  OutcomeAssessmentWord,
  TeamChangeKindWord,
  TeamPartyKindWord,
  TeamStatusWord,
  TeamTopologyWord,
} from './policy';

export { AgentTeamsError } from './errors';
export type { AgentTeamsErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  MAX_DESCRIPTION_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_ESCALATION_RULES,
  MAX_HEADLINE_CHARS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MEMBERS,
  MAX_OBJECTIVES,
  MAX_RATIONALE_CHARS,
  MAX_REASON_CHARS,
  MAX_ROLE_CHARS,
  MAX_SLUG_LENGTH,
  isUuid,
} from './validation';

export type {
  ValidatedBudget,
  ValidatedCreateTeamInput,
  ValidatedOutcomeInput,
  ValidatedParty,
  ValidatedReviseTeamInput,
  ValidatedTeamContent,
} from './validation';
