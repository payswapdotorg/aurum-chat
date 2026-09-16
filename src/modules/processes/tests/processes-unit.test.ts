// Unit tests for the processes module's PURE logic — reconstruction.ts and
// detection.ts (no database): the deterministic function from activity
// occurrences to the reconstructed model, and from model + options to the
// five finding kinds (bottlenecks, duplication, handoffs, manual effort,
// errors).

import { describe, expect, it } from 'vitest';
import {
  detectFindings,
  isErrorActivity,
  FINDING_KIND_RANK,
} from '../detection';
import {
  actorKeyOf,
  occurrenceCompare,
  reconstructProcessModel,
  MAX_MODEL_ACTIVITY_TYPES,
  type ActivityOccurrence,
} from '../reconstruction';
import { ProcessesError } from '../errors';
import type { ReconstructionOptions } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-09-14T08:00:00Z');

let occurrenceCounter = 0;

/** A tiny occurrence builder with auto-incrementing evidence ids. */
function occ(overrides: Partial<ActivityOccurrence> & Pick<ActivityOccurrence, 'activityType'>): ActivityOccurrence {
  occurrenceCounter += 1;
  const base: ActivityOccurrence = {
    caseId: 'case-1',
    activityType: overrides.activityType,
    actorKind: 'system',
    actorId: 'actor-system',
    actorLabel: null,
    occurredAtMs: T0,
    occurredAtIso: new Date(overrides.occurredAtMs ?? T0).toISOString(),
    evidenceKind: 'event',
    evidenceId: `00000000-0000-4000-8000-${String(occurrenceCounter).padStart(12, '0')}`,
    eventSequence: occurrenceCounter,
  };
  return { ...base, ...overrides };
}

const DEFAULT_OPTIONS: ReconstructionOptions = {
  bottleneckThresholdSeconds: null,
  minEdgeInstances: 2,
  manualShareThreshold: 0.5,
  errorActivityTypes: [],
  maxEvents: 2000,
};

// ---------------------------------------------------------------------------
// reconstruction.ts
// ---------------------------------------------------------------------------

describe('reconstructProcessModel', () => {
  it('groups occurrences into cases and derives steps, edges, variants and stats', () => {
    const occurrences = [
      // case A: intake → review → approve (3 steps, 2 edges)
      occ({ caseId: 'A', activityType: 'invoice.registered', occurredAtMs: T0 }),
      occ({ caseId: 'A', activityType: 'invoice.reviewed', occurredAtMs: T0 + 60_000 }),
      occ({ caseId: 'A', activityType: 'invoice.approved', occurredAtMs: T0 + 360_000 }),
      // case B: same flow, faster
      occ({ caseId: 'B', activityType: 'invoice.registered', occurredAtMs: T0 + 1_000_000 }),
      occ({ caseId: 'B', activityType: 'invoice.reviewed', occurredAtMs: T0 + 1_060_000 }),
      occ({ caseId: 'B', activityType: 'invoice.approved', occurredAtMs: T0 + 1_300_000 }),
    ];
    const model = reconstructProcessModel(occurrences, false);

    expect(model.steps.map((step) => step.activityType)).toEqual([
      'invoice.approved',
      'invoice.registered',
      'invoice.reviewed',
    ]);
    const registered = model.steps.find((step) => step.activityType === 'invoice.registered')!;
    expect(registered.instances).toBe(2);
    expect(registered.cases).toBe(2);
    expect(registered.firstOccurredAt).toBe(new Date(T0).toISOString());
    expect(registered.lastOccurredAt).toBe(new Date(T0 + 1_000_000).toISOString());

    // edges: registered→reviewed (2 instances, waits 60s and 60s),
    // reviewed→approved (2 instances, waits 300s and 240s)
    expect(model.edges).toEqual([
      {
        fromActivity: 'invoice.registered',
        toActivity: 'invoice.reviewed',
        instances: 2,
        avgWaitSeconds: 60,
        maxWaitSeconds: 60,
      },
      {
        fromActivity: 'invoice.reviewed',
        toActivity: 'invoice.approved',
        instances: 2,
        avgWaitSeconds: 270,
        maxWaitSeconds: 300,
      },
    ]);

    // one variant (both cases followed the same sequence)
    expect(model.variants).toEqual([
      {
        sequence: ['invoice.registered', 'invoice.reviewed', 'invoice.approved'],
        instances: 2,
      },
    ]);

    expect(model.stats).toMatchObject({
      caseCount: 2,
      occurrenceCount: 6,
      eventCount: 6,
      observationCount: 0,
      distinctActivityTypes: 3,
      distinctEdges: 2,
      variantCount: 1,
      variantsStored: 1,
      manualShare: 0,
      handoffCount: 0,
      errorCount: 0,
      avgCaseDurationSeconds: 330,
      minCaseDurationSeconds: 300,
      maxCaseDurationSeconds: 360,
      observationWindowTruncated: false,
    });
  });

  it('orders a case by occurrence time with deterministic tie-breaks (events before observations, then sequence, then id)', () => {
    const sameInstant = T0;
    const event = occ({
      caseId: 'A',
      activityType: 'happening.event',
      occurredAtMs: sameInstant,
      evidenceKind: 'event',
      evidenceId: 'aaaaaaaa-0000-4000-8000-000000000003',
      eventSequence: 3,
    });
    const observation = occ({
      caseId: 'A',
      activityType: 'evidence.noted',
      occurredAtMs: sameInstant,
      evidenceKind: 'observation',
      evidenceId: 'bbbbbbbb-0000-4000-8000-000000000001',
    });
    const earlierEvent = occ({
      caseId: 'A',
      activityType: 'happening.earlier',
      occurredAtMs: sameInstant,
      evidenceKind: 'event',
      evidenceId: 'cccccccc-0000-4000-8000-000000000002',
      eventSequence: 2,
    });
    const laterEvent = occ({
      caseId: 'A',
      activityType: 'happening.later',
      occurredAtMs: sameInstant,
      evidenceKind: 'event',
      evidenceId: 'dddddddd-0000-4000-8000-000000000004',
      eventSequence: 4,
    });

    // supply in scrambled order; the model's variant exposes the case order
    const model = reconstructProcessModel([laterEvent, observation, event, earlierEvent], false);
    expect(model.variants[0]!.sequence).toEqual([
      'happening.earlier',
      'happening.event',
      'happening.later',
      'evidence.noted',
    ]);

    // the comparator is exported and consistent with that order
    const ordered = [laterEvent, observation, event, earlierEvent].sort(occurrenceCompare);
    expect(ordered.map((o) => o.activityType)).toEqual([
      'happening.earlier',
      'happening.event',
      'happening.later',
      'evidence.noted',
    ]);
  });

  it('counts handoffs between distinct actors (id, then label, then kind alone)', () => {
    const model = reconstructProcessModel(
      [
        occ({ caseId: 'A', activityType: 'a.one', actorId: 'p1', actorKind: 'person' }),
        occ({ caseId: 'A', activityType: 'a.two', actorId: 'p2', actorKind: 'person' }),
        occ({ caseId: 'A', activityType: 'a.three', actorLabel: 'robot', actorKind: 'agent', actorId: null }),
        occ({ caseId: 'A', activityType: 'a.four', actorLabel: 'robot', actorKind: 'agent', actorId: null }),
      ],
      false,
    );
    // p1→p2 (handoff), p2→robot (handoff), robot→robot (no handoff)
    expect(model.stats.handoffCount).toBe(2);

    expect(actorKeyOf(occ({ activityType: 'x', actorId: 'p1', actorKind: 'person' }))).toBe('person:p1');
    expect(actorKeyOf(occ({ activityType: 'x', actorId: null, actorLabel: 'robot', actorKind: 'agent' }))).toBe(
      'agent:robot',
    );
    expect(actorKeyOf(occ({ activityType: 'x', actorId: null, actorLabel: null, actorKind: 'system' }))).toBe(
      'system:<unattributed>',
    );
  });

  it('keeps single-activity cases out of edges and durations but in steps/stats', () => {
    const model = reconstructProcessModel(
      [
        occ({ caseId: 'A', activityType: 'solo.step' }),
        occ({ caseId: 'B', activityType: 'paired.one' }),
        occ({ caseId: 'B', activityType: 'paired.two', occurredAtMs: T0 + 5000 }),
      ],
      false,
    );
    expect(model.edges).toHaveLength(1); // only within case B
    expect(model.stats.caseCount).toBe(2);
    expect(model.stats.avgCaseDurationSeconds).toBe(5); // only case B qualifies
    expect(model.stats.minCaseDurationSeconds).toBe(5);
    expect(model.stats.maxCaseDurationSeconds).toBe(5);
    expect(model.variants).toEqual([
      { sequence: ['paired.one', 'paired.two'], instances: 1 },
      { sequence: ['solo.step'], instances: 1 },
    ]);
  });

  it('stores only the top variants by instances (ties by sequence), keeping the true count', () => {
    const occurrences: ActivityOccurrence[] = [];
    for (let index = 0; index < 30; index += 1) {
      occurrences.push(
        occ({ caseId: `common-${index}`, activityType: 'common.step' }),
        // distinct activity per case → 30 distinct single-activity variants
        occ({ caseId: `rare-${index}`, activityType: `rare.step.${index}` }),
      );
    }
    const model = reconstructProcessModel(occurrences, false);
    expect(model.stats.variantCount).toBe(31); // 30 rare + 1 common
    expect(model.variants).toHaveLength(25); // MAX_VARIANTS_STORED
    // the common variant (30 instances) is first
    expect(model.variants[0]).toEqual({ sequence: ['common.step'], instances: 30 });
    // and the stored set keeps the deterministic order (rare.step.0.. rare.step.23
    // sort before rare.step.24..29 at equal instance counts)
    expect(model.variants[1]!.sequence).toEqual(['rare.step.0']);
    expect(model.stats.variantsStored).toBe(25);
  });

  it('refuses an oversized model with reconstruction_too_large (never truncates silently)', () => {
    const occurrences: ActivityOccurrence[] = [];
    for (let index = 0; index <= MAX_MODEL_ACTIVITY_TYPES; index += 1) {
      occurrences.push(occ({ caseId: `c-${index}`, activityType: `a.type.${index}` }));
    }
    expect(() => reconstructProcessModel(occurrences, false)).toThrowError(ProcessesError);
    try {
      reconstructProcessModel(occurrences, false);
    } catch (error) {
      expect((error as ProcessesError).code).toBe('reconstruction_too_large');
    }
  });

  it('derives manual share per step and overall from actor kinds', () => {
    const model = reconstructProcessModel(
      [
        occ({ caseId: 'A', activityType: 'manual.one', actorKind: 'person', actorId: 'p1' }),
        occ({ caseId: 'A', activityType: 'manual.one', actorKind: 'person', actorId: 'p2' }),
        occ({ caseId: 'A', activityType: 'auto.one', actorKind: 'system', actorId: 's1' }),
        occ({ caseId: 'B', activityType: 'mixed.one', actorKind: 'person', actorId: 'p1' }),
        occ({ caseId: 'B', activityType: 'mixed.one', actorKind: 'system', actorId: 's1' }),
        occ({ caseId: 'B', activityType: 'neutral.one', actorKind: 'external', actorId: 'e1' }),
      ],
      false,
    );
    const manual = model.steps.find((step) => step.activityType === 'manual.one')!;
    expect(manual.manualShare).toBe(1);
    expect(manual.actorCounts).toEqual({ person: 2, agent: 0, system: 0, external: 0, source: 0 });
    const mixed = model.steps.find((step) => step.activityType === 'mixed.one')!;
    expect(mixed.manualShare).toBe(0.5);
    // overall: 3 person occurrences of 6
    expect(model.stats.manualShare).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// detection.ts
// ---------------------------------------------------------------------------

describe('isErrorActivity', () => {
  it('classifies by default suffixes and caller-declared exact types', () => {
    expect(isErrorActivity('payment.failed', [])).toBe(true);
    expect(isErrorActivity('form.submission.error', [])).toBe(true);
    expect(isErrorActivity('order.rejected', [])).toBe(true);
    expect(isErrorActivity('invoice.registered', [])).toBe(false);
    expect(isErrorActivity('invoice.registered', ['invoice.registered'])).toBe(true);
    // suffix matching is anchored at the end
    expect(isErrorActivity('failed.lookup', [])).toBe(false);
  });
});

describe('detectFindings', () => {
  it('detects a bottleneck edge against the derived default threshold (2 × median qualifying wait)', () => {
    // three edges, each with 2 instances: waits 60s, 60s… and a slow one
    const occurrences = [
      // case 1
      occ({ caseId: 'c1', activityType: 'a.start', occurredAtMs: T0 }),
      occ({ caseId: 'c1', activityType: 'b.middle', occurredAtMs: T0 + 60_000 }),
      occ({ caseId: 'c1', activityType: 'c.end', occurredAtMs: T0 + 120_000 }),
      occ({ caseId: 'c1', activityType: 'd.slow', occurredAtMs: T0 + 720_000 }),
      // case 2 (same shape)
      occ({ caseId: 'c2', activityType: 'a.start', occurredAtMs: T0 + 10_000_000 }),
      occ({ caseId: 'c2', activityType: 'b.middle', occurredAtMs: T0 + 10_060_000 }),
      occ({ caseId: 'c2', activityType: 'c.end', occurredAtMs: T0 + 10_120_000 }),
      occ({ caseId: 'c2', activityType: 'd.slow', occurredAtMs: T0 + 10_780_000 }),
    ];
    const model = reconstructProcessModel(occurrences, false);
    // qualifying edges (≥ 2 instances): a→b (60s), b→c (60s), c→d (600s+660s→630s avg)
    // median of [60, 60, 630] = 60 → threshold 120s → only c→d qualifies
    const detection = detectFindings(model, occurrences, DEFAULT_OPTIONS);
    const bottlenecks = detection.findings.filter((finding) => finding.kind === 'bottleneck');
    expect(bottlenecks).toHaveLength(1);
    expect(bottlenecks[0]!.subject).toBe('edge:c.end->d.slow');
    expect(bottlenecks[0]!.metrics).toEqual({
      fromActivity: 'c.end',
      toActivity: 'd.slow',
      instances: 2,
      avgWaitSeconds: 630,
      maxWaitSeconds: 660,
      thresholdSeconds: 120,
    });
    // evidence cites the pairs demonstrating the wait
    expect(bottlenecks[0]!.evidenceEventIds).toHaveLength(4);
    expect(bottlenecks[0]!.evidenceObservationIds).toHaveLength(0);
  });

  it('honors an explicit bottleneck threshold and the minimum edge instances', () => {
    const occurrences = [
      occ({ caseId: 'c1', activityType: 'a.start', occurredAtMs: T0 }),
      occ({ caseId: 'c1', activityType: 'b.end', occurredAtMs: T0 + 500_000 }),
      occ({ caseId: 'c2', activityType: 'a.start', occurredAtMs: T0 + 1_000_000 }),
      occ({ caseId: 'c2', activityType: 'b.end', occurredAtMs: T0 + 1_500_000 }),
    ];
    const model = reconstructProcessModel(occurrences, false);

    // explicit threshold 100s: the edge (500s avg, 2 instances) qualifies
    const explicit = detectFindings(model, occurrences, {
      ...DEFAULT_OPTIONS,
      bottleneckThresholdSeconds: 100,
    });
    expect(explicit.findings.filter((f) => f.kind === 'bottleneck')).toHaveLength(1);

    // minEdgeInstances 3: no edge qualifies → no bottleneck findings
    const picky = detectFindings(model, occurrences, {
      ...DEFAULT_OPTIONS,
      minEdgeInstances: 3,
      bottleneckThresholdSeconds: 100,
    });
    expect(picky.findings.filter((f) => f.kind === 'bottleneck')).toHaveLength(0);
  });

  it('detects duplication when an activity repeats within one case, with support-scaled confidence', () => {
    const occurrences = [
      occ({ caseId: 'c1', activityType: 'x.check' }),
      occ({ caseId: 'c1', activityType: 'x.check', occurredAtMs: T0 + 1000 }),
      occ({ caseId: 'c1', activityType: 'x.check', occurredAtMs: T0 + 2000 }),
      occ({ caseId: 'c2', activityType: 'x.check' }),
      occ({ caseId: 'c2', activityType: 'y.done', occurredAtMs: T0 + 3000 }),
    ];
    const model = reconstructProcessModel(occurrences, false);
    const detection = detectFindings(model, occurrences, DEFAULT_OPTIONS);
    const duplication = detection.findings.filter((f) => f.kind === 'duplication');
    expect(duplication).toHaveLength(1);
    expect(duplication[0]!.subject).toBe('step:x.check');
    expect(duplication[0]!.metrics).toEqual({
      activityType: 'x.check',
      casesWithRepetition: 1,
      extraOccurrences: 2,
    });
    // confidence = min(0.9, 0.5 + 0.1 × 1 case)
    expect(duplication[0]!.confidence).toBe(0.6);
    expect(duplication[0]!.evidenceEventIds).toHaveLength(3);
  });

  it('detects ping-pong handoffs (A → B → A) but not plain actor changes', () => {
    const occurrences = [
      // ping-pong: p1 → p2 → p1 (flagged)
      occ({ caseId: 'c1', activityType: 'a.one', actorId: 'p1', actorKind: 'person' }),
      occ({ caseId: 'c1', activityType: 'a.two', actorId: 'p2', actorKind: 'person', occurredAtMs: T0 + 1000 }),
      occ({ caseId: 'c1', activityType: 'a.three', actorId: 'p1', actorKind: 'person', occurredAtMs: T0 + 2000 }),
      // necessary handoff: p1 → p2 → p3 (not flagged)
      occ({ caseId: 'c2', activityType: 'b.one', actorId: 'p1', actorKind: 'person', occurredAtMs: T0 + 3000 }),
      occ({ caseId: 'c2', activityType: 'b.two', actorId: 'p2', actorKind: 'person', occurredAtMs: T0 + 4000 }),
      occ({ caseId: 'c2', activityType: 'b.three', actorId: 'p3', actorKind: 'person', occurredAtMs: T0 + 5000 }),
    ];
    const model = reconstructProcessModel(occurrences, false);
    const detection = detectFindings(model, occurrences, DEFAULT_OPTIONS);
    const handoffs = detection.findings.filter((f) => f.kind === 'handoff');
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.subject).toBe('ping-pong:a.one->a.two->a.three');
    expect(handoffs[0]!.metrics).toMatchObject({
      fromActivity: 'a.one',
      midActivity: 'a.two',
      toActivity: 'a.three',
      instances: 1,
      fromActor: 'person:p1',
      midActor: 'person:p2',
    });
    // both cases contribute to the handoff COUNT in stats (2 + 2 = 4)
    expect(model.stats.handoffCount).toBe(4);
  });

  it('detects manual effort at the share threshold and respects a custom threshold', () => {
    const occurrences = [
      occ({ caseId: 'c1', activityType: 'm.step', actorKind: 'person', actorId: 'p1' }),
      occ({ caseId: 'c2', activityType: 'm.step', actorKind: 'person', actorId: 'p2' }),
      occ({ caseId: 'c3', activityType: 'm.step', actorKind: 'system', actorId: 's1' }),
      occ({ caseId: 'c4', activityType: 'm.step', actorKind: 'system', actorId: 's2' }),
    ];
    const model = reconstructProcessModel(occurrences, false);
    // 2 of 4 = 0.5 → at the default 0.5 threshold (≥), flagged
    const atDefault = detectFindings(model, occurrences, DEFAULT_OPTIONS);
    const manualDefault = atDefault.findings.filter((f) => f.kind === 'manual_effort');
    expect(manualDefault).toHaveLength(1);
    expect(manualDefault[0]!.subject).toBe('step:m.step');
    expect(manualDefault[0]!.metrics).toEqual({
      activityType: 'm.step',
      instances: 4,
      personInstances: 2,
      manualShare: 0.5,
      manualShareThreshold: 0.5,
    });
    // above the default: a stricter 0.75 threshold leaves the step unflagged
    const stricter = detectFindings(model, occurrences, {
      ...DEFAULT_OPTIONS,
      manualShareThreshold: 0.75,
    });
    expect(stricter.findings.filter((f) => f.kind === 'manual_effort')).toHaveLength(0);
  });

  it('requires at least 2 instances for a manual-effort finding', () => {
    const occurrences = [
      occ({ caseId: 'c1', activityType: 'once.manual', actorKind: 'person', actorId: 'p1' }),
    ];
    const model = reconstructProcessModel(occurrences, false);
    const detection = detectFindings(model, occurrences, DEFAULT_OPTIONS);
    expect(detection.findings.filter((f) => f.kind === 'manual_effort')).toHaveLength(0);
  });

  it('detects error occurrences (suffix or declared) and feeds stats.errorCount via the result', () => {
    const occurrences = [
      occ({ caseId: 'c1', activityType: 'job.started' }),
      occ({ caseId: 'c1', activityType: 'job.failed', occurredAtMs: T0 + 1000 }),
      occ({ caseId: 'c2', activityType: 'job.started' }),
      occ({ caseId: 'c2', activityType: 'job.failed', occurredAtMs: T0 + 2000 }),
      occ({ caseId: 'c3', activityType: 'custom.broken' }),
    ];
    const model = reconstructProcessModel(occurrences, false);
    // declared type adds custom.broken beyond the .failed suffix
    const detection = detectFindings(model, occurrences, {
      ...DEFAULT_OPTIONS,
      errorActivityTypes: ['custom.broken'],
    });
    const errors = detection.findings.filter((f) => f.kind === 'error');
    expect(errors.map((finding) => finding.subject)).toEqual([
      'step:custom.broken',
      'step:job.failed',
    ]);
    const jobFailed = errors.find((finding) => finding.subject === 'step:job.failed')!;
    expect(jobFailed.metrics).toEqual({
      activityType: 'job.failed',
      instances: 2,
      affectedCases: 2,
    });
    expect(jobFailed.confidence).toBe(0.7); // min(0.9, 0.5 + 0.1 × 2)
    expect(detection.errorCount).toBe(3);
  });

  it('caps finding confidence at 0.9 however large the support grows', () => {
    const occurrences: ActivityOccurrence[] = [];
    for (let index = 0; index < 20; index += 1) {
      occurrences.push(occ({ caseId: `c${index}`, activityType: 'boom.failed' }));
    }
    const model = reconstructProcessModel(occurrences, false);
    const detection = detectFindings(model, occurrences, DEFAULT_OPTIONS);
    const error = detection.findings.find((f) => f.kind === 'error')!;
    expect(error.confidence).toBe(0.9);
  });

  it('emits findings in the canonical kind-then-subject order', () => {
    const occurrences = [
      // bottleneck: slow edge, 2 instances
      occ({ caseId: 'c1', activityType: 'z.start', occurredAtMs: T0 }),
      occ({ caseId: 'c1', activityType: 'z.slow', occurredAtMs: T0 + 10_000_000 }),
      occ({ caseId: 'c2', activityType: 'z.start', occurredAtMs: T0 + 20_000_000 }),
      occ({ caseId: 'c2', activityType: 'z.slow', occurredAtMs: T0 + 30_000_000 }),
      // duplication: z.slow repeats… (already covered by c1/c2 once each — add a repeat)
      occ({ caseId: 'c1', activityType: 'z.start', occurredAtMs: T0 + 40_000_000 }),
      // handoff ping-pong: p1 → p2 → p1
      occ({ caseId: 'h1', activityType: 'h.one', actorId: 'p1', actorKind: 'person', occurredAtMs: T0 + 50_000_000 }),
      occ({ caseId: 'h1', activityType: 'h.two', actorId: 'p2', actorKind: 'person', occurredAtMs: T0 + 50_001_000 }),
      occ({ caseId: 'h1', activityType: 'h.three', actorId: 'p1', actorKind: 'person', occurredAtMs: T0 + 50_002_000 }),
      // manual: m.step person × 2
      occ({ caseId: 'm1', activityType: 'm.step', actorId: 'p1', actorKind: 'person', occurredAtMs: T0 + 60_000_000 }),
      occ({ caseId: 'm2', activityType: 'm.step', actorId: 'p2', actorKind: 'person', occurredAtMs: T0 + 60_001_000 }),
      // error: e.failed
      occ({ caseId: 'e1', activityType: 'e.failed', occurredAtMs: T0 + 70_000_000 }),
    ];
    const model = reconstructProcessModel(occurrences, false);
    const detection = detectFindings(model, occurrences, {
      ...DEFAULT_OPTIONS,
      // force every present kind into the result
      bottleneckThresholdSeconds: 1,
    });
    const kinds = detection.findings.map((finding) => finding.kind);
    expect(kinds).toEqual([
      'bottleneck',
      'duplication',
      'handoff',
      'manual_effort',
      'error',
    ]);
    // rank order is monotone
    const ranks = kinds.map((kind) => FINDING_KIND_RANK[kind]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('returns zero findings for a lean, automated, fast, single-occurrence flow', () => {
    const occurrences = [
      occ({ caseId: 'c1', activityType: 'fine.one', actorKind: 'system', actorId: 's1' }),
      occ({ caseId: 'c2', activityType: 'fine.two', actorKind: 'agent', actorId: 'ag1', occurredAtMs: T0 + 1000 }),
    ];
    const model = reconstructProcessModel(occurrences, false);
    const detection = detectFindings(model, occurrences, DEFAULT_OPTIONS);
    expect(detection.findings).toHaveLength(0);
    expect(detection.errorCount).toBe(0);
  });
});
