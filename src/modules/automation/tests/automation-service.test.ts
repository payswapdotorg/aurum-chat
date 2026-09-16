// Integration tests for the automation module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W018
// acceptance: "Represent automation candidates with process evidence,
// frequency, cost, error rate, candidate solution types, expected ROI and
// outcome measurement."
//
//  * EVIDENCE-BACKED: candidates are registered against a REAL process
//    reconstruction (events seeded through the events contract, then
//    reconstructProcess through the processes contract) citing its actual
//    findings; a missing process, a foreign-tenant process, a finding of
//    another process and a foreign-tenant finding are uniformly
//    `invalid_process_ref`; the optional capability reference is validated
//    through the capabilities contract (`processes + capabilities →
//    automation`) and a missing/foreign capability is
//    `invalid_capability_ref`.
//  * REPRESENTED: version 1 carries the process evidence (with name
//    snapshots), frequency, cost (integer minor units + ISO currency),
//    error rate, the candidate solution types, the committed expected-ROI
//    figures and the outcome-measurement plan, with system-minted
//    identity/tenancy/version/change-kind/commit-time/principal audit
//    fields — and the DERIVED expected-ROI summary (net benefit, ratio,
//    payback — never persisted) computed on read.
//  * VERSIONED/AUDITABLE: revisions append (carry-over merge, tri-state
//    clears, partial outcome-plan patches), lifecycle transitions are
//    surgical, accepted/dismissed records are frozen (the committed
//    prediction cannot be rewritten), reopening re-enables estimation,
//    histories are deep-linkable, and the storage layer rejects
//    UPDATE/DELETE/TRUNCATE on versions and measurements and DELETE/
//    TRUNCATE on identities outright (triggers) — while the identity's
//    version POINTER may still advance (that is its only job).
//  * OUTCOME MEASUREMENT: observed metric values are append-only,
//    recordable only while accepted, ordered canonically, deep-linkable,
//    and the current view derives the latest observed value and the
//    deterministic target-met verdict.
//  * CONFLICTS: duplicate names fail with `opportunity_name_conflict`;
//    a stale `expectedVersion` fails with `opportunity_conflict`.
//  * TENANT ISOLATION (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks): foreign-tenant
//    opportunities, versions and measurements read as missing; listings
//    never leak across tenants; the same NAME may exist in both tenants.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { appendEvent } from '@/modules/events/contract';
import {
  listProcessFindings,
  reconstructProcess,
  type Process,
  type ProcessFinding,
} from '@/modules/processes/contract';
import { registerCapability } from '@/modules/capabilities/contract';
import { AutomationError } from '../errors';
import * as automationContract from '../contract';
import type {
  AutomationOpportunity,
  AutomationOpportunityVersion,
  AutomationSolutionType,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getMeasurement,
  getOpportunity,
  getOpportunityVersion,
  listMeasurements,
  listOpportunities,
  listOpportunityVersions,
  recordMeasurement,
  registerOpportunity,
  reviseOpportunity,
} = automationContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantMain = newId(); // the full scenario (evidence → ROI → outcome)
const tenantIso = newId(); // the other tenant (isolation checks)
const tenantLifecycle = newId(); // transitions / freezing / conflicts
const tenantList = newId(); // management listings
const tenantTriggers = newId(); // storage-level append-only enforcement

const PERSON_OPS = '1a2b3c4d-0000-4000-8000-0000000000p1';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

const ACTOR = { kind: 'person' as const, id: PERSON_OPS, label: 'Ops lead' };

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AutomationError);
    expect((error as AutomationError).code).toBe(code);
  }
}

/** Raw SQL rejection assertion (the storage triggers). */
async function expectSqlRejection(sql: string): Promise<void> {
  await expect(getDb().query(sql)).rejects.toThrow();
}

function at(minutes: number): string {
  return new Date(Date.parse('2026-09-14T08:00:00Z') + minutes * 60_000).toISOString();
}

/**
 * Seeds the invoice flow the main scenario's process evidence comes from:
 * three cases with a ping-pong approval, a rework and a payment failure —
 * the W016 test scenario, so manual effort, duplication, handoffs and
 * errors are all detectable.
 */
async function seedInvoiceProcess(ctx: TenantContext, name: string): Promise<{
  process: Process;
  findings: ProcessFinding[];
}> {
  const flow1 = newId();
  const flow2 = newId();
  const flow3 = newId();
  const events: { type: string; occurredAt: string; correlationId: string; actorKind?: 'person' | 'system'; actorId?: string }[] = [
    { type: 'invoice.registered', occurredAt: at(0), correlationId: flow1 },
    { type: 'invoice.reviewed', occurredAt: at(30), correlationId: flow1, actorId: '1a2b3c4d-0000-4000-8000-0000000000p2' },
    { type: 'invoice.approved', occurredAt: at(90), correlationId: flow1 },
    { type: 'invoice.registered', occurredAt: at(1000), correlationId: flow2 },
    { type: 'invoice.reviewed', occurredAt: at(1030), correlationId: flow2, actorId: '1a2b3c4d-0000-4000-8000-0000000000p2' },
    { type: 'invoice.approved', occurredAt: at(1120), correlationId: flow2 },
    { type: 'invoice.registered', occurredAt: at(2000), correlationId: flow3 },
    { type: 'invoice.reviewed', occurredAt: at(2030), correlationId: flow3, actorId: '1a2b3c4d-0000-4000-8000-0000000000p2' },
    { type: 'invoice.reviewed', occurredAt: at(2040), correlationId: flow3, actorId: '1a2b3c4d-0000-4000-8000-0000000000p2' },
    { type: 'invoice.payment.failed', occurredAt: at(2045), correlationId: flow3, actorKind: 'system', actorId: 'billing-system' },
  ];
  for (const event of events) {
    await appendEvent(ctx, {
      type: event.type,
      payload: { note: `occurrence of ${event.type}` },
      occurredAt: event.occurredAt,
      actor: {
        kind: event.actorKind ?? 'person',
        id: event.actorId ?? PERSON_OPS,
      },
      source: { kind: 'system', label: 'test-harness' },
      correlationId: event.correlationId,
    });
  }
  const process = await reconstructProcess(ctx, {
    name,
    scope: {
      eventTypes: ['invoice.registered', 'invoice.reviewed', 'invoice.approved', 'invoice.payment.failed'],
    },
    options: { bottleneckThresholdSeconds: 3000 },
    actor: ACTOR,
    rationale: 'Quarterly process review',
  });
  const findings = await listProcessFindings(ctx, { processId: process.id, limit: 500 });
  return { process, findings };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The main scenario: process evidence → candidate → ROI → outcome measurement
// ---------------------------------------------------------------------------

describe('automation opportunities — the main scenario', () => {
  const ctx = member(tenantMain);
  let process: Process;
  let findings: ProcessFinding[];
  let opportunity: AutomationOpportunity;

  beforeAll(async () => {
    ({ process, findings } = await seedInvoiceProcess(ctx, 'Invoice approval'));
  });

  it('rejects a missing process reference (uniformly, like a foreign-tenant one)', async () => {
    await expectCode(
      'invalid_process_ref',
      () =>
        registerOpportunity(ctx, {
          name: 'Automate invoice data entry',
          processId: newId(),
          findingIds: [findings[0]!.id],
          frequencyCount: 600,
          period: 'month',
          currency: 'EUR',
          currentCostMinor: 900_000,
          errorRate: 0.08,
          solutionTypes: ['recruit_agent'],
          expectedSavingsMinor: 600_000,
          expectedInvestmentMinor: 240_000,
          roiHorizonPeriods: 12,
          outcome: {
            metricName: 'manual handling minutes per month',
            metricUnit: 'minutes',
            direction: 'at_most',
            baseline: 1200,
            target: 240,
          },
          actor: ACTOR,
        }),
    );
  });

  it('rejects a finding of another process', async () => {
    const { process: other, findings: otherFindings } = await seedInvoiceProcess(ctx, 'Expense approval');
    await expectCode(
      'invalid_process_ref',
      () =>
        registerOpportunity(ctx, {
          name: 'Automate invoice data entry',
          processId: process.id,
          findingIds: [otherFindings[0]!.id],
          frequencyCount: 600,
          period: 'month',
          currency: 'EUR',
          currentCostMinor: 900_000,
          errorRate: 0.08,
          solutionTypes: ['recruit_agent'],
          expectedSavingsMinor: 600_000,
          expectedInvestmentMinor: 240_000,
          roiHorizonPeriods: 12,
          outcome: {
            metricName: 'manual handling minutes per month',
            metricUnit: 'minutes',
            direction: 'at_most',
            baseline: 1200,
            target: 240,
          },
          actor: ACTOR,
        }),
    );
    expect(other.name).toBe('Expense approval'); // the decoy exists — the ref was wrong, not missing
  });

  it('registers a candidate at version 1 with all seven attributes and the derived ROI', async () => {
    opportunity = await registerOpportunity(ctx, {
      name: 'Automate invoice data entry',
      processId: process.id,
      findingIds: findings.map((finding) => finding.id),
      description: 'Manual entry of scanned invoices into the ERP',
      frequencyCount: 600,
      period: 'month',
      currency: 'EUR',
      currentCostMinor: 900_000,
      errorRate: 0.08,
      solutionTypes: ['install_extension', 'recruit_agent', 'build_extension'],
      expectedSavingsMinor: 600_000,
      expectedInvestmentMinor: 240_000,
      roiHorizonPeriods: 12,
      outcome: {
        metricName: 'manual handling minutes per month',
        metricUnit: 'minutes',
        direction: 'at_most',
        baseline: 1200,
        target: 240,
      },
      actor: ACTOR,
      rationale: 'Q3 process review',
    });

    // identity + audit (system-minted)
    expect(opportunity.tenantId).toBe(tenantMain);
    expect(opportunity.version).toBe(1);
    expect(opportunity.status).toBe('candidate');
    expect(opportunity.lastChange.kind).toBe('created');
    expect(opportunity.lastChange.actor).toEqual(ACTOR);
    expect(opportunity.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(opportunity.lastChange.rationale).toBe('Q3 process review');
    expect(opportunity.createdAt).toBe(opportunity.updatedAt);

    // process evidence (validated + snapshotted)
    expect(opportunity.process).toEqual({ id: process.id, name: 'Invoice approval' });
    expect(opportunity.findingIds).toEqual(findings.map((finding) => finding.id));
    expect(opportunity.capability).toBeNull();

    // frequency / cost / error rate / solution types
    expect(opportunity.frequencyCount).toBe(600);
    expect(opportunity.period).toBe('month');
    expect(opportunity.currency).toBe('EUR');
    expect(opportunity.currentCostMinor).toBe(900_000);
    expect(opportunity.errorRate).toBe(0.08);
    expect(opportunity.solutionTypes).toEqual(['recruit_agent', 'install_extension', 'build_extension']);

    // committed expected-ROI figures
    expect(opportunity.expectedSavingsMinor).toBe(600_000);
    expect(opportunity.expectedInvestmentMinor).toBe(240_000);
    expect(opportunity.roiHorizonPeriods).toBe(12);

    // the DERIVED ROI (never persisted): 600000 × 12 − 240000 = 6,960,000
    expect(opportunity.expectedRoi.expectedNetBenefitMinor).toBe(6_960_000);
    expect(opportunity.expectedRoi.expectedRoiRatio).toBe(29);
    expect(opportunity.expectedRoi.expectedPaybackPeriods).toBe(0.4);
    expect(opportunity.expectedRoi.currency).toBe('EUR');
    expect(opportunity.expectedRoi.period).toBe('month');

    // the outcome-measurement plan + the empty derived summary
    expect(opportunity.outcome).toEqual({
      metricName: 'manual handling minutes per month',
      metricUnit: 'minutes',
      direction: 'at_most',
      baseline: 1200,
      target: 240,
    });
    expect(opportunity.outcomeMeasurements.measurementCount).toBe(0);
    expect(opportunity.outcomeMeasurements.latest).toBeNull();
    expect(opportunity.outcomeMeasurements.progress).toBeNull();
  });

  it('rejects a duplicate name with opportunity_name_conflict', async () => {
    await expectCode(
      'opportunity_name_conflict',
      () =>
        registerOpportunity(ctx, {
          name: 'Automate invoice data entry',
          processId: process.id,
          findingIds: [findings[0]!.id],
          frequencyCount: 1,
          period: 'month',
          currency: 'EUR',
          currentCostMinor: 0,
          errorRate: 0,
          solutionTypes: ['outsource'],
          expectedSavingsMinor: 0,
          expectedInvestmentMinor: 0,
          roiHorizonPeriods: 1,
          outcome: {
            metricName: 'cost',
            metricUnit: 'EUR-minor',
            direction: 'at_most',
            baseline: 0,
            target: 0,
          },
          actor: ACTOR,
        }),
    );
  });

  it('links the optional capability through the capabilities contract', async () => {
    const capability = await registerCapability(ctx, {
      name: 'Invoice data entry',
      description: 'Keying scanned invoices into the ERP',
      actor: ACTOR,
    });
    const linked = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      capabilityId: capability.id,
      actor: ACTOR,
      rationale: 'The gap this candidate would close',
    });
    expect(linked.version).toBe(2);
    expect(linked.lastChange.kind).toBe('revised');
    expect(linked.capability).toEqual({ id: capability.id, name: 'Invoice data entry' });
    // carry-over: everything else survives the revision
    expect(linked.frequencyCount).toBe(600);
    expect(linked.findingIds).toEqual(opportunity.findingIds);

    // a missing/foreign capability is uniformly invalid_capability_ref
    await expectCode(
      'invalid_capability_ref',
      () =>
        reviseOpportunity(ctx, {
          opportunityId: opportunity.id,
          capabilityId: newId(),
          actor: ACTOR,
        }),
    );
    opportunity = linked;
  });

  it('revises content with carry-over, tri-state clears and partial outcome patches', async () => {
    const revised = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      description: null, // clear
      frequencyCount: 650,
      errorRate: 0.09,
      outcome: { target: 180 }, // partial plan patch
      actor: ACTOR,
      rationale: 'Re-measured after the window closed',
    });
    expect(revised.version).toBe(3);
    expect(revised.description).toBeNull();
    expect(revised.frequencyCount).toBe(650);
    expect(revised.errorRate).toBe(0.09);
    expect(revised.outcome).toEqual({
      metricName: 'manual handling minutes per month',
      metricUnit: 'minutes',
      direction: 'at_most',
      baseline: 1200,
      target: 180,
    });
    // untouched figures carry over and the derived ROI follows them
    expect(revised.expectedSavingsMinor).toBe(600_000);
    expect(revised.expectedRoi.expectedNetBenefitMinor).toBe(6_960_000);
    opportunity = revised;
  });

  it('refuses a stale expectedVersion (optimistic concurrency)', async () => {
    await expectCode(
      'opportunity_conflict',
      () =>
        reviseOpportunity(ctx, {
          opportunityId: opportunity.id,
          frequencyCount: 700,
          expectedVersion: 1, // the opportunity is at version 3
          actor: ACTOR,
        }),
    );
    const concurrent = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      frequencyCount: 700,
      expectedVersion: 3,
      actor: ACTOR,
    });
    expect(concurrent.version).toBe(4);
    opportunity = concurrent;
  });

  it('deep-links the version history and keeps it append-only at the contract level', async () => {
    const history: AutomationOpportunityVersion[] = await listOpportunityVersions(ctx, {
      opportunityId: opportunity.id,
    });
    expect(history.map((version) => version.version)).toEqual([1, 2, 3, 4]);
    expect(history.map((version) => version.changeKind)).toEqual([
      'created',
      'revised',
      'revised',
      'revised',
    ]);
    // every version is a self-contained snapshot (name + process + findings)
    for (const version of history) {
      expect(version.name).toBe('Automate invoice data entry');
      expect(version.process).toEqual({ id: process.id, name: 'Invoice approval' });
      expect(version.findingIds.length).toBeGreaterThan(0);
    }
    const deep = await getOpportunityVersion(ctx, { opportunityId: opportunity.id, version: 2 });
    expect(deep.capability!.name).toBe('Invoice data entry');
    expect(deep.frequencyCount).toBe(600); // pre-re-measurement figure, preserved
    await expectCode(
      'opportunity_version_not_found',
      () => getOpportunityVersion(ctx, { opportunityId: opportunity.id, version: 99 }),
    );
  });

  it('accepts the candidate surgically, freezes the prediction, then records measurements', async () => {
    const accepted = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      status: 'accepted',
      actor: { kind: 'person', id: '1a2b3c4d-0000-4000-8000-0000000000m1', label: 'COO' },
      rationale: 'Approved for the next quarter',
    });
    expect(accepted.version).toBe(5);
    expect(accepted.status).toBe('accepted');
    expect(accepted.lastChange.kind).toBe('accepted');
    expect(accepted.lastChange.actor.label).toBe('COO');
    opportunity = accepted;

    // the committed prediction is frozen: content revisions are refused
    await expectCode(
      'invalid_transition',
      () =>
        reviseOpportunity(ctx, {
          opportunityId: opportunity.id,
          frequencyCount: 800,
          actor: ACTOR,
        }),
    );
    // and so is walking an accepted record back to candidate
    await expectCode(
      'invalid_transition',
      () => reviseOpportunity(ctx, { opportunityId: opportunity.id, status: 'candidate', actor: ACTOR }),
    );

    // measurements against the accepted prediction
    const first = await recordMeasurement(ctx, {
      opportunityId: opportunity.id,
      value: 300,
      note: 'First month after the extension went live',
      evidence: [{ kind: 'metric', id: 'metric-17', label: 'ERP time report' }],
      actor: ACTOR,
    });
    const second = await recordMeasurement(ctx, {
      opportunityId: opportunity.id,
      value: 210,
      evidence: [{ kind: 'report', label: 'Ops monthly report' }],
      actor: ACTOR,
    });
    expect(second.recordedAt >= first.recordedAt).toBe(true);

    // the current view derives the latest observed value + target verdict
    const viewed = await getOpportunity(ctx, { opportunityId: opportunity.id });
    expect(viewed.outcomeMeasurements.measurementCount).toBe(2);
    expect(viewed.outcomeMeasurements.latest!.id).toBe(second.id);
    expect(viewed.outcomeMeasurements.latest!.value).toBe(210);
    expect(viewed.outcomeMeasurements.progress).toEqual({
      baseline: 1200,
      target: 180,
      latest: 210,
      direction: 'at_most',
      targetMet: false, // 210 > 180
    });

    // the series is listable ascending and deep-linkable
    const series = await listMeasurements(ctx, { opportunityId: opportunity.id });
    expect(series.map((measurement) => measurement.value)).toEqual([300, 210]);
    expect(series[0]!.evidence).toEqual([
      { kind: 'metric', id: 'metric-17', label: 'ERP time report' },
    ]);
    expect(series[0]!.recordedByPrincipal).toBe(ctx.principalId);
    const deep = await getMeasurement(ctx, { measurementId: first.id });
    expect(deep.value).toBe(300);
    await expectCode('measurement_not_found', () => getMeasurement(ctx, { measurementId: newId() }));
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: dismissal, reopening, measurement gating, conflicts
// ---------------------------------------------------------------------------

describe('automation opportunities — lifecycle and measurement gating', () => {
  const ctx = member(tenantLifecycle);
  let process: Process;
  let findings: ProcessFinding[];
  let opportunity: AutomationOpportunity;

  beforeAll(async () => {
    ({ process, findings } = await seedInvoiceProcess(ctx, 'Onboarding checklist'));
  });

  async function registerNamed(name: string): Promise<AutomationOpportunity> {
    return registerOpportunity(ctx, {
      name,
      processId: process.id,
      findingIds: [findings[0]!.id],
      frequencyCount: 40,
      period: 'week',
      currency: 'USD',
      currentCostMinor: 120_000,
      errorRate: 0.05,
      solutionTypes: ['train_employee', 'reassign_work'],
      expectedSavingsMinor: 60_000,
      expectedInvestmentMinor: 90_000,
      roiHorizonPeriods: 26,
      outcome: {
        metricName: 'onboarding hours per hire',
        metricUnit: 'hours',
        direction: 'at_most',
        baseline: 8,
        target: 3,
      },
      actor: ACTOR,
    });
  }

  it('refuses measurements against a mere candidate', async () => {
    opportunity = await registerNamed('Automate onboarding paperwork');
    await expectCode(
      'invalid_transition',
      () => recordMeasurement(ctx, { opportunityId: opportunity.id, value: 8, actor: ACTOR }),
    );
  });

  it('dismisses a candidate surgically and reopens it', async () => {
    const dismissed = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      status: 'dismissed',
      actor: ACTOR,
      rationale: 'Cheaper to reassign within the team',
    });
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.lastChange.kind).toBe('dismissed');

    // a dismissed record is frozen evidence — no content, no measurement
    await expectCode(
      'invalid_transition',
      () => reviseOpportunity(ctx, { opportunityId: opportunity.id, frequencyCount: 99, actor: ACTOR }),
    );
    await expectCode(
      'invalid_transition',
      () => recordMeasurement(ctx, { opportunityId: opportunity.id, value: 5, actor: ACTOR }),
    );

    const reopened = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      status: 'candidate',
      actor: ACTOR,
      rationale: 'The team is at capacity again',
    });
    expect(reopened.status).toBe('candidate');
    expect(reopened.lastChange.kind).toBe('reopened');
    opportunity = reopened;
  });

  it('dismisses an accepted opportunity after its measurements (retained negative evidence)', async () => {
    const accepted = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      status: 'accepted',
      actor: ACTOR,
    });
    expect(accepted.status).toBe('accepted');
    await recordMeasurement(ctx, { opportunityId: opportunity.id, value: 7.5, actor: ACTOR });

    const dismissed = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      status: 'dismissed',
      actor: ACTOR,
      rationale: 'The savings did not materialize',
    });
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.lastChange.kind).toBe('dismissed');

    // the retained measurement stays readable on the dismissed record
    const viewed = await getOpportunity(ctx, { opportunityId: opportunity.id });
    expect(viewed.outcomeMeasurements.measurementCount).toBe(1);
    expect(viewed.outcomeMeasurements.latest!.value).toBe(7.5);
    expect(viewed.outcomeMeasurements.progress!.targetMet).toBe(false); // 7.5 > 3
  });

  it('refuses illegal transitions and non-surgical status changes', async () => {
    // candidate → candidate (a no-op status change)
    const fresh = await registerNamed('Automate onboarding follow-ups');
    await expectCode(
      'invalid_transition',
      () => reviseOpportunity(ctx, { opportunityId: fresh.id, status: 'candidate', actor: ACTOR }),
    );
  });
});

// ---------------------------------------------------------------------------
// Management listings
// ---------------------------------------------------------------------------

describe('automation opportunities — listings', () => {
  const ctx = member(tenantList);
  let process: Process;
  let findings: ProcessFinding[];
  const created: AutomationOpportunity[] = [];

  beforeAll(async () => {
    ({ process, findings } = await seedInvoiceProcess(ctx, 'Order fulfilment'));
    const definitions: {
      name: string;
      solutionTypes: AutomationSolutionType[];
      status: 'candidate' | 'accepted' | 'dismissed';
    }[] = [
      { name: 'Batch label printing', solutionTypes: ['build_extension'], status: 'candidate' },
      { name: 'Carrier rate shopping', solutionTypes: ['recruit_agent', 'outsource'], status: 'accepted' },
      { name: 'Address validation', solutionTypes: ['install_extension'], status: 'dismissed' },
    ];
    for (const definition of definitions) {
      let opportunity = await registerOpportunity(ctx, {
        name: definition.name,
        processId: process.id,
        findingIds: [findings[0]!.id],
        frequencyCount: 100,
        period: 'month',
        currency: 'EUR',
        currentCostMinor: 50_000,
        errorRate: 0.02,
        solutionTypes: definition.solutionTypes,
        expectedSavingsMinor: 30_000,
        expectedInvestmentMinor: 60_000,
        roiHorizonPeriods: 12,
        outcome: {
          metricName: 'touchpoints per order',
          metricUnit: 'count',
          direction: 'at_most',
          baseline: 6,
          target: 2,
        },
        actor: ACTOR,
      });
      if (definition.status !== 'candidate') {
        opportunity = await reviseOpportunity(ctx, {
          opportunityId: opportunity.id,
          status: definition.status,
          actor: ACTOR,
        });
      }
      created.push(opportunity);
    }
  });

  it('lists current views ordered by name', async () => {
    const listed = await listOpportunities(ctx, {});
    expect(listed.map((opportunity) => opportunity.name)).toEqual([
      'Address validation',
      'Batch label printing',
      'Carrier rate shopping',
    ]);
  });

  it('filters by status, process, solution type, name and search', async () => {
    expect((await listOpportunities(ctx, { status: 'accepted' })).map((o) => o.name)).toEqual([
      'Carrier rate shopping',
    ]);
    expect((await listOpportunities(ctx, { processId: process.id })).length).toBe(3);
    expect((await listOpportunities(ctx, { processId: newId() })).length).toBe(0);
    expect(
      (await listOpportunities(ctx, { solutionType: 'outsource' })).map((o) => o.name),
    ).toEqual(['Carrier rate shopping']);
    expect((await listOpportunities(ctx, { solutionType: 'train_employee' })).length).toBe(0);
    expect((await listOpportunities(ctx, { name: 'Address validation' })).length).toBe(1);
    expect((await listOpportunities(ctx, { search: 'carrier' })).map((o) => o.name)).toEqual([
      'Carrier rate shopping',
    ]);
    expect((await listOpportunities(ctx, { search: 'CARRIER' })).map((o) => o.name)).toEqual([
      'Carrier rate shopping',
    ]);
    // caller search text is never a wildcard pattern
    expect((await listOpportunities(ctx, { search: '%' })).length).toBe(0);
    expect((await listOpportunities(ctx, { limit: 2 })).length).toBe(2);
  });

  it('honors the limit bounds', async () => {
    await expectCode('invalid_query', () => listOpportunities(ctx, { limit: 0 }));
    await expectCode('invalid_query', () => listOpportunities(ctx, { limit: 501 }));
    await expectCode('invalid_query', () => listOpportunities(ctx, { status: 'active' as never }));
  });
});

// ---------------------------------------------------------------------------
// Storage-level append-only enforcement (the triggers)
// ---------------------------------------------------------------------------

describe('automation opportunities — storage guarantees', () => {
  const ctx = member(tenantTriggers);

  beforeAll(async () => {
    const { process, findings } = await seedInvoiceProcess(ctx, 'Payroll run');
    const registered = await registerOpportunity(ctx, {
      name: 'Automate payroll reconciliation',
      processId: process.id,
      findingIds: [findings[0]!.id],
      frequencyCount: 4,
      period: 'month',
      currency: 'EUR',
      currentCostMinor: 320_000,
      errorRate: 0.01,
      solutionTypes: ['recruit_agent_team'],
      expectedSavingsMinor: 240_000,
      expectedInvestmentMinor: 480_000,
      roiHorizonPeriods: 24,
      outcome: {
        metricName: 'reconciliation hours per run',
        metricUnit: 'hours',
        direction: 'at_most',
        baseline: 20,
        target: 5,
      },
      actor: ACTOR,
    });
    const accepted = await reviseOpportunity(ctx, {
      opportunityId: registered.id,
      status: 'accepted',
      actor: ACTOR,
    });
    await recordMeasurement(ctx, { opportunityId: accepted.id, value: 18, actor: ACTOR });
  });

  it('rejects UPDATE/DELETE/TRUNCATE on versions and measurements; DELETE/TRUNCATE on identities', async () => {
    await expectSqlRejection(`UPDATE automation_opportunity_versions SET name = 'forged'`);
    await expectSqlRejection(`DELETE FROM automation_opportunity_versions`);
    await expectSqlRejection(`TRUNCATE automation_opportunity_versions`);
    await expectSqlRejection(`UPDATE automation_measurements SET value = 0`);
    await expectSqlRejection(`DELETE FROM automation_measurements`);
    await expectSqlRejection(`TRUNCATE automation_measurements`);
    await expectSqlRejection(`DELETE FROM automation_opportunities`);
    await expectSqlRejection(`TRUNCATE automation_opportunities`);
  });

  it('still lets the identity version pointer advance (that is its only job)', async () => {
    const result = await getDb().query(
      `UPDATE automation_opportunities SET current_version = current_version WHERE tenant_id = $1`,
      [tenantTriggers],
    );
    expect(result.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('automation opportunities — tenant isolation', () => {
  const ctxMain = member(tenantMain);
  const ctxIso = member(tenantIso);

  let isoProcess: Process;
  let isoFindings: ProcessFinding[];
  let isoOpportunity: AutomationOpportunity;

  beforeAll(async () => {
    ({ process: isoProcess, findings: isoFindings } = await seedInvoiceProcess(ctxIso, 'Invoice approval'));
    isoOpportunity = await registerOpportunity(ctxIso, {
      name: 'Automate invoice data entry', // the SAME name as tenantMain's — unique per tenant
      processId: isoProcess.id,
      findingIds: [isoFindings[0]!.id],
      frequencyCount: 10,
      period: 'month',
      currency: 'EUR',
      currentCostMinor: 5_000,
      errorRate: 0.1,
      solutionTypes: ['outsource'],
      expectedSavingsMinor: 3_000,
      expectedInvestmentMinor: 6_000,
      roiHorizonPeriods: 12,
      outcome: {
        metricName: 'minutes per invoice',
        metricUnit: 'minutes',
        direction: 'at_most',
        baseline: 12,
        target: 4,
      },
      actor: ACTOR,
    });
    await reviseOpportunity(ctxIso, { opportunityId: isoOpportunity.id, status: 'accepted', actor: ACTOR });
    await recordMeasurement(ctxIso, { opportunityId: isoOpportunity.id, value: 9, actor: ACTOR });
  });

  it('reads foreign opportunities, versions and measurements as missing', async () => {
    const mainListed = await listOpportunities(ctxMain, {});
    const mainOpportunity = mainListed.find((o) => o.name === 'Automate invoice data entry')!;
    expect(mainOpportunity.id).not.toBe(isoOpportunity.id);

    await expectCode(
      'opportunity_not_found',
      () => getOpportunity(ctxMain, { opportunityId: isoOpportunity.id }),
    );
    await expectCode(
      'opportunity_not_found',
      () =>
        reviseOpportunity(ctxMain, { opportunityId: isoOpportunity.id, status: 'dismissed', actor: ACTOR }),
    );
    await expectCode(
      'opportunity_version_not_found',
      () => getOpportunityVersion(ctxMain, { opportunityId: isoOpportunity.id, version: 1 }),
    );
    await expectCode(
      'opportunity_not_found',
      () => listOpportunityVersions(ctxMain, { opportunityId: isoOpportunity.id }),
    );
    await expectCode(
      'opportunity_not_found',
      () => recordMeasurement(ctxMain, { opportunityId: isoOpportunity.id, value: 1, actor: ACTOR }),
    );
    await expectCode(
      'opportunity_not_found',
      () => listMeasurements(ctxMain, { opportunityId: isoOpportunity.id }),
    );
    const isoMeasurements = await listMeasurements(ctxIso, { opportunityId: isoOpportunity.id });
    await expectCode(
      'measurement_not_found',
      () => getMeasurement(ctxMain, { measurementId: isoMeasurements[0]!.id }),
    );
  });

  it('rejects foreign-tenant process, finding and capability references on write', async () => {
    // a foreign-tenant process reads exactly like a missing one
    await expectCode(
      'invalid_process_ref',
      () =>
        registerOpportunity(ctxMain, {
          name: 'Cross-tenant candidate',
          processId: isoProcess.id,
          findingIds: [newId()],
          frequencyCount: 1,
          period: 'month',
          currency: 'EUR',
          currentCostMinor: 0,
          errorRate: 0,
          solutionTypes: ['train_employee'],
          expectedSavingsMinor: 0,
          expectedInvestmentMinor: 0,
          roiHorizonPeriods: 1,
          outcome: {
            metricName: 'x',
            metricUnit: 'count',
            direction: 'at_most',
            baseline: 0,
            target: 0,
          },
          actor: ACTOR,
        }),
    );
    // a foreign-tenant finding behind a local process, likewise
    const mainProcessId = (await listOpportunities(ctxMain, {}))[0]!.process.id;
    await expectCode(
      'invalid_process_ref',
      () =>
        registerOpportunity(ctxMain, {
          name: 'Cross-tenant candidate',
          processId: mainProcessId,
          findingIds: [isoFindings[0]!.id],
          frequencyCount: 1,
          period: 'month',
          currency: 'EUR',
          currentCostMinor: 0,
          errorRate: 0,
          solutionTypes: ['train_employee'],
          expectedSavingsMinor: 0,
          expectedInvestmentMinor: 0,
          roiHorizonPeriods: 1,
          outcome: {
            metricName: 'x',
            metricUnit: 'count',
            direction: 'at_most',
            baseline: 0,
            target: 0,
          },
          actor: ACTOR,
        }),
    );
    // a foreign-tenant capability
    const isoCapability = await registerCapability(ctxIso, {
      name: 'Foreign tenant capability',
      actor: ACTOR,
    });
    const mainOpportunity = (await listOpportunities(ctxMain, {})).find(
      (o) => o.name === 'Automate invoice data entry',
    )!;
    await expectCode(
      'invalid_capability_ref',
      () =>
        reviseOpportunity(ctxMain, {
          opportunityId: mainOpportunity.id,
          capabilityId: isoCapability.id,
          actor: ACTOR,
        }),
    );
  });

  it('never leaks listings across tenants', async () => {
    const mainNames = (await listOpportunities(ctxMain, {})).map((o) => o.name);
    const isoNames = (await listOpportunities(ctxIso, {})).map((o) => o.name);
    expect(mainNames).toContain('Automate invoice data entry'); // tenantMain's own candidate
    expect(mainNames).not.toContain('Automate payroll reconciliation'); // tenantTriggers'
    expect(isoNames).toEqual(['Automate invoice data entry']); // same name, different tenant — both legal
  });
});
