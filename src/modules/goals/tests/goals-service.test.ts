// Integration tests for the goals module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W008 acceptance:
//
//  * VERSIONED management goals ("versioned ... desired state, metrics,
//    thresholds, horizon, owner and priority"):
//      - a goal is an identity plus an append-only chain of full-snapshot
//        versions; revising appends version N+1 and carries untouched
//        fields over; arrays replace wholesale; the merged snapshot is
//        re-validated like a fresh create;
//      - version numbers, change kinds, commit times and the acting
//        principal are system-minted (smuggled fields rejected at the unit
//        level); versions are strictly increasing and unique per goal;
//      - lifecycle (active/archived) is versioned content with surgical
//        transitions: a status change is its own revision, archived goals
//        accept nothing but reactivation.
//  * AUDITABLE goal changes ("verify goal changes are auditable"):
//      - every version records who (actor party + authenticated principal),
//        when (recorded_at), what (change_kind + a self-contained snapshot)
//        and why (rationale);
//      - the audit trail is listable ascending and deep-linkable;
//      - the storage layer rejects UPDATE/DELETE/TRUNCATE on versions and
//        DELETE/TRUNCATE on goals outright (triggers) — history cannot be
//        rewritten even by a caller bypassing the service;
//      - a raced version append fails cleanly with goal_conflict.
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).
//  * the management listing: priority-rank ordering and the status /
//    priority / owner / horizon-window / title-search filters over CURRENT
//    versions only.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as goalsContract from '../contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { GoalsError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';
import type { CreateGoalInput, Goal } from '../types';

const {
  createGoal,
  getGoal,
  getGoalVersion,
  listGoalVersions,
  listGoals,
  reviseGoal,
} = goalsContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantA = newId();
const tenantB = newId();
const tenantLifecycle = newId();
const tenantAudit = newId();
const tenantConflict = newId();
const tenantList = newId();
const tenantIso = newId();

const OWNER_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const T0 = '2026-09-14T09:15:00.000Z'; // .000Z — the format instants round-trip in
const T0_PLUS = (seconds: number): string =>
  new Date(Date.parse(T0) + seconds * 1000).toISOString();
const D1 = '2026-10-01T00:00:00.000Z';
const D2 = '2026-11-01T00:00:00.000Z';
const D3 = '2026-12-01T00:00:00.000Z';
const D4 = '2027-01-01T00:00:00.000Z';
const D5 = '2027-02-01T00:00:00.000Z';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(GoalsError);
    expect((error as GoalsError).code).toBe(code);
  }
}

/** A full §5 definition, parameterized for the suites below. */
function goalInput(overrides: Partial<CreateGoalInput> = {}): CreateGoalInput {
  return {
    title: 'Q4 churn reduction',
    objective: 'Reduce monthly customer churn.',
    desiredState: 'Churn is below 5% every month of the quarter.',
    metrics: [
      { name: 'monthly-churn-ratio', unit: 'ratio', direction: 'at_most', threshold: 0.05 },
    ],
    horizonStart: T0,
    horizonEnd: D3,
    owner: { kind: 'person', id: OWNER_ID, label: 'VP Customer Success' },
    priority: 'high',
    evidenceSources: [
      { kind: 'source', label: 'billing-export' },
      { kind: 'person', id: OWNER_ID },
    ],
    successCriteria: 'Three consecutive months with churn at or below 5%.',
    actor: { kind: 'person', id: OWNER_ID },
    rationale: 'board-2026',
    ...overrides,
  };
}

async function seedGoal(
  ctx: TenantContext,
  overrides: Partial<CreateGoalInput> = {},
): Promise<Goal> {
  return createGoal(ctx, goalInput(overrides));
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', async () => {
    // There is deliberately no updateGoalVersion, no deleteGoal, no
    // eraseHistory and no setStatus shortcut: revising appends, archiving is
    // a versioned status change, and erasure is impossible by trigger.
    expect(Object.keys(goalsContract).sort()).toEqual([
      'DEFAULT_LIST_LIMIT',
      'GOAL_CHANGE_KINDS',
      'GOAL_EVIDENCE_SOURCE_KINDS',
      'GOAL_METRIC_DIRECTIONS',
      'GOAL_PARTY_KINDS',
      'GOAL_PRIORITIES',
      'GOAL_STATUSES',
      'GoalsError',
      'MAX_EVIDENCE_SOURCES',
      'MAX_LIST_LIMIT',
      'MAX_METRICS_PER_GOAL',
      'createGoal',
      'getGoal',
      'getGoalVersion',
      'isGoalChangeKind',
      'isGoalEvidenceSourceKind',
      'isGoalMetricDirection',
      'isGoalPartyKind',
      'isGoalPriority',
      'isGoalStatus',
      'isUuid',
      'listGoalVersions',
      'listGoals',
      'reviseGoal',
    ]);
  });
});

describe('createGoal / getGoal (the §5 definition, version 1)', () => {
  it('defines a goal with system-minted identity, version and audit fields', async () => {
    const ctx = member(tenantA);
    const before = new Date();
    const goal = await createGoal(ctx, goalInput());
    const after = new Date();

    expect(goal.version).toBe(1);
    expect(goal.content.status).toBe('active'); // minted, not caller-chosen
    expect(goal.lastChange.kind).toBe('created');
    expect(goal.lastChange.actor).toEqual({ kind: 'person', id: OWNER_ID, label: null });
    expect(goal.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(goal.lastChange.rationale).toBe('board-2026');
    for (const stamp of [goal.createdAt, goal.updatedAt, goal.lastChange.recordedAt]) {
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before.getTime());
      expect(Date.parse(stamp)).toBeLessThanOrEqual(after.getTime());
    }
    expect(goal.updatedAt).toBe(goal.lastChange.recordedAt);
  });

  it('round-trips the full definition — desired state, metrics/thresholds, horizon, owner, priority, evidence sources, success criteria', async () => {
    const ctx = member(tenantA);
    const goal = await createGoal(
      ctx,
      goalInput({
        metrics: [
          { name: 'arr', unit: 'EUR-cent', direction: 'at_least', threshold: 500_000_00 },
          { name: 'churn', unit: 'ratio', direction: 'at_most', threshold: 0.05 },
          { name: 'nps', unit: 'points', direction: 'in_range', lowerBound: 40, upperBound: 80 },
        ],
      }),
    );
    expect(goal.content.title).toBe('Q4 churn reduction');
    expect(goal.content.objective).toBe('Reduce monthly customer churn.');
    expect(goal.content.desiredState).toBe('Churn is below 5% every month of the quarter.');
    expect(goal.content.metrics).toEqual([
      {
        name: 'arr',
        unit: 'EUR-cent',
        direction: 'at_least',
        threshold: 500_000_00,
        lowerBound: null,
        upperBound: null,
      },
      {
        name: 'churn',
        unit: 'ratio',
        direction: 'at_most',
        threshold: 0.05,
        lowerBound: null,
        upperBound: null,
      },
      { name: 'nps', unit: 'points', direction: 'in_range', threshold: null, lowerBound: 40, upperBound: 80 },
    ]);
    expect(goal.content.horizon).toEqual({ start: T0, end: D3 });
    expect(goal.content.owner).toEqual({ kind: 'person', id: OWNER_ID, label: 'VP Customer Success' });
    expect(goal.content.priority).toBe('high');
    expect(goal.content.evidenceSources).toEqual([
      { kind: 'source', id: null, label: 'billing-export' },
      { kind: 'person', id: OWNER_ID, label: null },
    ]);
    expect(goal.content.successCriteria).toBe('Three consecutive months with churn at or below 5%.');

    const read = await getGoal(ctx, goal.id);
    expect(read).toEqual(goal);
  });

  it('applies the empty defaults (metrics, evidence sources, horizon start)', async () => {
    const ctx = member(tenantA);
    const input = goalInput();
    delete input.metrics;
    delete input.evidenceSources;
    delete input.horizonStart;
    const goal = await createGoal(ctx, input);
    expect(goal.content.metrics).toEqual([]);
    expect(goal.content.evidenceSources).toEqual([]);
    expect(goal.content.horizon.start).toBeNull();
  });

  it('reports unknown, malformed and foreign-tenant ids as goal_not_found (no leak)', async () => {
    const ctx = member(tenantA);
    await seedGoal(ctx);
    await expectCode('goal_not_found', () => getGoal(ctx, newId()));
    await expectCode('goal_not_found', () => getGoal(ctx, 'not-a-uuid'));
    await expectCode('goal_not_found', () => getGoal(member(tenantB), 'not-a-uuid'));
  });
});

describe('reviseGoal (append-only versioning of the definition)', () => {
  it('appends version 2 and carries untouched fields over', async () => {
    const ctx = member(tenantA);
    const original = await seedGoal(ctx);

    const revised = await reviseGoal(ctx, {
      goalId: original.id,
      title: 'Q4 churn reduction (stretch)',
      priority: 'critical',
      metrics: [{ name: 'monthly-churn-ratio', unit: 'ratio', direction: 'at_most', threshold: 0.04 }],
      actor: { kind: 'person', id: OWNER_ID },
      rationale: 'board raised the bar',
    });

    expect(revised.version).toBe(2);
    expect(revised.lastChange.kind).toBe('revised');
    expect(revised.lastChange.rationale).toBe('board raised the bar');
    expect(revised.createdAt).toBe(original.createdAt); // identity unchanged
    expect(Date.parse(revised.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt));

    // changed fields
    expect(revised.content.title).toBe('Q4 churn reduction (stretch)');
    expect(revised.content.priority).toBe('critical');
    expect(revised.content.metrics).toEqual([
      {
        name: 'monthly-churn-ratio',
        unit: 'ratio',
        direction: 'at_most',
        threshold: 0.04,
        lowerBound: null,
        upperBound: null,
      },
    ]);
    // untouched fields carry over exactly
    expect(revised.content.objective).toBe(original.content.objective);
    expect(revised.content.desiredState).toBe(original.content.desiredState);
    expect(revised.content.horizon).toEqual(original.content.horizon);
    expect(revised.content.owner).toEqual(original.content.owner);
    expect(revised.content.evidenceSources).toEqual(original.content.evidenceSources);
    expect(revised.content.successCriteria).toBe(original.content.successCriteria);

    expect(await getGoal(ctx, original.id)).toEqual(revised);
  });

  it('records the audit quartet on each revision (who/when/what/why)', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx);
    const principal = newId();
    const before = new Date();
    const revised = await reviseGoal(
      memberAs(ctx.tenantId, principal),
      {
        goalId: goal.id,
        desiredState: 'Churn is below 4.5% every month of the quarter.',
        actor: { kind: 'person', id: OWNER_ID, label: 'VP Customer Success' },
        rationale: 'tightened after September actuals',
      },
    );
    const after = new Date();

    expect(revised.lastChange.actor).toEqual({
      kind: 'person',
      id: OWNER_ID,
      label: 'VP Customer Success',
    });
    expect(revised.lastChange.changedByPrincipal).toBe(principal);
    expect(revised.lastChange.rationale).toBe('tightened after September actuals');
    expect(Date.parse(revised.lastChange.recordedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(revised.lastChange.recordedAt)).toBeLessThanOrEqual(after.getTime());
    // the previous version's audit record is untouched
    const v1 = await getGoalVersion(ctx, { goalId: goal.id, version: 1 });
    expect(v1.changedByPrincipal).toBe(goal.lastChange.changedByPrincipal);
  });

  it('revalidates the merged content — horizon ordering spans patch and current', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx); // horizon [T0, D3]

    await expectCode('invalid_revision_input', () =>
      reviseGoal(ctx, {
        goalId: goal.id,
        horizonStart: D4, // after the carried-over horizonEnd D3
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
    await expectCode('invalid_revision_input', () =>
      reviseGoal(ctx, {
        goalId: goal.id,
        horizonEnd: T0, // before the carried-over horizonStart T0 → not strictly after
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
    // nothing was appended by the failed revisions
    expect((await listGoalVersions(ctx, { goalId: goal.id })).length).toBe(1);
  });

  it('treats horizonStart as tri-state (omitted / null clears / string sets)', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx); // horizonStart T0
    expect(goal.content.horizon.start).toBe(T0);

    const cleared = await reviseGoal(ctx, {
      goalId: goal.id,
      horizonStart: null,
      actor: { kind: 'person', id: OWNER_ID },
    });
    expect(cleared.content.horizon.start).toBeNull();

    const set = await reviseGoal(ctx, {
      goalId: goal.id,
      horizonStart: T0_PLUS(3600),
      actor: { kind: 'person', id: OWNER_ID },
    });
    expect(set.content.horizon.start).toBe(T0_PLUS(3600));
    expect(set.content.horizon.end).toBe(D3);
    expect(set.version).toBe(3);
  });

  it('rejects revising an unknown or foreign-tenant goal as goal_not_found', async () => {
    const ctx = member(tenantA);
    const goal = await seedGoal(ctx);
    await expectCode('goal_not_found', () =>
      reviseGoal(ctx, {
        goalId: newId(),
        title: 'x',
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
    await expectCode('goal_not_found', () =>
      reviseGoal(member(tenantB), {
        goalId: goal.id, // exists — but only in tenant A
        title: 'x',
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
    expect((await listGoalVersions(ctx, { goalId: goal.id })).length).toBe(1);
  });
});

describe('lifecycle (surgical, auditable status transitions)', () => {
  it('archives with a status-only revision and records why', async () => {
    const ctx = member(tenantLifecycle);
    const goal = await seedGoal(ctx);

    const archived = await reviseGoal(ctx, {
      goalId: goal.id,
      status: 'archived',
      actor: { kind: 'person', id: OWNER_ID },
      rationale: 'superseded by the 2027 plan',
    });
    expect(archived.version).toBe(2);
    expect(archived.lastChange.kind).toBe('archived');
    expect(archived.content.status).toBe('archived');
    expect(archived.lastChange.rationale).toBe('superseded by the 2027 plan');
    // lifecycle transitions change nothing else
    expect(archived.content.title).toBe(goal.content.title);
    expect(archived.content.metrics).toEqual(goal.content.metrics);
    expect(archived.content.horizon).toEqual(goal.content.horizon);
  });

  it('rejects content changes on an archived goal (reactivation is the only path)', async () => {
    const ctx = member(tenantLifecycle);
    const goal = await seedGoal(ctx);
    await reviseGoal(ctx, {
      goalId: goal.id,
      status: 'archived',
      actor: { kind: 'person', id: OWNER_ID },
    });

    await expectCode('invalid_transition', () =>
      reviseGoal(ctx, {
        goalId: goal.id,
        title: 'sneaky edit',
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
    await expectCode('invalid_transition', () =>
      reviseGoal(ctx, {
        goalId: goal.id,
        metrics: [],
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
  });

  it('rejects no-op and repeated lifecycle transitions', async () => {
    const ctx = member(tenantLifecycle);
    const active = await seedGoal(ctx);
    await expectCode('invalid_transition', () =>
      reviseGoal(ctx, {
        goalId: active.id,
        status: 'active', // already active
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );

    const archived = await reviseGoal(ctx, {
      goalId: active.id,
      status: 'archived',
      actor: { kind: 'person', id: OWNER_ID },
    });
    await expectCode('invalid_transition', () =>
      reviseGoal(ctx, {
        goalId: archived.id,
        status: 'archived', // already archived
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
  });

  it('reactivates with a status-only revision and unblocks content revisions', async () => {
    const ctx = member(tenantLifecycle);
    const goal = await seedGoal(ctx);
    await reviseGoal(ctx, {
      goalId: goal.id,
      status: 'archived',
      actor: { kind: 'person', id: OWNER_ID },
    });

    const reactivated = await reviseGoal(ctx, {
      goalId: goal.id,
      status: 'active',
      actor: { kind: 'person', id: OWNER_ID },
      rationale: '2027 plan revived the target',
    });
    expect(reactivated.version).toBe(3);
    expect(reactivated.lastChange.kind).toBe('reactivated');
    expect(reactivated.content.status).toBe('active');
    expect(reactivated.content.title).toBe(goal.content.title);

    const revised = await reviseGoal(ctx, {
      goalId: goal.id,
      title: 'Churn reduction (revived)',
      actor: { kind: 'person', id: OWNER_ID },
    });
    expect(revised.version).toBe(4);
    expect(revised.lastChange.kind).toBe('revised');
    expect(revised.content.status).toBe('active');
  });
});

describe('the audit trail (W008: goal changes are auditable)', () => {
  it('lists the full ascending, self-contained history', async () => {
    const ctx = member(tenantAudit);
    const v1 = await seedGoal(ctx, { title: 'Original' });
    const v2 = await reviseGoal(ctx, {
      goalId: v1.id,
      title: 'Second',
      priority: 'critical',
      actor: { kind: 'person', id: OWNER_ID },
      rationale: 're-prioritized',
    });
    await reviseGoal(ctx, {
      goalId: v1.id,
      status: 'archived',
      actor: { kind: 'person', id: OWNER_ID },
      rationale: 'year closed',
    });

    const history = await listGoalVersions(ctx, { goalId: v1.id });
    expect(history.map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(history.map((entry) => entry.changeKind)).toEqual(['created', 'revised', 'archived']);
    expect(new Set(history.map((entry) => entry.id)).size).toBe(3);

    // every version is self-contained: v1 still reads the ORIGINAL content
    // even though the goal has moved on.
    expect(history[0]!.content.title).toBe('Original');
    expect(history[0]!.content.priority).toBe('high');
    expect(history[1]!.content.title).toBe('Second');
    expect(history[1]!.content.priority).toBe('critical');
    expect(history[2]!.content.status).toBe('archived');
    expect(history[2]!.rationale).toBe('year closed');

    // commit times never go backwards along the chain
    for (let index = 1; index < history.length; index += 1) {
      expect(Date.parse(history[index]!.recordedAt)).toBeGreaterThanOrEqual(
        Date.parse(history[index - 1]!.recordedAt),
      );
    }

    // deep-link matches the history entry exactly
    expect(await getGoalVersion(ctx, { goalId: v1.id, version: 2 })).toEqual(history[1]);
    expect(v2.version).toBe(2);
  });

  it('reports unknown versions as goal_version_not_found (foreign tenant included)', async () => {
    const ctx = member(tenantAudit);
    const goal = await seedGoal(ctx);
    await expectCode('goal_version_not_found', () =>
      getGoalVersion(ctx, { goalId: goal.id, version: 2 }),
    );
    // a malformed version number is a query problem, not a lookup miss
    await expectCode('invalid_query', () =>
      getGoalVersion(ctx, { goalId: goal.id, version: 0 }),
    );
    await expectCode('goal_version_not_found', () =>
      getGoalVersion(member(tenantB), { goalId: goal.id, version: 1 }),
    );
  });

  it('rejects UPDATE, DELETE and TRUNCATE on the audit trail at the storage layer', async () => {
    const ctx = member(tenantAudit);
    const goal = await seedGoal(ctx);

    await expect(
      getDb().query(`UPDATE goal_versions SET title = 'tampered' WHERE goal_id = $1`, [goal.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      getDb().query(`DELETE FROM goal_versions WHERE goal_id = $1`, [goal.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(getDb().query(`TRUNCATE goal_versions`)).rejects.toThrow(/append-only/i);

    // the goals identity cannot be erased either — archiving is the
    // retirement path, and its history must survive it.
    await expect(getDb().query(`DELETE FROM goals WHERE id = $1`, [goal.id])).rejects.toThrow(
      /cannot be erased/i,
    );
    // TRUNCATE goals is rejected too — either by the module's trigger or by
    // PostgreSQL's own foreign-key guard (goal_versions references goals);
    // either way the identity and its history cannot be erased.
    await expect(getDb().query(`TRUNCATE goals`)).rejects.toThrow(
      /cannot be erased|cannot truncate/i,
    );

    const after = await getGoal(ctx, goal.id);
    expect(after.version).toBe(1);
    expect(after.content.title).toBe('Q4 churn reduction');
  });

  it('fails a raced version append cleanly with goal_conflict (backstop)', async () => {
    const ctx = member(tenantConflict);
    const goal = await seedGoal(ctx);

    // A version 2 row inserted behind the service's back (simulating a
    // concurrent writer that allocated the number first) without moving the
    // current-version pointer.
    await getDb().query(
      `INSERT INTO goal_versions (
         tenant_id, goal_id, version, change_kind,
         title, objective, desired_state, metrics,
         horizon_start, horizon_end, owner, priority,
         evidence_sources, success_criteria, status,
         actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
       ) VALUES (
         $1, $2, 2, 'revised',
         'raced', 'raced', 'raced', '[]'::jsonb,
         NULL, $3, '{"kind":"system","label":"race"}'::jsonb, 'low',
         '[]'::jsonb, 'raced', 'active',
         'system', NULL, 'race', 'race', NULL, now()
       )`,
      [goal.tenantId, goal.id, D5],
    );

    await expectCode('goal_conflict', () =>
      reviseGoal(ctx, {
        goalId: goal.id,
        title: 'loser of the race',
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
    // the failed revision rolled back completely: the current version is
    // still version 1 with its original content
    const after = await getGoal(ctx, goal.id);
    expect(after.version).toBe(1);
    expect(after.content.title).toBe('Q4 churn reduction');
  });
});

describe('tenant isolation (ADR-0001)', () => {
  it('another tenant cannot read, revise or audit a goal', async () => {
    const ctxA = member(tenantIso);
    const goal = await seedGoal(ctxA);
    await reviseGoal(ctxA, {
      goalId: goal.id,
      title: 'A-only revision',
      actor: { kind: 'person', id: OWNER_ID },
    });

    const ctxB = member(tenantB);
    await expectCode('goal_not_found', () => getGoal(ctxB, goal.id));
    await expectCode('goal_not_found', () =>
      reviseGoal(ctxB, {
        goalId: goal.id,
        title: 'B trying to revise A goal',
        actor: { kind: 'person', id: OWNER_ID },
      }),
    );
    await expectCode('goal_version_not_found', () =>
      getGoalVersion(ctxB, { goalId: goal.id, version: 1 }),
    );
    await expectCode('goal_not_found', () => listGoalVersions(ctxB, { goalId: goal.id }));
    expect(await listGoals(ctxB, {})).toEqual([]);

    // A's goal is intact and unreachable-into
    const after = await getGoal(ctxA, goal.id);
    expect(after.version).toBe(2);
    expect(after.content.title).toBe('A-only revision');
  });

  it('same-named goals in different tenants stay independent', async () => {
    const ctxA = member(tenantIso);
    const ctxB = member(tenantB);
    const goalA = await seedGoal(ctxA);
    const goalB = await seedGoal(ctxB);

    await reviseGoal(ctxA, {
      goalId: goalA.id,
      priority: 'critical',
      actor: { kind: 'person', id: OWNER_ID },
    });

    const inA = await listGoals(ctxA, { search: 'churn' });
    expect(inA.map((goal) => goal.id)).toEqual([goalA.id]);
    expect(inA[0]!.version).toBe(2);
    const inB = await listGoals(ctxB, { search: 'churn' });
    expect(inB.map((goal) => goal.id)).toEqual([goalB.id]);
    expect(inB[0]!.version).toBe(1);
  });

  it('owner filters never leak across tenants', async () => {
    // fresh tenants so earlier seeds (owned by the default owner) cannot
    // pollute the filter result
    const ctxA = member(newId());
    const ctxB = member(newId());
    // both tenants have goals owned by the very same person id
    await seedGoal(ctxA, { title: 'A goal' });
    await seedGoal(ctxB, { title: 'B goal' });

    const inA = await listGoals(ctxA, { ownerKind: 'person', ownerId: OWNER_ID });
    expect(inA.map((goal) => goal.content.title)).toEqual(['A goal']);
    const inB = await listGoals(ctxB, { ownerKind: 'person', ownerId: OWNER_ID });
    expect(inB.map((goal) => goal.content.title)).toEqual(['B goal']);
  });
});

describe('listGoals (the management listing)', () => {
  // Seeds (all in tenantList):
  //   Alpha   — critical, active,  person O1, horizon ends D1
  //   Epsilon — critical, archived,team  O2, horizon ends D5
  //   Beta    — high,    active,  team  O2, horizon ends D2
  //   Gamma   — medium,  active,  person O1, horizon ends D3
  //   Zeta ×2 — medium,  active,  person O2, horizon ends D4 (title tie)
  //   Delta   — low,     active,  person O1, horizon ends D4
  const O1 = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
  const O2 = '2d4b0a5c-3e6d-4fac-9b5a-9c4d8e7f6a1b';
  let alpha: Goal;
  let epsilon: Goal;
  let zetaA: Goal;
  let zetaB: Goal;

  beforeAll(async () => {
    const ctx = member(tenantList);
    alpha = await seedGoal(ctx, {
      title: 'Alpha',
      priority: 'critical',
      owner: { kind: 'person', id: O1 },
      horizonEnd: D1,
    });
    epsilon = await seedGoal(ctx, {
      title: 'Epsilon',
      priority: 'critical',
      owner: { kind: 'team', id: O2 },
      horizonEnd: D5,
    });
    await reviseGoal(ctx, {
      goalId: epsilon.id,
      status: 'archived',
      actor: { kind: 'person', id: O1 },
    });
    await seedGoal(ctx, {
      title: 'Beta',
      priority: 'high',
      owner: { kind: 'team', id: O2 },
      horizonEnd: D2,
    });
    await seedGoal(ctx, {
      title: 'Gamma',
      priority: 'medium',
      owner: { kind: 'person', id: O1 },
      horizonEnd: D3,
    });
    zetaA = await seedGoal(ctx, {
      title: 'Zeta',
      priority: 'medium',
      owner: { kind: 'person', id: O2 },
      horizonEnd: D4,
    });
    zetaB = await seedGoal(ctx, {
      title: 'Zeta',
      priority: 'medium',
      owner: { kind: 'person', id: O2 },
      horizonEnd: D4,
    });
    await seedGoal(ctx, {
      title: 'Delta',
      priority: 'low',
      owner: { kind: 'person', id: O1 },
      horizonEnd: D4,
    });
  });

  it('orders by priority rank (critical first), then title, then id', async () => {
    const goals = await listGoals(member(tenantList), {});
    expect(goals.map((goal) => goal.content.title)).toEqual([
      'Alpha',
      'Epsilon',
      'Beta',
      'Gamma',
      'Zeta',
      'Zeta',
      'Delta',
    ]);
    expect(goals[0]!.id).toBe(alpha.id);
    expect(goals[1]!.id).toBe(epsilon.id);
    // the title tie between the two Zetas resolves by goal id, ascending
    const zetas = [zetaA.id, zetaB.id].sort();
    expect(goals[4]!.id).toBe(zetas[0]);
    expect(goals[5]!.id).toBe(zetas[1]);
  });

  it('filters by status', async () => {
    const ctx = member(tenantList);
    const archived = await listGoals(ctx, { status: 'archived' });
    expect(archived.map((goal) => goal.id)).toEqual([epsilon.id]);
    const active = await listGoals(ctx, { status: 'active' });
    expect(active.map((goal) => goal.content.title)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Zeta',
      'Zeta',
      'Delta',
    ]);
  });

  it('filters by priority', async () => {
    const critical = await listGoals(member(tenantList), { priority: 'critical' });
    expect(critical.map((goal) => goal.content.title)).toEqual(['Alpha', 'Epsilon']);
  });

  it('filters by owner (kind + id)', async () => {
    const ctx = member(tenantList);
    const ofO1 = await listGoals(ctx, { ownerKind: 'person', ownerId: O1 });
    expect(ofO1.map((goal) => goal.content.title)).toEqual(['Alpha', 'Gamma', 'Delta']);
    // team O2 owns Beta and the ARCHIVED Epsilon — without a status filter,
    // archived goals are listed too (they are still the tenant's goals).
    const teams = await listGoals(ctx, { ownerKind: 'team', ownerId: O2 });
    expect(teams.map((goal) => goal.content.title)).toEqual(['Epsilon', 'Beta']);
    const activeTeams = await listGoals(ctx, {
      ownerKind: 'team',
      ownerId: O2,
      status: 'active',
    });
    expect(activeTeams.map((goal) => goal.content.title)).toEqual(['Beta']);
  });

  it('filters by horizon window (inclusive bounds on horizon end)', async () => {
    const ctx = member(tenantList);
    const window = await listGoals(ctx, { horizonEndFrom: D2, horizonEndTo: D3 });
    expect(window.map((goal) => goal.content.title)).toEqual(['Beta', 'Gamma']);
    const fromD3 = await listGoals(ctx, { horizonEndFrom: D3 });
    expect(fromD3.map((goal) => goal.content.title)).toEqual([
      'Epsilon',
      'Gamma',
      'Zeta',
      'Zeta',
      'Delta',
    ]);
    const toD2 = await listGoals(ctx, { horizonEndTo: D2 });
    expect(toD2.map((goal) => goal.content.title)).toEqual(['Alpha', 'Beta']);
  });

  it('searches titles case-insensitively and treats wildcard characters literally', async () => {
    const ctx = member(tenantList);
    const lower = await listGoals(ctx, { search: 'alpha' });
    expect(lower.map((goal) => goal.id)).toEqual([alpha.id]);
    // '%' would match everything as an ILIKE pattern — escaped, it is a
    // literal with no match among the seeded titles.
    expect(await listGoals(ctx, { search: '%' })).toEqual([]);
    // '_' would match any single character in ILIKE — escaped, no match.
    expect(await listGoals(ctx, { search: 'Z_ta' })).toEqual([]);
    expect(await listGoals(ctx, { search: 'Zeta' })).toHaveLength(2);
  });

  it('limits results', async () => {
    const first = await listGoals(member(tenantList), { limit: 2 });
    expect(first.map((goal) => goal.content.title)).toEqual(['Alpha', 'Epsilon']);
  });

  it('lists only CURRENT versions — a revised goal appears once, with its latest content', async () => {
    const ctx = member(tenantList);
    const revised = await reviseGoal(ctx, {
      goalId: alpha.id,
      title: 'Alpha prime',
      actor: { kind: 'person', id: O1 },
    });
    const goals = await listGoals(ctx, { search: 'alpha' });
    expect(goals).toHaveLength(1);
    expect(goals[0]!.id).toBe(alpha.id);
    expect(goals[0]!.version).toBe(revised.version);
    expect(goals[0]!.content.title).toBe('Alpha prime');
    // and the audit trail still holds the original
    const v1 = await getGoalVersion(ctx, { goalId: alpha.id, version: 1 });
    expect(v1.content.title).toBe('Alpha');
  });
});
