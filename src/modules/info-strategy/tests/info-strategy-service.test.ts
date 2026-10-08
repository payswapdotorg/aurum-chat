// Integration tests for the info-strategy module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W134
// acceptance — "what to know, source choice, freshness/confidence, cost
// and escalation are represented and outcome-tunable; existing
// Unknown/LearningMission/KnowledgeAcquisition authorities remain
// canonical":
//
//   * REPRESENTATION — a full strategy (requirements against REAL
//     epistemics unknowns, preferred sources, freshness/confidence
//     targets, cost ceilings, escalation thresholds) round-trips exactly;
//   * CONTEXT-CONDITIONED SCOPING — one ACTIVE strategy per (tenant,
//     goal, fingerprint); the same goal under a DIFFERENT fingerprint
//     yields a different, equally legitimate strategy (the contextual
//     rule as DATA, never code);
//   * VERSIONED, IMMUTABLE, OUTCOME-TUNABLE — adjustments append new
//     versions carrying outcome evidence; omitted fields carry over;
//     historical versions are immutable (trigger-enforced) and version
//     numbers are unique per (tenant, strategy) (constraint-enforced);
//   * REF VALIDATION AT WRITE TIME — goal active, fingerprint readable,
//     tracked unknowns readable — all through the owning contracts, all
//     uniformly not-found (no existence leak);
//   * LIFECYCLE — retirement is one-way with a retained reason, and a
//     retired strategy frees the scope for a successor definition;
//   * TENANT ISOLATION (ADR-0001) — another tenant's strategies and
//     versions are indistinguishable from missing ones.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as infoStrategyContract from '../contract';
import { InfoStrategyError } from '../errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { createGoal, reviseGoal } from '@/modules/goals/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import { deriveFingerprint } from '@/modules/context/contract';

const {
  adjustStrategy,
  defineStrategy,
  getStrategy,
  getStrategyVersion,
  listStrategies,
  listStrategyVersions,
  retireStrategy,
} = infoStrategyContract;

// Dedicated tenants per concern so every assertion below sees only what
// it created itself.
const tenantRepresent = newId();
const tenantScope = newId();
const tenantVersioning = newId();
const tenantLifecycle = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantList = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: string, fn: () => unknown): Promise<InfoStrategyError> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(InfoStrategyError);
    const typed = error as InfoStrategyError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

async function seedGoal(ctx: TenantContext, title: string): Promise<string> {
  const goal = await createGoal(ctx, {
    title,
    objective: `Objective of ${title}`,
    desiredState: `Desired state of ${title}`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'team', label: 'operations' },
    priority: 'high',
    successCriteria: 'Measurable success',
    actor: { kind: 'system', label: 'w134-test' },
  });
  return goal.id;
}

async function seedFingerprint(
  ctx: TenantContext,
  goalId: string,
  season: string,
): Promise<string> {
  const fingerprint = await deriveFingerprint(ctx, {
    goalId,
    observations: {
      season: { window: season, note: null },
      staffing: { headcount: 6, experienceMix: { novice: 5, intermediate: 0, expert: 1 }, note: null },
    },
  });
  return fingerprint.fingerprintId;
}

async function seedUnknown(
  ctx: TenantContext,
  question: string,
): Promise<string> {
  const unknown = await recordUnknown(ctx, {
    question,
    consequence: `Not knowing this blocks the decision it names`,
  });
  return unknown.id;
}

/** A ready-to-define strategy body against real fixture refs. */
async function strategyBody(ctx: TenantContext, goalId: string, unknownId: string) {
  return {
    goalId,
    fingerprintId: await seedFingerprint(ctx, goalId, 'spring'),
    content: {
      knowledgeRequirements: [
        {
          unknownId,
          targetConfidence: 0.9,
          maxEvidenceAgeSeconds: 172_800,
          rationale: 'Safety-critical driver knowledge',
        },
      ],
      preferredSources: [
        { registry: 'source', ref: 'source-1', rationale: 'Licensed engineer feed' },
      ],
      costCeilings: [{ scope: 'per-strategy', amount: 500_000, currency: 'EUR' }],
      escalationThresholds: [
        { trigger: 'failed-attempts', afterAttempts: 2, note: 'Escalate to senior operator' },
      ],
    },
    note: 'Initial hypothesis',
    derivedFrom: [],
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Representation + write-time ref validation
// ---------------------------------------------------------------------------

describe('defineStrategy / getStrategy (W134 representation)', () => {
  it('round-trips a full strategy: what to know, sources, targets, cost, escalation', async () => {
    const ctx = member(tenantRepresent);
    const goalId = await seedGoal(ctx, 'Roof rebuild');
    const unknownId = await seedUnknown(ctx, 'What drives roof-tile breakage on windy sites?');
    const input = await strategyBody(ctx, goalId, unknownId);
    const strategy = await defineStrategy(ctx, input);

    expect(strategy.id).toMatch(/[0-9a-f-]{36}/);
    expect(strategy.tenantId).toBe(ctx.tenantId);
    expect(strategy.goalId).toBe(goalId);
    expect(strategy.fingerprintId).toBe(input.fingerprintId);
    expect(strategy.status).toBe('active');
    expect(strategy.currentVersion).toBe(1);
    expect(strategy.note).toBe('Initial hypothesis');
    expect(strategy.outcomeEvidence).toEqual([]);
    expect(strategy.lifecycleNote).toBeNull();
    expect(strategy.retiredAt).toBeNull();
    expect(Number.isNaN(new Date(strategy.createdAt).getTime())).toBe(false);

    const read = await getStrategy(ctx, { strategyId: strategy.id });
    expect(read).toEqual(strategy);
    expect(read.content.knowledgeRequirements).toEqual([
      {
        unknownId,
        targetConfidence: 0.9,
        maxEvidenceAgeSeconds: 172_800,
        rationale: 'Safety-critical driver knowledge',
      },
    ]);
    expect(read.content.preferredSources).toEqual([
      { registry: 'source', ref: 'source-1', rationale: 'Licensed engineer feed' },
    ]);
    expect(read.content.costCeilings).toEqual([
      { scope: 'per-strategy', amount: 500_000, currency: 'EUR' },
    ]);
    expect(read.content.escalationThresholds).toEqual([
      { trigger: 'failed-attempts', afterAttempts: 2, note: 'Escalate to senior operator' },
    ]);
  });

  it('validates the goal at write time (active only, uniform not-found)', async () => {
    const ctx = member(tenantRepresent);
    const unknownId = await seedUnknown(ctx, 'What drives churn?');
    await expectCode('goal_not_found', () =>
      defineStrategy(ctx, {
        goalId: newId(),
        fingerprintId: newId(),
        content: {
          knowledgeRequirements: [{ unknownId, targetConfidence: 0.5, rationale: 'R' }],
        },
      }),
    );

    const goalId = await seedGoal(ctx, 'Soon archived strategy goal');
    await reviseGoal(ctx, {
      goalId,
      status: 'archived',
      actor: { kind: 'system', label: 'w134-test' },
      rationale: 'direction changed',
    });
    await expectCode('goal_not_found', () =>
      defineStrategy(ctx, {
        goalId,
        fingerprintId: newId(),
        content: {
          knowledgeRequirements: [{ unknownId, targetConfidence: 0.5, rationale: 'R' }],
        },
      }),
    );
  });

  it('validates the fingerprint at write time (the strategy layer never re-derives context)', async () => {
    const ctx = member(tenantRepresent);
    const goalId = await seedGoal(ctx, 'Fingerprint gate goal');
    const unknownId = await seedUnknown(ctx, 'What drives delivery latency?');
    await expectCode('fingerprint_not_found', () =>
      defineStrategy(ctx, {
        goalId,
        fingerprintId: newId(),
        content: {
          knowledgeRequirements: [{ unknownId, targetConfidence: 0.5, rationale: 'R' }],
        },
      }),
    );
  });

  it('validates tracked unknowns at write time — reference, never duplicate, the Unknown authority', async () => {
    const ctx = member(tenantRepresent);
    const goalId = await seedGoal(ctx, 'Unknown gate goal');
    const fingerprintId = await seedFingerprint(ctx, goalId, 'summer');
    await expectCode('unknown_not_found', () =>
      defineStrategy(ctx, {
        goalId,
        fingerprintId,
        content: {
          knowledgeRequirements: [
            { unknownId: newId(), targetConfidence: 0.5, rationale: 'Ghost unknown' },
          ],
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Context-conditioned scoping (the contextual rule as data)
// ---------------------------------------------------------------------------

describe('context-conditioned scoping (the contextual rule)', () => {
  it('allows ONE active strategy per (goal, fingerprint) and refuses duplicates', async () => {
    const ctx = member(tenantScope);
    const goalId = await seedGoal(ctx, 'Scope witness goal');
    const unknownId = await seedUnknown(ctx, 'What drives scope churn?');
    const fingerprintId = await seedFingerprint(ctx, goalId, 'spring');
    const body = {
      goalId,
      fingerprintId,
      content: {
        knowledgeRequirements: [{ unknownId, targetConfidence: 0.5, rationale: 'R' }],
      },
    };
    await defineStrategy(ctx, body);
    await expectCode('strategy_already_defined', () => defineStrategy(ctx, { ...body, note: 'Again' }));
  });

  it('holds DIFFERENT strategies for the same goal under different fingerprints (divergence is data)', async () => {
    const ctx = member(tenantScope);
    const goalId = await seedGoal(ctx, 'Season-sensitive goal');
    const unknownId = await seedUnknown(ctx, 'What drives schedule slip?');

    // Spring + novice-heavy crew: fresher evidence, tighter escalation.
    const springFingerprint = await seedFingerprint(ctx, goalId, 'spring');
    const springStrategy = await defineStrategy(ctx, {
      goalId,
      fingerprintId: springFingerprint,
      content: {
        knowledgeRequirements: [
          { unknownId, targetConfidence: 0.9, maxEvidenceAgeSeconds: 172_800, rationale: 'Novice crew needs current safety evidence' },
        ],
        escalationThresholds: [
          { trigger: 'failed-attempts', afterAttempts: 2, note: 'Escalate early for novices' },
        ],
      },
      note: 'Spring hypothesis: fresh evidence, fast escalation',
    });

    // Fall + (fingerprint carries no staffing difference here, but a
    // materially different context record) — a legitimately different
    // strategy: calmer escalation, longer freshness tolerance.
    const fallFingerprint = await seedFingerprint(ctx, goalId, 'fall');
    const fallStrategy = await defineStrategy(ctx, {
      goalId,
      fingerprintId: fallFingerprint,
      content: {
        knowledgeRequirements: [
          { unknownId, targetConfidence: 0.7, maxEvidenceAgeSeconds: 2_592_000, rationale: 'Settled crew tolerates older evidence' },
        ],
        escalationThresholds: [
          { trigger: 'failed-attempts', afterAttempts: 5, note: 'Escalate only after repeated failure' },
        ],
      },
      note: 'Fall hypothesis: calmer season, calmer escalation',
    });

    expect(springStrategy.id).not.toBe(fallStrategy.id);
    const readSpring = await getStrategy(ctx, { strategyId: springStrategy.id });
    const readFall = await getStrategy(ctx, { strategyId: fallStrategy.id });
    expect(readSpring.content.knowledgeRequirements[0]?.maxEvidenceAgeSeconds).toBe(172_800);
    expect(readFall.content.knowledgeRequirements[0]?.maxEvidenceAgeSeconds).toBe(2_592_000);
    expect(readSpring.content.escalationThresholds[0]?.afterAttempts).toBe(2);
    expect(readFall.content.escalationThresholds[0]?.afterAttempts).toBe(5);

    // Both are first-class current strategies of the SAME goal — listed
    // together, each conditioned on its own context.
    const forGoal = await listStrategies(ctx, { goalId });
    expect(forGoal.length).toBe(2);
    expect(new Set(forGoal.map((s) => s.fingerprintId))).toEqual(
      new Set([springFingerprint, fallFingerprint]),
    );
  });
});

// ---------------------------------------------------------------------------
// Versioning: immutable history + outcome tuning
// ---------------------------------------------------------------------------

describe('versioned adjustments (the learning loop)', () => {
  it('appends version 2 with merged content and immutable version 1', async () => {
    const ctx = member(tenantVersioning);
    const goalId = await seedGoal(ctx, 'Versioning goal');
    const unknownId = await seedUnknown(ctx, 'What drives cost overrun?');
    const strategy = await defineStrategy(ctx, await strategyBody(ctx, goalId, unknownId));

    const adjusted = await adjustStrategy(ctx, {
      strategyId: strategy.id,
      changes: {
        // Arrays replace wholesale; omitted fields carry over unchanged.
        knowledgeRequirements: [
          { unknownId, targetConfidence: 0.75, maxEvidenceAgeSeconds: 604_800, rationale: 'Relaxed after outcome' },
        ],
        escalationThresholds: [
          { trigger: 'confidence-shortfall', note: 'Re-plan the strategy when targets are missed' },
        ],
      },
      outcomeEvidence: [
        {
          kind: 'mission',
          ref: 'mission-1',
          observed: 'The 48h freshness target was unachievable; 7-day evidence sufficed',
        },
      ],
      note: 'Relaxed freshness and escalation after mission outcomes',
    });

    expect(adjusted.currentVersion).toBe(2);
    expect(adjusted.content.knowledgeRequirements).toEqual([
      { unknownId, targetConfidence: 0.75, maxEvidenceAgeSeconds: 604_800, rationale: 'Relaxed after outcome' },
    ]);
    // Carried over wholesale (not patched per-item):
    expect(adjusted.content.preferredSources).toEqual(strategy.content.preferredSources);
    expect(adjusted.content.costCeilings).toEqual(strategy.content.costCeilings);
    expect(adjusted.content.escalationThresholds).toEqual([
      { trigger: 'confidence-shortfall', afterAttempts: null, note: 'Re-plan the strategy when targets are missed' },
    ]);
    expect(adjusted.outcomeEvidence).toEqual([
      { kind: 'mission', ref: 'mission-1', observed: 'The 48h freshness target was unachievable; 7-day evidence sufficed' },
    ]);
    expect(adjusted.note).toBe('Relaxed freshness and escalation after mission outcomes');

    // Version 1 is unchanged history.
    const versionOne = await getStrategyVersion(ctx, { strategyId: strategy.id, version: 1 });
    expect(versionOne.content.knowledgeRequirements[0]?.maxEvidenceAgeSeconds).toBe(172_800);
    expect(versionOne.outcomeEvidence).toEqual([]);
    expect(versionOne.note).toBe('Initial hypothesis');

    const history = await listStrategyVersions(ctx, { strategyId: strategy.id });
    expect(history.map((v) => v.version)).toEqual([1, 2]);
  });

  it('accepts an outcome-evidence-only adjustment (recording learning without changing content)', async () => {
    const ctx = member(tenantVersioning);
    const goalId = await seedGoal(ctx, 'Evidence-only goal');
    const unknownId = await seedUnknown(ctx, 'What drives downtime?');
    const strategy = await defineStrategy(ctx, await strategyBody(ctx, goalId, unknownId));

    const adjusted = await adjustStrategy(ctx, {
      strategyId: strategy.id,
      outcomeEvidence: [
        { kind: 'acquisition-plan', ref: 'plan-7', observed: 'Cost ceiling hit without confidence gain' },
      ],
      note: 'Recorded for the next strategy decision',
    });
    expect(adjusted.currentVersion).toBe(2);
    expect(adjusted.content).toEqual(strategy.content);
    expect(adjusted.outcomeEvidence).toHaveLength(1);
  });

  it('refuses an adjustment that records nothing', async () => {
    const ctx = member(tenantVersioning);
    const goalId = await seedGoal(ctx, 'Empty adjustment goal');
    const unknownId = await seedUnknown(ctx, 'What drives rework?');
    const strategy = await defineStrategy(ctx, await strategyBody(ctx, goalId, unknownId));
    await expectCode('invalid_adjustment_input', () =>
      adjustStrategy(ctx, { strategyId: strategy.id, note: 'Nothing actually changed' }),
    );
  });

  it('validates unknown refs on adjustment, including carried-over requirements', async () => {
    const ctx = member(tenantVersioning);
    const goalId = await seedGoal(ctx, 'Adjustment gate goal');
    const unknownId = await seedUnknown(ctx, 'What drives escalation latency?');
    const strategy = await defineStrategy(ctx, await strategyBody(ctx, goalId, unknownId));
    await expectCode('unknown_not_found', () =>
      adjustStrategy(ctx, {
        strategyId: strategy.id,
        changes: {
          knowledgeRequirements: [
            { unknownId: newId(), targetConfidence: 0.5, rationale: 'Ghost on adjust' },
          ],
        },
        note: 'Tries to track a ghost unknown',
      }),
    );
  });

  it('makes version history immutable (UPDATE/DELETE/TRUNCATE rejected) and version numbers per-tenant unique', async () => {
    const ctx = member(tenantVersioning);
    const goalId = await seedGoal(ctx, 'Immutability goal');
    const unknownId = await seedUnknown(ctx, 'What drives audit failures?');
    const strategy = await defineStrategy(ctx, await strategyBody(ctx, goalId, unknownId));
    await adjustStrategy(ctx, {
      strategyId: strategy.id,
      outcomeEvidence: [{ kind: 'other', ref: 'note-1', observed: 'Learning recorded' }],
      note: 'Second version for the immutability proof',
    });

    const versionRow = await getDb().query<{ id: string }>(
      `SELECT id FROM info_strategy_versions WHERE tenant_id = $1 AND strategy_id = $2 AND version = 1`,
      [ctx.tenantId, strategy.id],
    );
    const versionId = versionRow.rows[0]!.id;

    await expect(
      getDb().query(`UPDATE info_strategy_versions SET note = 'rewritten' WHERE id = $1`, [versionId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM info_strategy_versions WHERE id = $1`, [versionId]),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE info_strategy_versions`)).rejects.toThrow(/append-only/);

    // Version uniqueness scoped per (tenant, strategy): the constraint
    // itself refuses a second row for the same version number.
    await expect(
      getDb().query(
        `INSERT INTO info_strategy_versions (id, tenant_id, strategy_id, version, document, recorded_by)
         VALUES ($1, $2, $3, 1, '{}'::jsonb, 'constraint-proof')`,
        [newId(), ctx.tenantId, strategy.id],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    // A DIFFERENT strategy in the SAME tenant may hold its own version 1
    // (per-tenant scoping means per-strategy, not per-tenant global).
    const otherGoalId = await seedGoal(ctx, 'Parallel versioning goal');
    const otherUnknownId = await seedUnknown(ctx, 'What drives parallel drift?');
    const other = await defineStrategy(ctx, await strategyBody(ctx, otherGoalId, otherUnknownId));
    expect(other.currentVersion).toBe(1);
  });

  it('mints version numbers strictly sequentially (never caller-supplied)', async () => {
    const ctx = member(tenantVersioning);
    const goalId = await seedGoal(ctx, 'Sequential versions goal');
    const unknownId = await seedUnknown(ctx, 'What drives sequencing?');
    const strategy = await defineStrategy(ctx, await strategyBody(ctx, goalId, unknownId));
    for (let index = 2; index <= 4; index += 1) {
      const adjusted = await adjustStrategy(ctx, {
        strategyId: strategy.id,
        outcomeEvidence: [{ kind: 'other', ref: `obs-${index}`, observed: `Observation ${index}` }],
        note: `Adjustment ${index}`,
      });
      expect(adjusted.currentVersion).toBe(index);
    }
    const history = await listStrategyVersions(ctx, { strategyId: strategy.id });
    expect(history.map((v) => v.version)).toEqual([1, 2, 3, 4]);

    await expectCode('strategy_version_not_found', () =>
      getStrategyVersion(ctx, { strategyId: strategy.id, version: 99 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('retirement (one-way, scope-freeing)', () => {
  it('retires with a retained reason, refuses further adjustment and re-definition, then frees the scope', async () => {
    const ctx = member(tenantLifecycle);
    const goalId = await seedGoal(ctx, 'Lifecycle goal');
    const unknownId = await seedUnknown(ctx, 'What drives retirement?');
    const fingerprintId = await seedFingerprint(ctx, goalId, 'winter');
    const content = {
      knowledgeRequirements: [{ unknownId, targetConfidence: 0.5, rationale: 'R' }],
    };

    const first = await defineStrategy(ctx, { goalId, fingerprintId, content });
    const retired = await retireStrategy(ctx, {
      strategyId: first.id,
      reason: 'Context fingerprint superseded by a re-derivation',
    });
    expect(retired.status).toBe('retired');
    expect(retired.lifecycleNote).toBe('Context fingerprint superseded by a re-derivation');
    expect(retired.retiredAt).not.toBeNull();
    // Content history is still fully readable on the retired strategy.
    expect(retired.content.knowledgeRequirements).toHaveLength(1);

    // Retirement is one-way: a second retire reads as already-retired.
    await expectCode('strategy_retired', () =>
      retireStrategy(ctx, { strategyId: first.id, reason: 'Again' }),
    );
    // Terminal: no further adjustments.
    await expectCode('strategy_retired', () =>
      adjustStrategy(ctx, {
        strategyId: first.id,
        outcomeEvidence: [{ kind: 'other', ref: 'x', observed: 'Nope' }],
        note: 'Post-retirement adjustment',
      }),
    );

    // The scope is FREE: a successor strategy may be defined for the same
    // goal + fingerprint (the returning need is a new definition).
    const successor = await defineStrategy(ctx, {
      goalId,
      fingerprintId,
      content,
      note: 'Successor after retirement',
    });
    expect(successor.id).not.toBe(first.id);
    expect(successor.status).toBe('active');
  });

  it('keeps retired strategies readable through the list filters', async () => {
    const ctx = member(tenantLifecycle);
    const goalId = await seedGoal(ctx, 'Retired listing goal');
    const unknownId = await seedUnknown(ctx, 'What drives listing?');
    const strategy = await defineStrategy(ctx, await strategyBody(ctx, goalId, unknownId));
    await retireStrategy(ctx, { strategyId: strategy.id, reason: 'Direction changed' });

    const retiredList = await listStrategies(ctx, { status: 'retired' });
    expect(retiredList.some((s) => s.id === strategy.id)).toBe(true);
    const activeList = await listStrategies(ctx, { status: 'active' });
    expect(activeList.some((s) => s.id === strategy.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('makes another tenant\'s strategy indistinguishable from missing (reads and deep links)', async () => {
    const ctxA = member(tenantIsoA);
    const ctxB = member(tenantIsoB);
    const goalA = await seedGoal(ctxA, 'Tenant A strategy goal');
    const unknownA = await seedUnknown(ctxA, 'What drives isolation?');
    const strategyA = await defineStrategy(ctxA, await strategyBody(ctxA, goalA, unknownA));
    await adjustStrategy(ctxA, {
      strategyId: strategyA.id,
      outcomeEvidence: [{ kind: 'other', ref: 'a-1', observed: 'Tenant A learning' }],
      note: 'Tenant A adjustment',
    });

    await expectCode('strategy_not_found', () =>
      getStrategy(ctxB, { strategyId: strategyA.id }),
    );
    await expectCode('strategy_not_found', () =>
      getStrategyVersion(ctxB, { strategyId: strategyA.id, version: 1 }),
    );
    await expectCode('strategy_not_found', () =>
      listStrategyVersions(ctxB, { strategyId: strategyA.id }),
    );
    await expectCode('strategy_not_found', () =>
      adjustStrategy(ctxB, {
        strategyId: strategyA.id,
        outcomeEvidence: [{ kind: 'other', ref: 'b-1', observed: 'Cross-tenant write attempt' }],
        note: 'Should never land',
      }),
    );
    await expectCode('strategy_not_found', () =>
      retireStrategy(ctxB, { strategyId: strategyA.id, reason: 'Should never land' }),
    );
    expect((await listStrategies(ctxB)).length).toBe(0);
  });

  it('reads a foreign fingerprint or unknown uniformly as not-found (no existence leak through refs)', async () => {
    const ctxA = member(tenantIsoA);
    const ctxB = member(tenantIsoB);
    const goalB = await seedGoal(ctxB, 'Tenant B own goal');
    const unknownA = await seedUnknown(ctxA, 'Tenant A unknown');
    const fingerprintB = await seedFingerprint(ctxB, goalB, 'spring');

    // Tenant B cannot build a strategy on tenant A's unknown...
    await expectCode('unknown_not_found', () =>
      defineStrategy(ctxB, {
        goalId: goalB,
        fingerprintId: fingerprintB,
        content: {
          knowledgeRequirements: [{ unknownId: unknownA, targetConfidence: 0.5, rationale: 'R' }],
        },
      }),
    );
    // ...nor on tenant A's fingerprint (created against tenant A's goal).
    const goalA = await seedGoal(ctxA, 'Tenant A fingerprint source goal');
    const fingerprintA = await seedFingerprint(ctxA, goalA, 'fall');
    const unknownB = await seedUnknown(ctxB, 'Tenant B unknown');
    await expectCode('fingerprint_not_found', () =>
      defineStrategy(ctxB, {
        goalId: goalB,
        fingerprintId: fingerprintA,
        content: {
          knowledgeRequirements: [{ unknownId: unknownB, targetConfidence: 0.5, rationale: 'R' }],
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('listStrategies (filters and summaries)', () => {
  it('filters by goal, fingerprint and status with version counts', async () => {
    const ctx = member(tenantList);
    const goalOne = await seedGoal(ctx, 'List goal one');
    const goalTwo = await seedGoal(ctx, 'List goal two');
    const unknownId = await seedUnknown(ctx, 'What drives listing quality?');

    const oneSpring = await defineStrategy(ctx, await strategyBody(ctx, goalOne, unknownId));
    const oneFall = await defineStrategy(ctx, {
      goalId: goalOne,
      fingerprintId: await seedFingerprint(ctx, goalOne, 'fall'),
      content: {
        knowledgeRequirements: [{ unknownId, targetConfidence: 0.5, rationale: 'R' }],
      },
    });
    await defineStrategy(ctx, {
      goalId: goalTwo,
      fingerprintId: await seedFingerprint(ctx, goalTwo, 'spring'),
      content: {
        knowledgeRequirements: [{ unknownId, targetConfidence: 0.5, rationale: 'R' }],
      },
    });
    await adjustStrategy(ctx, {
      strategyId: oneSpring.id,
      outcomeEvidence: [{ kind: 'other', ref: 'o-1', observed: 'Learning on one-spring' }],
      note: 'Bumped for the version-count proof',
    });
    await retireStrategy(ctx, { strategyId: oneFall.id, reason: 'Fall season ended' });

    const forGoalOne = await listStrategies(ctx, { goalId: goalOne });
    expect(forGoalOne.length).toBe(2);

    const byFingerprint = await listStrategies(ctx, { fingerprintId: oneSpring.fingerprintId });
    expect(byFingerprint.length).toBe(1);
    expect(byFingerprint[0]!.id).toBe(oneSpring.id);
    expect(byFingerprint[0]!.versionCount).toBe(2);
    expect(byFingerprint[0]!.currentVersion).toBe(2);

    const activeForGoalOne = await listStrategies(ctx, { goalId: goalOne, status: 'active' });
    expect(activeForGoalOne.map((s) => s.id)).toEqual([oneSpring.id]);

    const all = await listStrategies(ctx);
    expect(all.length).toBe(3);
  });
});
