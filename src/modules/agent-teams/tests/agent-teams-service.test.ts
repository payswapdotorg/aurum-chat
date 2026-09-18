// Integration tests for the agent-teams module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W023
// acceptance: "Create agent-team topology, roles, shared objectives,
// budgets, escalation and team outcomes."
//
//  * the team contract — claim-gated creation (idempotent per slug),
//    the versioned content round-trip (roster with roles + reporting
//    lines, shared objectives, budget, escalation rules, owner),
//    revision patch semantics (carry-over + wholesale arrays + merged
//    re-validation), the version audit chain;
//  * cross-module member validation — roster members must be readable
//    through the agents contract (uniform `invalid_agent_ref`, no
//    existence leak), and activation requires every member ACTIVE;
//  * the gated lifecycle — activation routes through the W009 matrix
//    (kind 'agent-recruitment', EXECUTE): the built-in default holds it
//    `pending` until a human approves (decideApproval → same
//    idempotency key replays the gate and applies); a tenant policy
//    can allow it outright (immediate apply) or forbid it
//    (`forbidden_by_policy`); a human can reject it. Dissolution
//    (kind 'agent-termination') follows the same shape with a required
//    reason; dissolved is terminal (no revision, no re-activation, no
//    second dissolution);
//  * team outcomes — append-only records with objective references
//    validated against the CURRENT version (draft teams have performed
//    no work; dissolved teams still accept historical outcomes), the
//    objective-filtered timeline, and open member access (evidence
//    recording is not administration);
//  * storage-level guarantees — versions and outcomes are append-only
//    (UPDATE/DELETE/TRUNCATE rejected by triggers), team identity is
//    never erased, structural content invariants (topology cycles,
//    escalation landing spots, gate shape) hold even for a caller
//    bypassing the service;
//  * tenant isolation — every operation is tenant-scoped; another
//    tenant's teams, versions and outcomes are indistinguishable from
//    missing ones.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as agentTeamsContract from '../contract';
import { decideApproval, setAuthorityPolicy } from '@/modules/actions/contract';
import { registerAgent, updateAgent } from '@/modules/agents/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { AgentTeamsError } from '../errors';
import type { CreateTeamInput, Team } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  activateTeam,
  createTeam,
  dissolveTeam,
  getTeam,
  listTeamOutcomes,
  listTeamVersions,
  listTeams,
  recordTeamOutcome,
  reviseTeam,
  teamCoordinator,
} = agentTeamsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantCreate = newId();
const tenantRevise = newId();
const tenantActivate = newId();
const tenantSleeper = newId();
const tenantAllow = newId();
const tenantForbid = newId();
const tenantReject = newId();
const tenantDissolve = newId();
const tenantOutcomes = newId();
const tenantIsolation = newId();
const tenantOther = newId();
const tenantStorage = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function teamsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['agents:administer'] };
}

function policyAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer', 'agents:administer'] };
}

function approver(tenantId: string): TenantContext {
  // A DIFFERENT principal with the actions approval claim (separation of duties).
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectCode(
  code: AgentTeamsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected AgentTeamsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentTeamsError);
    expect((error as AgentTeamsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Fixtures: member agent definitions through the agents contract
// ---------------------------------------------------------------------------

let agentCounter = 0;

/** Registers one active member agent definition and returns its id. */
async function registerMemberAgent(ctx: TenantContext, role: string): Promise<string> {
  agentCounter += 1;
  const agent = await registerAgent(ctx, {
    slug: `team-agent-${String(agentCounter).padStart(4, '0')}`,
    role,
    provider: 'openai-assistants',
    instructions: `Acts as ${role} on an agent team.`,
    permissions: ['observe', 'analyze'],
  });
  return agent.agent.id;
}

/** A minimal, fully valid team creation over freshly registered agents. */
async function validTeamInput(
  ctx: TenantContext,
  overrides: Partial<CreateTeamInput> = {},
): Promise<CreateTeamInput> {
  const coordinatorId = await registerMemberAgent(ctx, 'coordinator');
  const workerId = await registerMemberAgent(ctx, 'worker');
  return {
    slug: `team-${newId().slice(0, 8)}`,
    displayName: 'Collections team',
    description: 'Chases overdue invoices under an escalation policy.',
    topology: 'hierarchical',
    members: [
      { agentId: coordinatorId, role: 'coordinator' },
      { agentId: workerId, role: 'worker', reportsTo: coordinatorId },
    ],
    objectives: [
      {
        key: 'recovery-rate',
        objective: 'Recover 80% of overdue invoices within 30 days',
        successCriteria: 'Monthly recovery ratio ≥ 0.8',
      },
      {
        key: 'cost-discipline',
        objective: 'Keep recovery cost under 5% of recovered value',
      },
    ],
    budget: { amountMinor: 500_000, currency: 'USD' },
    escalationRules: [
      { trigger: 'member-failure', threshold: 2, route: 'coordinator' },
      { trigger: 'budget-threshold', threshold: 0.8, route: 'owner' },
      { trigger: 'authority-gap', route: 'management' },
    ],
    ownerPrincipal: 'owner-principal-1',
    ...overrides,
  };
}

/** Creates a team and walks it to ACTIVE under a permissive policy. */
async function activeTeam(ctx: TenantContext, input?: CreateTeamInput): Promise<Team> {
  await setAuthorityPolicy(ctx, {
    actionKind: 'agent-recruitment',
    approvalLevels: [],
    forbiddenLevels: [],
  });
  const { team } = await createTeam(ctx, input ?? (await validTeamInput(ctx)));
  const result = await activateTeam(ctx, { teamId: team.id });
  expect(result.applied).toBe(true);
  return result.team;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The team contract: creation + versioned content
// ---------------------------------------------------------------------------

describe('createTeam — the versioned team contract', () => {
  it('mints version 1 as a draft with the full contract round-tripping', async () => {
    const ctx = teamsAdmin(tenantCreate);
    const input = await validTeamInput(ctx, { slug: 'collections-team' });
    const { team, created } = await createTeam(ctx, input);

    expect(created).toBe(true);
    expect(team.tenantId).toBe(tenantCreate);
    expect(team.slug).toBe('collections-team');
    expect(team.status).toBe('draft');
    expect(team.version).toBe(1);
    expect(team.createdAt).toBe(team.updatedAt);

    // Topology + roles: the roster round-trips with reporting lines
    // (root members normalize to an explicit reportsTo: null).
    expect(team.content.topology).toBe('hierarchical');
    expect(team.content.members).toEqual([
      { agentId: input.members[0]!.agentId, role: 'coordinator', reportsTo: null },
      input.members[1],
    ]);
    expect(teamCoordinator(team)?.agentId).toBe(input.members[0]!.agentId);

    // Shared objectives, budget, escalation, owner (omitted optional
    // fields normalize to explicit nulls).
    expect(team.content.objectives).toEqual([
      input.objectives[0],
      { ...input.objectives[1]!, successCriteria: null },
    ]);
    expect(team.content.budget).toEqual({ amountMinor: 500_000, currency: 'USD' });
    expect(team.content.escalationRules).toEqual([
      { trigger: 'member-failure', threshold: 2, route: 'coordinator' },
      { trigger: 'budget-threshold', threshold: 0.8, route: 'owner' },
      { trigger: 'authority-gap', threshold: null, route: 'management' },
    ]);
    expect(team.content.ownerPrincipal).toBe('owner-principal-1');

    // The audit quartet: the calling principal is the default actor.
    expect(team.lastChange.kind).toBe('created');
    expect(team.lastChange.actor).toEqual({ kind: 'person', id: ctx.principalId, label: null });
    expect(team.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(team.lastChange.actionRequestId).toBeNull();
  });

  it('is claim-gated: a plain member cannot mint organizational actors', async () => {
    const adminCtx = teamsAdmin(tenantCreate);
    const input = await validTeamInput(adminCtx);
    await expectCode('forbidden', () => createTeam(member(tenantCreate), input));
    // And nothing was recorded.
    expect(await listTeams(adminCtx, {})).toHaveLength(1);
  });

  it('is idempotent per slug: the first registration stands', async () => {
    const ctx = teamsAdmin(tenantCreate);
    const first = await getTeam(ctx, { slug: 'collections-team' });
    const again = await createTeam(ctx, await validTeamInput(ctx, { slug: 'collections-team' }));
    expect(again.created).toBe(false);
    expect(again.team.id).toBe(first.id);
    expect(again.team.version).toBe(first.version);
  });

  it('validates roster members through the agents contract (uniform not-found)', async () => {
    const ctx = teamsAdmin(tenantCreate);
    const coordinatorId = await registerMemberAgent(ctx, 'coordinator');
    const base = await validTeamInput(ctx, { slug: 'broken-team' });
    await expectCode('invalid_agent_ref', () =>
      createTeam(ctx, {
        ...base,
        members: [
          { agentId: coordinatorId, role: 'coordinator' },
          { agentId: newId(), role: 'worker', reportsTo: coordinatorId },
        ],
      }),
    );
    await expectCode('team_not_found', () => getTeam(ctx, { slug: 'broken-team' }));
  });

  it('rejects malformed content before anything is recorded', async () => {
    const ctx = teamsAdmin(tenantCreate);
    const base = await validTeamInput(ctx);
    await expectCode('invalid_team_input', () =>
      createTeam(ctx, { ...base, budget: { amountMinor: -5, currency: 'USD' } }),
    );
    await expectCode('invalid_team_input', () =>
      createTeam(ctx, { ...base, topology: 'mesh' as never }),
    );
    await expectCode('invalid_team_input', () => createTeam(ctx, { ...base, members: [] }));
    await expectCode('invalid_team_input', () => createTeam(ctx, { ...base, objectives: [] }));
    await expectCode('invalid_team_input', () =>
      createTeam(ctx, {
        ...base,
        escalationRules: [{ trigger: 'authority-gap', threshold: 3, route: 'management' }],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// reviseTeam — patch semantics + the audit chain
// ---------------------------------------------------------------------------

describe('reviseTeam — patch semantics and the audit chain', () => {
  it('carries omitted fields over, replaces arrays wholesale and appends a version', async () => {
    const ctx = teamsAdmin(tenantRevise);
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'revise-me' }));
    const extraWorker = await registerMemberAgent(ctx, 'reviewer');
    const coordinatorId = team.content.members[0]!.agentId;

    const revised = await reviseTeam(ctx, {
      teamId: team.id,
      members: [
        { agentId: coordinatorId, role: 'coordinator' },
        { agentId: extraWorker, role: 'reviewer', reportsTo: coordinatorId },
      ],
      budget: { amountMinor: 750_000, currency: 'EUR' },
      ownerPrincipal: 'owner-principal-2', // tri-state: set
      rationale: 'quarterly budget and roster review',
      actor: { kind: 'person', label: 'ops manager' },
    });

    expect(revised.version).toBe(2);
    expect(revised.status).toBe('draft'); // revisions carry the status forward
    expect(revised.content.members).toHaveLength(2);
    expect(revised.content.members[1]!.role).toBe('reviewer');
    expect(revised.content.budget).toEqual({ amountMinor: 750_000, currency: 'EUR' });
    expect(revised.content.ownerPrincipal).toBe('owner-principal-2'); // set
    expect(revised.content.escalationRules).toEqual(team.content.escalationRules); // carried over
    expect(revised.content.objectives).toEqual(team.content.objectives); // carried over
    expect(revised.content.displayName).toBe(team.content.displayName); // carried over
    expect(revised.lastChange.kind).toBe('revised');
    expect(revised.lastChange.rationale).toBe('quarterly budget and roster review');
    expect(revised.lastChange.actor).toEqual({ kind: 'person', id: null, label: 'ops manager' });
    expect(revised.lastChange.actionRequestId).toBeNull();

    // The audit chain: both versions, ascending, the first unchanged.
    const versions = await listTeamVersions(ctx, { teamId: team.id });
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[0]!.content.budget.currency).toBe('USD');
    expect(versions[1]!.content.budget.currency).toBe('EUR');
  });

  it('re-validates the MERGED content (a flat switch over a reporting roster fails)', async () => {
    const ctx = teamsAdmin(tenantRevise);
    const { team } = await createTeam(ctx, await validTeamInput(ctx));
    await expectCode('invalid_team_input', () =>
      reviseTeam(ctx, { teamId: team.id, topology: 'flat' }),
    );
    // Nothing moved.
    const unchanged = await getTeam(ctx, { teamId: team.id });
    expect(unchanged.version).toBe(1);
    expect(unchanged.content.topology).toBe('hierarchical');
  });

  it('validates member-changing revisions through the agents contract', async () => {
    const ctx = teamsAdmin(tenantRevise);
    const { team } = await createTeam(ctx, await validTeamInput(ctx));
    await expectCode('invalid_agent_ref', () =>
      reviseTeam(ctx, {
        teamId: team.id,
        members: [{ agentId: newId(), role: 'solo' }],
      }),
    );
    await expectCode('invalid_team_input', () =>
      reviseTeam(ctx, { teamId: team.id }), // empty revision
    );
  });

  it('reads by id and by slug, and lists by status', async () => {
    const ctx = teamsAdmin(tenantRevise);
    const bySlug = await getTeam(ctx, { slug: 'revise-me' });
    const byId = await getTeam(ctx, { teamId: bySlug.id });
    expect(byId.id).toBe(bySlug.id);
    expect(byId.version).toBe(2);

    const drafts = await listTeams(ctx, { status: 'draft' });
    expect(drafts.some((team) => team.slug === 'revise-me')).toBe(true);
    expect(await listTeams(ctx, { status: 'active' })).toHaveLength(0);
    // Ordered by slug.
    const slugs = (await listTeams(ctx, {})).map((team) => team.slug);
    expect([...slugs].sort()).toEqual(slugs);
  });
});

// ---------------------------------------------------------------------------
// Activation — the W009-gated draft → active transition
// ---------------------------------------------------------------------------

describe('activateTeam — the authority-gated transition', () => {
  it('holds the transition at the gate until a human approves, then applies on replay', async () => {
    const ctx = teamsAdmin(tenantActivate);
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'gate-me' }));

    // The built-in default gates EXECUTE behind human approval.
    const held = await activateTeam(ctx, { teamId: team.id, idempotencyKey: 'activate:gate-me' });
    expect(held.applied).toBe(false);
    expect(held.gate.status).toBe('pending');
    expect(held.team.status).toBe('draft'); // unchanged
    expect(held.team.version).toBe(1);

    // A human approves (a different principal — separation of duties).
    await decideApproval(approver(tenantActivate), {
      requestId: held.gate.actionRequestId,
      decision: 'approve',
    });

    // Re-invoking with the SAME key replays the gate (now approved) and applies.
    const applied = await activateTeam(ctx, {
      teamId: team.id,
      idempotencyKey: 'activate:gate-me',
    });
    expect(applied.applied).toBe(true);
    expect(applied.gate.status).toBe('approved');
    expect(applied.team.status).toBe('active');
    expect(applied.team.version).toBe(2);
    expect(applied.team.lastChange.kind).toBe('activated');
    expect(applied.team.lastChange.actionRequestId).toBe(held.gate.actionRequestId);

    // The surgical version carries the gate linkage; version 1 does not.
    const versions = await listTeamVersions(ctx, { teamId: team.id });
    expect(versions[0]!.actionRequestId).toBeNull();
    expect(versions[1]!.actionRequestId).toBe(held.gate.actionRequestId);
    expect(versions[1]!.status).toBe('active');

    // An idempotent replay of the completed transition returns the outcome.
    const replay = await activateTeam(ctx, {
      teamId: team.id,
      idempotencyKey: 'activate:gate-me',
    });
    expect(replay.applied).toBe(true);
    expect(replay.team.version).toBe(2);
  });

  it('rejects re-activating an already-active team without a replay key', async () => {
    const ctx = policyAdmin(tenantActivate);
    const live = await activeTeam(ctx, await validTeamInput(ctx, { slug: 'already-live' }));
    await expectCode('invalid_transition', () => activateTeam(ctx, { teamId: live.id }));
  });

  it('requires every member agent to be ACTIVE at activation', async () => {
    const ctx = teamsAdmin(tenantSleeper);
    const input = await validTeamInput(ctx, { slug: 'has-sleeper' });
    const { team } = await createTeam(ctx, input);
    // Disable the worker member.
    await updateAgent(ctx, { agentId: input.members[1]!.agentId, status: 'disabled' });
    await expectCode('member_agent_inactive', () => activateTeam(ctx, { teamId: team.id }));
    // Re-enable: the liveness check passes and the gate holds as usual.
    await updateAgent(ctx, { agentId: input.members[1]!.agentId, status: 'active' });
    const held = await activateTeam(ctx, { teamId: team.id, idempotencyKey: 'activate:sleeper' });
    expect(held.gate.status).toBe('pending');
  });

  it('applies immediately when tenant policy allows the level', async () => {
    const ctx = policyAdmin(tenantAllow);
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'auto-activate' }));
    await setAuthorityPolicy(ctx, {
      actionKind: 'agent-recruitment',
      approvalLevels: [],
      forbiddenLevels: [],
    });
    const applied = await activateTeam(ctx, { teamId: team.id });
    expect(applied.applied).toBe(true);
    expect(applied.team.status).toBe('active');
  });

  it('fails loudly when tenant policy forbids the level', async () => {
    const ctx = policyAdmin(tenantForbid);
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'forbidden' }));
    await setAuthorityPolicy(ctx, {
      actionKind: 'agent-recruitment',
      approvalLevels: [],
      forbiddenLevels: ['EXECUTE'],
    });
    await expectCode('forbidden_by_policy', () => activateTeam(ctx, { teamId: team.id }));
    // The team stands unchanged.
    expect((await getTeam(ctx, { teamId: team.id })).status).toBe('draft');
  });

  it('records a human rejection as forbidden_by_policy on replay', async () => {
    const ctx = teamsAdmin(tenantReject);
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'rejected' }));
    const held = await activateTeam(ctx, { teamId: team.id, idempotencyKey: 'activate:rejected' });
    expect(held.gate.status).toBe('pending');
    await decideApproval(approver(tenantReject), {
      requestId: held.gate.actionRequestId,
      decision: 'reject',
    });
    await expectCode('forbidden_by_policy', () =>
      activateTeam(ctx, { teamId: team.id, idempotencyKey: 'activate:rejected' }),
    );
    expect((await getTeam(ctx, { teamId: team.id })).status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// Dissolution — the gated terminal transition
// ---------------------------------------------------------------------------

describe('dissolveTeam — the gated terminal transition', () => {
  it('dissolves an active team through the gate, recording the required reason', async () => {
    const ctx = policyAdmin(tenantDissolve);
    const live = await activeTeam(ctx, await validTeamInput(ctx, { slug: 'retire-me' }));

    // Dissolution is an 'agent-termination' EXECUTE — gated by default.
    const held = await dissolveTeam(ctx, {
      teamId: live.id,
      reason: 'objective achieved; the capability is no longer needed',
      idempotencyKey: 'dissolve:retire-me',
    });
    expect(held.applied).toBe(false);
    expect(held.gate.status).toBe('pending');

    await decideApproval(approver(tenantDissolve), {
      requestId: held.gate.actionRequestId,
      decision: 'approve',
    });
    const applied = await dissolveTeam(ctx, {
      teamId: live.id,
      reason: 'objective achieved; the capability is no longer needed',
      idempotencyKey: 'dissolve:retire-me',
    });
    expect(applied.applied).toBe(true);
    expect(applied.team.status).toBe('dissolved');
    expect(applied.team.lastChange.kind).toBe('dissolved');
    expect(applied.team.lastChange.rationale).toBe(
      'objective achieved; the capability is no longer needed',
    );
    expect(applied.team.lastChange.actionRequestId).toBe(held.gate.actionRequestId);
  });

  it('can also retire a draft (never activated), and dissolved is terminal', async () => {
    const ctx = policyAdmin(tenantDissolve);
    await setAuthorityPolicy(ctx, {
      actionKind: 'agent-termination',
      approvalLevels: [],
      forbiddenLevels: [],
    });
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'abandoned-draft' }));
    const applied = await dissolveTeam(ctx, { teamId: team.id, reason: 'planning abandoned' });
    expect(applied.applied).toBe(true);
    expect(applied.team.status).toBe('dissolved');

    // Terminal: no revision, no re-activation, no second dissolution.
    await expectCode('invalid_transition', () =>
      reviseTeam(ctx, { teamId: team.id, displayName: 'zombie' }),
    );
    await expectCode('invalid_transition', () => activateTeam(ctx, { teamId: team.id }));
    await expectCode('invalid_transition', () =>
      dissolveTeam(ctx, { teamId: team.id, reason: 'again' }),
    );
  });

  it('requires a reason (terminal transitions record their why)', async () => {
    const ctx = teamsAdmin(tenantDissolve);
    const { team } = await createTeam(ctx, await validTeamInput(ctx));
    await expectCode('invalid_team_input', () =>
      dissolveTeam(ctx, { teamId: team.id, reason: '' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Team outcomes — append-only, provenance-bearing evidence
// ---------------------------------------------------------------------------

describe('team outcomes', () => {
  it('records outcomes against objectives of the current version', async () => {
    const ctx = policyAdmin(tenantOutcomes);
    const live = await activeTeam(ctx, await validTeamInput(ctx, { slug: 'outcomes-team' }));
    const executionId = newId();

    const outcome = await recordTeamOutcome(ctx, {
      teamId: live.id,
      objectiveKey: 'recovery-rate',
      headline: 'Recovered 82% of overdue invoices in Q3',
      detail: 'Exceeded the 80% target for three consecutive months.',
      assessment: 'met',
      evidence: [{ kind: 'agent-execution', id: executionId }],
      actor: { kind: 'system', label: 'evaluation run' },
    });
    expect(outcome.teamId).toBe(live.id);
    expect(outcome.objectiveKey).toBe('recovery-rate');
    expect(outcome.assessment).toBe('met');
    expect(outcome.evidence).toEqual([{ kind: 'agent-execution', id: executionId, label: null }]);
    expect(outcome.actor).toEqual({ kind: 'system', id: null, label: 'evaluation run' });
    expect(outcome.recordedByPrincipal).toBe(ctx.principalId);

    // A plain member may record a team-level overall outcome (evidence
    // recording is not administration) — the actor defaults to them.
    const overall = await recordTeamOutcome(member(tenantOutcomes), {
      teamId: live.id,
      headline: 'Team performed reliably through Q3',
      assessment: 'partial',
    });
    expect(overall.objectiveKey).toBeNull();
    expect(overall.actor).toEqual({ kind: 'person', id: overall.recordedByPrincipal, label: null });

    // The timeline: newest first, filterable by objective.
    const all = await listTeamOutcomes(ctx, { teamId: live.id });
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toBe(overall.id); // newest first
    const filtered = await listTeamOutcomes(ctx, {
      teamId: live.id,
      objectiveKey: 'recovery-rate',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe(outcome.id);
  });

  it('validates the objective reference against the CURRENT version', async () => {
    const ctx = policyAdmin(tenantOutcomes);
    const live = await activeTeam(ctx, await validTeamInput(ctx, { slug: 'objective-refs' }));
    await expectCode('invalid_objective_ref', () =>
      recordTeamOutcome(ctx, {
        teamId: live.id,
        objectiveKey: 'nonexistent',
        headline: 'x',
        assessment: 'met',
      }),
    );
    // Revise the objectives away and the old key no longer resolves.
    await reviseTeam(ctx, {
      teamId: live.id,
      objectives: [{ key: 'new-objective', objective: 'Something else entirely' }],
      rationale: 'pivot',
    });
    await expectCode('invalid_objective_ref', () =>
      recordTeamOutcome(ctx, {
        teamId: live.id,
        objectiveKey: 'recovery-rate',
        headline: 'x',
        assessment: 'met',
      }),
    );
    const ok = await recordTeamOutcome(ctx, {
      teamId: live.id,
      objectiveKey: 'new-objective',
      headline: 'y',
      assessment: 'partial',
    });
    expect(ok.objectiveKey).toBe('new-objective');
  });

  it('rejects outcomes for draft teams but keeps dissolved history recordable', async () => {
    const ctx = policyAdmin(tenantOutcomes);
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'never-worked' }));
    await expectCode('invalid_transition', () =>
      recordTeamOutcome(ctx, { teamId: team.id, headline: 'nothing yet', assessment: 'met' }),
    );

    // Dissolved teams accept their historical outcomes.
    await setAuthorityPolicy(ctx, {
      actionKind: 'agent-termination',
      approvalLevels: [],
      forbiddenLevels: [],
    });
    const dissolved = await dissolveTeam(ctx, { teamId: team.id, reason: 'retired' });
    expect(dissolved.team.status).toBe('dissolved');
    const late = await recordTeamOutcome(ctx, {
      teamId: team.id,
      headline: 'Final wrap-up recorded post-dissolution',
      assessment: 'missed',
    });
    expect(late.assessment).toBe('missed');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it("makes another tenant's teams indistinguishable from missing ones", async () => {
    const ownerCtx = policyAdmin(tenantIsolation);
    const team = await activeTeam(ownerCtx, await validTeamInput(ownerCtx, { slug: 'private-team' }));
    await recordTeamOutcome(ownerCtx, {
      teamId: team.id,
      headline: 'internal result',
      assessment: 'met',
    });

    const stranger = teamsAdmin(tenantOther);
    await expectCode('team_not_found', () => getTeam(stranger, { teamId: team.id }));
    await expectCode('team_not_found', () => getTeam(stranger, { slug: 'private-team' }));
    await expectCode('team_not_found', () => listTeamVersions(stranger, { teamId: team.id }));
    await expectCode('team_not_found', () => activateTeam(stranger, { teamId: team.id }));
    await expectCode('team_not_found', () =>
      reviseTeam(stranger, { teamId: team.id, displayName: 'X' }),
    );
    await expectCode('team_not_found', () =>
      dissolveTeam(stranger, { teamId: team.id, reason: 'hostile' }),
    );
    await expectCode('team_not_found', () =>
      recordTeamOutcome(stranger, { teamId: team.id, headline: 'x', assessment: 'met' }),
    );
    expect(await listTeams(stranger, {})).toHaveLength(0);
    expect(await listTeamOutcomes(stranger, { teamId: team.id })).toHaveLength(0);
  });

  it('never leaks cross-tenant member agents into rosters', async () => {
    // A member agent registered in tenant A cannot staff a team in tenant B.
    const ownerCtx = teamsAdmin(tenantIsolation);
    const foreignAgentId = await registerMemberAgent(ownerCtx, 'foreign worker');
    const strangerCtx = teamsAdmin(tenantOther);
    const base = await validTeamInput(strangerCtx, { slug: 'stolen-roster' });
    await expectCode('invalid_agent_ref', () =>
      createTeam(strangerCtx, {
        ...base,
        members: [{ agentId: foreignAgentId, role: 'solo' }],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees (triggers, not just service discipline)
// ---------------------------------------------------------------------------

describe('storage-level guarantees', () => {
  it('rejects mutation and erasure at the storage level', async () => {
    const ctx = teamsAdmin(tenantStorage);
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'guarded' }));
    const db = getDb();

    await expect(
      db.query(`UPDATE agent_team_versions SET display_name = 'hacked' WHERE tenant_id = $1`, [
        tenantStorage,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM agent_team_versions WHERE tenant_id = $1`, [tenantStorage]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM agent_teams WHERE tenant_id = $1`, [tenantStorage]),
    ).rejects.toThrow(/cannot be erased/);
    // TRUNCATE is blocked as well — by the FK references while they
    // exist, and by the erasure trigger regardless.
    await expect(db.query(`TRUNCATE agent_teams`)).rejects.toThrow(
      /cannot be erased|cannot truncate/,
    );

    // The team stands, its history intact.
    const intact = await getTeam(ctx, { teamId: team.id });
    expect(intact.version).toBe(1);
    expect(await listTeamVersions(ctx, { teamId: team.id })).toHaveLength(1);
  });

  it('enforces the structural content invariants on direct SQL writes', async () => {
    const ctx = teamsAdmin(tenantStorage);
    const { team } = await createTeam(ctx, await validTeamInput(ctx, { slug: 'trigger-guarded' }));
    const db = getDb();
    const coordinator = team.content.members[0]!.agentId;
    const worker = team.content.members[1]!.agentId;

    // A version with a reporting cycle BELOW a root (B → C → B, with
    // the coordinator as the single legitimate root).
    const bWorker = newId();
    const cWorker = newId();
    await expect(
      db.query(
        `INSERT INTO agent_team_versions (
           tenant_id, team_id, version, change_kind, topology, members, objectives,
           budget_amount_minor, budget_currency, escalation_rules, status,
           actor_kind, actor_label, changed_by_principal
         ) VALUES ($1, $2, 2, 'revised', 'hierarchical', $3::jsonb, $4::jsonb, 0, 'USD', '[]'::jsonb,
           'draft', 'person', 'sql', 'direct')`,
        [
          tenantStorage,
          team.id,
          JSON.stringify([
            { agentId: coordinator, role: 'coordinator', reportsTo: null },
            { agentId: worker, role: 'worker', reportsTo: coordinator },
            { agentId: bWorker, role: 'worker', reportsTo: cWorker },
            { agentId: cWorker, role: 'worker', reportsTo: bWorker },
          ]),
          JSON.stringify([{ key: 'kk', objective: 'anything' }]),
        ],
      ),
    ).rejects.toThrow(/cycle/);

    // A flat version that carries reporting lines.
    await expect(
      db.query(
        `INSERT INTO agent_team_versions (
           tenant_id, team_id, version, change_kind, topology, members, objectives,
           budget_amount_minor, budget_currency, escalation_rules, status,
           actor_kind, actor_label, changed_by_principal
         ) VALUES ($1, $2, 2, 'revised', 'flat', $3::jsonb, $4::jsonb, 0, 'USD', '[]'::jsonb,
           'draft', 'person', 'sql', 'direct')`,
        [
          tenantStorage,
          team.id,
          JSON.stringify([
            { agentId: coordinator, role: 'solo' },
            { agentId: worker, role: 'worker', reportsTo: coordinator },
          ]),
          JSON.stringify([{ key: 'kk', objective: 'anything' }]),
        ],
      ),
    ).rejects.toThrow(/flat/);

    // An escalation rule with nowhere to land (coordinator route on flat).
    await expect(
      db.query(
        `INSERT INTO agent_team_versions (
           tenant_id, team_id, version, change_kind, topology, members, objectives,
           budget_amount_minor, budget_currency, escalation_rules, status,
           actor_kind, actor_label, changed_by_principal
         ) VALUES ($1, $2, 2, 'revised', 'flat', $3::jsonb, $4::jsonb, 0, 'USD', $5::jsonb,
           'draft', 'person', 'sql', 'direct')`,
        [
          tenantStorage,
          team.id,
          JSON.stringify([{ agentId: coordinator, role: 'solo' }]),
          JSON.stringify([{ key: 'kk', objective: 'anything' }]),
          JSON.stringify([{ trigger: 'member-failure', threshold: 1, route: 'coordinator' }]),
        ],
      ),
    ).rejects.toThrow(/coordinator/);

    // A lifecycle version without its gate linkage violates the CHECK.
    await expect(
      db.query(
        `INSERT INTO agent_team_versions (
           tenant_id, team_id, version, change_kind, topology, members, objectives,
           budget_amount_minor, budget_currency, escalation_rules, status,
           actor_kind, actor_label, changed_by_principal
         ) VALUES ($1, $2, 2, 'activated', 'flat', $3::jsonb, $4::jsonb, 0, 'USD', '[]'::jsonb,
           'active', 'person', 'sql', 'direct')`,
        [
          tenantStorage,
          team.id,
          JSON.stringify([{ agentId: coordinator, role: 'solo' }]),
          JSON.stringify([{ key: 'kk', objective: 'anything' }]),
        ],
      ),
    ).rejects.toThrow(/gate_shape/);
  });

  it('keeps outcomes append-only and evidence traceable at the storage level', async () => {
    const ctx = policyAdmin(tenantStorage);
    const live = await activeTeam(ctx, await validTeamInput(ctx, { slug: 'outcome-guarded' }));
    const outcome = await recordTeamOutcome(ctx, {
      teamId: live.id,
      headline: 'storage-guarded outcome',
      assessment: 'met',
    });
    const db = getDb();

    await expect(
      db.query(`UPDATE agent_team_outcomes SET headline = 'hacked' WHERE tenant_id = $1`, [
        tenantStorage,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM agent_team_outcomes WHERE id = $1`, [outcome.id]),
    ).rejects.toThrow(/append-only/);

    // Untraceable evidence is rejected by the storage trigger too.
    await expect(
      db.query(
        `INSERT INTO agent_team_outcomes (
           tenant_id, team_id, objective_key, headline, assessment, evidence,
           actor_kind, actor_label, recorded_by_principal
         ) VALUES ($1, $2, NULL, 'x', 'met', $3::jsonb, 'person', 'sql', 'direct')`,
        [tenantStorage, live.id, JSON.stringify([{ kind: 'agent-execution' }])],
      ),
    ).rejects.toThrow(/traceable/);
  });
});
