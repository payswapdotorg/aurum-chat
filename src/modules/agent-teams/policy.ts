// Pure team-policy logic of the agent-teams module (W023 — Agent
// Teams). No database, no context, no time — everything here is a
// total, deterministic function of its arguments (the actions module's
// matrix.ts / agents module's policy.ts discipline), so downstream
// modules (W024 evaluation, W054 capability outcome learning) can
// reason about team topology, escalation routing and lifecycle rules
// without a database.
//
// Three concerns live here, deliberately pure:
//
//  1. VOCABULARIES — the closed enums mirrored by the migrations'
//     CHECK constraints (topologies, statuses, change kinds, escalation
//     triggers/routes, outcome assessments, party kinds) plus the
//     administer-claim rule for the tenant's agent workforce.
//
//  2. TOPOLOGY — the structural validation of a roster (unique agents,
//     reporting-line membership, exactly one root for hierarchical
//     teams, no cycles) and the coordinator lookup (the root member a
//     'coordinator'-routed escalation lands on).
//
//  3. ESCALATION — the structural validation of the escalation rule
//     set against the topology and the owner (a coordinator route needs
//     a hierarchy to route up; an owner route needs an owner to land
//     on) and the per-trigger threshold rules.

// (No imports: this file is pure by design — see the header. The
// vocabularies are frozen by ARCHITECTURE.md §15 and pinned by tests.)

import type {
  TeamEscalationRule,
  TeamMember,
  TeamTopology,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** The coordination topologies a roster may take. */
export const TEAM_TOPOLOGIES = ['flat', 'hierarchical'] as const;

export type TeamTopologyWord = (typeof TEAM_TOPOLOGIES)[number];

export function isTeamTopology(value: unknown): value is TeamTopologyWord {
  return typeof value === 'string' && (TEAM_TOPOLOGIES as readonly string[]).includes(value);
}

/** The team lifecycle states. */
export const TEAM_STATUSES = ['draft', 'active', 'dissolved'] as const;

export type TeamStatusWord = (typeof TEAM_STATUSES)[number];

export function isTeamStatus(value: unknown): value is TeamStatusWord {
  return typeof value === 'string' && (TEAM_STATUSES as readonly string[]).includes(value);
}

/** The terminal (non-resumable) team states — history from then on. */
export const TEAM_TERMINAL_STATUSES = ['dissolved'] as const;

export function isTerminalTeamStatus(status: TeamStatusWord): boolean {
  return (TEAM_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** What kind of change appends a version. */
export const TEAM_CHANGE_KINDS = ['created', 'revised', 'activated', 'dissolved'] as const;

export type TeamChangeKindWord = (typeof TEAM_CHANGE_KINDS)[number];

export function isTeamChangeKind(value: unknown): value is TeamChangeKindWord {
  return typeof value === 'string' && (TEAM_CHANGE_KINDS as readonly string[]).includes(value);
}

/** The escalation trigger vocabulary. */
export const ESCALATION_TRIGGERS = [
  'member-failure',
  'budget-threshold',
  'authority-gap',
] as const;

export type EscalationTriggerWord = (typeof ESCALATION_TRIGGERS)[number];

export function isEscalationTrigger(value: unknown): value is EscalationTriggerWord {
  return typeof value === 'string' && (ESCALATION_TRIGGERS as readonly string[]).includes(value);
}

/** The escalation route vocabulary. */
export const ESCALATION_ROUTES = ['coordinator', 'owner', 'management'] as const;

export type EscalationRouteWord = (typeof ESCALATION_ROUTES)[number];

export function isEscalationRoute(value: unknown): value is EscalationRouteWord {
  return typeof value === 'string' && (ESCALATION_ROUTES as readonly string[]).includes(value);
}

/** The recorded verdicts of a team outcome. */
export const OUTCOME_ASSESSMENTS = ['met', 'partial', 'missed'] as const;

export type OutcomeAssessmentWord = (typeof OUTCOME_ASSESSMENTS)[number];

export function isOutcomeAssessment(value: unknown): value is OutcomeAssessmentWord {
  return typeof value === 'string' && (OUTCOME_ASSESSMENTS as readonly string[]).includes(value);
}

/** The provider-neutral party vocabulary (the missions/goals actor kinds). */
export const TEAM_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

export type TeamPartyKindWord = (typeof TEAM_PARTY_KINDS)[number];

export function isTeamPartyKind(value: unknown): value is TeamPartyKindWord {
  return typeof value === 'string' && (TEAM_PARTY_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Administration claim
// ---------------------------------------------------------------------------

/**
 * The authority claim that administers the tenant's agent WORKFORCE —
 * the agents module's claim ('agents:administer'), reused for teams:
 * minting or re-shaping organizational actors (agent definitions,
 * agent teams) is one management capability, not two. The string is
 * mirrored locally (the agents module's policy.ts mirrors the §20
 * level words the same way — a pure policy file imports nothing) and
 * PINNED by tests against the agents contract's exported constant, so
 * the two can never drift.
 */
export const AGENT_TEAMS_AUTHORITY_ADMINISTER = 'agents:administer';

/** May these authority claims administer the tenant's agent teams? */
export function canAdministerAgentTeams(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(AGENT_TEAMS_AUTHORITY_ADMINISTER);
}

// ---------------------------------------------------------------------------
// Topology (structural roster validation)
// ---------------------------------------------------------------------------

/** One structural problem found in a roster (a human-readable diagnosis). */
export interface TopologyProblem {
  /** The offending member's agent id, when the problem is member-local. */
  agentId?: string;
  problem: string;
}

/**
 * Validate a roster's structure against its topology — the pure heart
 * of "agent-team topology, roles":
 *  * a team is composed of AT LEAST ONE agent;
 *  * every agent appears at most once (one slot per agent);
 *  * `flat` rosters have NO reporting lines at all;
 *  * `hierarchical` rosters have EXACTLY ONE root (the coordinator),
 *    every reportsTo points at a roster member, nobody reports to
 *    themselves and the reporting lines form no cycle (every member
 *    walks up to the root).
 * Returns the first problem, or null when the roster is well-formed.
 */
export function topologyProblem(
  topology: TeamTopology,
  members: readonly TeamMember[],
): TopologyProblem | null {
  if (members.length === 0) {
    return { problem: 'an agent team is composed of at least one agent' };
  }

  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.agentId)) {
      return { agentId: member.agentId, problem: 'the agent appears twice in the roster' };
    }
    seen.add(member.agentId);
  }

  if (topology === 'flat') {
    for (const member of members) {
      if (member.reportsTo !== null) {
        return {
          agentId: member.agentId,
          problem: `a flat team has no reporting lines, but this member reports to '${member.reportsTo}'`,
        };
      }
    }
    return null;
  }

  // hierarchical
  let roots = 0;
  for (const member of members) {
    if (member.reportsTo === null) {
      roots += 1;
      continue;
    }
    if (member.reportsTo === member.agentId) {
      return { agentId: member.agentId, problem: 'the member reports to itself' };
    }
    if (!seen.has(member.reportsTo)) {
      return {
        agentId: member.agentId,
        problem: `the member reports to '${member.reportsTo}', which is not on the roster`,
      };
    }
  }
  if (roots !== 1) {
    return {
      problem: `a hierarchical team has exactly one coordinator (root member); this roster has ${roots}`,
    };
  }

  // Acyclicity: walk up from every member; every walk must terminate at
  // the root within members.length steps (a longer walk necessarily
  // revisits a node — a cycle).
  for (const member of members) {
    const visited = new Set<string>();
    let cursor: string | null = member.agentId;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        return { agentId: cursor, problem: 'the reporting lines form a cycle at this member' };
      }
      visited.add(cursor);
      if (visited.size > members.length) break; // unreachable guard; kept total
      const next = members.find((entry) => entry.agentId === cursor);
      cursor = next === undefined ? null : next.reportsTo;
    }
  }
  return null;
}

/**
 * The coordinator of a roster: the single root member of a
 * hierarchical team — where 'coordinator'-routed escalations land.
 * Null for flat teams (no coordinator exists).
 */
export function coordinatorOf(
  topology: TeamTopology,
  members: readonly TeamMember[],
): TeamMember | null {
  if (topology !== 'hierarchical') return null;
  return members.find((member) => member.reportsTo === null) ?? null;
}

// ---------------------------------------------------------------------------
// Escalation rules (structural validation)
// ---------------------------------------------------------------------------

/** One structural problem found in an escalation rule set. */
export interface EscalationProblem {
  /** The offending rule's index, when the problem is rule-local. */
  index?: number;
  problem: string;
}

/**
 * Validate an escalation rule set against the team it belongs to — the
 * pure heart of "escalation":
 *  * `member-failure` carries an integer threshold ≥ 1 (failures
 *    tolerated before escalating);
 *  * `budget-threshold` carries a fraction in (0, 1] of the envelope;
 *  * `authority-gap` carries NO threshold;
 *  * a `coordinator` route needs a hierarchical topology (a flat team
 *    has nobody to route up to);
 *  * an `owner` route needs an owner principal to land on;
 *  * exact duplicate rules are rejected (the same trigger, threshold
 *    and route twice says nothing twice).
 * Returns the first problem, or null when the rule set is well-formed.
 */
export function escalationProblem(
  rules: readonly TeamEscalationRule[],
  topology: TeamTopology,
  ownerPresent: boolean,
): EscalationProblem | null {
  const signatures = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    switch (rule.trigger) {
      case 'member-failure':
        if (
          rule.threshold === null ||
          !Number.isInteger(rule.threshold) ||
          rule.threshold < 1
        ) {
          return {
            index,
            problem: `a 'member-failure' escalation carries an integer failure threshold ≥ 1 (got '${String(rule.threshold)}')`,
          };
        }
        break;
      case 'budget-threshold':
        if (rule.threshold === null || !(rule.threshold > 0) || !(rule.threshold <= 1)) {
          return {
            index,
            problem: `a 'budget-threshold' escalation carries a fraction of the budget envelope in (0, 1] (got '${String(rule.threshold)}')`,
          };
        }
        break;
      case 'authority-gap':
        if (rule.threshold !== null) {
          return {
            index,
            problem: `an 'authority-gap' escalation carries no threshold (got '${String(rule.threshold)}')`,
          };
        }
        break;
    }
    if (rule.route === 'coordinator' && topology !== 'hierarchical') {
      return {
        index,
        problem: "a 'coordinator' escalation route needs a hierarchical team — a flat team has no coordinator",
      };
    }
    if (rule.route === 'owner' && !ownerPresent) {
      return {
        index,
        problem: "an 'owner' escalation route needs an owner principal on the team",
      };
    }
    const signature = `${rule.trigger}|${rule.threshold === null ? '~' : String(rule.threshold)}|${rule.route}`;
    if (signatures.has(signature)) {
      return { index, problem: 'the same escalation rule appears twice' };
    }
    signatures.add(signature);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

/** The largest integer minor-unit amount a JS number represents exactly. */
export const MAX_SAFE_MINOR = 9_007_199_254_740_991;

/** Is this a well-formed budget envelope (integer minor units + ISO-shaped currency)? */
export function isWellFormedBudget(budget: { amountMinor: number; currency: string }): boolean {
  return (
    Number.isInteger(budget.amountMinor) &&
    budget.amountMinor >= 0 &&
    budget.amountMinor <= MAX_SAFE_MINOR &&
    /^[A-Z]{3}$/.test(budget.currency)
  );
}
