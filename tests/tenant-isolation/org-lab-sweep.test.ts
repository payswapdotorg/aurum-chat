// WB2 integration (2026-10-07) — Tenant Isolation Verification · sweep for
// the org-lab module (W135: the Contextual Organizational Lab — candidates,
// the contextually-conditioned search, and the §11 evidence object).
//
// REAL two-tenant service proof in the W044 house style (the manifest v9
// registration): tenant A builds Lab state through the public contract —
// a candidate registry entry, a contextual search under a real W134
// fingerprint, a §11 recommendation with evaluated candidates + expected
// outcomes, and its calibration — and tenant B must see none of it:
//
//   * empty-list invisibility — B's listCandidates / listRecommendations
//     are empty before it creates its own state;
//   * uniform not-found — a FOREIGN id and a MISSING one reject
//     identically on every surface (`candidate_not_found`,
//     `recommendation_not_found`, and the mapped `goal_not_found` /
//     `fingerprint_not_found` / `node_ref_not_found` from the consumed
//     contracts) — no existence leak (ADR-0001);
//   * same natural keys coexist per tenant — the tenant-unique candidate
//     slug lives independently in both tenants, and each tenant's
//     searches / recommendations / calibrations stay fully isolated;
//   * writes never mutate another tenant's rows — B cannot retire A's
//     candidate, cannot recommend on A's goal, cannot calibrate A's
//     recommendation, and cannot even compose a candidate over A's
//     agent body (the W133 seam's uniform not-found).
//
// Scope rules honored here: org-lab code is imported ONLY through
// '@/modules/org-lab/contract'; the goals/context/agent-body/learning
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
  OrgLabError,
  getCandidate,
  getCandidateCalibration,
  getRecommendation,
  listCandidates,
  listRecommendations,
  recordCalibration,
  recordRecommendation,
  registerCandidate,
  retireCandidate,
  searchOrganizations,
} from '@/modules/org-lab/contract';
import type { OrgLabErrorCode } from '@/modules/org-lab/contract';
import { createGoal } from '@/modules/goals/contract';
import { deriveFingerprint } from '@/modules/context/contract';
import { createAgentBody } from '@/modules/agent-body/contract';
import {
  defineOutcome,
  recordMeasurement,
  settleOutcome,
} from '@/modules/learning/contract';

const tenantSweepA = newId();
const tenantSweepB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: OrgLabErrorCode, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(OrgLabError);
    expect((error as OrgLabError).code).toBe(code);
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

describe('W044 org-lab — the Contextual Organizational Lab (W135) is tenant-scoped', () => {
  it("tenant A's candidates, searches, recommendations and calibrations are invisible to tenant B; the same slug coexists per tenant", async () => {
    const ctxA = member(tenantSweepA);
    const ctxB = member(tenantSweepB);

    // ---- Tenant A: the Lab state, through the real consumed seams -------
    const goalA = await createGoal(ctxA, sweepGoalInput('WB2 sweep lab goal'));
    const fingerprintA = await deriveFingerprint(ctxA, {
      goalId: goalA.id,
      observations: sweepObservations(),
      derivedFrom: ['wb2-sweep-obs-1'],
    });
    const bodyA = await createAgentBody(ctxA, {
      role: 'dispatch-body',
      label: 'Dispatch body',
    });
    const candidateA1 = await registerCandidate(ctxA, {
      slug: 'spring-crew',
      label: 'Spring sprint crew',
      description: 'The sweep candidate with a real agent-body node.',
      composition: {
        nodes: [
          {
            nodeId: 'dispatch',
            kind: 'agent-body' as const,
            role: 'Dispatch lead',
            ref: bodyA.id,
            purposes: ['cognition' as const],
          },
          { nodeId: 'solo', kind: 'tenant-agent' as const, role: 'Support triage' },
        ],
        edges: [],
        informationRoutes: [],
      },
      applicability: {
        seasonWindows: ['spring'],
        durationClasses: ['short' as const],
      },
    });
    expect(candidateA1.tenantId).toBe(tenantSweepA);
    const candidateA2 = await registerCandidate(ctxA, {
      slug: 'winter-brigade',
      label: 'Winter freight brigade',
      composition: {
        nodes: [{ nodeId: 'solo', kind: 'tenant-agent' as const, role: 'Solo operator' }],
      },
    });

    // A contextual search under A's real fingerprint stays in A.
    const resultsA = await searchOrganizations(ctxA, {
      goalId: goalA.id,
      fingerprintId: fingerprintA.fingerprintId,
    });
    expect(resultsA.map((result) => result.candidateId).sort()).toEqual(
      [candidateA1.id, candidateA2.id].sort(),
    );

    // ---- Tenant B sees none of it ---------------------------------------
    expect(await listCandidates(ctxB, {})).toHaveLength(0);
    expect(await listRecommendations(ctxB, {})).toHaveLength(0);

    // Uniform not-founds: a FOREIGN id and a MISSING one are
    // indistinguishable on every read surface.
    await expectCode('candidate_not_found', () =>
      getCandidate(ctxB, { candidateId: candidateA1.id }),
    );
    await expectCode('candidate_not_found', () =>
      getCandidate(ctxB, { candidateId: newId() }),
    );
    await expectCode('goal_not_found', () =>
      searchOrganizations(ctxB, { goalId: goalA.id, fingerprintId: fingerprintA.fingerprintId }),
    );
    await expectCode('goal_not_found', () =>
      searchOrganizations(ctxB, { goalId: newId(), fingerprintId: newId() }),
    );

    // Cross-tenant WRITES are refused the same way: B cannot retire A's
    // candidate, cannot recommend on A's goal, and cannot even compose a
    // candidate over A's agent body (the W133 seam's uniform not-found).
    await expectCode('candidate_not_found', () =>
      retireCandidate(ctxB, { candidateId: candidateA1.id, reason: 'cross-tenant probe' }),
    );
    await expectCode('goal_not_found', () =>
      recordRecommendation(ctxB, {
        goalId: goalA.id,
        fingerprintId: fingerprintA.fingerprintId,
        knowledgeObjective: 'cross-tenant probe',
        evaluationConfig: { criteria: [{ name: 'contextual fit' }] },
        candidates: [
          {
            candidateId: newId(),
            disposition: 'recommended',
            summary: 'cross-tenant probe',
          },
          {
            candidateId: newId(),
            disposition: 'rejected',
            rejectionReasons: ['probe'],
            summary: 'cross-tenant probe',
          },
        ],
        expectedOutcomeIds: [newId()],
        note: 'cross-tenant probe',
      }),
    );
    await expectCode('node_ref_not_found', () =>
      registerCandidate(ctxB, {
        slug: 'stolen-body-crew',
        label: 'Stolen body crew',
        composition: {
          nodes: [
            {
              nodeId: 'dispatch',
              kind: 'agent-body' as const,
              role: 'Dispatch lead',
              ref: bodyA.id,
            },
          ],
        },
      }),
    );

    // ---- The same natural key coexists per tenant ------------------------
    // The tenant-unique slug 'spring-crew' lives independently in B.
    const candidateB1 = await registerCandidate(ctxB, {
      slug: 'spring-crew',
      label: 'Spring sprint crew (tenant B)',
      composition: {
        nodes: [{ nodeId: 'solo', kind: 'tenant-agent' as const, role: 'Solo operator' }],
      },
    });
    expect(candidateB1.id).not.toBe(candidateA1.id);
    expect(candidateB1.tenantId).toBe(tenantSweepB);
    expect((await listCandidates(ctxB, {})).map((candidate) => candidate.id)).toEqual([
      candidateB1.id,
    ]);
    // And A's registry still holds exactly its own two candidates.
    expect((await listCandidates(ctxA, {})).map((candidate) => candidate.id).sort()).toEqual(
      [candidateA1.id, candidateA2.id].sort(),
    );

    // ---- The §11 evidence object stays tenant-scoped ---------------------
    // A records a recommendation over its own candidates + one OPEN
    // learning outcome, then calibrates it after realization.
    const outcomeA = await defineOutcome(ctxA, {
      subject: { kind: 'recommendation', id: newId(), label: 'wb2 sweep recommendation' },
      metricName: 'rides completed per week',
      metricUnit: 'rides',
      direction: 'at_least',
      baseline: 1200,
      expected: 1500,
      horizon: null,
      affectedGoals: [],
      originExecutionId: null,
      actor: { kind: 'person', label: 'ops lead' },
      rationale: 'the wb2 sweep commitment',
    });
    const recommendationA = await recordRecommendation(ctxA, {
      goalId: goalA.id,
      fingerprintId: fingerprintA.fingerprintId,
      knowledgeObjective: 'A dispatch organization for the spring window',
      evaluationConfig: {
        criteria: [{ name: 'contextual fit', weight: 1 }],
        note: 'wb2 sweep evaluation',
      },
      candidates: [
        {
          candidateId: candidateA1.id,
          disposition: 'recommended',
          summary: 'Fits the observed spring/short context.',
          scores: [{ name: 'contextual fit', value: 0.95 }],
          evidenceRefs: ['wb2-sweep-search'],
        },
        {
          candidateId: candidateA2.id,
          disposition: 'rejected',
          rejectionReasons: ['no declared spring applicability'],
          summary: 'Context misfit.',
        },
      ],
      expectedOutcomeIds: [outcomeA.id],
      derivedFrom: ['wb2-sweep-search'],
      note: 'recorded by the wb2 sweep',
    });
    expect(recommendationA.tenantId).toBe(tenantSweepA);

    // B cannot read or calibrate A's recommendation (uniform not-found).
    await expectCode('recommendation_not_found', () =>
      getRecommendation(ctxB, { recommendationId: recommendationA.id }),
    );
    await expectCode('recommendation_not_found', () =>
      recordCalibration(ctxB, { recommendationId: recommendationA.id, note: 'cross-tenant probe' }),
    );
    expect(await listRecommendations(ctxB, {})).toHaveLength(0);

    // A calibrates; B's own calibration surface stays honestly cold (null).
    const measurementA = await recordMeasurement(ctxA, {
      outcomeId: outcomeA.id,
      value: 1620,
      actor: { kind: 'system', label: 'metrics-warehouse' },
    });
    await settleOutcome(ctxA, {
      outcomeId: outcomeA.id,
      measurementId: measurementA.id,
      actor: { kind: 'person', label: 'ops lead' },
    });
    const calibratedA = await recordCalibration(ctxA, {
      recommendationId: recommendationA.id,
      note: 'positive: the spring commitment was exceeded',
    });
    expect(calibratedA.status).toBe('calibrated');
    expect(calibratedA.calibration?.polarity).toBe('positive');
    expect(
      await getCandidateCalibration(ctxA, { candidateId: candidateA1.id }),
    ).not.toBeNull();
    expect(await getCandidateCalibration(ctxB, { candidateId: candidateB1.id })).toBeNull();
  });
});
