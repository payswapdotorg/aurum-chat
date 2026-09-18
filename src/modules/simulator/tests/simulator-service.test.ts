// Integration tests for the simulator module (W056) against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the module's
// own acceptance beyond the longitudinal benchmark (tests/longitudinal):
//
//  * MATERIALIZATION: the company exists through the ordinary contracts
//    (employees with verified identities, registered sources, goal,
//    reconstructed process with a bottleneck, suppliers), requires the
//    identity authorities, rejects duplicate seeds and invalid inputs.
//  * THE MONTH DRIVER: advanceMonth runs the full loop (discovery →
//    mission → planner walk → answers → mission outcome → intervention →
//    learning → judgments → snapshot) and the EXPERIENCED instance's
//    month 2 is measurably better than its month 1 at the module level
//    (7 steps → 1 step, the Controller first → the CRM first), while the
//    no-learning tenant stays at cold behavior and CompanyModel version 0.
//  * TENANT ISOLATION: another tenant's context sees nothing
//    (company_not_found on every surface — no existence leak).
//  * NO GROUND-TRUTH LEAKAGE: the hidden markers never appear on any
//    cognition surface (observations, claims, messages, CompanyModel
//    statements), and the hidden answers appear ONLY as the evidence
//    observations of answered acquisition plans.
//  * DETERMINISM: the same seed in a second tenant reproduces month 1's
//    observable behavior exactly.
//
// Time is deterministic: the service clock ticks +60s per call from a
// per-month pinned base (the quality/learning test precedent, extended to
// a tick because one advanceMonth call makes many contract calls).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { systemClock } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { getCompanyModel } from '@/modules/learning/contract';
import { listAcquisitionPlans } from '@/modules/knowledge-acquisition/contract';
import { listClaims } from '@/modules/epistemics/contract';
import { listMessages } from '@/modules/conversations/contract';
import { listObservations } from '@/modules/observations/contract';
import { listProcesses } from '@/modules/processes/contract';
import { listSuppliers } from '@/modules/suppliers/contract';
import { listSources } from '@/modules/sources/contract';
import { runMigrations } from '../../../../scripts/migrate';
import * as simulatorContract from '../contract';
import { deriveCompanyDesign } from '../world';
import type { MonthReport, SimCompanyView } from '../types';

const {
  advanceMonth,
  getCompany,
  materializeCompany,
  revealGroundTruth,
} = simulatorContract;

const SEED = 0x005eedc0;

const tenantExperienced = newId();
const tenantCold = newId();
const tenantDeterminism = newId();
const tenantStranger = newId();
const tenantGuards = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function privileged(tenantId: string): TenantContext {
  return {
    tenantId,
    principalId: newId(),
    authority: ['identity:attest', 'identity:link'],
  };
}

// The tick clock: every now() call advances 60s from the pinned base.
let virtualMs = Date.parse('2025-12-15T09:00:00.000Z');
function pin(iso: string): void {
  virtualMs = Date.parse(iso);
}

const companyExperienced: { view: SimCompanyView } = { view: null as unknown as SimCompanyView };
const companyCold: { view: SimCompanyView } = { view: null as unknown as SimCompanyView };
const companyDeterminism: { view: SimCompanyView } = { view: null as unknown as SimCompanyView };
const monthOne: { report: MonthReport } = { report: null as unknown as MonthReport };
const monthTwo: { report: MonthReport } = { report: null as unknown as MonthReport };
const coldOne: { report: MonthReport } = { report: null as unknown as MonthReport };
const coldTwo: { report: MonthReport } = { report: null as unknown as MonthReport };
const determinismOne: { report: MonthReport } = { report: null as unknown as MonthReport };

beforeAll(async () => {
  await runMigrations(getDb());
  vi.spyOn(systemClock, 'now').mockImplementation(() => {
    virtualMs += 60_000;
    return new Date(virtualMs);
  });

  // -- The experienced instance: months 1-2 with learning.
  const ctxA = privileged(tenantExperienced);
  companyExperienced.view = await materializeCompany(ctxA, { seed: SEED });
  pin('2026-01-01T00:00:00.000Z');
  monthOne.report = await advanceMonth(ctxA, {
    companyId: companyExperienced.view.id,
    learning: true,
  });
  pin('2026-02-01T00:00:00.000Z');
  monthTwo.report = await advanceMonth(ctxA, {
    companyId: companyExperienced.view.id,
    learning: true,
  });

  // -- The no-learning control: months 1-2 without learning.
  const ctxB = privileged(tenantCold);
  companyCold.view = await materializeCompany(ctxB, { seed: SEED });
  pin('2026-01-01T00:00:00.000Z');
  coldOne.report = await advanceMonth(ctxB, {
    companyId: companyCold.view.id,
    learning: false,
  });
  pin('2026-02-01T00:00:00.000Z');
  coldTwo.report = await advanceMonth(ctxB, {
    companyId: companyCold.view.id,
    learning: false,
  });

  // -- The determinism tenant: month 1 with learning (must equal A's month 1).
  const ctxC = privileged(tenantDeterminism);
  companyDeterminism.view = await materializeCompany(ctxC, { seed: SEED });
  pin('2026-01-01T00:00:00.000Z');
  determinismOne.report = await advanceMonth(ctxC, {
    companyId: companyDeterminism.view.id,
    learning: true,
  });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

describe('materializeCompany', () => {
  it('builds the company through the ordinary module contracts', async () => {
    const view = companyExperienced.view;
    expect(view.seed).toBe(SEED);
    expect(view.employees).toHaveLength(5);
    expect(view.systems).toHaveLength(4);
    // The view read fresh reflects the advanced months.
    const fresh = await getCompany(member(tenantExperienced), { companyId: view.id });
    expect(fresh.currentMonth).toBe(2);

    const design = deriveCompanyDesign(SEED);
    const ctx = member(tenantExperienced);
    const suppliers = await listSuppliers(ctx, { limit: 500 });
    expect(suppliers.map((supplier) => supplier.name).sort()).toEqual(
      [...design.suppliers.map((supplier) => supplier.name)].sort(),
    );
    const sources = await listSources(ctx, { limit: 500 });
    expect(sources).toHaveLength(4);
    const processes = await listProcesses(ctx, { limit: 500 });
    expect(processes.map((process) => process.name)).toContain(design.process.name);

    // The registered sources carry opaque credential REFERENCES, never values.
    for (const source of sources) {
      expect(source.credentialRef.startsWith('secret-ref://simulator/')).toBe(true);
    }
  });

  it('requires the identity attest and link authorities', async () => {
    const ctx = member(tenantGuards);
    await expect(materializeCompany(ctx, { seed: 999 })).rejects.toMatchObject({
      code: 'identity_authority_required',
    });
  });

  it('rejects invalid seeds and duplicate seeds per tenant', async () => {
    const ctx = privileged(tenantGuards);
    await expect(materializeCompany(ctx, { seed: -1 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(materializeCompany(ctx, { seed: 0x8000_0000 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await materializeCompany(ctx, { seed: 12345 });
    await expect(materializeCompany(ctx, { seed: 12345 })).rejects.toMatchObject({
      code: 'company_already_exists',
    });
  });

  it('reveals the hidden ground truth only through the evaluation surface', async () => {
    const ctx = member(tenantExperienced);
    const reveal = await revealGroundTruth(ctx, {
      companyId: companyExperienced.view.id,
      month: 1,
    });
    expect(reveal.marker).toMatch(/^gt-[0-9a-f]{8}-m01$/);
    expect(reveal.consequential).toBe(true);
    expect(reveal.hiddenQualities).toHaveLength(9);
    const crm = reveal.hiddenQualities.find((entry) => entry.label === 'Billing CRM')!;
    expect(crm.quality).toBe(0.98);
    expect(reveal.intervention.realizedValue).toBe(10.5);
    await expect(
      revealGroundTruth(ctx, { companyId: companyExperienced.view.id, month: 25 }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// ---------------------------------------------------------------------------
// The month driver
// ---------------------------------------------------------------------------

describe('advanceMonth — the intelligence loop over the synthetic company', () => {
  it('month 1: unprompted discovery, a 7-step walk, settled outcomes, learning', async () => {
    const report = monthOne.report;
    expect(report.month).toBe(1);
    expect(report.topic).toBe('churn-driver');
    expect(report.promotedCandidates).toHaveLength(1);
    expect(report.steps).toBe(7);
    expect(report.firstChoice?.kind).toBe('person');

    // The walk's order is the public-authority order (cold-start behavior).
    const labels = report.acquisitions.map((entry) => entry.chosen.label);
    expect(labels).toEqual([
      expect.any(String), // the Controller (highest public authority)
      expect.any(String), // the Operations lead
      expect.any(String), // the Support lead
      expect.any(String), // the Warehouse specialist
      expect.any(String), // the Finance analyst
      'Company Wiki',
      'Billing CRM',
    ]);
    expect(report.acquisitions.every((entry) => entry.outcome === 'answered')).toBe(true);

    // The mission resolved on the CRM's 0.98 evidence.
    expect(report.resolution).not.toBeNull();
    expect(report.resolution!.achievedConfidence).toBe(0.98);

    // The month's capability change: cold expectation, realized through W054.
    expect(report.intervention).not.toBeNull();
    expect(report.intervention!.expected).toBe(12);

    // The experienced instance recorded its learning update and judgments.
    expect(report.learningUpdateId).not.toBeNull();
    expect(report.judgmentIds).toHaveLength(2);
    expect(report.snapshotId).not.toBeNull();
  });

  it('month 2: the learned priors route the walk to the CRM first (1 step)', async () => {
    const report = monthTwo.report;
    expect(report.month).toBe(2);
    expect(report.topic).toBe('supplier-delay');
    expect(report.steps).toBe(1);
    expect(report.firstChoice?.kind).toBe('system');
    expect(report.firstChoice?.label).toBe('Billing CRM');
    expect(report.resolution!.achievedConfidence).toBe(0.98);
    // The recommendation is now calibrated by the learned intervention prior:
    // 12 × (0.45 + 0.55 × 10.5/12) = 11.175.
    expect(report.intervention!.expected).toBe(11.175);
    expect(report.learningUpdateId).not.toBeNull();
  });

  it('the no-learning control stays at cold behavior with CompanyModel version 0', async () => {
    const ctx = member(tenantCold);
    expect(coldOne.report.steps).toBe(7);
    expect(coldOne.report.firstChoice?.kind).toBe('person');
    expect(coldTwo.report.steps).toBe(7);
    expect(coldTwo.report.firstChoice?.kind).toBe('person');
    expect(coldTwo.report.intervention!.expected).toBe(12);
    expect(coldOne.report.learningUpdateId).toBeNull();
    expect(coldTwo.report.learningUpdateId).toBeNull();

    const model = await getCompanyModel(ctx, {});
    expect(model.modelVersion).toBe(0);
    expect(model.assertions).toEqual([]);

    const view = await getCompany(ctx, { companyId: companyCold.view.id });
    expect(view.currentMonth).toBe(2);
  });

  it('exhausts the timeline after 24 months', { timeout: 120_000 }, async () => {
    // Fast-forward a fresh company through its remaining months.
    const ctx = privileged(tenantGuards);
    const view = await materializeCompany(ctx, { seed: 777 });
    for (let month = 1; month <= 24; month += 1) {
      const year = month <= 12 ? 2026 : 2027;
      pin(`${year}-${String(((month - 1) % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`);
      await advanceMonth(ctx, { companyId: view.id, learning: false });
    }
    await expect(advanceMonth(ctx, { companyId: view.id, learning: false })).rejects.toMatchObject({
      code: 'month_unavailable',
    });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it("another tenant sees nothing — uniform not-found, no existence leak", async () => {
    const ctx = member(tenantStranger);
    const companyId = companyExperienced.view.id;
    await expect(getCompany(ctx, { companyId })).rejects.toMatchObject({
      code: 'company_not_found',
    });
    await expect(
      revealGroundTruth(ctx, { companyId, month: 1 }),
    ).rejects.toMatchObject({ code: 'company_not_found' });
    await expect(
      advanceMonth(ctx, { companyId, learning: false }),
    ).rejects.toMatchObject({ code: 'company_not_found' });
  });
});

// ---------------------------------------------------------------------------
// No ground-truth leakage
// ---------------------------------------------------------------------------

describe('no hidden-ground-truth leakage', () => {
  it('the hidden markers never appear on any cognition surface', async () => {
    const ctx = member(tenantExperienced);
    const revealOne = await revealGroundTruth(ctx, {
      companyId: companyExperienced.view.id,
      month: 1,
    });
    const revealTwo = await revealGroundTruth(ctx, {
      companyId: companyExperienced.view.id,
      month: 2,
    });
    const markers = [revealOne.marker, revealTwo.marker];
    const answers = [revealOne.answerText, revealTwo.answerText];

    // Observations: no markers anywhere; answers only as answered-plan evidence.
    const observations = await listObservations(ctx, { limit: 500 });
    expect(observations.length).toBeGreaterThan(0);
    const plans = await listAcquisitionPlans(ctx, { limit: 500 });
    const answeredEvidenceIds = new Set(
      plans
        .filter((plan) => plan.outcome?.outcome === 'answered')
        .map((plan) => plan.outcome!.evidenceObservationId)
        .filter((id): id is string => id !== null),
    );
    expect(answeredEvidenceIds.size).toBeGreaterThan(0);
    for (const observation of observations) {
      const serialized = JSON.stringify(observation.payload);
      for (const marker of markers) {
        expect(serialized.includes(marker)).toBe(false);
      }
      if (answers.some((answer) => serialized.includes(answer))) {
        expect(answeredEvidenceIds.has(observation.id)).toBe(true);
      }
    }

    // Claims: propositions carry readings, never markers or answers.
    const claims = await listClaims(ctx, { limit: 500 });
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      for (const marker of markers) {
        expect(claim.proposition.includes(marker)).toBe(false);
      }
      for (const answer of answers) {
        expect(claim.proposition.includes(answer)).toBe(false);
      }
    }

    // Messages: chatter, never markers or answers.
    const messages = await listMessages(ctx, { limit: 500 });
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      const serialized = JSON.stringify(message.payload);
      for (const marker of markers) {
        expect(serialized.includes(marker)).toBe(false);
      }
      for (const answer of answers) {
        expect(serialized.includes(answer)).toBe(false);
      }
    }

    // The CompanyModel: learned scores only — no hidden content.
    const model = await getCompanyModel(ctx, {});
    expect(model.modelVersion).toBe(2);
    for (const assertion of model.assertions) {
      const serialized = JSON.stringify(assertion.statement);
      for (const marker of markers) {
        expect(serialized.includes(marker)).toBe(false);
      }
      for (const answer of answers) {
        expect(serialized.includes(answer)).toBe(false);
      }
      expect(Object.keys(assertion.statement)).toEqual(['score']);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism — the same seed, the same company, the same behavior', () => {
  it('reproduces month 1 exactly in a second tenant', async () => {
    const left = monthOne.report;
    const right = determinismOne.report;
    expect(right.steps).toBe(left.steps);
    expect(right.firstChoice?.kind).toBe(left.firstChoice?.kind);
    expect(right.firstChoice?.label).toBe(left.firstChoice?.label);
    expect(
      right.acquisitions.map((entry) => `${entry.chosen.kind}:${entry.chosen.label}:${entry.outcome}`),
    ).toEqual(
      left.acquisitions.map((entry) => `${entry.chosen.kind}:${entry.chosen.label}:${entry.outcome}`),
    );
    expect(right.resolution?.achievedConfidence).toBe(left.resolution?.achievedConfidence);
    expect(right.intervention?.expected).toBe(left.intervention?.expected);
    expect(right.topic).toBe(left.topic);
  });
});
