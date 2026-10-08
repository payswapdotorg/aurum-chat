// Integration tests for the context module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W134
// acceptance — "Derive a ContextFingerprint from a goal + task +
// observable context input":
//
//   * DERIVATION + PERSISTENCE — a full-observation derivation round-trips
//     exactly (every dimension, task, evidence refs, ISO derivedAt);
//   * THE NULL-SIGNAL LAW END TO END — an empty-observation derivation is
//     accepted and persists every dimension as SQL NULL; partial knowledge
//     persists partially;
//   * REF VALIDATION AT WRITE TIME — the goal must exist and be ACTIVE in
//     the asking tenant (missing, archived and foreign goals all read
//     uniformly as goal_not_found — no existence leak);
//   * APPEND-ONLY HISTORY — UPDATE/DELETE/TRUNCATE are rejected by the
//     storage triggers (fingerprints are immutable evidence);
//   * TENANT ISOLATION (ADR-0001) — another tenant's fingerprints are
//     indistinguishable from missing ones, on reads and on lists.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as contextContract from '../contract';
import { ContextError } from '../errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { createGoal, reviseGoal } from '@/modules/goals/contract';
import { runMigrations } from '../../../../scripts/migrate';

const {
  deriveFingerprint,
  getFingerprint,
  listFingerprints,
  summarizeFingerprint,
} = contextContract;

// Dedicated tenants per concern so every assertion below sees only what
// it created itself.
const tenantDerive = newId();
const tenantGoalGate = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantListA = newId();
const tenantListB = newId();
const tenantFilter = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: string, fn: () => unknown): Promise<ContextError> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ContextError);
    const typed = error as ContextError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

async function seedActiveGoal(ctx: TenantContext, title: string): Promise<string> {
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

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Derivation + persistence
// ---------------------------------------------------------------------------

describe('deriveFingerprint / getFingerprint (W134)', () => {
  it('round-trips a full-observation derivation exactly', async () => {
    const ctx = member(tenantDerive);
    const goalId = await seedActiveGoal(ctx, 'Roof rebuild');
    const fingerprint = await deriveFingerprint(ctx, {
      goalId,
      task: { title: 'Roof rebuild', kind: 'build' },
      observations: {
        season: { window: 'spring', note: 'clear weather forecast' },
        duration: { durationClass: 'short', estimatedSpan: '~6 weeks' },
        staffing: {
          headcount: 6,
          experienceMix: { novice: 5, intermediate: 0, expert: 1 },
          note: 'seasonal hires',
        },
        workload: 'heavy',
        capabilities: { available: ['scaffolding'], missing: ['crane'] },
        environment: { factors: ['windy-site'] },
        constraints: {
          budgetNote: 'fixed price',
          slaNote: null,
          qualityTarget: 'code-compliant',
          riskTolerance: 'risk-averse',
          verificationRequirements: ['engineer-signoff'],
        },
        evidenceFreshness: { maxEvidenceAge: '48h', criticalFreshSurfaces: ['weather'] },
        additionalSignals: { region: 'north-coast' },
      },
      derivedFrom: ['evidence-1', 'evidence-2'],
    });

    expect(fingerprint.fingerprintId).toMatch(/[0-9a-f-]{36}/);
    expect(fingerprint.tenantId).toBe(ctx.tenantId);
    expect(fingerprint.goalId).toBe(goalId);
    expect(Number.isNaN(new Date(fingerprint.derivedAt).getTime())).toBe(false);

    const read = await getFingerprint(ctx, { fingerprintId: fingerprint.fingerprintId });
    expect(read).toEqual(fingerprint);
    expect(read.task).toEqual({ title: 'Roof rebuild', kind: 'build' });
    expect(read.season).toEqual({ window: 'spring', note: 'clear weather forecast' });
    expect(read.staffing?.experienceMix).toEqual({ novice: 5, intermediate: 0, expert: 1 });
    expect(read.constraints?.riskTolerance).toBe('risk-averse');
    expect(read.additionalSignals).toEqual({ region: 'north-coast' });
    expect(read.derivedFrom).toEqual(['evidence-1', 'evidence-2']);
  });

  it('NULL-SIGNAL LAW end to end: empty observations persist as SQL NULLs', async () => {
    const ctx = member(tenantDerive);
    const goalId = await seedActiveGoal(ctx, 'Blank context goal');
    const fingerprint = await deriveFingerprint(ctx, { goalId });

    expect(fingerprint.task).toBeNull();
    expect(fingerprint.season).toBeNull();
    expect(fingerprint.duration).toBeNull();
    expect(fingerprint.staffing).toBeNull();
    expect(fingerprint.workload).toBeNull();
    expect(fingerprint.capabilities).toBeNull();
    expect(fingerprint.environment).toBeNull();
    expect(fingerprint.constraints).toBeNull();
    expect(fingerprint.evidenceFreshness).toBeNull();
    expect(fingerprint.additionalSignals).toEqual({});
    expect(fingerprint.derivedFrom).toEqual([]);

    const read = await getFingerprint(ctx, { fingerprintId: fingerprint.fingerprintId });
    expect(read).toEqual(fingerprint);

    const summary = summarizeFingerprint(read);
    expect(summary.headline).toBe('no known context dimensions');
    expect(summary.knownDimensions).toEqual([]);
    expect(summary.absentDimensions.length).toBe(8);

    // The null signal is real at the storage level, not just the mapper.
    const row = await getDb().query<{ season: unknown; workload: unknown }>(
      `SELECT season, workload FROM context_fingerprints WHERE id = $1`,
      [fingerprint.fingerprintId],
    );
    expect(row.rows[0]!.season).toBeNull();
    expect(row.rows[0]!.workload).toBeNull();
  });

  it('persists partial knowledge partially (no fabrication of the rest)', async () => {
    const ctx = member(tenantDerive);
    const goalId = await seedActiveGoal(ctx, 'Partial context goal');
    const fingerprint = await deriveFingerprint(ctx, {
      goalId,
      task: { kind: 'audit' },
      observations: { season: { window: 'fall', note: null }, workload: 'light' },
    });

    expect(fingerprint.task).toEqual({ title: null, kind: 'audit' });
    expect(fingerprint.season).toEqual({ window: 'fall', note: null });
    expect(fingerprint.workload).toBe('light');
    expect(fingerprint.duration).toBeNull();
    expect(fingerprint.staffing).toBeNull();

    const summary = summarizeFingerprint(fingerprint);
    expect(summary.headline).toBe('fall · audit · light workload');
    expect(summary.knownDimensions).toEqual(['season', 'workload']);
  });

  it('rejects invalid derivation input with the typed code', async () => {
    const ctx = member(tenantDerive);
    const goalId = await seedActiveGoal(ctx, 'Validation target goal');
    await expectCode('invalid_derivation_input', () =>
      deriveFingerprint(ctx, {
        goalId,
        observations: { workload: 'brutal' as never },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Goal gate (ref validation at write time)
// ---------------------------------------------------------------------------

describe('the goal gate (fingerprints follow current direction only)', () => {
  it('reads a missing goal uniformly as goal_not_found', async () => {
    const ctx = member(tenantGoalGate);
    await expectCode('goal_not_found', () =>
      deriveFingerprint(ctx, { goalId: newId() }),
    );
  });

  it('refuses an archived goal (uniformly, like a missing one)', async () => {
    const ctx = member(tenantGoalGate);
    const goalId = await seedActiveGoal(ctx, 'Soon archived');
    await reviseGoal(ctx, {
      goalId,
      status: 'archived',
      actor: { kind: 'system', label: 'w134-test' },
      rationale: 'direction changed',
    });
    await expectCode('goal_not_found', () => deriveFingerprint(ctx, { goalId }));
  });

  it('reads another tenant\'s goal uniformly as goal_not_found', async () => {
    const ownerCtx = member(tenantGoalGate);
    const goalId = await seedActiveGoal(ownerCtx, 'Foreign tenant goal');
    const otherCtx = member(newId());
    await expectCode('goal_not_found', () => deriveFingerprint(otherCtx, { goalId }));
  });
});

// ---------------------------------------------------------------------------
// Append-only history
// ---------------------------------------------------------------------------

describe('append-only fingerprint history', () => {
  it('rejects UPDATE, DELETE and TRUNCATE at the storage level', async () => {
    const ctx = member(tenantDerive);
    const goalId = await seedActiveGoal(ctx, 'Immutability witness goal');
    const fingerprint = await deriveFingerprint(ctx, { goalId });

    await expect(getDb().query(`UPDATE context_fingerprints SET workload = 'light' WHERE id = $1`, [
      fingerprint.fingerprintId,
    ])).rejects.toThrow(/append-only/);
    await expect(getDb().query(`DELETE FROM context_fingerprints WHERE id = $1`, [
      fingerprint.fingerprintId,
    ])).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE context_fingerprints`)).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('makes another tenant\'s fingerprint indistinguishable from missing', async () => {
    const ctxA = member(tenantIsoA);
    const goalA = await seedActiveGoal(ctxA, 'Tenant A goal');
    const fingerprintA = await deriveFingerprint(ctxA, {
      goalId: goalA,
      observations: { season: { window: 'spring', note: null } },
    });

    const ctxB = member(tenantIsoB);
    await expectCode('fingerprint_not_found', () =>
      getFingerprint(ctxB, { fingerprintId: fingerprintA.fingerprintId }),
    );
  });

  it('scopes listFingerprints to the asking tenant', async () => {
    const ctxA = member(tenantListA);
    const ctxB = member(tenantListB);
    const goalA = await seedActiveGoal(ctxA, 'Tenant A list goal');
    const goalB = await seedActiveGoal(ctxB, 'Tenant B list goal');
    await deriveFingerprint(ctxA, { goalId: goalA });
    await deriveFingerprint(ctxA, { goalId: goalA });
    await deriveFingerprint(ctxB, { goalId: goalB });

    const listA = await listFingerprints(ctxA);
    const listB = await listFingerprints(ctxB);
    expect(listA.length).toBe(2);
    expect(listB.length).toBe(1);
    expect(listA.every((fp) => fp.tenantId === tenantListA)).toBe(true);
    expect(listB.every((fp) => fp.tenantId === tenantListB)).toBe(true);
  });

  it('filters by goal and lists newest-first with a limit', async () => {
    const ctx = member(tenantFilter);
    const goalOne = await seedActiveGoal(ctx, 'Filter goal one');
    const goalTwo = await seedActiveGoal(ctx, 'Filter goal two');
    await deriveFingerprint(ctx, { goalId: goalOne });
    await deriveFingerprint(ctx, { goalId: goalTwo });
    await deriveFingerprint(ctx, { goalId: goalOne });

    const forGoalOne = await listFingerprints(ctx, { goalId: goalOne });
    expect(forGoalOne.length).toBe(2);
    expect(forGoalOne.every((fp) => fp.goalId === goalOne)).toBe(true);

    const limited = await listFingerprints(ctx, { limit: 1 });
    expect(limited.length).toBe(1);

    const all = await listFingerprints(ctx);
    expect(all.length).toBe(3);
    // Newest-first (derived_at DESC); ties broken deterministically by id.
    for (let index = 1; index < all.length; index += 1) {
      const previous = new Date(all[index - 1]!.derivedAt).getTime();
      const current = new Date(all[index]!.derivedAt).getTime();
      expect(previous).toBeGreaterThanOrEqual(current);
    }
  });

  it('rejects malformed queries with the typed code', async () => {
    const ctx = member(tenantIsoB);
    await expectCode('invalid_query', () =>
      getFingerprint(ctx, { fingerprintId: 'not-a-uuid' }),
    );
    await expectCode('invalid_query', () =>
      listFingerprints(ctx, { limit: 0 }),
    );
  });
});
