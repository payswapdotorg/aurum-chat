// Unit tests for the agent-teams module's pure logic (no database):
// the topology/status/change-kind/escalation/assessment/party
// vocabularies, the roster topology validation (the flat/hierarchical
// split, single-root and cycle rules), the coordinator lookup, the
// escalation rule validation (threshold rules, route landing spots,
// duplicates), the budget shape, the administer-claim rule (pinned
// against the agents contract's constant), and the full
// validation/normalization surface (create, revision patch, lifecycle
// inputs, outcomes, queries). Storage-level guarantees (append-only
// versions and outcomes, tenant scoping, the authority gates) are
// covered by agent-teams-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { AGENTS_AUTHORITY_ADMINISTER_CLAIM } from '@/modules/agents/contract';
import { AgentTeamsError } from '../errors';
import {
  AGENT_TEAMS_AUTHORITY_ADMINISTER,
  ESCALATION_ROUTES,
  ESCALATION_TRIGGERS,
  MAX_SAFE_MINOR,
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
} from '../policy';
import {
  assertAgentTeamsTenantContext,
  MAX_ESCALATION_RULES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MEMBERS,
  validateActivateTeamInput,
  validateCreateTeamInput,
  validateDissolveTeamInput,
  validateGetTeamQuery,
  validateListTeamOutcomesQuery,
  validateListTeamVersionsQuery,
  validateListTeamsQuery,
  validateRecordTeamOutcomeInput,
  validateReviseTeamInput,
  validateTeamContent,
} from '../validation';
import type { TeamEscalationRule, TeamMember } from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3f8e2a-2d5b-4e8a-9f3e-7a2b6c5d4e90';
const UUID_C = '2d4f8e2a-3e6b-4f8a-9f3e-7a2b6c5d4e91';

function expectCode(code: AgentTeamsError['code'], fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentTeamsError);
    expect((error as AgentTeamsError).code).toBe(code);
  }
}

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return { tenantId: newId(), principalId: newId(), authority: [], ...overrides };
}

/** Deterministic distinct uuid for a small integer (roster padding). */
function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** A minimal, fully valid member entry. */
function member(agentId: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return { agentId, role: 'worker', reportsTo: null, ...overrides };
}

/** A minimal, fully valid hierarchical roster (coordinator + one report). */
function hierarchicalRoster(): TeamMember[] {
  return [
    member(UUID_A, { role: 'coordinator' }),
    member(UUID_B, { reportsTo: UUID_A }),
  ];
}

/** A minimal, fully valid content record (all fields present). */
function validContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: 'Collections team',
    description: 'Chases overdue invoices',
    topology: 'hierarchical',
    members: hierarchicalRoster(),
    objectives: [
      {
        key: 'recovery-rate',
        objective: 'Recover 80% of overdue invoices within 30 days',
        successCriteria: 'Monthly recovery ratio ≥ 0.8',
      },
    ],
    budget: { amountMinor: 500_000, currency: 'USD' },
    escalationRules: [
      { trigger: 'member-failure', threshold: 2, route: 'coordinator' },
      { trigger: 'authority-gap', threshold: null, route: 'management' },
    ],
    ownerPrincipal: 'principal-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

describe('vocabularies (§15)', () => {
  it('declares the topologies', () => {
    expect([...TEAM_TOPOLOGIES]).toEqual(['flat', 'hierarchical']);
    for (const topology of TEAM_TOPOLOGIES) expect(isTeamTopology(topology)).toBe(true);
    expect(isTeamTopology('mesh')).toBe(false);
    expect(isTeamTopology('FLAT')).toBe(false);
  });

  it('declares the statuses and their terminal partition', () => {
    expect([...TEAM_STATUSES]).toEqual(['draft', 'active', 'dissolved']);
    for (const status of TEAM_STATUSES) expect(isTeamStatus(status)).toBe(true);
    expect(isTeamStatus('retired')).toBe(false);
    expect([...TEAM_TERMINAL_STATUSES]).toEqual(['dissolved']);
    expect(isTerminalTeamStatus('dissolved')).toBe(true);
    expect(isTerminalTeamStatus('active')).toBe(false);
    expect(isTerminalTeamStatus('draft')).toBe(false);
  });

  it('declares the change kinds', () => {
    expect([...TEAM_CHANGE_KINDS]).toEqual(['created', 'revised', 'activated', 'dissolved']);
    for (const kind of TEAM_CHANGE_KINDS) expect(isTeamChangeKind(kind)).toBe(true);
    expect(isTeamChangeKind('deleted')).toBe(false);
  });

  it('declares the escalation triggers and routes', () => {
    expect([...ESCALATION_TRIGGERS]).toEqual([
      'member-failure',
      'budget-threshold',
      'authority-gap',
    ]);
    expect([...ESCALATION_ROUTES]).toEqual(['coordinator', 'owner', 'management']);
    for (const trigger of ESCALATION_TRIGGERS) expect(isEscalationTrigger(trigger)).toBe(true);
    for (const route of ESCALATION_ROUTES) expect(isEscalationRoute(route)).toBe(true);
    expect(isEscalationTrigger('deadline')).toBe(false);
    expect(isEscalationRoute('human')).toBe(false);
  });

  it('declares the outcome assessments and party kinds', () => {
    expect([...OUTCOME_ASSESSMENTS]).toEqual(['met', 'partial', 'missed']);
    for (const assessment of OUTCOME_ASSESSMENTS) expect(isOutcomeAssessment(assessment)).toBe(true);
    expect(isOutcomeAssessment('exceeded')).toBe(false);
    expect([...TEAM_PARTY_KINDS]).toEqual(['person', 'team', 'agent', 'system', 'external']);
    for (const kind of TEAM_PARTY_KINDS) expect(isTeamPartyKind(kind)).toBe(true);
    expect(isTeamPartyKind('provider')).toBe(false);
  });

  it("pins the administer claim to the agents contract's constant", () => {
    // The claim is mirrored locally in policy.ts (pure file, no imports);
    // this pin keeps the mirror from ever drifting from the minting module.
    expect(AGENT_TEAMS_AUTHORITY_ADMINISTER).toBe(AGENTS_AUTHORITY_ADMINISTER_CLAIM);
    expect(AGENT_TEAMS_AUTHORITY_ADMINISTER).toBe('agents:administer');
  });

  it('applies the administer claim rule', () => {
    expect(canAdministerAgentTeams(['agents:administer'])).toBe(true);
    expect(canAdministerAgentTeams(['agents:administer', 'other'])).toBe(true);
    expect(canAdministerAgentTeams([])).toBe(false);
    expect(canAdministerAgentTeams(['actions:approve'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Topology validation (the pure heart of "topology, roles")
// ---------------------------------------------------------------------------

describe('topologyProblem', () => {
  it('accepts a flat roster of peers', () => {
    const roster = [member(UUID_A), member(UUID_B), member(UUID_C)];
    expect(topologyProblem('flat', roster)).toBeNull();
  });

  it('rejects an empty roster — a team is composed of agents', () => {
    expect(topologyProblem('flat', [])).toEqual({
      problem: 'an agent team is composed of at least one agent',
    });
    expect(topologyProblem('hierarchical', [])).not.toBeNull();
  });

  it('rejects a duplicate agent — one slot per agent', () => {
    const roster = [member(UUID_A), member(UUID_A, { role: 'other' })];
    const problem = topologyProblem('flat', roster);
    expect(problem).not.toBeNull();
    expect(problem!.agentId).toBe(UUID_A);
  });

  it('rejects reporting lines on a flat team', () => {
    const roster = [member(UUID_A), member(UUID_B, { reportsTo: UUID_A })];
    const problem = topologyProblem('flat', roster);
    expect(problem).not.toBeNull();
    expect(problem!.agentId).toBe(UUID_B);
  });

  it('accepts a hierarchical tree and finds its coordinator', () => {
    const roster = [
      member(UUID_A, { role: 'coordinator' }),
      member(UUID_B, { reportsTo: UUID_A }),
      member(UUID_C, { reportsTo: UUID_B }),
    ];
    expect(topologyProblem('hierarchical', roster)).toBeNull();
    expect(coordinatorOf('hierarchical', roster)?.agentId).toBe(UUID_A);
  });

  it('rejects a rootless hierarchical team', () => {
    const roster = [member(UUID_A, { reportsTo: UUID_B }), member(UUID_B, { reportsTo: UUID_A })];
    const problem = topologyProblem('hierarchical', roster);
    expect(problem).not.toBeNull();
    expect(problem!.problem).toContain('exactly one coordinator');
  });

  it('rejects a two-root hierarchical team', () => {
    const roster = [member(UUID_A), member(UUID_B), member(UUID_C, { reportsTo: UUID_A })];
    expect(topologyProblem('hierarchical', roster)?.problem).toContain('2');
  });

  it('rejects a self-report', () => {
    const roster = [member(UUID_A, { reportsTo: UUID_A })];
    expect(topologyProblem('hierarchical', roster)?.agentId).toBe(UUID_A);
  });

  it('rejects reporting to an agent outside the roster', () => {
    const roster = [member(UUID_A), member(UUID_B, { reportsTo: UUID_C })];
    const problem = topologyProblem('hierarchical', roster);
    expect(problem).not.toBeNull();
    expect(problem!.agentId).toBe(UUID_B);
  });

  it('rejects a cycle even when a root exists', () => {
    const roster = [
      member(UUID_A, { role: 'coordinator' }),
      member(UUID_B, { reportsTo: UUID_C }),
      member(UUID_C, { reportsTo: UUID_B }),
    ];
    const problem = topologyProblem('hierarchical', roster);
    expect(problem).not.toBeNull();
    expect(problem!.problem).toContain('cycle');
  });

  it('has no coordinator on a flat team', () => {
    expect(coordinatorOf('flat', [member(UUID_A)])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Escalation validation (the pure heart of "escalation")
// ---------------------------------------------------------------------------

describe('escalationProblem', () => {
  it('accepts a well-formed rule set', () => {
    const rules: TeamEscalationRule[] = [
      { trigger: 'member-failure', threshold: 3, route: 'coordinator' },
      { trigger: 'budget-threshold', threshold: 0.8, route: 'owner' },
      { trigger: 'authority-gap', threshold: null, route: 'management' },
    ];
    expect(escalationProblem(rules, 'hierarchical', true)).toBeNull();
  });

  it('accepts an empty rule set (no custom escalation policy)', () => {
    expect(escalationProblem([], 'flat', false)).toBeNull();
  });

  it('enforces the member-failure threshold shape', () => {
    for (const bad of [null, 0, -1, 1.5]) {
      const problem = escalationProblem(
        [{ trigger: 'member-failure', threshold: bad, route: 'management' }],
        'flat',
        false,
      );
      expect(problem).not.toBeNull();
      expect(problem!.index).toBe(0);
    }
    expect(
      escalationProblem([{ trigger: 'member-failure', threshold: 1, route: 'management' }], 'flat', false),
    ).toBeNull();
  });

  it('enforces the budget-threshold fraction', () => {
    for (const bad of [null, 0, -0.5, 1.0001]) {
      expect(
        escalationProblem([{ trigger: 'budget-threshold', threshold: bad, route: 'management' }], 'flat', false),
      ).not.toBeNull();
    }
    for (const good of [0.01, 0.5, 1]) {
      expect(
        escalationProblem([{ trigger: 'budget-threshold', threshold: good, route: 'management' }], 'flat', false),
      ).toBeNull();
    }
  });

  it('forbids a threshold on the authority gap', () => {
    expect(
      escalationProblem([{ trigger: 'authority-gap', threshold: 2, route: 'management' }], 'flat', false),
    )?.not.toBeNull();
    expect(
      escalationProblem([{ trigger: 'authority-gap', threshold: null, route: 'management' }], 'flat', false),
    ).toBeNull();
  });

  it("requires a hierarchy for the 'coordinator' route", () => {
    const problem = escalationProblem(
      [{ trigger: 'member-failure', threshold: 1, route: 'coordinator' }],
      'flat',
      false,
    );
    expect(problem?.problem).toContain('hierarchical');
    expect(
      escalationProblem([{ trigger: 'member-failure', threshold: 1, route: 'coordinator' }], 'hierarchical', false),
    ).toBeNull();
  });

  it("requires an owner for the 'owner' route", () => {
    const problem = escalationProblem(
      [{ trigger: 'budget-threshold', threshold: 1, route: 'owner' }],
      'flat',
      false,
    );
    expect(problem?.problem).toContain('owner principal');
    expect(
      escalationProblem([{ trigger: 'budget-threshold', threshold: 1, route: 'owner' }], 'flat', true),
    ).toBeNull();
  });

  it('rejects exact duplicate rules', () => {
    const rules: TeamEscalationRule[] = [
      { trigger: 'member-failure', threshold: 2, route: 'management' },
      { trigger: 'member-failure', threshold: 2, route: 'management' },
    ];
    expect(escalationProblem(rules, 'flat', false)?.problem).toContain('twice');
  });

  it('allows the same trigger with different thresholds or routes', () => {
    const rules: TeamEscalationRule[] = [
      { trigger: 'budget-threshold', threshold: 0.5, route: 'coordinator' },
      { trigger: 'budget-threshold', threshold: 0.9, route: 'management' },
    ];
    expect(escalationProblem(rules, 'hierarchical', false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Budget shape
// ---------------------------------------------------------------------------

describe('isWellFormedBudget', () => {
  it('accepts integer minor amounts with ISO-shaped currencies', () => {
    expect(isWellFormedBudget({ amountMinor: 0, currency: 'USD' })).toBe(true);
    expect(isWellFormedBudget({ amountMinor: MAX_SAFE_MINOR, currency: 'EUR' })).toBe(true);
  });

  it('rejects non-integer, negative, oversized or mis-currencied budgets', () => {
    expect(isWellFormedBudget({ amountMinor: 1.5, currency: 'USD' })).toBe(false);
    expect(isWellFormedBudget({ amountMinor: -1, currency: 'USD' })).toBe(false);
    expect(isWellFormedBudget({ amountMinor: MAX_SAFE_MINOR + 1, currency: 'USD' })).toBe(false);
    expect(isWellFormedBudget({ amountMinor: 1, currency: 'usd' })).toBe(false);
    expect(isWellFormedBudget({ amountMinor: 1, currency: 'US' })).toBe(false);
    expect(isWellFormedBudget({ amountMinor: 1, currency: 'USDD' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TenantContext shape
// ---------------------------------------------------------------------------

describe('assertAgentTeamsTenantContext', () => {
  it('accepts a well-formed context and rejects malformed ones', () => {
    expect(() => assertAgentTeamsTenantContext(context())).not.toThrow();
    expectCode('invalid_context', () => assertAgentTeamsTenantContext(null as unknown as TenantContext));
    expectCode('invalid_context', () =>
      assertAgentTeamsTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertAgentTeamsTenantContext({ tenantId: 't', principalId: '', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertAgentTeamsTenantContext({ tenantId: 't', principalId: 'p', authority: 'yes' as unknown as [] }),
    );
  });
});

// ---------------------------------------------------------------------------
// Content validation (the create/revise merge gate)
// ---------------------------------------------------------------------------

describe('validateTeamContent', () => {
  it('normalizes a fully valid content record', () => {
    const valid = validateTeamContent(validContent());
    expect(valid.topology).toBe('hierarchical');
    expect(valid.members).toHaveLength(2);
    expect(valid.objectives[0]!.key).toBe('recovery-rate');
    expect(valid.budget).toEqual({ amountMinor: 500_000, currency: 'USD' });
    expect(valid.escalationRules).toHaveLength(2);
    expect(valid.ownerPrincipal).toBe('principal-1');
  });

  it('rejects unknown content fields — callers cannot smuggle identity or state', () => {
    expectCode('invalid_team_input', () => validateTeamContent({ ...validContent(), id: UUID_A }));
    expectCode('invalid_team_input', () =>
      validateTeamContent({ ...validContent(), status: 'active' }),
    );
  });

  it('rejects a bad topology word', () => {
    expectCode('invalid_team_input', () => validateTeamContent(validContent({ topology: 'mesh' })));
  });

  it('requires members and objectives (a team is composed of agents working toward objectives)', () => {
    expectCode('invalid_team_input', () => validateTeamContent(validContent({ members: [] })));
    expectCode('invalid_team_input', () => validateTeamContent(validContent({ objectives: [] })));
  });

  it('caps the roster and the objective list', () => {
    const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, index) =>
      member(uuidFor(index)),
    );
    expectCode('invalid_team_input', () => validateTeamContent(validContent({ members: many })));
    expectCode('invalid_team_input', () =>
      validateTeamContent(
        validContent({
          objectives: Array.from({ length: 26 }, (_, index) => ({
            key: `objective-${index}`,
            objective: 'do the thing',
          })),
        }),
      ),
    );
  });

  it('rejects malformed member entries', () => {
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ members: [{ agentId: 'not-a-uuid', role: 'x' }] })),
    );
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ members: [{ agentId: UUID_A, role: '' }] })),
    );
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ members: [{ agentId: UUID_A, role: 'x', extra: 1 } as unknown] })),
    );
  });

  it('rejects duplicate or malformed objective keys', () => {
    expectCode('invalid_team_input', () =>
      validateTeamContent(
        validContent({
          objectives: [
            { key: 'same', objective: 'one' },
            { key: 'same', objective: 'two' },
          ],
        }),
      ),
    );
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ objectives: [{ key: 'Not A Key', objective: 'x' }] })),
    );
  });

  it('rejects malformed budgets (integer minor units + ISO currency)', () => {
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ budget: { amountMinor: -1, currency: 'USD' } })),
    );
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ budget: { amountMinor: 1.5, currency: 'USD' } })),
    );
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ budget: { amountMinor: 1, currency: 'dollars' } })),
    );
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ budget: { amountMinor: 1 } as unknown })),
    );
  });

  it('surfaces structural topology failures as input errors', () => {
    // The roster carries reporting lines but the topology says flat.
    expectCode('invalid_team_input', () => validateTeamContent(validContent({ topology: 'flat' })));
    // A hierarchical roster with no root (a two-member cycle).
    expectCode('invalid_team_input', () =>
      validateTeamContent(
        validContent({
          members: [member(UUID_A, { reportsTo: UUID_B }), member(UUID_B, { reportsTo: UUID_A })],
        }),
      ),
    );
  });

  it('rejects escalation rules with nowhere to land', () => {
    expectCode('invalid_team_input', () =>
      validateTeamContent(
        validContent({
          escalationRules: [{ trigger: 'member-failure', threshold: 1, route: 'owner' }],
          ownerPrincipal: null,
        }),
      ),
    );
    expectCode('invalid_team_input', () =>
      validateTeamContent(
        validContent({
          topology: 'flat',
          members: [member(UUID_A)],
          escalationRules: [{ trigger: 'member-failure', threshold: 1, route: 'coordinator' }],
        }),
      ),
    );
  });

  it('caps the escalation rule list', () => {
    const rules = Array.from({ length: MAX_ESCALATION_RULES + 1 }, () => ({
      trigger: 'authority-gap',
      route: 'management',
    }));
    expectCode('invalid_team_input', () =>
      validateTeamContent(validContent({ escalationRules: rules })),
    );
  });
});

// ---------------------------------------------------------------------------
// createTeam input
// ---------------------------------------------------------------------------

describe('validateCreateTeamInput', () => {
  function validCreate(): Record<string, unknown> {
    return { slug: 'collections-team', ...validContent() };
  }

  it('accepts and normalizes a fully valid creation', () => {
    const valid = validateCreateTeamInput(validCreate() as never);
    expect(valid.slug).toBe('collections-team');
    expect(valid.actor).toBeNull(); // service binds the calling principal
    expect(valid.content.topology).toBe('hierarchical');
  });

  it('rejects malformed slugs (and normalizes case, the house convention)', () => {
    for (const slug of ['', 'has space', '-leading', 'a'.repeat(65), 'ok/slash']) {
      expectCode('invalid_team_input', () =>
        validateCreateTeamInput({ ...validCreate(), slug } as never),
      );
    }
    // Uppercase slugs normalize to lowercase before the pattern check
    // (the agents module's convention).
    const normalized = validateCreateTeamInput({ ...validCreate(), slug: 'Collections-Team' } as never);
    expect(normalized.slug).toBe('collections-team');
  });

  it('rejects unknown top-level fields', () => {
    expectCode('invalid_team_input', () =>
      validateCreateTeamInput({ ...validCreate(), tenantId: 't' } as never),
    );
    expectCode('invalid_team_input', () =>
      validateCreateTeamInput({ ...validCreate(), version: 7 } as never),
    );
  });

  it('validates explicit actors (traceable parties)', () => {
    expectCode('invalid_team_input', () =>
      validateCreateTeamInput({ ...validCreate(), actor: { kind: 'wizard' } } as never),
    );
    expectCode('invalid_team_input', () =>
      validateCreateTeamInput({ ...validCreate(), actor: { kind: 'person' } } as never),
    );
    const valid = validateCreateTeamInput({
      ...validCreate(),
      actor: { kind: 'agent', label: 'cognition' },
    } as never);
    expect(valid.actor).toEqual({ kind: 'agent', id: null, label: 'cognition' });
  });
});

// ---------------------------------------------------------------------------
// reviseTeam input (patch semantics)
// ---------------------------------------------------------------------------

describe('validateReviseTeamInput', () => {
  it('accepts a patch and rejects empty revisions', () => {
    const valid = validateReviseTeamInput({ teamId: UUID_A, budget: { amountMinor: 1, currency: 'EUR' } } as never);
    expect(valid.teamId).toBe(UUID_A);
    expect(valid.patch.budget).toEqual({ amountMinor: 1, currency: 'EUR' });
    expectCode('invalid_team_input', () => validateReviseTeamInput({ teamId: UUID_A } as never));
  });

  it('keeps tri-state ownerPrincipal and displayName semantics', () => {
    const cleared = validateReviseTeamInput({ teamId: UUID_A, ownerPrincipal: null } as never);
    expect(cleared.patch.ownerPrincipal).toBeNull();
    const set = validateReviseTeamInput({ teamId: UUID_A, ownerPrincipal: 'p-2' } as never);
    expect(set.patch.ownerPrincipal).toBe('p-2');
    const absent = validateReviseTeamInput({ teamId: UUID_A, displayName: 'X' } as never);
    expect(absent.patch.ownerPrincipal).toBeUndefined();
  });

  it('rejects malformed team ids and status/slug smuggling', () => {
    expectCode('invalid_team_input', () =>
      validateReviseTeamInput({ teamId: 'nope', displayName: 'X' } as never),
    );
    expectCode('invalid_team_input', () =>
      validateReviseTeamInput({ teamId: UUID_A, slug: 'new-slug' } as never),
    );
    expectCode('invalid_team_input', () =>
      validateReviseTeamInput({ teamId: UUID_A, status: 'active' } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle inputs
// ---------------------------------------------------------------------------

describe('lifecycle input validation', () => {
  it('validates activation inputs', () => {
    expect(validateActivateTeamInput({ teamId: UUID_A }).idempotencyKey).toBeNull();
    expect(
      validateActivateTeamInput({ teamId: UUID_A, idempotencyKey: 'teams:activate:1' }).idempotencyKey,
    ).toBe('teams:activate:1');
    expectCode('invalid_team_input', () => validateActivateTeamInput({ teamId: 'nope' } as never));
    expectCode('invalid_team_input', () =>
      validateActivateTeamInput({ teamId: UUID_A, extra: true } as never),
    );
  });

  it('requires a dissolution reason and validates the shape', () => {
    expectCode('invalid_team_input', () =>
      validateDissolveTeamInput({ teamId: UUID_A } as never),
    );
    expectCode('invalid_team_input', () =>
      validateDissolveTeamInput({ teamId: UUID_A, reason: '' } as never),
    );
    expectCode('invalid_team_input', () =>
      validateDissolveTeamInput({ teamId: UUID_A, reason: 'x'.repeat(513) } as never),
    );
    const valid = validateDissolveTeamInput({ teamId: UUID_A, reason: 'objective met, disband' });
    expect(valid.reason).toBe('objective met, disband');
  });

  it('bounds the idempotency key shape', () => {
    expectCode('invalid_team_input', () =>
      validateActivateTeamInput({ teamId: UUID_A, idempotencyKey: 'has space' } as never),
    );
    expectCode('invalid_team_input', () =>
      validateActivateTeamInput({
        teamId: UUID_A,
        idempotencyKey: `x`.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
      } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// Outcome input
// ---------------------------------------------------------------------------

describe('validateRecordTeamOutcomeInput', () => {
  function validOutcome(): Record<string, unknown> {
    return {
      teamId: UUID_A,
      objectiveKey: 'recovery-rate',
      headline: 'Recovered 82% of overdue invoices in Q3',
      assessment: 'met',
      evidence: [{ kind: 'agent-execution', id: UUID_B }],
    };
  }

  it('accepts and normalizes a fully valid outcome', () => {
    const valid = validateRecordTeamOutcomeInput(validOutcome() as never);
    expect(valid.objectiveKey).toBe('recovery-rate');
    expect(valid.assessment).toBe('met');
    expect(valid.evidence).toEqual([{ kind: 'agent-execution', id: UUID_B, label: null }]);
    expect(valid.actor).toBeNull();
  });

  it('rejects bad assessments, headlines and objective keys', () => {
    expectCode('invalid_team_input', () =>
      validateRecordTeamOutcomeInput({ ...validOutcome(), assessment: 'exceeded' } as never),
    );
    expectCode('invalid_team_input', () =>
      validateRecordTeamOutcomeInput({ ...validOutcome(), headline: '' } as never),
    );
    expectCode('invalid_team_input', () =>
      validateRecordTeamOutcomeInput({ ...validOutcome(), headline: 'x'.repeat(201) } as never),
    );
    expectCode('invalid_team_input', () =>
      validateRecordTeamOutcomeInput({ ...validOutcome(), objectiveKey: 'Not A Key' } as never),
    );
  });

  it('rejects untraceable evidence and non-array evidence', () => {
    expectCode('invalid_team_input', () =>
      validateRecordTeamOutcomeInput({ ...validOutcome(), evidence: [{ kind: 'x' }] } as never),
    );
    expectCode('invalid_team_input', () =>
      validateRecordTeamOutcomeInput({ ...validOutcome(), evidence: 'nope' } as never),
    );
  });

  it('rejects unknown fields — no id/tenant smuggling', () => {
    expectCode('invalid_team_input', () =>
      validateRecordTeamOutcomeInput({ ...validOutcome(), id: UUID_C } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe('query validation', () => {
  it('getTeam demands exactly one identifier', () => {
    expect(validateGetTeamQuery({ teamId: UUID_A }).teamId).toBe(UUID_A);
    expect(validateGetTeamQuery({ slug: 'collections-team' }).slug).toBe('collections-team');
    expectCode('invalid_query', () => validateGetTeamQuery({} as never));
    expectCode('invalid_query', () =>
      validateGetTeamQuery({ teamId: UUID_A, slug: 'collections-team' } as never),
    );
    expectCode('invalid_query', () => validateGetTeamQuery({ teamId: 'nope' } as never));
    expectCode('invalid_query', () => validateGetTeamQuery({ slug: 'BAD SLUG' } as never));
  });

  it('listTeams validates status and limit', () => {
    expect(validateListTeamsQuery({}).limit).toBe(50);
    expect(validateListTeamsQuery({ status: 'active' }).status).toBe('active');
    expectCode('invalid_query', () => validateListTeamsQuery({ status: 'retired' } as never));
    expectCode('invalid_query', () => validateListTeamsQuery({ limit: 0 } as never));
    expectCode('invalid_query', () =>
      validateListTeamsQuery({ limit: MAX_LIST_LIMIT + 1 } as never),
    );
  });

  it('listTeamVersions and listTeamOutcomes validate their shapes', () => {
    expect(validateListTeamVersionsQuery({ teamId: UUID_A }).teamId).toBe(UUID_A);
    expectCode('invalid_query', () => validateListTeamVersionsQuery({ teamId: 'x' } as never));
    expect(validateListTeamOutcomesQuery({ teamId: UUID_A, objectiveKey: 'kk' }).objectiveKey).toBe('kk');
    expectCode('invalid_query', () =>
      validateListTeamOutcomesQuery({ teamId: UUID_A, objectiveKey: 'Not A Key' } as never),
    );
    expectCode('invalid_query', () => validateListTeamOutcomesQuery({ teamId: UUID_A, limit: -1 } as never));
  });
});
