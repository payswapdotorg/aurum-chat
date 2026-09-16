// Integration tests for the processes module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W016
// acceptance: "Reconstruct processes from events/observations; detect
// bottlenecks, duplication, handoffs, manual effort and errors."
//
//  * RECONSTRUCTION FROM EVENTS: a seeded invoice-approval flow (three
//    correlation cases: a ping-pong approval, a slow approval, a rework +
//    payment failure) reconstructs into the expected steps / edges /
//    variants / stats, and every detected finding kind is present with the
//    right subject, metrics, support-scaled confidence and EXACT event-id
//    evidence. Identity, version, change kind, commit time and acting
//    principal are system-minted.
//  * RECONSTRUCTION FROM OBSERVATIONS: payload case keys group
//    observations into cases (edges within a case, single-activity cases
//    for keyless observations); observation actor kinds map to manual
//    effort; the 500-latest window bound is reported honestly via
//    observationWindowTruncated.
//  * MIXED EVIDENCE: an observation whose case key IS an event flow's
//    correlation id joins that flow's case (the unified case space).
//  * VERSIONED/AUDITABLE reconstructions: a process is an identity plus an
//    append-only chain of full-snapshot versions; re-reconstructing appends
//    version N+1; expectedVersion guards refuse stale writers; the version
//    history is listable and deep-linkable; the storage layer rejects
//    UPDATE/DELETE/TRUNCATE on versions and findings and DELETE/TRUNCATE on
//    identities outright (triggers) — while the identity's version POINTER
//    may still advance (that is its only job).
//  * EVIDENCE VOLUME BOUND: exceeding options.maxEvents refuses with
//    reconstruction_too_large (evidence is never silently dropped).
//  * TENANT ISOLATION (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks): foreign-tenant processes,
//    versions and findings read as missing; foreign-tenant events and
//    observations never enter a reconstruction.
//  * The management listings: current-view processes (name filter, search,
//    ordering, finding counts) and findings (default current version,
//    explicit version, kind, minimum confidence, canonical order).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { appendEvent, listEvents } from '@/modules/events/contract';
import { recordObservation } from '@/modules/observations/contract';
import { ProcessesError } from '../errors';
import * as processesContract from '../contract';
import type { Process, ProcessVersion, ReconstructProcessInput } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getProcess,
  getProcessFinding,
  getProcessVersion,
  listProcessFindings,
  listProcesses,
  listProcessVersions,
  reconstructProcess,
} = processesContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantA = newId(); // events-driven reconstruction (the main flow)
const tenantB = newId(); // the other tenant (isolation checks)
const tenantObs = newId(); // observation-driven reconstruction
const tenantMixed = newId(); // mixed events + observations
const tenantVersioned = newId(); // versioning / audit / conflicts
const tenantCap = newId(); // maxEvents bound
const tenantList = newId(); // management listings
const tenantBulk = newId(); // observation window bound (500 seeds)

const PERSON_1 = '1a2b3c4d-0000-4000-8000-0000000000p1';
const PERSON_2 = '1a2b3c4d-0000-4000-8000-0000000000p2';
const SYSTEM_BILLING = 'billing-system';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessesError);
    expect((error as ProcessesError).code).toBe(code);
  }
}

function at(minutes: number): string {
  return new Date(Date.parse('2026-09-14T08:00:00Z') + minutes * 60_000).toISOString();
}

/** All event ids of one correlation flow, read through the events contract. */
async function eventIdsOfFlow(ctx: TenantContext, correlationId: string): Promise<string[]> {
  const events = await listEvents(ctx, { correlationId, limit: 500 });
  return events.map((event) => event.id);
}

/** Seeds one event of the invoice flow (person actors unless overridden). */
async function seedEvent(
  ctx: TenantContext,
  input: {
    type: string;
    occurredAt: string;
    correlationId: string;
    actorKind?: 'person' | 'agent' | 'system' | 'external' | 'source';
    actorId?: string;
  },
): Promise<string> {
  const actorKind = input.actorKind ?? 'person';
  const event = await appendEvent(ctx, {
    type: input.type,
    payload: { note: `occurrence of ${input.type}` },
    occurredAt: input.occurredAt,
    actor: {
      kind: actorKind,
      id: input.actorId ?? (actorKind === 'person' ? PERSON_1 : SYSTEM_BILLING),
    },
    source: { kind: 'system', label: 'test-harness' },
    correlationId: input.correlationId,
  });
  return event.id;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Reconstruction from events + all five finding kinds
// ---------------------------------------------------------------------------

describe('reconstructProcess from events', () => {
  const ctx = member(tenantA);
  const FLOW_1 = newId();
  const FLOW_2 = newId();
  const FLOW_3 = newId();
  let process: Process;
  let findings: processesContract.ProcessFinding[];
  let seededEventIds: string[];

  beforeAll(async () => {
    // Case 1: register (p1) → review (p2) → approve (p1): ping-pong + fast
    await seedEvent(ctx, { type: 'invoice.registered', occurredAt: at(0), correlationId: FLOW_1 });
    await seedEvent(ctx, {
      type: 'invoice.reviewed',
      occurredAt: at(30),
      correlationId: FLOW_1,
      actorId: PERSON_2,
    });
    await seedEvent(ctx, { type: 'invoice.approved', occurredAt: at(90), correlationId: FLOW_1 });
    // Case 2: same flow, slower approval edge
    await seedEvent(ctx, { type: 'invoice.registered', occurredAt: at(1000), correlationId: FLOW_2 });
    await seedEvent(ctx, {
      type: 'invoice.reviewed',
      occurredAt: at(1030),
      correlationId: FLOW_2,
      actorId: PERSON_2,
    });
    await seedEvent(ctx, { type: 'invoice.approved', occurredAt: at(1120), correlationId: FLOW_2 });
    // Case 3: register → review → review (rework) → payment failure
    await seedEvent(ctx, { type: 'invoice.registered', occurredAt: at(2000), correlationId: FLOW_3 });
    await seedEvent(ctx, {
      type: 'invoice.reviewed',
      occurredAt: at(2030),
      correlationId: FLOW_3,
      actorId: PERSON_2,
    });
    await seedEvent(ctx, {
      type: 'invoice.reviewed',
      occurredAt: at(2040),
      correlationId: FLOW_3,
      actorId: PERSON_2,
    });
    await seedEvent(ctx, {
      type: 'invoice.payment.failed',
      occurredAt: at(2045),
      correlationId: FLOW_3,
      actorKind: 'system',
      actorId: SYSTEM_BILLING,
    });

    seededEventIds = [];
    // re-derive the ids through the events contract for evidence assertions
    for (const flow of [FLOW_1, FLOW_2, FLOW_3]) {
      seededEventIds.push(...(await eventIdsOfFlow(ctx, flow)));
    }

    process = await reconstructProcess(ctx, {
      name: 'Invoice approval',
      scope: { eventTypes: ['invoice.registered', 'invoice.reviewed', 'invoice.approved', 'invoice.payment.failed'] },
      options: { bottleneckThresholdSeconds: 3000 },
      actor: { kind: 'person', id: PERSON_1, label: 'Ops lead' },
      rationale: 'Quarterly process review',
    });
    findings = await listProcessFindings(ctx, { processId: process.id, limit: 500 });
  });

  it('creates the process identity at version 1 with system-minted audit fields', () => {
    expect(process.tenantId).toBe(tenantA);
    expect(process.version).toBe(1);
    expect(process.name).toBe('Invoice approval');
    expect(process.lastChange.kind).toBe('created');
    expect(process.lastChange.actor).toEqual({ kind: 'person', id: PERSON_1, label: 'Ops lead' });
    expect(process.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(process.lastChange.rationale).toBe('Quarterly process review');
    expect(process.createdAt).toBe(process.updatedAt);
    expect(process.scope.eventTypes).toEqual([
      'invoice.approved',
      'invoice.payment.failed',
      'invoice.registered',
      'invoice.reviewed',
    ]);
    expect(process.scope.observationKinds).toEqual([]);
    expect(process.scope.occurredFrom).toBeNull();
    expect(process.scope.occurredTo).toBeNull();
    expect(process.options).toEqual({
      bottleneckThresholdSeconds: 3000,
      minEdgeInstances: 2,
      manualShareThreshold: 0.5,
      errorActivityTypes: [],
      maxEvents: 2000,
    });
  });

  it('reconstructs the steps with actor breakdowns', async () => {
    const version = await getProcessVersion(ctx, { processId: process.id, version: 1 });
    const byType = new Map(version.steps.map((step) => [step.activityType, step]));

    const registered = byType.get('invoice.registered')!;
    expect(registered.instances).toBe(3);
    expect(registered.cases).toBe(3);
    expect(registered.actorCounts).toEqual({ person: 3, agent: 0, system: 0, external: 0, source: 0 });
    expect(registered.manualShare).toBe(1);
    expect(registered.firstOccurredAt).toBe(at(0));
    expect(registered.lastOccurredAt).toBe(at(2000));

    const reviewed = byType.get('invoice.reviewed')!;
    expect(reviewed.instances).toBe(4); // 2 (rework) + 1 + 1
    expect(reviewed.cases).toBe(3);

    const failed = byType.get('invoice.payment.failed')!;
    expect(failed.instances).toBe(1);
    expect(failed.actorCounts.system).toBe(1);
    expect(failed.manualShare).toBe(0);

    expect(version.steps.map((step) => step.activityType)).toEqual([
      'invoice.approved',
      'invoice.payment.failed',
      'invoice.registered',
      'invoice.reviewed',
    ]);
  });

  it('reconstructs the directly-follows flow edges with wait times', async () => {
    const version = await getProcessVersion(ctx, { processId: process.id, version: 1 });
    expect(version.edges).toEqual([
      // registered → reviewed: 30min × 3
      { fromActivity: 'invoice.registered', toActivity: 'invoice.reviewed', instances: 3, avgWaitSeconds: 1800, maxWaitSeconds: 1800 },
      // reviewed → approved: 60min + 90min
      { fromActivity: 'invoice.reviewed', toActivity: 'invoice.approved', instances: 2, avgWaitSeconds: 4500, maxWaitSeconds: 5400 },
      // reviewed → payment.failed: 5min (deterministic from,to ordering)
      { fromActivity: 'invoice.reviewed', toActivity: 'invoice.payment.failed', instances: 1, avgWaitSeconds: 300, maxWaitSeconds: 300 },
      // reviewed → reviewed (rework): 10min
      { fromActivity: 'invoice.reviewed', toActivity: 'invoice.reviewed', instances: 1, avgWaitSeconds: 600, maxWaitSeconds: 600 },
    ]);
  });

  it('reconstructs the observed variants (most frequent first)', async () => {
    const version = await getProcessVersion(ctx, { processId: process.id, version: 1 });
    expect(version.variants).toEqual([
      {
        sequence: ['invoice.registered', 'invoice.reviewed', 'invoice.approved'],
        instances: 2,
      },
      {
        sequence: ['invoice.registered', 'invoice.reviewed', 'invoice.reviewed', 'invoice.payment.failed'],
        instances: 1,
      },
    ]);
  });

  it('aggregates the process statistics', () => {
    expect(process.stats).toMatchObject({
      caseCount: 3,
      occurrenceCount: 10,
      eventCount: 10,
      observationCount: 0,
      distinctActivityTypes: 4,
      distinctEdges: 4,
      variantCount: 2,
      variantsStored: 2,
      manualShare: 0.9, // 9 person occurrences of 10
      handoffCount: 6, // f1: 2, f2: 2, f3: 2 (rework pair shares the actor)
      errorCount: 1,
      avgCaseDurationSeconds: 5100, // (90 + 120 + 45) min / 3
      minCaseDurationSeconds: 2700,
      maxCaseDurationSeconds: 7200,
      observationWindowTruncated: false,
    });
  });

  it('detects the bottleneck edge with exact metrics and evidence', () => {
    const bottleneck = findings.filter((finding) => finding.kind === 'bottleneck');
    expect(bottleneck).toHaveLength(1);
    expect(bottleneck[0]!.subject).toBe('edge:invoice.reviewed->invoice.approved');
    expect(bottleneck[0]!.metrics).toEqual({
      fromActivity: 'invoice.reviewed',
      toActivity: 'invoice.approved',
      instances: 2,
      avgWaitSeconds: 4500,
      maxWaitSeconds: 5400,
      thresholdSeconds: 3000,
    });
    // the two pairs demonstrating the wait: 4 cited events, most recent first
    expect(bottleneck[0]!.evidenceEventIds).toHaveLength(4);
    expect(bottleneck[0]!.evidenceObservationIds).toEqual([]);
    for (const eventId of bottleneck[0]!.evidenceEventIds) {
      expect(seededEventIds).toContain(eventId);
    }
  });

  it('detects the duplication of the reviewed activity within case 3', () => {
    const duplication = findings.filter((finding) => finding.kind === 'duplication');
    expect(duplication).toHaveLength(1);
    expect(duplication[0]!.subject).toBe('step:invoice.reviewed');
    expect(duplication[0]!.metrics).toEqual({
      activityType: 'invoice.reviewed',
      casesWithRepetition: 1,
      extraOccurrences: 1,
    });
    expect(duplication[0]!.confidence).toBe(0.6);
    // evidence: exactly the two reworked review events
    expect(duplication[0]!.evidenceEventIds).toHaveLength(2);
  });

  it('detects the ping-pong handoff pattern (p1 → p2 → p1)', () => {
    const handoffs = findings.filter((finding) => finding.kind === 'handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.subject).toBe('ping-pong:invoice.registered->invoice.reviewed->invoice.approved');
    expect(handoffs[0]!.metrics).toMatchObject({
      fromActivity: 'invoice.registered',
      midActivity: 'invoice.reviewed',
      toActivity: 'invoice.approved',
      instances: 2, // f1 and f2 both bounce back to p1
      fromActor: `person:${PERSON_1}`,
      midActor: `person:${PERSON_2}`,
    });
    expect(handoffs[0]!.confidence).toBe(0.7);
    expect(handoffs[0]!.evidenceEventIds).toHaveLength(6); // both triples
  });

  it('detects manual effort on the human-performed steps', () => {
    const manual = findings.filter((finding) => finding.kind === 'manual_effort');
    expect(manual.map((finding) => finding.subject)).toEqual([
      'step:invoice.approved',
      'step:invoice.registered',
      'step:invoice.reviewed',
    ]);
    const reviewed = manual.find((finding) => finding.subject === 'step:invoice.reviewed')!;
    expect(reviewed.metrics).toEqual({
      activityType: 'invoice.reviewed',
      instances: 4,
      personInstances: 4,
      manualShare: 1,
      manualShareThreshold: 0.5,
    });
    expect(reviewed.confidence).toBe(0.9); // min(0.9, 0.5 + 0.1 × 4)
  });

  it('detects the error occurrence with its affected case', () => {
    const errors = findings.filter((finding) => finding.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.subject).toBe('step:invoice.payment.failed');
    expect(errors[0]!.metrics).toEqual({
      activityType: 'invoice.payment.failed',
      instances: 1,
      affectedCases: 1,
    });
    expect(errors[0]!.confidence).toBe(0.6);
    expect(errors[0]!.evidenceEventIds).toHaveLength(1);
  });

  it('exposes finding counts on the current view and the canonical order on the list', () => {
    expect(process.findingCounts).toEqual({
      bottleneck: 1,
      duplication: 1,
      handoff: 1,
      manualEffort: 3,
      error: 1,
    });
    // canonical order: kind rank, then subject
    expect(findings.map((finding) => finding.kind)).toEqual([
      'bottleneck',
      'duplication',
      'handoff',
      'manual_effort',
      'manual_effort',
      'manual_effort',
      'error',
    ]);
  });

  it('deep-links one finding by id', async () => {
    const finding = await getProcessFinding(ctx, { findingId: findings[0]!.id });
    expect(finding.id).toBe(findings[0]!.id);
    expect(finding.processId).toBe(process.id);
    expect(finding.version).toBe(1);
    expect(finding.detectedByPrincipal).toBe(ctx.principalId);
    expect(finding.detectedAt).toBe(process.updatedAt);
  });

  it('round-trips through getProcess with the same current view', async () => {
    const current = await getProcess(ctx, process.id);
    expect(current.id).toBe(process.id);
    expect(current.version).toBe(1);
    expect(current.findingCounts).toEqual(process.findingCounts);
    expect(current.stats).toEqual(process.stats);
  });
});

// ---------------------------------------------------------------------------
// Reconstruction from observations
// ---------------------------------------------------------------------------

describe('reconstructProcess from observations', () => {
  const ctx = member(tenantObs);

  beforeAll(async () => {
    // two keyed observations form a case; a keyless one stands alone
    await recordObservation(ctx, {
      kind: 'crm.note.created',
      payload: { caseId: 'deal-42', text: 'First contact' },
      observedAt: at(0),
      source: { kind: 'person', id: PERSON_1 },
      channel: 'api',
      confidence: { value: 0.8, method: 'source_trust' },
    });
    await recordObservation(ctx, {
      kind: 'crm.note.enriched',
      payload: { caseId: 'deal-42', enrichment: 'company profile' },
      observedAt: at(20),
      source: { kind: 'agent', label: 'enrichment-agent' },
      channel: 'api',
      confidence: { value: 0.7, method: 'source_trust' },
    });
    await recordObservation(ctx, {
      kind: 'crm.note.created',
      payload: { text: 'orphan note without a case key' },
      observedAt: at(40),
      source: { kind: 'person', id: PERSON_2 },
      channel: 'api',
      confidence: { value: 0.8, method: 'source_trust' },
    });
  });

  it('groups observations by payload case key and keeps keyless ones single-activity', async () => {
    const process = await reconstructProcess(ctx, {
      name: 'CRM notes',
      scope: {
        observationKinds: ['crm.note.created', 'crm.note.enriched'],
        caseKeyCandidates: ['caseId'],
      },
      actor: { kind: 'system', label: 'nightly-analysis' },
    });

    expect(process.stats).toMatchObject({
      caseCount: 2, // deal-42 + the orphan
      occurrenceCount: 3,
      eventCount: 0,
      observationCount: 3,
      distinctEdges: 1, // created → enriched within deal-42
      manualShare: 2 / 3,
      observationWindowTruncated: false,
    });

    const version = await getProcessVersion(ctx, { processId: process.id, version: 1 });
    expect(version.edges).toEqual([
      {
        fromActivity: 'crm.note.created',
        toActivity: 'crm.note.enriched',
        instances: 1,
        avgWaitSeconds: 1200,
        maxWaitSeconds: 1200,
      },
    ]);
    // the person-created note is manual; the agent-enriched one is not
    const findings = await listProcessFindings(ctx, { processId: process.id });
    expect(findings.map((finding) => finding.subject)).toEqual(['step:crm.note.created']);
    expect(findings[0]!.kind).toBe('manual_effort');
    expect(findings[0]!.evidenceObservationIds).toHaveLength(2);
    expect(findings[0]!.evidenceEventIds).toEqual([]);
  });

  it('derives the bottleneck threshold from the flow when none is given', async () => {
    // one edge only → median is that edge's own wait → threshold 2× it →
    // never flagged (an only edge cannot be an outlier of itself)
    const process = await reconstructProcess(ctx, {
      name: 'CRM notes (derived threshold)',
      scope: {
        observationKinds: ['crm.note.created', 'crm.note.enriched'],
        caseKeyCandidates: ['caseId'],
      },
      actor: { kind: 'system', label: 'nightly-analysis' },
    });
    const findings = await listProcessFindings(ctx, { processId: process.id });
    expect(findings.filter((finding) => finding.kind === 'bottleneck')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed events + observations in one case
// ---------------------------------------------------------------------------

describe('reconstructProcess over mixed events and observations', () => {
  const ctx = member(tenantMixed);
  const flowId = newId();

  beforeAll(async () => {
    await seedEvent(ctx, { type: 'deal.registered', occurredAt: at(0), correlationId: flowId });
    await recordObservation(ctx, {
      kind: 'deal.note.added',
      payload: { caseRef: flowId, note: 'customer asked for a demo' },
      observedAt: at(15),
      source: { kind: 'person', id: PERSON_1 },
      channel: 'api',
      confidence: { value: 0.9, method: 'source_trust' },
    });
  });

  it('joins an observation to an event flow when the case key matches the correlation id', async () => {
    const process = await reconstructProcess(ctx, {
      name: 'Deal intake',
      scope: {
        eventTypes: ['deal.registered'],
        observationKinds: ['deal.note.added'],
        caseKeyCandidates: ['caseRef'],
      },
      actor: { kind: 'agent', label: 'cognition-loop' },
    });
    expect(process.stats).toMatchObject({
      caseCount: 1,
      occurrenceCount: 2,
      eventCount: 1,
      observationCount: 1,
      distinctEdges: 1, // registered → note.added across the two surfaces
    });
    const findings = await listProcessFindings(ctx, { processId: process.id });
    // no repetition, no error, sub-threshold manual (note.added has 1 instance)
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Versioning, audit trail and concurrency guards
// ---------------------------------------------------------------------------

describe('versioned reconstructions', () => {
  const ctx = member(tenantVersioned);

  it('appends versions on re-reconstruction and keeps history intact', async () => {
    const v1 = await reconstructProcess(ctx, {
      name: 'Onboarding',
      scope: { eventTypes: ['user.signed_up'] },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(v1.version).toBe(1);
    expect(v1.lastChange.kind).toBe('created');
    expect(v1.stats.occurrenceCount).toBe(0);

    // new evidence arrives, the process is re-reconstructed
    await seedEvent(ctx, {
      type: 'user.signed_up',
      occurredAt: at(0),
      correlationId: newId(),
    });
    const v2 = await reconstructProcess(ctx, {
      name: 'Onboarding',
      scope: { eventTypes: ['user.signed_up'] },
      actor: { kind: 'system', label: 'cognition' },
      rationale: 'weekly refresh',
    });
    expect(v2.id).toBe(v1.id); // same identity
    expect(v2.version).toBe(2);
    expect(v2.lastChange.kind).toBe('reconstructed');
    expect(v2.lastChange.rationale).toBe('weekly refresh');
    expect(v2.stats.occurrenceCount).toBe(1);
    expect(v2.createdAt).toBe(v1.createdAt);
    expect(v2.updatedAt).toBe(v2.lastChange.recordedAt);

    // the history is intact, listable and deep-linkable
    const history: ProcessVersion[] = await listProcessVersions(ctx, { processId: v1.id });
    expect(history.map((version) => version.version)).toEqual([1, 2]);
    expect(history[0]!.stats.occurrenceCount).toBe(0); // v1 unchanged
    expect(history[1]!.stats.occurrenceCount).toBe(1);
    const deepLinked = await getProcessVersion(ctx, { processId: v1.id, version: 1 });
    expect(deepLinked.changeKind).toBe('created');

    // findings default to the CURRENT version
    const v3 = await reconstructProcess(ctx, {
      name: 'Onboarding',
      scope: { eventTypes: ['user.signed_up'] },
      options: { errorActivityTypes: ['user.signed_up'] }, // v3: declared error type
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(v3.version).toBe(3);
    const currentFindings = await listProcessFindings(ctx, { processId: v1.id });
    expect(currentFindings.map((finding) => finding.kind)).toEqual(['error']);
    expect(currentFindings[0]!.version).toBe(3);
    // ...while an explicit version audits the past reconstruction
    const v2Findings = await listProcessFindings(ctx, { processId: v1.id, version: 2 });
    expect(v2Findings).toHaveLength(0);
  });

  it('guards against stale writers with expectedVersion', async () => {
    const process = await reconstructProcess(ctx, {
      name: 'Guarded',
      scope: { eventTypes: ['user.signed_up'] },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(process.version).toBe(1);

    // a stale reader expects version 1 while the process is at 2
    const moved = await reconstructProcess(ctx, {
      name: 'Guarded',
      scope: { eventTypes: ['user.signed_up'] },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(moved.version).toBe(2);
    await expectCode(
      'process_conflict',
      () =>
        reconstructProcess(ctx, {
          name: 'Guarded',
          scope: { eventTypes: ['user.signed_up'] },
          expectedVersion: 1,
          actor: { kind: 'system', label: 'cognition' },
        }) as unknown as Promise<unknown>,
    );
    // the correct expectation succeeds
    const ok = await reconstructProcess(ctx, {
      name: 'Guarded',
      scope: { eventTypes: ['user.signed_up'] },
      expectedVersion: 2,
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(ok.version).toBe(3);

    // an expectedVersion for a process that does not exist in this tenant
    // reads as missing (uniform no-leak)
    await expectCode(
      'process_not_found',
      () =>
        reconstructProcess(ctx, {
          name: 'No such process',
          scope: { eventTypes: ['user.signed_up'] },
          expectedVersion: 1,
          actor: { kind: 'system', label: 'cognition' },
        }) as unknown as Promise<unknown>,
    );
  });

  it('keeps separate identities per name and rejects unknown-tenant version lookups', async () => {
    const first = await reconstructProcess(ctx, {
      name: 'Alpha flow',
      scope: { eventTypes: ['user.signed_up'] },
      actor: { kind: 'system', label: 'cognition' },
    });
    const second = await reconstructProcess(ctx, {
      name: 'Beta flow',
      scope: { eventTypes: ['user.signed_up'] },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(second.id).not.toBe(first.id);

    await expectCode(
      'process_version_not_found',
      () => getProcessVersion(ctx, { processId: first.id, version: 2 }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'process_not_found',
      () => listProcessVersions(ctx, { processId: newId() }) as unknown as Promise<unknown>,
    );
  });

  it('enforces append-only history at the storage layer (triggers)', async () => {
    const process = await reconstructProcess(ctx, {
      name: 'Immutable',
      scope: { eventTypes: ['user.signed_up'] },
      actor: { kind: 'system', label: 'cognition' },
    });
    const db = getDb();
    await expect(
      db.query(`UPDATE process_versions SET stats = '{}'::jsonb WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrowError(/append-only/);
    await expect(
      db.query(`DELETE FROM process_versions WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrowError(/append-only/);
    await expect(
      db.query(`UPDATE process_findings SET summary = 'forged' WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrowError(/append-only/);
    await expect(
      db.query(`DELETE FROM process_findings WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrowError(/append-only/);
    await expect(
      db.query(`TRUNCATE process_findings`),
    ).rejects.toThrowError(/append-only/);
    await expect(
      db.query(`DELETE FROM processes WHERE tenant_id = $1 AND id = $2`, [tenantVersioned, process.id]),
    ).rejects.toThrowError(/cannot be erased/);
    // (PostgreSQL may raise the FK check before the trigger fires — the
    // missions module's TRUNCATE-test precedent accepts both refusals.)
    await expect(db.query(`TRUNCATE processes`)).rejects.toThrowError(/cannot be erased|cannot truncate/i);

    // the identity's version POINTER may still advance — that is its only job
    const moved = await db.query(
      `UPDATE processes SET current_version = current_version WHERE tenant_id = $1 AND id = $2`,
      [tenantVersioned, process.id],
    );
    expect(moved.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The evidence volume bound
// ---------------------------------------------------------------------------

describe('the maxEvents evidence bound', () => {
  const ctx = member(tenantCap);

  beforeAll(async () => {
    for (let index = 0; index < 6; index += 1) {
      await seedEvent(ctx, {
        type: 'batch.tick',
        occurredAt: at(index),
        correlationId: newId(),
      });
    }
  });

  it('refuses evidence beyond the bound instead of dropping it silently', async () => {
    await expectCode(
      'reconstruction_too_large',
      () =>
        reconstructProcess(ctx, {
          name: 'Bounded',
          scope: { eventTypes: ['batch.tick'] },
          options: { maxEvents: 5 },
          actor: { kind: 'system', label: 'cognition' },
        }) as unknown as Promise<unknown>,
    );
    // the same evidence fits a sufficient bound
    const process = await reconstructProcess(ctx, {
      name: 'Bounded',
      scope: { eventTypes: ['batch.tick'] },
      options: { maxEvents: 6 },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(process.stats.occurrenceCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  const ctxA = member(tenantA);
  const ctxB = member(tenantB);

  it('reads foreign processes, versions and findings as missing', async () => {
    const foreign = await getProcess(ctxA, (await listProcesses(ctxA, { limit: 1 }))[0]!.id);
    const foreignFindings = await listProcessFindings(ctxA, { processId: foreign.id });
    expect(foreignFindings.length).toBeGreaterThan(0);

    await expectCode(
      'process_not_found',
      () => getProcess(ctxB, foreign.id) as unknown as Promise<unknown>,
    );
    await expectCode(
      'process_version_not_found',
      () => getProcessVersion(ctxB, { processId: foreign.id, version: 1 }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'process_not_found',
      () => listProcessFindings(ctxB, { processId: foreign.id }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'finding_not_found',
      () => getProcessFinding(ctxB, { findingId: foreignFindings[0]!.id }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'process_not_found',
      () => listProcessVersions(ctxB, { processId: foreign.id }) as unknown as Promise<unknown>,
    );
  });

  it('never mixes foreign evidence into a reconstruction and isolates names per tenant', async () => {
    // tenant A has 10 invoice events; tenant B reconstructs the SAME scope
    // and sees none of them
    const processB = await reconstructProcess(ctxB, {
      name: 'Invoice approval', // same name as tenant A's process
      scope: { eventTypes: ['invoice.registered', 'invoice.reviewed', 'invoice.approved', 'invoice.payment.failed'] },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(processB.tenantId).toBe(tenantB);
    expect(processB.stats).toMatchObject({
      caseCount: 0,
      occurrenceCount: 0,
      eventCount: 0,
      distinctActivityTypes: 0,
    });
    expect(processB.findingCounts).toEqual({
      bottleneck: 0,
      duplication: 0,
      handoff: 0,
      manualEffort: 0,
      error: 0,
    });
    // a distinct identity — the name is tenant-unique, not globally unique
    const processesA = await listProcesses(ctxA, { name: 'Invoice approval' });
    expect(processesA).toHaveLength(1);
    expect(processesA[0]!.id).not.toBe(processB.id);
    const processesB = await listProcesses(ctxB, { name: 'Invoice approval' });
    expect(processesB).toHaveLength(1);
    expect(processesB[0]!.id).toBe(processB.id);
  });

  it('never leaks events of another tenant even within a shared window', async () => {
    // same type, same shape, different tenant: the events contract scopes it
    const seed = await appendEvent(ctxB, {
      type: 'invoice.registered',
      payload: { note: 'tenant B only' },
      occurredAt: at(0),
      actor: { kind: 'person', id: PERSON_1 },
      source: { kind: 'system', label: 'test-harness' },
      correlationId: newId(),
    });
    expect(seed.tenantId).toBe(tenantB);
    const processB = await reconstructProcess(ctxB, {
      name: 'Invoice approval', // appends version 2 in tenant B
      scope: { eventTypes: ['invoice.registered'] },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(processB.version).toBe(2);
    expect(processB.stats.occurrenceCount).toBe(1); // only tenant B's event
  });
});

// ---------------------------------------------------------------------------
// Management listings
// ---------------------------------------------------------------------------

describe('management listings', () => {
  const ctx = member(tenantList);

  beforeAll(async () => {
    for (const name of ['Procure-to-pay', 'Order-to-cash', 'Onboarding']) {
      await reconstructProcess(ctx, {
        name,
        scope: { eventTypes: ['user.signed_up'] },
        actor: { kind: 'system', label: 'cognition' },
      });
    }
  });

  it('lists current views ordered by name with finding counts', async () => {
    const processes = await listProcesses(ctx, {});
    expect(processes.map((process) => process.name)).toEqual([
      'Onboarding',
      'Order-to-cash',
      'Procure-to-pay',
    ]);
    for (const process of processes) {
      expect(process.version).toBe(1);
      expect(process.findingCounts).toEqual({
        bottleneck: 0,
        duplication: 0,
        handoff: 0,
        manualEffort: 0,
        error: 0,
      });
    }
  });

  it('filters by exact name and by case-insensitive search', async () => {
    expect((await listProcesses(ctx, { name: 'Onboarding' })).map((p) => p.name)).toEqual([
      'Onboarding',
    ]);
    // the name filter is exact (names are identity keys); search is the
    // case-insensitive surface
    expect((await listProcesses(ctx, { name: 'onboarding' })).map((p) => p.name)).toEqual([]);
    expect((await listProcesses(ctx, { search: 'onboarding' })).map((p) => p.name)).toEqual([
      'Onboarding',
    ]);
    expect((await listProcesses(ctx, { search: 'order' })).map((p) => p.name)).toEqual([
      'Order-to-cash',
    ]);
    expect((await listProcesses(ctx, { search: 'TO-' })).map((p) => p.name)).toEqual([
      'Order-to-cash',
      'Procure-to-pay',
    ]);
    // escaped: a wildcard-looking search is a literal substring
    expect((await listProcesses(ctx, { search: '%' })).map((p) => p.name)).toEqual([]);
    expect((await listProcesses(ctx, { limit: 2 })).map((p) => p.name)).toEqual([
      'Onboarding',
      'Order-to-cash',
    ]);
  });

  it('rejects malformed queries and reports missing processes uniformly', async () => {
    await expectCode(
      'invalid_process_query',
      () => listProcesses(ctx, { nope: 1 } as never) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_process_query',
      () => listProcesses(ctx, { limit: 0 }) as unknown as Promise<unknown>,
    );
    await expectCode('process_not_found', () => getProcess(ctx, 'not-a-uuid'));
    await expectCode(
      'process_not_found',
      () => getProcess(ctx, newId()) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_process_query',
      () =>
        listProcessFindings(ctx, { processId: newId(), kind: 'nonsense' } as never) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_process_query',
      () =>
        listProcessFindings(ctx, { processId: 'nope', minConfidence: 2 } as never) as unknown as Promise<unknown>,
    );
  });
});

// ---------------------------------------------------------------------------
// The observation window bound (500-latest per kind)
// ---------------------------------------------------------------------------

describe('the observation window bound', () => {
  const ctx = member(tenantBulk);

  beforeAll(async () => {
    // exactly the observations contract's page cap of one kind
    for (let index = 0; index < 500; index += 1) {
      await recordObservation(ctx, {
        kind: 'bulk.note',
        payload: { caseId: `bulk-${index % 50}`, seq: index },
        observedAt: at(index),
        source: { kind: 'system', label: 'bulk-ingest' },
        channel: 'api',
        confidence: { value: 0.5, method: 'source_trust' },
      });
    }
  }, 120_000);

  it('reports the truncated window honestly', async () => {
    const process = await reconstructProcess(ctx, {
      name: 'Bulk notes',
      scope: { observationKinds: ['bulk.note'], caseKeyCandidates: ['caseId'] },
      options: { maxEvents: 2000 },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(process.stats.observationCount).toBe(500);
    expect(process.stats.observationWindowTruncated).toBe(true);
    expect(process.stats.caseCount).toBe(50);
    // a smaller window below the cap is not truncated
    const small = await reconstructProcess(ctx, {
      name: 'Bulk notes (windowed)',
      scope: { observationKinds: ['bulk.note'], caseKeyCandidates: ['caseId'], occurredFrom: at(0), occurredTo: at(9) },
      actor: { kind: 'system', label: 'cognition' },
    });
    expect(small.stats.observationCount).toBe(10);
    expect(small.stats.observationWindowTruncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation (the pure guards, through the service surface)
// ---------------------------------------------------------------------------

describe('reconstruction input validation', () => {
  const ctx = member(tenantList);

  const base: ReconstructProcessInput = {
    name: 'Valid',
    scope: { eventTypes: ['a.valid_type'] },
    actor: { kind: 'system', label: 'cognition' },
  };

  it('requires an evidence declaration', async () => {
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          scope: {},
        }) as unknown as Promise<unknown>,
    );
  });

  it('rejects unknown fields, bad classifications and bad windows', async () => {
    await expectCode(
      'invalid_reconstruction_input',
      () => reconstructProcess(ctx, { ...base, nope: true } as never) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          scope: { eventTypes: ['not a type!'] },
        }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          scope: { eventTypes: ['a.valid_type'], occurredFrom: '2026-09-14T08:00:00', occurredTo: at(1) },
        }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          scope: { eventTypes: ['a.valid_type'], occurredFrom: at(10), occurredTo: at(1) },
        }) as unknown as Promise<unknown>,
    );
  });

  it('rejects untraceable actors, bad options and oversized inputs', async () => {
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          actor: { kind: 'person' }, // no id, no label
        }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          options: { manualShareThreshold: 1.5 },
        }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          options: { minEdgeInstances: 0 },
        }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          options: { maxEvents: 0 },
        }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          scope: { eventTypes: [], observationKinds: [] },
        }) as unknown as Promise<unknown>,
    );
    await expectCode(
      'invalid_reconstruction_input',
      () =>
        reconstructProcess(ctx, {
          ...base,
          name: '', // names are non-empty
        }) as unknown as Promise<unknown>,
    );
  });
});
