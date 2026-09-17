// Public domain types of the agent-teams module (W023 — Agent Teams).
//
// W023 owns the TEAM actor of the agent workforce (ARCHITECTURE.md §15,
// frozen): "AgentTeam is a first-class organizational actor composed of
// agents with roles, topology, shared objectives, budget, escalation
// rules and team-level outcomes." Lock 22: "Agent and AgentTeam are
// organizational actors with explicit contracts, budgets, permissions
// and outcomes." ADR-0008: "AgentTeam is a first-class actor."
//
// The three halves of the W023 acceptance, kept distinct by the types:
//   * THE TEAM CONTRACT (versioned content) — `TeamContent` is WHAT the
//     team is: its member roster with per-member roles and reporting
//     lines (the topology), the shared objectives every member works
//     toward, the team budget envelope (integer minor units + ISO
//     currency, the house money convention), the escalation rules that
//     route trouble to a coordinator / the owner / management, and the
//     accountable owner principal. Content lives ONLY in append-only
//     version rows (`agent_team_versions`) — the goals/missions
//     discipline — so composition changes are auditable history, never
//     silent rewrites (§24 reconstructability).
//   * THE LIFECYCLE — `draft → active → dissolved`, with `active`
//     reachable only through the W009 authority gate (kind
//     'agent-recruitment', level EXECUTE — lock 23: "Agent recruitment
//     and termination obey policy/approval") and `dissolved` the
//     terminal retirement (kind 'agent-termination', EXECUTE). Terminal
//     states are dead ends: a returning need is a NEW team.
//   * TEAM OUTCOMES — `TeamOutcome` is the append-only, team-level
//     outcome record: what was achieved against which shared objective,
//     with the recorded assessment, provenance (actor + principal +
//     clock) and opaque evidence references. W024 (evaluation) and
//     W054 (capability outcome learning) consume these through this
//     contract; the learning module (W040) owns the general
//     expected-versus-realized measurement primitive for its subject
//     vocabulary — team outcomes are the team actor's own record of
//     what its work produced, deliberately free of W040's numeric
//     measurement model (no silent overlap with a delivered module).
//
// Member agents are opaque forward references to agents module (W021)
// records: no cross-module foreign keys (the missions module's
// affected-goals precedent), validated readable through the agents
// contract at write time. Execution stays with the W021 gateway — this
// module composes agents into an organizational actor; it does not
// dispatch work (W024+ layer evaluation and routing on top).

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the migrations' CHECK constraints)
// ---------------------------------------------------------------------------

/**
 * How the roster coordinates (the topology half of "roles, topology"):
 *  * `flat`        — peers with NO reporting lines; every member is a
 *    root, so escalation must route to the owner or management;
 *  * `hierarchical` — a single coordinator (the one root member) with a
 *    reporting tree; members may escalate up their reporting line.
 */
export type TeamTopology = 'flat' | 'hierarchical';

/** Lifecycle states of a team (§15's RETAIN/MODIFY/TERMINATE map to revise/dissolve). */
export type TeamStatus = 'draft' | 'active' | 'dissolved';

/** What kind of change appended one version to the audit chain. */
export type TeamChangeKind = 'created' | 'revised' | 'activated' | 'dissolved';

/**
 * What triggers one escalation rule:
 *  * `member-failure`   — a member fails its assignment; the integer
 *    threshold is the tolerated number of failures before escalating;
 *  * `budget-threshold` — team spend crosses the given fraction (0, 1]
 *    of the budget envelope;
 *  * `authority-gap`    — a needed action exceeds the team's authority;
 *    never has a threshold.
 */
export type EscalationTrigger = 'member-failure' | 'budget-threshold' | 'authority-gap';

/** Where an escalation lands. */
export type EscalationRoute = 'coordinator' | 'owner' | 'management';

/** The recorded verdict of one team outcome (a recorded judgment, not a derived value). */
export type OutcomeAssessment = 'met' | 'partial' | 'missed';

/** Provider-neutral party vocabulary (the missions/goals actor discipline). */
export type TeamPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

// ---------------------------------------------------------------------------
// Content shapes (the team contract)
// ---------------------------------------------------------------------------

/**
 * One roster member: WHICH agent fills the slot, its ROLE on the team
 * and — for hierarchical topologies — the member it reports to. Agent
 * ids are opaque references to agents module (W021) definitions,
 * validated readable through that contract at write time; a member
 * appears at most once per roster.
 */
export interface TeamMember {
  agentId: string;
  /** The member's role on the team (free-form, 1..128 chars). */
  role: string;
  /** The agent this member reports to (hierarchical only); null = root/peer. */
  reportsTo: string | null;
}

/**
 * One shared objective: the stable `key` outcomes reference, the
 * objective statement and optional success criteria. Keys are unique
 * per roster; a team carries at least one objective (a team without a
 * shared objective is not a team).
 */
export interface TeamObjective {
  key: string;
  objective: string;
  successCriteria: string | null;
}

/** The team budget envelope — integer minor units + ISO currency (§8 convention). */
export interface TeamBudget {
  amountMinor: number;
  currency: string;
}

/**
 * One escalation rule: a trigger (with its threshold where the trigger
 * is thresholded) and the route the escalation takes. Rules are part of
 * the versioned content — changing the escalation policy of a team is
 * an auditable revision, never a silent config edit.
 */
export interface TeamEscalationRule {
  trigger: EscalationTrigger;
  /** Failures tolerated (int ≥ 1) / budget fraction in (0, 1]; null for 'authority-gap'. */
  threshold: number | null;
  route: EscalationRoute;
}

/** The full versioned team contract — WHAT the team is. */
export interface TeamContent {
  displayName: string | null;
  description: string | null;
  topology: TeamTopology;
  members: TeamMember[];
  objectives: TeamObjective[];
  budget: TeamBudget;
  escalationRules: TeamEscalationRule[];
  /** The accountable human principal; escalations routed to 'owner' require it. */
  ownerPrincipal: string | null;
}

// ---------------------------------------------------------------------------
// Provenance (the audit quartet's who)
// ---------------------------------------------------------------------------

/** A provider-neutral acting party (opaque id and/or label — traceable). */
export interface TeamParty {
  kind: TeamPartyKind;
  id: string | null;
  label: string | null;
}

/** One opaque evidence reference on a team outcome (kind + id and/or label). */
export interface TeamEvidenceRef {
  kind: string;
  id?: string | null;
  label?: string | null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** The audit summary of the change that produced one version. */
export interface TeamLastChange {
  kind: TeamChangeKind;
  actor: TeamParty;
  changedByPrincipal: string;
  rationale: string | null;
  /** The authority-gate request that decided this transition; null on content versions. */
  actionRequestId: string | null;
  recordedAt: string;
}

/** The current view of a team: identity + current version's content + status. */
export interface Team {
  id: string;
  tenantId: string;
  /** Stable identity, unique per tenant; not revisable. */
  slug: string;
  /** The current version number of the audit chain. */
  version: number;
  content: TeamContent;
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
  lastChange: TeamLastChange;
}

/** One append-only audit record of the team's version chain. */
export interface TeamVersion {
  id: string;
  tenantId: string;
  teamId: string;
  version: number;
  changeKind: TeamChangeKind;
  content: TeamContent;
  status: TeamStatus;
  actor: TeamParty;
  changedByPrincipal: string;
  rationale: string | null;
  actionRequestId: string | null;
  recordedAt: string;
}

/** One append-only team-level outcome record. */
export interface TeamOutcome {
  id: string;
  tenantId: string;
  teamId: string;
  /** Which shared objective this outcome measures; null = team-level overall. */
  objectiveKey: string | null;
  headline: string;
  detail: string | null;
  assessment: OutcomeAssessment;
  evidence: TeamEvidenceRef[];
  actor: TeamParty;
  recordedByPrincipal: string;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface TeamMemberInput {
  agentId: string;
  role: string;
  /** Omitted = null (root/peer). */
  reportsTo?: string | null;
}

export interface TeamObjectiveInput {
  key: string;
  objective: string;
  /** Omitted = null. */
  successCriteria?: string | null;
}

export interface TeamEscalationRuleInput {
  trigger: EscalationTrigger;
  /** Required for thresholded triggers; must be null/omitted for 'authority-gap'. */
  threshold?: number | null;
  route: EscalationRoute;
}

export interface TeamPartyInput {
  kind: TeamPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `createTeam` (version 1, status 'draft'). */
export interface CreateTeamInput {
  slug: string;
  displayName?: string | null;
  description?: string | null;
  topology: TeamTopology;
  /** 1..32 members; each agentId must be readable through the agents contract. */
  members: TeamMemberInput[];
  /** 1..25 shared objectives. */
  objectives: TeamObjectiveInput[];
  budget: TeamBudget;
  /** 0..16 rules; defaults to none. */
  escalationRules?: TeamEscalationRuleInput[];
  ownerPrincipal?: string | null;
  /** Acting party recorded on version 1; defaults to the calling principal. */
  actor?: TeamPartyInput;
  rationale?: string | null;
}

/**
 * Input shape of `reviseTeam` — a PATCH against the current version:
 * omitted fields carry over unchanged; present fields replace (arrays
 * wholesale). Text/owner fields are tri-state: omitted = unchanged,
 * null = cleared, string = set. There is deliberately NO `status` and
 * NO `slug` in a revision: lifecycle transitions are the dedicated
 * gated operations, and slug is stable identity.
 */
export interface ReviseTeamInput {
  teamId: string;
  displayName?: string | null;
  description?: string | null;
  topology?: TeamTopology;
  members?: TeamMemberInput[];
  objectives?: TeamObjectiveInput[];
  budget?: TeamBudget;
  escalationRules?: TeamEscalationRuleInput[];
  ownerPrincipal?: string | null;
  actor?: TeamPartyInput;
  rationale?: string | null;
}

/**
 * Input shape of `activateTeam` (draft → active). `idempotencyKey` is
 * optional but load-bearing for the gated flow: the authority matrix's
 * built-in default gates EXECUTE behind human approval, so activation
 * typically sits `pending`; re-invoking with the SAME key after the
 * approval replays the original gate request (now approved) and
 * applies. The key also makes a crash-retry replay the already-applied
 * outcome instead of failing.
 */
export interface ActivateTeamInput {
  teamId: string;
  idempotencyKey?: string | null;
}

/** Input shape of `dissolveTeam` (draft|active → dissolved, terminal). */
export interface DissolveTeamInput {
  teamId: string;
  /** Required — terminal transitions record their why. */
  reason: string;
  idempotencyKey?: string | null;
}

/** What `createTeam` returns — `created` is false when the slug already stood. */
export interface CreateTeamResult {
  team: Team;
  created: boolean;
}

/**
 * What `activateTeam` / `dissolveTeam` return. `applied` is false
 * exactly when the authority gate routed the request to `pending` —
 * the team is unchanged, the gate request id is returned, and a later
 * re-invocation (same idempotency key) completes the transition once a
 * human approves (the extensions module's gate-result shape).
 */
export interface TeamTransitionResult {
  team: Team;
  applied: boolean;
  gate: {
    actionRequestId: string;
    status: 'pending' | 'approved' | 'rejected';
  };
}

/** Query shape of `getTeam` (exactly one of teamId / slug). */
export interface GetTeamQuery {
  teamId?: string;
  slug?: string;
}

/** Query shape of `listTeams`. */
export interface ListTeamsQuery {
  status?: TeamStatus;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listTeamVersions`. */
export interface ListTeamVersionsQuery {
  teamId: string;
}

/** Input shape of `recordTeamOutcome`. */
export interface RecordTeamOutcomeInput {
  teamId: string;
  /** Must exist in the CURRENT version's objectives when given. */
  objectiveKey?: string | null;
  /** The outcome statement (1..200 chars). */
  headline: string;
  detail?: string | null;
  assessment: OutcomeAssessment;
  /** Opaque evidence references (0..32). */
  evidence?: TeamEvidenceRef[];
  /** Acting party; defaults to the calling principal. */
  actor?: TeamPartyInput;
}

/** Query shape of `listTeamOutcomes`. */
export interface ListTeamOutcomesQuery {
  teamId: string;
  objectiveKey?: string;
  /** 1..500, default 50. */
  limit?: number;
}
