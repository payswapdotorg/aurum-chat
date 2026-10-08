// WB2 integration (2026-10-07) — Tenant Isolation Verification · sweep for
// the info-strategy module (W134: goal/context-conditioned information
// strategy — what to know, source choice, freshness/confidence, cost and
// escalation, outcome-tunable).
//
// REAL two-tenant service proof in the W044 house style (the manifest v9
// registration): tenant A defines a strategy scoped to a real goal + real
// context fingerprint + real epistemics unknown (all through their owning
// contracts), and tenant B must see none of it:
//
//   * empty-list invisibility — B's listStrategies is empty before it
//     defines its own;
//   * uniform not-found — a FOREIGN strategy id and a MISSING one reject
//     identically (`strategy_not_found`) on the strategy and version
//     surfaces — no existence leak (ADR-0001);
//   * cross-tenant writes are refused with the SAME uniform not-founds
//     mapped from the owning contracts (`goal_not_found`,
//     `fingerprint_not_found`) — B cannot define a strategy on A's scope
//     and cannot even learn it exists;
//   * same natural keys coexist per tenant — the SAME (goal, fingerprint)
//     scope shape with the SAME content lives independently in both
//     tenants (one ACTIVE strategy per scope per tenant), and the
//     versioned learning loop (adjustStrategy) stays per-tenant.
//
// Scope rules honored here: info-strategy code is imported ONLY through
// '@/modules/info-strategy/contract'; the goals/context/epistemics
// fixtures come through their public contracts (the consumed seams,
// exercised as real records — never direct SQL writes).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';

import {
  InfoStrategyError,
  adjustStrategy,
  defineStrategy,
  getStrategy,
  getStrategyVersion,
  listStrategies,
  listStrategyVersions,
} from '@/modules/info-strategy/contract';
import type { InfoStrategyErrorCode } from '@/modules/info-strategy/contract';
import { createGoal } from '@/modules/goals/contract';
import { deriveFingerprint } from '@/modules/context/contract';
import { recordUnknown } from '@/modules/epistemics/contract';

const tenantSweepA = newId();
const tenantSweepB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: InfoStrategyErrorCode, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(InfoStrategyError);
    expect((error as InfoStrategyError).code).toBe(code);
  }
}

function sweepGoalInput(title: string) {
  return {
    title,
    objective: `Objective of ${title}`,
    desiredState: `Desired state of ${title}`,
    horizonEnd: '2027-12-31T00:00:00.000Z',
    owner: { kind: 'team' as const, label: 'operations' },
    priority: 'high' as const,
    successCriteria: 'Measurable success',
    actor: { kind: 'system' as const, label: 'wb2-sweep' },
  };
}

function sweepObservations() {
  return {
    season: { window: 'spring', note: 'clear weather forecast' },
    duration: { durationClass: 'short' as const, estimatedSpan: '~6 weeks' },
    workload: 'light' as const,
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 info-strategy — goal/context-conditioned strategies (W134) are tenant-scoped', () => {
  it("tenant A's strategies and versions are invisible to tenant B; the same scope shape coexists per tenant", async () => {
    const ctxA = member(tenantSweepA);
    const ctxB = member(tenantSweepB);

    // ---- Tenant A: a real strategy on a real (goal, fingerprint) scope --
    const goalA = await createGoal(ctxA, sweepGoalInput('WB2 sweep strategy goal'));
    const fingerprintA = await deriveFingerprint(ctxA, {
      goalId: goalA.id,
      observations: sweepObservations(),
      derivedFrom: ['wb2-sweep-obs-1'],
    });
    const unknownA = await recordUnknown(ctxA, {
      question: 'Which information sources hold the spring dispatch context?',
      consequence: 'Not knowing this blocks the spring staffing decision.',
    });
    const strategyA = await defineStrategy(ctxA, {
      goalId: goalA.id,
      fingerprintId: fingerprintA.fingerprintId,
      content: {
        knowledgeRequirements: [
          {
            unknownId: unknownA.id,
            targetConfidence: 0.8,
            rationale: 'The spring window decision depends on it.',
          },
        ],
        preferredSources: [
          { registry: 'source', ref: 'src-traffic', rationale: 'live traffic feed' },
        ],
        costCeilings: [{ scope: 'per-acquisition', amount: 500, currency: 'USD' }],
        escalationThresholds: [{ trigger: 'failed-attempts', afterAttempts: 3 }],
      },
      note: 'wb2 sweep strategy (tenant A)',
    });
    expect(strategyA.tenantId).toBe(tenantSweepA);
    expect(strategyA.status).toBe('active');

    // One ACTIVE strategy per scope: defining again for the SAME scope is
    // refused with the typed code (nothing appended).
    await expectCode('strategy_already_defined', () =>
      defineStrategy(ctxA, {
        goalId: goalA.id,
        fingerprintId: fingerprintA.fingerprintId,
        content: { knowledgeRequirements: [{ unknownId: unknownA.id, targetConfidence: 0.9, rationale: 'dup scope probe' }] },
        note: 'duplicate scope probe',
      }),
    );

    // ---- Tenant B sees none of it --------------------------------------
    expect(await listStrategies(ctxB, {})).toHaveLength(0);

    // Uniform not-found: a FOREIGN strategy id and a MISSING one are
    // indistinguishable, on the strategy surface AND the version surface
    // (the version lookup gates on the strategy first — same uniform
    // code). The version surface's own code surfaces only for a strategy
    // that EXISTS with a version number that does not.
    await expectCode('strategy_not_found', () =>
      getStrategy(ctxB, { strategyId: strategyA.id }),
    );
    await expectCode('strategy_not_found', () =>
      getStrategy(ctxB, { strategyId: newId() }),
    );
    await expectCode('strategy_not_found', () =>
      getStrategyVersion(ctxB, { strategyId: strategyA.id, version: 1 }),
    );
    await expectCode('strategy_not_found', () =>
      listStrategyVersions(ctxB, { strategyId: strategyA.id }),
    );
    await expectCode('strategy_version_not_found', () =>
      getStrategyVersion(ctxA, { strategyId: strategyA.id, version: 99 }),
    );

    // Cross-tenant WRITES are refused with the same uniform not-founds
    // mapped from the owning contracts: B cannot define a strategy on A's
    // goal (nor on A's goal + A's fingerprint) and cannot learn they exist
    // (the goal gate fires before any unknown-ref resolution).
    await expectCode('goal_not_found', () =>
      defineStrategy(ctxB, {
        goalId: goalA.id,
        fingerprintId: fingerprintA.fingerprintId,
        content: {
          knowledgeRequirements: [
            { unknownId: newId(), targetConfidence: 0.8, rationale: 'cross-tenant probe' },
          ],
        },
        note: 'cross-tenant probe',
      }),
    );

    // ---- The same natural key coexists per tenant ----------------------
    // The SAME goal title, observation content and strategy content live
    // independently in B: B's own goal, own fingerprint, own unknown.
    const goalB = await createGoal(ctxB, sweepGoalInput('WB2 sweep strategy goal'));
    const fingerprintB = await deriveFingerprint(ctxB, {
      goalId: goalB.id,
      observations: sweepObservations(),
      derivedFrom: ['wb2-sweep-obs-1'],
    });
    const unknownB = await recordUnknown(ctxB, {
      question: 'Which information sources hold the spring dispatch context?',
      consequence: 'Not knowing this blocks the spring staffing decision.',
    });
    const strategyB = await defineStrategy(ctxB, {
      goalId: goalB.id,
      fingerprintId: fingerprintB.fingerprintId,
      content: {
        knowledgeRequirements: [
          {
            unknownId: unknownB.id,
            targetConfidence: 0.8,
            rationale: 'The spring window decision depends on it.',
          },
        ],
        preferredSources: [
          { registry: 'source', ref: 'src-traffic', rationale: 'live traffic feed' },
        ],
        costCeilings: [{ scope: 'per-acquisition', amount: 500, currency: 'USD' }],
        escalationThresholds: [{ trigger: 'failed-attempts', afterAttempts: 3 }],
      },
      note: 'wb2 sweep strategy (tenant B)',
    });
    expect(strategyB.id).not.toBe(strategyA.id);
    expect(strategyB.tenantId).toBe(tenantSweepB);
    expect((await listStrategies(ctxB, {})).map((strategy) => strategy.id)).toEqual([
      strategyB.id,
    ]);
    // And A's list still holds exactly its own strategy.
    expect((await listStrategies(ctxA, {})).map((strategy) => strategy.id)).toEqual([
      strategyA.id,
    ]);

    // ---- The learning loop stays per-tenant -----------------------------
    // A adjusts its strategy (v2 with outcome evidence); B's strategy and
    // history are untouched, and B cannot adjust A's strategy at all.
    const adjustedA = await adjustStrategy(ctxA, {
      strategyId: strategyA.id,
      changes: {
        escalationThresholds: [{ trigger: 'budget-exhausted' }],
      },
      outcomeEvidence: [
        { kind: 'other', ref: 'outcome-sweep-1', observed: 'spring target met at 0.82' },
      ],
      note: 'post-outcome tightening',
    });
    expect(adjustedA.currentVersion).toBe(2);
    expect((await listStrategyVersions(ctxA, { strategyId: strategyA.id })).map((v) => v.version)).toEqual([1, 2]);
    await expectCode('strategy_not_found', () =>
      adjustStrategy(ctxB, {
        strategyId: strategyA.id,
        changes: { escalationThresholds: [{ trigger: 'budget-exhausted' }] },
        note: 'cross-tenant probe',
      }),
    );
    expect((await listStrategyVersions(ctxB, { strategyId: strategyB.id })).map((v) => v.version)).toEqual([1]);
  });
});
