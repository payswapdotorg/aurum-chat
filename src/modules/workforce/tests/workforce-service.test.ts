// Integration tests for the workforce module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W019
// acceptance: "Assess workload, role/capability fit, performance signals
// and staffing needs while preserving alternative explanations and human
// decision authority."
//
//  * THE FULL §14 CHAIN: roles with capability requirements (opaque
//    references into the capabilities module, W017), assignments with
//    allocations, immutable workload/performance signals, and
//    `assessWorkforce` computing the deterministic interpretation —
//    workload (overallocation, observed-vs-committed), fit (through the
//    capabilities contract's supplies), performance, staffing — with
//    generated alternative explanations and alternatives, evidence
//    citations and the options snapshot. Re-assessment appends the next
//    version of the same per-employee identity.
//  * LOCK 20 GUARDS: employment-impacting recommendations
//    (role_change/performance_action/termination) require preserved
//    uncertainty (confidence < 1), ≥ 1 alternative explanation, ≥ 2
//    distinct alternatives and ≥ 1 evidence reference — enforced by the
//    service AND mirrored by storage CHECK constraints (a raw INSERT with
//    an unguarded shape is rejected by PostgreSQL itself).
//  * GROUNDING: 'termination'/'performance_action' without an adverse
//    computed finding fail with `ungrounded_recommendation`.
//  * LOCK 21 / HUMAN DECISION AUTHORITY: no employment/execution
//    operation exists; decisions are append-only, claim-gated
//    ('workforce:decide'), human-only (decider kind 'person'), one per
//    version (first wins).
//  * SIGNAL WINDOW: only signals inside the assessment window feed the
//    computation (clock-controlled).
//  * VERSIONED/AUDITABLE + APPEND-ONLY STORAGE: surgical lifecycle
//    transitions, tri-state carries, version deep links, and the
//    migration 001 triggers rejecting UPDATE/DELETE/TRUNCATE on versions,
//    signals and decisions (and DELETE/TRUNCATE on identities).
//  * TENANT ISOLATION (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks), including the capability
//    supplies read through the capabilities contract (they are
//    tenant-scoped by that module).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { registerCapability, registerSupply } from '@/modules/capabilities/contract';
import { WorkforceError } from '../errors';
import * as workforceContract from '../contract';
import type { WorkforceAssessment } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  assignRole,
  assessWorkforce,
  getAssignment,
  getAssignmentVersion,
  getAssessment,
  getAssessmentVersion,
  getDecision,
  getRole,
  getRoleVersion,
  getSignal,
  listAssignments,
  listAssignmentVersions,
  listAssessments,
  listAssessmentVersions,
  listDecisions,
  listRoles,
  listRoleVersions,
  listSignals,
  recordDecision,
  recordSignal,
  registerRole,
  reviseAssignment,
  reviseRole,
} = workforceContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantMain = newId(); // the full §14 chain scenario
const tenantIso = newId(); // the other tenant (isolation checks)
const tenantGuards = newId(); // lock-20 guards + grounding
const tenantDecide = newId(); // human decisions
const tenantVersioned = newId(); // versioning / audit / triggers / conflicts
const tenantWindow = newId(); // the signal-window scenario

const PERSON_OPS = { kind: 'person' as const, id: newId(), label: 'Ops lead' };
const PERSON_MANAGER = { kind: 'person' as const, id: newId(), label: 'Team manager' };

// Fixed ids so ordering is deterministic (Ada < Bob).
const EMPLOYEE_ADA = '00000000-0000-4000-8000-0000000000a1';
const EMPLOYEE_BOB = '00000000-0000-4000-8000-0000000000a2';

const OBS_1 = '00000000-0000-4000-8000-000000000011';
const OBS_2 = '00000000-0000-4000-8000-000000000012';

// Capability ids are minted by PostgreSQL (gen_random_uuid) — the actual
// ids are captured at fixture time and threaded through the expectations.
let germanCapId = '';
let invoiceCapId = '';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** A member holding the workforce decision authority claim. */
function decider(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['workforce:decide'] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkforceError);
    expect((error as WorkforceError).code).toBe(code);
  }
}

/** Raw SQL rejection assertion (the storage triggers and CHECK constraints). */
async function expectSqlRejection(sql: string): Promise<void> {
  await expect(getDb().query(sql)).rejects.toThrow();
}

// ---------------------------------------------------------------------------
// The main scenario: the §14 chain end to end
// ---------------------------------------------------------------------------

describe('workforce intelligence — the §14 chain', () => {
  const ctx = member(tenantMain);

  let support: Awaited<ReturnType<typeof registerRole>>;
  let bilingual: Awaited<ReturnType<typeof registerRole>>;
  let adaSupport: Awaited<ReturnType<typeof assignRole>>;
  let adaBilingual: Awaited<ReturnType<typeof assignRole>>;
  let assessment: WorkforceAssessment;
  let workloadSignal: Awaited<ReturnType<typeof recordSignal>>;
  let performanceSignal: Awaited<ReturnType<typeof recordSignal>>;

  beforeAll(async () => {
    // --- the capability graph side (W017), read through its contract ---
    const german = await registerCapability(ctx, { name: 'German-language support', actor: PERSON_OPS });
    const invoice = await registerCapability(ctx, { name: 'Invoice processing', actor: PERSON_OPS });
    germanCapId = german.id;
    invoiceCapId = invoice.id;
    await registerSupply(ctx, {
      capabilityId: german.id,
      supplier: { kind: 'employee', id: EMPLOYEE_ADA, label: 'Ada' },
      level: 0.9,
      actor: PERSON_OPS,
    });

    // --- the expectation side ---
    support = await registerRole(ctx, {
      roleKey: 'Support engineer',
      title: 'Support engineer',
      description: 'Front-line customer support',
      requiredCapabilities: [
        { capabilityId: german.id, minLevel: 0.8 },
        { capabilityId: invoice.id, minLevel: 0.5 },
      ],
      expectedWeeklyHours: 40,
      actor: PERSON_OPS,
      rationale: 'Onboarding the support desk',
    });
    bilingual = await registerRole(ctx, {
      roleKey: 'Bilingual desk',
      requiredCapabilities: [{ capabilityId: german.id, minLevel: 0.9 }],
      expectedWeeklyHours: 20,
      actor: PERSON_OPS,
    });

    // --- the observed side ---
    adaSupport = await assignRole(ctx, {
      roleId: support.id,
      employee: { id: EMPLOYEE_ADA, label: 'Ada' },
      allocation: 0.75,
      evidenceObservationIds: [OBS_1],
      actor: PERSON_OPS,
    });
    adaBilingual = await assignRole(ctx, {
      roleId: bilingual.id,
      employee: { id: EMPLOYEE_ADA, label: 'Ada' },
      allocation: 0.5,
      actor: PERSON_OPS,
    });
    workloadSignal = await recordSignal(ctx, {
      employee: { id: EMPLOYEE_ADA, label: 'Ada' },
      kind: 'workload',
      value: 50,
      evidenceObservationIds: [OBS_1],
      actor: PERSON_OPS,
    });
    performanceSignal = await recordSignal(ctx, {
      employee: { id: EMPLOYEE_ADA, label: 'Ada' },
      kind: 'performance',
      value: 0.3,
      actor: PERSON_OPS,
    });

    // --- the interpretation ---
    assessment = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_ADA, label: 'Ada' },
      recommendation: {
        kind: 'redistribute_work',
        text: 'Move part of the bilingual desk off Ada; her committed load exceeds one FTE and performance is slipping.',
      },
      confidence: 0.7,
      actor: { kind: 'system', id: 'aurum', label: 'Aurum' },
      rationale: 'Weekly workforce review',
    });
  });

  it('registers roles with immutable keys, requirements and hours (v1 created/active)', async () => {
    expect(support.roleKey).toBe('Support engineer');
    expect(support.version).toBe(1);
    expect(support.status).toBe('active');
    expect(support.lastChange.kind).toBe('created');
    expect(support.lastChange.actor).toEqual(PERSON_OPS);
    expect(support.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(support.requiredCapabilities).toEqual([
      { capabilityId: germanCapId, minLevel: 0.8 },
      { capabilityId: invoiceCapId, minLevel: 0.5 },
    ]);
    expect(support.expectedWeeklyHours).toBe(40);
    // The registration view predates any assignment (empty summary); the
    // current view reflects the assignment made in the fixture.
    expect(support.assignmentSummary).toEqual({ activeCount: 0, retiredCount: 0 });
    const supportNow = await getRole(ctx, support.id);
    expect(supportNow.assignmentSummary).toEqual({ activeCount: 1, retiredCount: 0 });
  });

  it('assigns roles with allocation, employee identity and evidence', () => {
    expect(adaSupport.role).toEqual({ id: support.id, roleKey: 'Support engineer', status: 'active' });
    expect(adaSupport.employee).toEqual({ id: EMPLOYEE_ADA, label: 'Ada' });
    expect(adaSupport.allocation).toBe(0.75);
    expect(adaSupport.status).toBe('active');
    expect(adaSupport.lastChange.kind).toBe('assigned');
    expect(adaSupport.evidenceObservationIds).toEqual([OBS_1]);
  });

  it('records immutable signals with provenance', async () => {
    expect(workloadSignal.kind).toBe('workload');
    expect(workloadSignal.value).toBe(50);
    expect(workloadSignal.recordedByPrincipal).toBe(ctx.principalId);
    expect(workloadSignal.actor).toEqual(PERSON_OPS);
    expect(performanceSignal.kind).toBe('performance');
    await expectCode('invalid_signal_input', () =>
      recordSignal(ctx, {
        employee: { id: EMPLOYEE_ADA },
        kind: 'workload',
        value: 169, // more hours than the week has
        actor: PERSON_OPS,
      }),
    );
    await expectCode('invalid_signal_input', () =>
      recordSignal(ctx, {
        employee: { id: EMPLOYEE_ADA },
        kind: 'performance',
        value: 1.5,
        actor: PERSON_OPS,
      }),
    );
  });

  it('computes the deterministic interpretation (v1 issued)', () => {
    expect(assessment.version).toBe(1);
    expect(assessment.changeKind).toBe('issued');
    expect(assessment.employee).toEqual({ id: EMPLOYEE_ADA, label: 'Ada' });
    const { content } = assessment;
    // Workload: 0.75×40 + 0.5×20 = 40 committed at allocation 1.25.
    expect(content.workload.status).toBe('overallocated');
    expect(content.workload.totalAllocation).toBeCloseTo(1.25, 10);
    expect(content.workload.committedWeeklyHours).toBe(40);
    expect(content.workload.observedWeeklyHours).toBe(50);
    // Fit: German required at max(0.8, 0.9) = 0.9, Ada supplies 0.9 → met;
    // invoice processing has no supply record → unmet (partial).
    expect(content.fit.status).toBe('partial');
    expect(content.fit.requiredCount).toBe(2);
    expect(content.fit.metCount).toBe(1);
    expect(content.fit.unmet).toEqual([
      { capabilityId: invoiceCapId, requiredLevel: 0.5, suppliedLevel: null, met: false },
    ]);
    // Performance: 0.3 < 0.5.
    expect(content.performance.status).toBe('needs_attention');
    expect(content.performance.score).toBe(0.3);
    // Staffing: relief — the observed excess (50 − 40 = 10) exceeds the
    // structural one (40 × (1 − 1/1.25) = 8).
    expect(content.staffing.status).toBe('relief_needed');
    expect(content.staffing.neededWeeklyHoursReduction).toBe(10);
    expect(content.scope).toEqual({
      consideredActiveAssignmentCount: 2,
      excludedRetiredRoleAssignmentCount: 0,
      unconsideredAssignmentOverflowCount: 0,
      requiredCapabilityCount: 2,
      requiredCapabilityOverflowCount: 0,
    });
    expect(content.adverseFindings).toEqual([
      'workload_overallocated',
      'fit_partial',
      'performance_needs_attention',
      'staffing_relief_needed',
    ]);
  });

  it('preserves alternative explanations and alternatives (lock 20) with evidence citations', () => {
    const { content } = assessment;
    // Generated explanations for every adverse/unknown dimension.
    expect(content.alternativeExplanations.length).toBeGreaterThanOrEqual(3);
    expect(
      content.alternativeExplanations.every((e) => e.source === 'generated'),
    ).toBe(true);
    expect(
      content.alternativeExplanations.some((e) => e.text.includes('double-booked assignments')),
    ).toBe(true);
    expect(
      content.alternativeExplanations.some((e) => e.text.includes('capability graph may be incomplete')),
    ).toBe(true);
    // Generated alternatives: the union of the offloading options (§13
    // vocabulary), the fit-gap acquisition options and the performance
    // options — deduplicated in vocabulary order.
    expect(content.alternatives.map((a) => a.kind)).toEqual([
      'redistribute_work',
      'reassign',
      'train',
      'hire',
      'recruit_agent',
      'install_software',
      'outsource',
      'process_improvement',
      'investigate_further',
    ]);
    // Evidence citations: both signals fed the assessment.
    expect(content.consideredSignalIds.sort()).toEqual(
      [workloadSignal.id, performanceSignal.id].sort(),
    );
    // The recommendation is not employment-impacting and carries the stated text.
    expect(content.recommendation.employmentImpacting).toBe(false);
    expect(content.recommendation.kind).toBe('redistribute_work');
    expect(content.recommendation.text).toContain('bilingual desk');
    expect(content.confidence).toBe(0.7);
    expect(content.options).toEqual({
      windowWeeks: 4,
      workloadMargin: 0.15,
      performanceStrong: 0.75,
      performanceSatisfactory: 0.5,
    });
  });

  it('reads the employee capability supplies through the capabilities contract', async () => {
    // Bob has an assignment to the support role but no capability supplies
    // at all — his fit must be does_not_fit with null supplied levels.
    await assignRole(ctx, {
      roleId: support.id,
      employee: { id: EMPLOYEE_BOB, label: 'Bob' },
      actor: PERSON_OPS,
    });
    const bob = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_BOB, label: 'Bob' },
      recommendation: { kind: 'training', text: 'Get Bob trained on the desk.' },
      confidence: 0.6,
      actor: { kind: 'system', id: 'aurum', label: 'Aurum' },
    });
    expect(bob.content.fit.status).toBe('does_not_fit');
    expect(bob.content.fit.unmet).toHaveLength(2);
    expect(bob.content.fit.unmet.every((detail) => detail.suppliedLevel === null)).toBe(true);
  });

  it('appends the next version on re-assessment (gapless chain, deep links)', async () => {
    // Offload the bilingual desk to Bob: Ada drops to a clean 0.75×40 = 30
    // committed hours, and her observed 50 is now overloaded (50 > 30×1.15).
    await reviseAssignment(ctx, {
      assignmentId: adaBilingual.id,
      allocation: 0.25,
      actor: PERSON_OPS,
      rationale: 'Rebalancing the bilingual desk',
    });
    const reassessed = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_ADA, label: 'Ada' },
      recommendation: { kind: 'monitor', text: 'Watch Ada’s load after the rebalancing.' },
      confidence: 0.65,
      actor: { kind: 'system', id: 'aurum', label: 'Aurum' },
    });
    expect(reassessed.version).toBe(2);
    expect(reassessed.changeKind).toBe('reassessed');
    expect(reassessed.versionCount).toBe(2);
    expect(reassessed.content.workload.totalAllocation).toBe(1); // 0.75 + 0.25
    expect(reassessed.content.workload.committedWeeklyHours).toBe(35);
    expect(reassessed.content.workload.status).toBe('overloaded'); // 50 > 35×1.15 = 40.25
    expect(reassessed.content.staffing.neededWeeklyHoursReduction).toBe(15); // 50 − 35
    expect(reassessed.decision).toBeNull();
    expect(reassessed.decisionCount).toBe(0);

    // The history is deep-linkable and never rewritten.
    const v1 = await getAssessmentVersion(ctx, { assessmentId: reassessed.id, version: 1 });
    expect(v1.content.workload.status).toBe('overallocated');
    expect(v1.changeKind).toBe('issued');
    const history = await listAssessmentVersions(ctx, { assessmentId: reassessed.id });
    expect(history.map((version) => version.version)).toEqual([1, 2]);

    const fetched = await getAssessment(ctx, reassessed.id);
    expect(fetched.version).toBe(2);
    expect(fetched.versionCount).toBe(2);
  });

  it('exposes listings with filters and deterministic order', async () => {
    const roles = await listRoles(ctx, { search: 'desk' });
    expect(roles.map((role) => role.roleKey)).toEqual(['Bilingual desk']);
    const activeRoles = await listRoles(ctx, { status: 'active' });
    expect(activeRoles).toHaveLength(2);
    const adaAssignments = await listAssignments(ctx, { employeeId: EMPLOYEE_ADA });
    expect(adaAssignments).toHaveLength(2);
    expect(adaAssignments.every((a) => a.employee.id === EMPLOYEE_ADA)).toBe(true);
    const signals = await listSignals(ctx, { employeeId: EMPLOYEE_ADA });
    expect(signals).toHaveLength(2); // newest first, both kinds
    const assessments = await listAssessments(ctx, { employeeId: EMPLOYEE_ADA });
    expect(assessments).toHaveLength(1);
    expect(assessments[0]!.version).toBe(2);
    const impacting = await listAssessments(ctx, { employmentImpacting: true });
    expect(impacting).toHaveLength(0);
    const monitor = await listAssessments(ctx, { recommendationKind: 'monitor' });
    expect(monitor).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The signal window (clock-controlled)
// ---------------------------------------------------------------------------

describe('workforce intelligence — the assessment window', () => {
  const ctx = member(tenantWindow);
  let clockMs = Date.parse('2026-09-14T08:00:00Z');
  const week = 7 * 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    // The mock reads the MUTABLE clockMs — tests advance time by mutating it.
    vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
    const role = await registerRole(ctx, {
      roleKey: 'Analyst',
      expectedWeeklyHours: 40,
      actor: PERSON_OPS,
    });
    await assignRole(ctx, {
      roleId: role.id,
      employee: { id: EMPLOYEE_ADA },
      actor: PERSON_OPS,
    });
    // Week 0 and week 3 workload signals.
    await recordSignal(ctx, {
      employee: { id: EMPLOYEE_ADA },
      kind: 'workload',
      value: 20,
      actor: PERSON_OPS,
    });
    clockMs += 3 * week;
    await recordSignal(ctx, {
      employee: { id: EMPLOYEE_ADA },
      kind: 'workload',
      value: 50,
      actor: PERSON_OPS,
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('considers only the signals inside the window', async () => {
    // Now = week 3; window 4 → both signals (mean 35 vs committed 40 → at_capacity).
    const current = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_ADA },
      recommendation: { kind: 'monitor', text: 'Steady.' },
      confidence: 0.6,
      actor: PERSON_OPS,
    });
    expect(current.content.workload.workloadSignalCount).toBe(2);
    expect(current.content.workload.observedWeeklyHours).toBe(35);
    expect(current.content.workload.status).toBe('at_capacity');

    // Week 5; window 4 → only the week-3 signal (50 vs 40 → overloaded).
    clockMs += 2 * week;
    const later = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_ADA },
      recommendation: { kind: 'redistribute_work', text: 'Load rising.' },
      confidence: 0.6,
      actor: PERSON_OPS,
      options: { windowWeeks: 4 },
    });
    expect(later.content.workload.workloadSignalCount).toBe(1);
    expect(later.content.workload.observedWeeklyHours).toBe(50);
    expect(later.content.workload.status).toBe('overloaded');

    // A one-week window at week 5 excludes even the week-3 signal.
    const tight = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_ADA },
      recommendation: { kind: 'monitor', text: 'No recent evidence.' },
      confidence: 0.4,
      actor: PERSON_OPS,
      options: { windowWeeks: 1 },
    });
    expect(tight.content.workload.status).toBe('insufficient_evidence');
    expect(tight.content.performance.status).toBe('insufficient_evidence');
    expect(tight.content.staffing.status).toBe('unknown');
    expect(
      tight.content.alternativeExplanations.some((e) => e.text.includes('measurement gap')),
    ).toBe(true);
    expect(tight.content.alternatives.map((a) => a.kind)).toEqual(['investigate_further']);
  });
});

// ---------------------------------------------------------------------------
// Lock 20 guards + grounding
// ---------------------------------------------------------------------------

describe('workforce intelligence — employment guards (lock 20) and grounding', () => {
  const ctx = member(tenantGuards);

  // EVE is perfectly fine: at capacity, fits, strong.
  const EMPLOYEE_EVE = '00000000-0000-4000-8000-0000000000e1';
  // ZOE is overloaded with slipping performance.
  const EMPLOYEE_ZOE = '00000000-0000-4000-8000-0000000000e2';
  let eveAssessment: WorkforceAssessment;
  let zoeAssessment: WorkforceAssessment;

  beforeAll(async () => {
    const capability = await registerCapability(ctx, { name: 'Escalation handling', actor: PERSON_OPS });
    const role = await registerRole(ctx, {
      roleKey: 'Escalations',
      requiredCapabilities: [{ capabilityId: capability.id, minLevel: 0.5 }],
      expectedWeeklyHours: 40,
      actor: PERSON_OPS,
    });
    await registerSupply(ctx, {
      capabilityId: capability.id,
      supplier: { kind: 'employee', id: EMPLOYEE_EVE },
      level: 0.9,
      actor: PERSON_OPS,
    });
    for (const employee of [EMPLOYEE_EVE, EMPLOYEE_ZOE]) {
      await assignRole(ctx, {
        roleId: role.id,
        employee: { id: employee },
        actor: PERSON_OPS,
      });
    }
    await recordSignal(ctx, {
      employee: { id: EMPLOYEE_EVE },
      kind: 'workload',
      value: 40,
      actor: PERSON_OPS,
    });
    await recordSignal(ctx, {
      employee: { id: EMPLOYEE_EVE },
      kind: 'performance',
      value: 0.9,
      actor: PERSON_OPS,
    });
    await recordSignal(ctx, {
      employee: { id: EMPLOYEE_ZOE },
      kind: 'workload',
      value: 55,
      actor: PERSON_OPS,
    });
    await recordSignal(ctx, {
      employee: { id: EMPLOYEE_ZOE },
      kind: 'performance',
      value: 0.3,
      actor: PERSON_OPS,
    });

    // Sanity: EVE is all-okay (no generated explanations/alternatives), ZOE is not.
    eveAssessment = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_EVE },
      recommendation: { kind: 'no_action', text: 'Everything nominal.' },
      confidence: 0.9,
      actor: PERSON_OPS,
    });
    expect(eveAssessment.content.workload.status).toBe('at_capacity');
    expect(eveAssessment.content.fit.status).toBe('fits');
    expect(eveAssessment.content.performance.status).toBe('strong');
    expect(eveAssessment.content.adverseFindings).toEqual([]);
    expect(eveAssessment.content.alternativeExplanations).toEqual([]);
    expect(eveAssessment.content.alternatives.map((a) => a.kind)).toEqual(['no_change']);

    zoeAssessment = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_ZOE },
      recommendation: { kind: 'redistribute_work', text: 'Zoe is overloaded.' },
      confidence: 0.7,
      actor: PERSON_OPS,
    });
    expect(zoeAssessment.content.workload.status).toBe('overloaded');
    expect(zoeAssessment.content.performance.status).toBe('needs_attention');
  });

  it('rejects an employment-impacting recommendation with certain confidence', async () => {
    await expectCode('employment_guard', () =>
      assessWorkforce(ctx, {
        employee: { id: EMPLOYEE_EVE },
        recommendation: { kind: 'role_change', text: 'Move Eve to the new desk.' },
        confidence: 1, // uncertainty must be preserved
        additionalAlternativeExplanations: [{ text: 'She may prefer the new desk.' }],
        additionalAlternatives: [
          { kind: 'reassign', description: 'Keep her on the current desk.' },
          { kind: 'hire', description: 'Hire for the new desk instead.' },
        ],
        actor: PERSON_OPS,
      }),
    );
  });

  it('rejects an employment-impacting recommendation without alternative explanations', async () => {
    // EVE is all-okay, so nothing is generated — the caller must state one.
    await expectCode('employment_guard', () =>
      assessWorkforce(ctx, {
        employee: { id: EMPLOYEE_EVE },
        recommendation: { kind: 'role_change', text: 'Move Eve to the new desk.' },
        confidence: 0.8,
        additionalAlternatives: [
          { kind: 'reassign', description: 'Keep her on the current desk.' },
          { kind: 'hire', description: 'Hire for the new desk instead.' },
        ],
        actor: PERSON_OPS,
      }),
    );
  });

  it('rejects an employment-impacting recommendation with fewer than two distinct alternatives', async () => {
    // EVE is all-okay, so the only generated alternative is 'no_change' —
    // with nothing stated, exactly ONE distinct course of action remains.
    await expectCode('employment_guard', () =>
      assessWorkforce(ctx, {
        employee: { id: EMPLOYEE_EVE },
        recommendation: { kind: 'role_change', text: 'Move Eve to the new desk.' },
        confidence: 0.8,
        additionalAlternativeExplanations: [{ text: 'She may prefer the new desk.' }],
        actor: PERSON_OPS,
      }),
    );
  });

  it('rejects an employment-impacting recommendation without any evidence reference', async () => {
    // A fresh employee: no assignments, no signals, no observations cited.
    const EMPLOYEE_NEW = '00000000-0000-4000-8000-0000000000e3';
    await expectCode('employment_guard', () =>
      assessWorkforce(ctx, {
        employee: { id: EMPLOYEE_NEW },
        recommendation: { kind: 'role_change', text: 'Move the new hire.' },
        confidence: 0.8,
        additionalAlternativeExplanations: [{ text: 'The onboarding plan may change.' }],
        additionalAlternatives: [
          { kind: 'reassign', description: 'a' },
          { kind: 'hire', description: 'b' },
        ],
        actor: PERSON_OPS,
      }),
    );
    // Citing an observation reference satisfies the evidence requirement.
    const withEvidence = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_NEW },
      recommendation: { kind: 'role_change', text: 'Move the new hire.' },
      confidence: 0.8,
      additionalAlternativeExplanations: [{ text: 'The onboarding plan may change.' }],
      additionalAlternatives: [
        { kind: 'reassign', description: 'a' },
        { kind: 'hire', description: 'b' },
      ],
      evidenceObservationIds: [OBS_2],
      actor: PERSON_OPS,
    });
    expect(withEvidence.content.recommendation.employmentImpacting).toBe(true);
    expect(withEvidence.content.evidenceObservationIds).toEqual([OBS_2]);
    expect(withEvidence.content.workload.status).toBe('unassigned');
  });

  it('rejects ungrounded termination/performance_action (no adverse finding)', async () => {
    // EVE is all-okay; guards satisfied but nothing adverse is computed.
    await expectCode('ungrounded_recommendation', () =>
      assessWorkforce(ctx, {
        employee: { id: EMPLOYEE_EVE },
        recommendation: { kind: 'termination', text: 'Terminate Eve.' },
        confidence: 0.8,
        additionalAlternativeExplanations: [{ text: 'Budget pressure may be temporary.' }],
        additionalAlternatives: [
          { kind: 'reassign', description: 'a' },
          { kind: 'hire', description: 'b' },
        ],
        evidenceObservationIds: [OBS_1],
        actor: PERSON_OPS,
      }),
    );
    await expectCode('ungrounded_recommendation', () =>
      assessWorkforce(ctx, {
        employee: { id: EMPLOYEE_EVE },
        recommendation: { kind: 'performance_action', text: 'Start a performance process.' },
        confidence: 0.8,
        additionalAlternativeExplanations: [{ text: 'Expectations may be unclear.' }],
        additionalAlternatives: [
          { kind: 'train', description: 'a' },
          { kind: 'process_improvement', description: 'b' },
        ],
        evidenceObservationIds: [OBS_1],
        actor: PERSON_OPS,
      }),
    );
  });

  it('issues a grounded, fully guarded termination recommendation — but executes nothing', async () => {
    // ZOE is overloaded with slipping performance: adverse findings exist,
    // and the generated explanations/alternatives satisfy the guards.
    const termination = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_ZOE },
      recommendation: {
        kind: 'termination',
        text: 'Consider ending Zoe’s employment after the support options are exhausted.',
      },
      confidence: 0.75,
      additionalAlternativeExplanations: [
        { text: 'A personal circumstance may be temporarily reducing her capacity.' },
      ],
      actor: PERSON_OPS,
      rationale: 'Escalation review',
    });
    expect(termination.content.recommendation.employmentImpacting).toBe(true);
    expect(termination.content.adverseFindings).toContain('workload_overloaded');
    expect(termination.content.alternativeExplanations.length).toBeGreaterThanOrEqual(3);
    expect(new Set(termination.content.alternatives.map((a) => a.kind)).size).toBeGreaterThanOrEqual(2);
    // The §14 chain snapshot is complete and self-contained.
    const deep = await getAssessmentVersion(ctx, {
      assessmentId: termination.id,
      version: termination.version,
    });
    expect(deep.content.recommendation.kind).toBe('termination');
    expect(deep.content.consideredSignalIds).toHaveLength(2);
  });

  it('a non-impacting recommendation may be fully confident (guards are for employment impact)', async () => {
    const noAction = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_EVE },
      recommendation: { kind: 'no_action', text: 'Everything nominal.' },
      confidence: 1,
      actor: PERSON_OPS,
    });
    expect(noAction.content.recommendation.employmentImpacting).toBe(false);
    expect(noAction.content.confidence).toBe(1);
  });

  it('mirrors the guards at the storage level (CHECK constraints, defense in depth)', async () => {
    // A fresh raw identity (INSERT on identities is legal — no trigger), so
    // the version-row inserts below can fail ONLY on the guard CHECKs, not
    // on a dangling FK or a duplicate version number.
    await getDb().query(
      `INSERT INTO workforce_assessments (tenant_id, employee_key, employee_id)
         VALUES ('${tenantGuards}', 'raw-employee', 'raw-employee')`,
    );
    const assessmentId = (
      await getDb().query<{ id: string }>(
        `SELECT id FROM workforce_assessments
          WHERE tenant_id = '${tenantGuards}' AND employee_key = 'raw-employee'`,
      )
    ).rows[0]!.id;
    const versionRow = (
      version: number,
      confidence: number,
      adverse: string,
      explanations: string,
      alternatives: string,
      signals: string,
    ) => `INSERT INTO workforce_assessment_versions (
        tenant_id, assessment_id, version, change_kind, employee_id, employee_label,
        workload, fit, performance, staffing, scope,
        adverse_findings, alternative_explanations, alternatives,
        recommendation_kind, recommendation_text, employment_impacting, confidence,
        window_weeks, workload_margin, performance_strong, performance_satisfactory,
        considered_signal_ids, evidence_observation_ids,
        actor_kind, actor_id, changed_by_principal, recorded_at
      ) VALUES (
        '${tenantGuards}', '${assessmentId}', ${version}, 'issued', 'raw-employee', null,
        '{"status":"at_capacity"}'::jsonb, '{"status":"fits"}'::jsonb,
        '{"status":"strong"}'::jsonb, '{"status":"adequate"}'::jsonb, '{}'::jsonb,
        '${adverse}'::jsonb, '${explanations}'::jsonb, '${alternatives}'::jsonb,
        'termination', 'raw insert', true, ${confidence},
        4, 0.15, 0.75, 0.5,
        '${signals}'::jsonb, '[]'::jsonb,
        'system', 'attacker', 'attacker', now()
      )`;
    const SIGNAL = '["00000000-0000-4000-8000-0000000000f1"]';
    const EXPLAINED = '[{"text":"x","source":"stated"}]';
    const TWO_ALTERNATIVES =
      '[{"kind":"hire","description":"x","source":"stated"},{"kind":"train","description":"y","source":"stated"}]';

    // Certain confidence on an employment-impacting shape → rejected by the
    // storage CHECK, even bypassing the service entirely.
    await expectSqlRejection(versionRow(1, 1, '[]', EXPLAINED, TWO_ALTERNATIVES, SIGNAL));
    // No alternative explanations → rejected.
    await expectSqlRejection(versionRow(1, 0.5, '[]', '[]', TWO_ALTERNATIVES, SIGNAL));
    // Fewer than two alternatives → rejected.
    await expectSqlRejection(
      versionRow(1, 0.5, '[]', EXPLAINED, '[{"kind":"hire","description":"x","source":"stated"}]', SIGNAL),
    );
    // No evidence reference at all → rejected.
    await expectSqlRejection(versionRow(1, 0.5, '[]', EXPLAINED, TWO_ALTERNATIVES, '[]'));
    // Guards satisfied but NO adverse finding → the grounding CHECK rejects.
    await expectSqlRejection(versionRow(1, 0.5, '[]', EXPLAINED, TWO_ALTERNATIVES, SIGNAL));
    // The fully guarded AND grounded shape persists (the constraints do not
    // accidentally reject everything).
    const inserted = await getDb().query(
      versionRow(1, 0.5, '["fit_partial"]', EXPLAINED, TWO_ALTERNATIVES, SIGNAL),
    );
    expect(inserted.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Human decisions (lock 21 — the chain's terminus)
// ---------------------------------------------------------------------------

describe('workforce intelligence — the authorized human decision', () => {
  const plain = member(tenantDecide);
  const manager = decider(tenantDecide);
  const EMPLOYEE_KIM = '00000000-0000-4000-8000-0000000000d1';
  let assessment: WorkforceAssessment;

  beforeAll(async () => {
    const role = await registerRole(plain, {
      roleKey: 'Onboarding buddy',
      expectedWeeklyHours: 10,
      actor: PERSON_OPS,
    });
    await assignRole(plain, {
      roleId: role.id,
      employee: { id: EMPLOYEE_KIM, label: 'Kim' },
      allocation: 0.25,
      actor: PERSON_OPS,
    });
    await recordSignal(plain, {
      employee: { id: EMPLOYEE_KIM, label: 'Kim' },
      kind: 'workload',
      value: 3,
      actor: PERSON_OPS,
    });
    assessment = await assessWorkforce(plain, {
      employee: { id: EMPLOYEE_KIM, label: 'Kim' },
      recommendation: { kind: 'monitor', text: 'Kim has spare capacity; watch for drift.' },
      confidence: 0.7,
      actor: PERSON_OPS,
    });
  });

  it('requires the workforce:decide authority claim', async () => {
    await expectCode('forbidden', () =>
      recordDecision(plain, {
        assessmentId: assessment.id,
        decision: 'accepted',
        decider: { kind: 'person', id: PERSON_MANAGER.id },
      }),
    );
  });

  it('requires a HUMAN decider (kind person, id present)', async () => {
    await expectCode('invalid_decision_input', () =>
      recordDecision(manager, {
        assessmentId: assessment.id,
        decision: 'accepted',
        decider: { kind: 'agent', id: 'aurum' } as unknown as { kind: 'person'; id: string },
      }),
    );
    await expectCode('invalid_decision_input', () =>
      recordDecision(manager, {
        assessmentId: assessment.id,
        decision: 'accepted',
        decider: { kind: 'person', label: 'A label is not an identity' } as unknown as {
          kind: 'person';
          id: string;
        },
      }),
    );
  });

  it('records the decision with full provenance and surfaces it on the assessment', async () => {
    const decision = await recordDecision(manager, {
      assessmentId: assessment.id,
      decision: 'more_information_needed',
      decider: { kind: 'person', id: PERSON_MANAGER.id, label: 'Team manager' },
      rationale: 'Check the buddy program plan first',
      followUpNote: 'Re-assess after the Q4 plan lands',
    });
    expect(decision.assessmentVersion).toBe(1);
    expect(decision.decider).toEqual({ kind: 'person', id: PERSON_MANAGER.id, label: 'Team manager' });
    expect(decision.decidedByPrincipal).toBe(manager.principalId);
    expect(decision.rationale).toBe('Check the buddy program plan first');

    const fetched = await getAssessment(plain, assessment.id);
    expect(fetched.decision?.id).toBe(decision.id);
    expect(fetched.decisionCount).toBe(1);
    expect(fetched.version).toBe(1);

    const byId = await getDecision(plain, { decisionId: decision.id });
    expect(byId.decision).toBe('more_information_needed');
    const listed = await listDecisions(plain, { assessmentId: assessment.id });
    expect(listed).toHaveLength(1);
  });

  it('first decision wins — the same version cannot be decided twice', async () => {
    await expectCode('already_decided', () =>
      recordDecision(manager, {
        assessmentId: assessment.id,
        decision: 'rejected',
        decider: { kind: 'person', id: PERSON_MANAGER.id },
      }),
    );
  });

  it('a re-assessment opens a new decidable version; old versions stay decidable too', async () => {
    const reassessed = await assessWorkforce(plain, {
      employee: { id: EMPLOYEE_KIM, label: 'Kim' },
      recommendation: { kind: 'no_action', text: 'Steady after review.' },
      confidence: 0.8,
      actor: PERSON_OPS,
    });
    expect(reassessed.version).toBe(2);
    expect(reassessed.decision).toBeNull();
    expect(reassessed.decisionCount).toBe(1); // the v1 decision persists

    const v2Decision = await recordDecision(manager, {
      assessmentId: reassessed.id,
      decision: 'accepted',
      decider: { kind: 'person', id: PERSON_MANAGER.id },
    });
    expect(v2Decision.assessmentVersion).toBe(2);

    const all = await listDecisions(plain, { assessmentId: reassessed.id });
    expect(all.map((decision) => decision.assessmentVersion).sort()).toEqual([1, 2]);
  });

  it('decisions attach to existing versions only', async () => {
    await expectCode('assessment_version_not_found', () =>
      recordDecision(manager, {
        assessmentId: assessment.id,
        version: 99,
        decision: 'accepted',
        decider: { kind: 'person', id: PERSON_MANAGER.id },
      }),
    );
    await expectCode('assessment_not_found', () =>
      recordDecision(manager, {
        assessmentId: '00000000-0000-4000-8000-0000000000ff',
        decision: 'accepted',
        decider: { kind: 'person', id: PERSON_MANAGER.id },
      }),
    );
  });

  it('decisions are append-only at the storage level', async () => {
    await expectSqlRejection(
      `UPDATE workforce_decisions SET decision = 'accepted' WHERE tenant_id = '${tenantDecide}'`,
    );
    await expectSqlRejection(`DELETE FROM workforce_decisions WHERE tenant_id = '${tenantDecide}'`);
    await expectSqlRejection(`TRUNCATE workforce_decisions`);
  });
});

// ---------------------------------------------------------------------------
// Versioning, audit, conflicts and append-only storage
// ---------------------------------------------------------------------------

describe('workforce intelligence — versioned records and append-only storage', () => {
  const ctx = member(tenantVersioned);

  it('versions role revisions (tri-state carry, wholesale replace, surgical transitions)', async () => {
    const role = await registerRole(ctx, {
      roleKey: 'Data steward',
      title: 'Data steward',
      description: 'Keeps the records clean',
      expectedWeeklyHours: 30,
      actor: PERSON_OPS,
    });
    const revised = await reviseRole(ctx, {
      roleId: role.id,
      title: 'Senior data steward', // carry description/hours over
      actor: PERSON_OPS,
      rationale: 'Title refresh',
    });
    expect(revised.version).toBe(2);
    expect(revised.title).toBe('Senior data steward');
    expect(revised.description).toBe('Keeps the records clean');
    expect(revised.expectedWeeklyHours).toBe(30);
    expect(revised.lastChange.kind).toBe('revised');

    const replaced = await reviseRole(ctx, {
      roleId: role.id,
      description: null, // clear
      requiredCapabilities: [], // replace wholesale with none
      actor: PERSON_OPS,
    });
    expect(replaced.version).toBe(3);
    expect(replaced.description).toBeNull();
    expect(replaced.requiredCapabilities).toEqual([]);

    // A status revision must be surgical.
    await expectCode('invalid_role_input', () =>
      reviseRole(ctx, { roleId: role.id, status: 'retired', title: 'nope', actor: PERSON_OPS }),
    );
    const retired = await reviseRole(ctx, {
      roleId: role.id,
      status: 'retired',
      actor: PERSON_OPS,
      rationale: 'Role eliminated',
    });
    expect(retired.version).toBe(4);
    expect(retired.status).toBe('retired');
    expect(retired.lastChange.kind).toBe('retired');

    // A retired role accepts nothing but a reactivation...
    await expectCode('invalid_transition', () =>
      reviseRole(ctx, { roleId: role.id, title: 'nope', actor: PERSON_OPS }),
    );
    await expectCode('invalid_transition', () =>
      reviseRole(ctx, { roleId: role.id, status: 'retired', actor: PERSON_OPS }),
    );
    const reactivated = await reviseRole(ctx, {
      roleId: role.id,
      status: 'active',
      actor: PERSON_OPS,
      rationale: 'Role reinstated',
    });
    expect(reactivated.status).toBe('active');
    expect(reactivated.lastChange.kind).toBe('reactivated');

    // Deep links: the full history is reconstructable.
    const history = await listRoleVersions(ctx, { roleId: role.id });
    expect(history.map((version) => version.version)).toEqual([1, 2, 3, 4, 5]);
    expect(history.map((version) => version.changeKind)).toEqual([
      'created',
      'revised',
      'revised',
      'retired',
      'reactivated',
    ]);
    const v4 = await getRoleVersion(ctx, { roleId: role.id, version: 4 });
    expect(v4.status).toBe('retired');
    expect(v4.roleKey).toBe('Data steward'); // immutable key snapshotted
    await expectCode('role_version_not_found', () =>
      getRoleVersion(ctx, { roleId: role.id, version: 99 }),
    );
  });

  it('rejects duplicate role keys with a clean conflict code', async () => {
    await registerRole(ctx, { roleKey: 'Unique desk', expectedWeeklyHours: 40, actor: PERSON_OPS });
    await expectCode('role_key_conflict', () =>
      registerRole(ctx, { roleKey: 'Unique desk', expectedWeeklyHours: 20, actor: PERSON_OPS }),
    );
  });

  it('versions assignments, rejects duplicates and retired-role assignments', async () => {
    const role = await registerRole(ctx, { roleKey: 'Billing desk', expectedWeeklyHours: 40, actor: PERSON_OPS });
    const assignment = await assignRole(ctx, {
      roleId: role.id,
      employee: { id: EMPLOYEE_BOB, label: 'Bob' },
      allocation: 0.5,
      actor: PERSON_OPS,
    });
    // (role, employee) is the graph key.
    await expectCode('assignment_conflict', () =>
      assignRole(ctx, {
        roleId: role.id,
        employee: { id: EMPLOYEE_BOB, label: 'Bob' },
        actor: PERSON_OPS,
      }),
    );
    const revised = await reviseAssignment(ctx, {
      assignmentId: assignment.id,
      allocation: 0.75,
      evidenceObservationIds: [OBS_1],
      actor: PERSON_OPS,
    });
    expect(revised.version).toBe(2);
    expect(revised.allocation).toBe(0.75);
    expect(revised.evidenceObservationIds).toEqual([OBS_1]);

    await expectCode('invalid_assignment_input', () =>
      reviseAssignment(ctx, {
        assignmentId: assignment.id,
        status: 'retired',
        allocation: 1,
        actor: PERSON_OPS,
      }),
    );
    const retired = await reviseAssignment(ctx, {
      assignmentId: assignment.id,
      status: 'retired',
      actor: PERSON_OPS,
      rationale: 'Bob moved on',
    });
    expect(retired.status).toBe('retired');
    await expectCode('invalid_transition', () =>
      reviseAssignment(ctx, { assignmentId: assignment.id, allocation: 1, actor: PERSON_OPS }),
    );
    const reactivated = await reviseAssignment(ctx, {
      assignmentId: assignment.id,
      status: 'active',
      actor: PERSON_OPS,
    });
    expect(reactivated.status).toBe('active');

    // Assignments against a retired role are rejected.
    const tempRole = await registerRole(ctx, { roleKey: 'Temp desk', expectedWeeklyHours: 10, actor: PERSON_OPS });
    await reviseRole(ctx, { roleId: tempRole.id, status: 'retired', actor: PERSON_OPS });
    await expectCode('invalid_transition', () =>
      assignRole(ctx, { roleId: tempRole.id, employee: { id: EMPLOYEE_BOB }, actor: PERSON_OPS }),
    );
    // A foreign role id reads as missing (no existence leak).
    await expectCode('role_not_found', () =>
      assignRole(ctx, { roleId: '00000000-0000-4000-8000-0000000000ff', employee: { id: EMPLOYEE_BOB }, actor: PERSON_OPS }),
    );

    // Deep links + summaries.
    const history = await listAssignmentVersions(ctx, { assignmentId: assignment.id });
    expect(history.map((version) => version.changeKind)).toEqual([
      'assigned',
      'revised',
      'retired',
      'reactivated',
    ]);
    const v2 = await getAssignmentVersion(ctx, { assignmentId: assignment.id, version: 2 });
    expect(v2.employee).toEqual({ id: EMPLOYEE_BOB, label: 'Bob' }); // immutable identity snapshot
    const roleNow = await getRole(ctx, role.id);
    expect(roleNow.assignmentSummary).toEqual({ activeCount: 1, retiredCount: 0 });

    // Assessment of a retired role's assignment: excluded with the count reported.
    await reviseRole(ctx, { roleId: tempRole.id, status: 'active', actor: PERSON_OPS });
    await assignRole(ctx, { roleId: tempRole.id, employee: { id: EMPLOYEE_BOB }, actor: PERSON_OPS });
    await reviseRole(ctx, { roleId: tempRole.id, status: 'retired', actor: PERSON_OPS });
    const assessed = await assessWorkforce(ctx, {
      employee: { id: EMPLOYEE_BOB, label: 'Bob' },
      recommendation: { kind: 'monitor', text: 'Check the desk situation.' },
      confidence: 0.5,
      actor: PERSON_OPS,
    });
    expect(assessed.content.scope.excludedRetiredRoleAssignmentCount).toBe(1);
    expect(assessed.content.workload.totalAllocation).toBe(0.75); // billing desk only (at its revised allocation)
    expect(assessed.content.workload.status).toBe('insufficient_evidence');
  });

  it('signals and versions are append-only at the storage level', async () => {
    const role = await registerRole(ctx, { roleKey: 'Archive desk', expectedWeeklyHours: 5, actor: PERSON_OPS });
    const assignment = await assignRole(ctx, {
      roleId: role.id,
      employee: { id: EMPLOYEE_ADA },
      actor: PERSON_OPS,
    });
    // A signal row must exist in THIS tenant: row-level triggers fire only
    // for rows the statement actually touches.
    await recordSignal(ctx, {
      employee: { id: EMPLOYEE_ADA },
      kind: 'workload',
      value: 5,
      actor: PERSON_OPS,
    });
    await expectSqlRejection(
      `UPDATE workforce_signals SET value = 0 WHERE tenant_id = '${tenantVersioned}'`,
    );
    await expectSqlRejection(`DELETE FROM workforce_signals WHERE tenant_id = '${tenantVersioned}'`);
    await expectSqlRejection(`TRUNCATE workforce_signals`);
    await expectSqlRejection(
      `UPDATE role_expectation_versions SET title = 'forged' WHERE tenant_id = '${tenantVersioned}'`,
    );
    await expectSqlRejection(
      `DELETE FROM role_assignment_versions WHERE tenant_id = '${tenantVersioned}'`,
    );
    await expectSqlRejection(
      `UPDATE workforce_assessment_versions SET confidence = 1 WHERE tenant_id = '${tenantVersioned}'`,
    );
    await expectSqlRejection(`DELETE FROM role_expectations WHERE tenant_id = '${tenantVersioned}'`);
    await expectSqlRejection(`DELETE FROM role_assignments WHERE tenant_id = '${tenantVersioned}'`);
    await expectSqlRejection(`DELETE FROM workforce_assessments WHERE tenant_id = '${tenantVersioned}'`);
    await expectSqlRejection(`TRUNCATE role_expectation_versions`);
    // The identity version POINTER may still advance — that is versioning.
    const pointer = await getDb().query(
      `UPDATE role_assignments SET current_version = current_version WHERE id = '${assignment.id}' AND tenant_id = '${tenantVersioned}'`,
    );
    expect(pointer.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('workforce intelligence — tenant isolation', () => {
  const main = member(tenantMain);
  const iso = member(tenantIso);

  it('foreign-tenant records read as missing across every surface (no existence leak)', async () => {
    const roles = await listRoles(main, {});
    const foreignRole = roles[0]!;
    const assignments = await listAssignments(main, { employeeId: EMPLOYEE_ADA });
    const foreignAssignment = assignments[0]!;
    const signals = await listSignals(main, {});
    const foreignSignal = signals[0]!;
    const assessments = await listAssessments(main, {});
    const foreignAssessment = assessments[0]!;
    const decision = await getDecision(member(tenantDecide), {
      decisionId: (await listDecisions(member(tenantDecide), {}))[0]!.id,
    });

    await expectCode('role_not_found', () => getRole(iso, foreignRole.id));
    await expectCode('role_version_not_found', () =>
      getRoleVersion(iso, { roleId: foreignRole.id, version: 1 }),
    );
    await expectCode('role_not_found', () =>
      listRoleVersions(iso, { roleId: foreignRole.id }),
    );
    await expectCode('role_not_found', () =>
      reviseRole(iso, { roleId: foreignRole.id, title: 'steal', actor: PERSON_OPS }),
    );
    await expectCode('assignment_not_found', () => getAssignment(iso, foreignAssignment.id));
    await expectCode('assignment_not_found', () =>
      reviseAssignment(iso, {
        assignmentId: foreignAssignment.id,
        allocation: 1,
        actor: PERSON_OPS,
      }),
    );
    await expectCode('signal_not_found', () => getSignal(iso, { signalId: foreignSignal.id }));
    await expectCode('assessment_not_found', () => getAssessment(iso, foreignAssessment.id));
    await expectCode('assessment_not_found', () =>
      listAssessmentVersions(iso, { assessmentId: foreignAssessment.id }),
    );
    await expectCode('assessment_not_found', () =>
      recordDecision(decider(tenantIso), {
        assessmentId: foreignAssessment.id,
        decision: 'accepted',
        decider: { kind: 'person', id: PERSON_MANAGER.id },
      }),
    );
    await expectCode('decision_not_found', () => getDecision(iso, { decisionId: decision.id }));
    // Registrations against foreign-tenant ids read as missing too.
    await expectCode('role_not_found', () =>
      assignRole(iso, { roleId: foreignRole.id, employee: { id: EMPLOYEE_ADA }, actor: PERSON_OPS }),
    );
  });

  it('listings and assessments never leak across tenants', async () => {
    expect(await listRoles(iso, {})).toEqual([]);
    expect(await listAssignments(iso, {})).toEqual([]);
    expect(await listSignals(iso, {})).toEqual([]);
    expect(await listAssessments(iso, {})).toEqual([]);
    expect(await listDecisions(iso, {})).toEqual([]);
  });

  it('capability supplies are read tenant-scoped through the capabilities contract', async () => {
    // The same employee id exists in both tenants; only the ISO tenant's
    // capability graph feeds the ISO tenant's fit assessment.
    const isoCapability = await registerCapability(iso, {
      name: 'German-language support',
      actor: PERSON_OPS,
    });
    await registerSupply(iso, {
      capabilityId: isoCapability.id,
      supplier: { kind: 'employee', id: EMPLOYEE_ADA, label: 'Ada (iso)' },
      level: 0.2, // deliberately different from the main tenant's 0.9
      actor: PERSON_OPS,
    });
    const isoRole = await registerRole(iso, {
      roleKey: 'Support engineer',
      requiredCapabilities: [{ capabilityId: isoCapability.id, minLevel: 0.5 }],
      expectedWeeklyHours: 40,
      actor: PERSON_OPS,
    });
    await assignRole(iso, {
      roleId: isoRole.id,
      employee: { id: EMPLOYEE_ADA, label: 'Ada (iso)' },
      actor: PERSON_OPS,
    });
    const isoAssessment = await assessWorkforce(iso, {
      employee: { id: EMPLOYEE_ADA, label: 'Ada (iso)' },
      recommendation: { kind: 'training', text: 'German skills need work in this tenant.' },
      confidence: 0.6,
      actor: PERSON_OPS,
    });
    // The MAIN tenant's 0.9 supply did not leak: ISO fit is unmet at 0.2 < 0.5.
    expect(isoAssessment.content.fit.status).toBe('does_not_fit');
    expect(isoAssessment.content.fit.details[0]!.suppliedLevel).toBe(0.2);
    // A separate assessment identity per tenant for the same employee id.
    const mainAssessments = await listAssessments(main, { employeeId: EMPLOYEE_ADA });
    expect(mainAssessments[0]!.id).not.toBe(isoAssessment.id);
  });

  it('rejects malformed and invalid contexts', async () => {
    await expectCode('invalid_context', () =>
      listRoles({ tenantId: '', principalId: 'p', authority: [] }, {}),
    );
    await expectCode('invalid_query', () => listRoles(main, { limit: 0 }));
    await expectCode('invalid_query', () =>
      listSignals(main, { employeeId: 'x'.repeat(201) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeDb();
});
