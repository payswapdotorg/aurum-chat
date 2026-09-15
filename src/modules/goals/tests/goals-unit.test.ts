// Unit tests for the goals module's pure logic (no database): the
// vocabularies (priorities, statuses, change kinds, party/evidence/metric
// kinds), the change-kind derivation, the TenantContext shape, and the full
// validation/normalization surface of create inputs, revision patches and
// queries. Storage-level guarantees (append-only version chain, audit
// quartet capture, tenant scoping, lifecycle gates) are covered by
// goals-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { GoalsError } from '../errors';
import {
  assertGoalTenantContext,
  deriveChangeKind,
  GOAL_CHANGE_KINDS,
  GOAL_EVIDENCE_SOURCE_KINDS,
  GOAL_METRIC_DIRECTIONS,
  GOAL_PARTY_KINDS,
  GOAL_PRIORITIES,
  GOAL_STATUSES,
  isGoalChangeKind,
  isGoalEvidenceSourceKind,
  isGoalMetricDirection,
  isGoalPartyKind,
  isGoalPriority,
  isGoalStatus,
  isUuid,
  MAX_EVIDENCE_SOURCES,
  MAX_METRICS_PER_GOAL,
  validateCreateGoalInput,
  validateListGoalsQuery,
  validateHistoryQuery,
  validateVersionQuery,
  validateReviseGoalInput,
} from '../validation';
import type {
  CreateGoalInput,
  GetGoalVersionQuery,
  ListGoalsQuery,
  ListGoalVersionsQuery,
  ReviseGoalInput,
} from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_UPPER = '0B2F8E2A-1C4B-4D8A-9F3E-7A2B6C5D4E8F';
const T0 = '2026-09-14T09:15:00Z';
const T1 = '2026-12-31T23:59:59Z';
const T2 = '2027-06-30T12:00:00+02:00';

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(GoalsError);
    expect((error as GoalsError).code).toBe(code);
  }
}

function ctx(): TenantContext {
  return { tenantId: newId(), principalId: newId(), authority: [] };
}

/** A minimal, fully valid create input (§5 field list). */
function validCreate(): CreateGoalInput {
  return {
    title: 'Q4 churn reduction',
    objective: 'Reduce monthly customer churn.',
    desiredState: 'Churn is below 5% every month of the quarter.',
    metrics: [
      { name: 'monthly-churn-ratio', unit: 'ratio', direction: 'at_most', threshold: 0.05 },
    ],
    horizonStart: T0,
    horizonEnd: T1,
    owner: { kind: 'person', id: UUID_A, label: 'VP Customer Success' },
    priority: 'high',
    evidenceSources: [{ kind: 'source', label: 'billing-export' }],
    successCriteria: 'Three consecutive months with churn at or below 5%.',
    actor: { kind: 'person', id: UUID_A },
    rationale: 'Board directive 2026-03',
  };
}

/** A minimal, fully valid revision patch. */
function validRevision(): ReviseGoalInput {
  return {
    goalId: UUID_A,
    title: 'Q4 churn reduction (updated)',
    actor: { kind: 'person', id: UUID_A },
  };
}

describe('vocabularies (ARCHITECTURE.md §5 goal definition)', () => {
  it('declares the canonical values without duplicates', () => {
    expect([...GOAL_PRIORITIES]).toEqual(['critical', 'high', 'medium', 'low']);
    expect([...GOAL_STATUSES]).toEqual(['active', 'archived']);
    expect([...GOAL_CHANGE_KINDS]).toEqual(['created', 'revised', 'archived', 'reactivated']);
    expect([...GOAL_PARTY_KINDS]).toEqual(['person', 'team', 'agent', 'system', 'external']);
    expect([...GOAL_EVIDENCE_SOURCE_KINDS]).toEqual([
      'source',
      'person',
      'agent',
      'system',
      'external',
    ]);
    expect([...GOAL_METRIC_DIRECTIONS]).toEqual(['at_least', 'at_most', 'in_range']);
    for (const list of [
      GOAL_PRIORITIES,
      GOAL_STATUSES,
      GOAL_CHANGE_KINDS,
      GOAL_PARTY_KINDS,
      GOAL_EVIDENCE_SOURCE_KINDS,
      GOAL_METRIC_DIRECTIONS,
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('guards recognize members and reject everything else', () => {
    for (const priority of GOAL_PRIORITIES) expect(isGoalPriority(priority)).toBe(true);
    for (const status of GOAL_STATUSES) expect(isGoalStatus(status)).toBe(true);
    for (const kind of GOAL_CHANGE_KINDS) expect(isGoalChangeKind(kind)).toBe(true);
    for (const kind of GOAL_PARTY_KINDS) expect(isGoalPartyKind(kind)).toBe(true);
    for (const kind of GOAL_EVIDENCE_SOURCE_KINDS) {
      expect(isGoalEvidenceSourceKind(kind)).toBe(true);
    }
    for (const direction of GOAL_METRIC_DIRECTIONS) {
      expect(isGoalMetricDirection(direction)).toBe(true);
    }
    for (const bad of ['', 'Critical', 'urgent', 42, null, undefined, 'in-range']) {
      expect(isGoalPriority(bad)).toBe(false);
      expect(isGoalStatus(bad)).toBe(false);
      expect(isGoalChangeKind(bad)).toBe(false);
      expect(isGoalPartyKind(bad)).toBe(false);
      expect(isGoalEvidenceSourceKind(bad)).toBe(false);
      expect(isGoalMetricDirection(bad)).toBe(false);
    }
  });

  it('recognizes uuids (case-insensitive)', () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid(UUID_UPPER)).toBe(true);
    expect(isUuid(newId())).toBe(true);
    for (const bad of ['', 'not-a-uuid', 42, null, undefined]) expect(isUuid(bad)).toBe(false);
  });
});

describe('deriveChangeKind (the audit classification of a version)', () => {
  it('version 1 is always created', () => {
    expect(deriveChangeKind(null, 'active')).toBe('created');
    expect(deriveChangeKind(null, 'archived')).toBe('created');
  });

  it('same-status transitions are content revisions', () => {
    expect(deriveChangeKind('active', 'active')).toBe('revised');
    expect(deriveChangeKind('archived', 'archived')).toBe('revised');
  });

  it('status transitions are lifecycle changes', () => {
    expect(deriveChangeKind('active', 'archived')).toBe('archived');
    expect(deriveChangeKind('archived', 'active')).toBe('reactivated');
  });
});

describe('TenantContext shape (ADR-0001: explicit context, no ambient global)', () => {
  it('is asserted on every contract call surface', () => {
    expect(() => assertGoalTenantContext(ctx())).not.toThrow();
    expectCode('invalid_context', () =>
      assertGoalTenantContext({ tenantId: ' ', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertGoalTenantContext({ tenantId: 't', principalId: '', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertGoalTenantContext({ tenantId: 't', principalId: 'p', authority: 'none' as unknown as [] }),
    );
  });
});

describe('validateCreateGoalInput (the §5 definition)', () => {
  it('accepts and normalizes a full definition', () => {
    const valid = validateCreateGoalInput(validCreate());
    expect(valid.content.title).toBe('Q4 churn reduction');
    expect(valid.content.objective).toBe('Reduce monthly customer churn.');
    expect(valid.content.desiredState).toBe('Churn is below 5% every month of the quarter.');
    expect(valid.content.metrics).toEqual([
      {
        name: 'monthly-churn-ratio',
        unit: 'ratio',
        direction: 'at_most',
        threshold: 0.05,
        lowerBound: null,
        upperBound: null,
      },
    ]);
    expect(valid.content.horizonStart).toBe(T0);
    expect(valid.content.horizonEnd).toBe(T1);
    expect(valid.content.owner).toEqual({
      kind: 'person',
      id: UUID_A,
      label: 'VP Customer Success',
    });
    expect(valid.content.priority).toBe('high');
    expect(valid.content.evidenceSources).toEqual([{ kind: 'source', id: null, label: 'billing-export' }]);
    expect(valid.content.successCriteria).toBe('Three consecutive months with churn at or below 5%.');
    expect(valid.actor).toEqual({ kind: 'person', id: UUID_A, label: null });
    expect(valid.rationale).toBe('Board directive 2026-03');
  });

  it('applies the empty defaults (metrics, evidence sources, horizon start)', () => {
    const input = validCreate();
    delete input.metrics;
    delete input.evidenceSources;
    delete input.horizonStart;
    delete input.rationale;
    const valid = validateCreateGoalInput(input);
    expect(valid.content.metrics).toEqual([]);
    expect(valid.content.evidenceSources).toEqual([]);
    expect(valid.content.horizonStart).toBeNull();
    expect(valid.rationale).toBeNull();
  });

  it('normalizes a uuid owner id to lowercase and keeps offsets verbatim', () => {
    const input = validCreate();
    input.owner = { kind: 'team', id: UUID_UPPER };
    input.horizonEnd = T2;
    const valid = validateCreateGoalInput(input);
    expect(valid.content.owner).toEqual({ kind: 'team', id: UUID_A, label: null });
    expect(valid.content.horizonEnd).toBe(T2);
  });

  it('rejects non-object input and unknown fields — system-minted fields cannot be smuggled', () => {
    expectCode('invalid_goal_input', () => validateCreateGoalInput(null as unknown as CreateGoalInput));
    expectCode('invalid_goal_input', () => validateCreateGoalInput('goal' as unknown as CreateGoalInput));
    for (const smuggled of [
      'id',
      'tenantId',
      'version',
      'status',
      'changeKind',
      'recordedAt',
      'changedByPrincipal',
      'createdAt',
    ]) {
      const input = validCreate() as unknown as Record<string, unknown>;
      input[smuggled] = 'anything';
      expectCode('invalid_goal_input', () =>
        validateCreateGoalInput(input as unknown as CreateGoalInput),
      );
    }
  });

  it('validates the text fields (non-empty, bounded)', () => {
    for (const field of ['title', 'objective', 'desiredState', 'successCriteria'] as const) {
      const missing = validCreate() as unknown as Record<string, unknown>;
      delete missing[field];
      expectCode('invalid_goal_input', () =>
        validateCreateGoalInput(missing as unknown as CreateGoalInput),
      );
      const empty = validCreate();
      (empty as unknown as Record<string, unknown>)[field] = '   ';
      expectCode('invalid_goal_input', () => validateCreateGoalInput(empty));
      const long = validCreate();
      (long as unknown as Record<string, unknown>)[field] = 'x'.repeat(5000);
      expectCode('invalid_goal_input', () => validateCreateGoalInput(long));
    }
    const rationale = validCreate();
    rationale.rationale = 'x'.repeat(2001);
    expectCode('invalid_goal_input', () => validateCreateGoalInput(rationale));
    const trimmed = validCreate();
    trimmed.title = '  trimmed title  ';
    expect(validateCreateGoalInput(trimmed).content.title).toBe('trimmed title');
  });

  it('validates the horizon (end required, start strictly before end)', () => {
    const noEnd = validCreate() as unknown as Record<string, unknown>;
    delete noEnd.horizonEnd;
    expectCode('invalid_goal_input', () =>
      validateCreateGoalInput(noEnd as unknown as CreateGoalInput),
    );
    for (const bad of ['', '2026-12-31', 'not-a-time', 42, null]) {
      const input = validCreate();
      (input as unknown as Record<string, unknown>).horizonEnd = bad;
      expectCode('invalid_goal_input', () => validateCreateGoalInput(input));
    }
    const equal = validCreate();
    equal.horizonStart = equal.horizonEnd;
    expectCode('invalid_goal_input', () => validateCreateGoalInput(equal));
    const after = validCreate();
    after.horizonStart = '2027-01-01T00:00:00Z';
    expectCode('invalid_goal_input', () => validateCreateGoalInput(after));
  });

  it('validates the owner (kind, traceability, uuid id)', () => {
    for (const bad of [null, 'person', {}, { kind: 'manager' }, { kind: 'person' }]) {
      const input = validCreate();
      (input as unknown as Record<string, unknown>).owner = bad;
      expectCode('invalid_goal_input', () => validateCreateGoalInput(input));
    }
    const nonUuid = validCreate();
    nonUuid.owner = { kind: 'person', id: 'not-a-uuid' };
    expectCode('invalid_goal_input', () => validateCreateGoalInput(nonUuid));
    const labelOnly = validCreate();
    labelOnly.owner = { kind: 'team', label: 'Growth pod' };
    expect(validateCreateGoalInput(labelOnly).content.owner).toEqual({
      kind: 'team',
      id: null,
      label: 'Growth pod',
    });
  });

  it('validates the priority enum', () => {
    const input = validCreate();
    (input as unknown as Record<string, unknown>).priority = 'urgent';
    expectCode('invalid_goal_input', () => validateCreateGoalInput(input));
  });

  it('validates evidence sources (kinds, traceability, cap)', () => {
    const notArray = validCreate();
    (notArray as unknown as Record<string, unknown>).evidenceSources = 'billing';
    expectCode('invalid_goal_input', () => validateCreateGoalInput(notArray));
    const badKind = validCreate();
    badKind.evidenceSources = [
      { kind: 'channel', label: 'x' },
    ] as unknown as CreateGoalInput['evidenceSources'];
    expectCode('invalid_goal_input', () => validateCreateGoalInput(badKind));
    const untraceable = validCreate();
    untraceable.evidenceSources = [{ kind: 'source' }];
    expectCode('invalid_goal_input', () => validateCreateGoalInput(untraceable));
    const tooMany = validCreate();
    tooMany.evidenceSources = Array.from({ length: MAX_EVIDENCE_SOURCES + 1 }, (_, i) => ({
      kind: 'source',
      label: `s-${i}`,
    }));
    expectCode('invalid_goal_input', () => validateCreateGoalInput(tooMany));
  });

  it('validates the actor (same party rules as the owner)', () => {
    for (const bad of [null, {}, { kind: 'source' }, { kind: 'person', id: 'nope' }]) {
      const input = validCreate();
      (input as unknown as Record<string, unknown>).actor = bad;
      expectCode('invalid_goal_input', () => validateCreateGoalInput(input));
    }
    const labelOnly = validCreate();
    labelOnly.actor = { kind: 'system', label: 'management-import' };
    expect(validateCreateGoalInput(labelOnly).actor).toEqual({
      kind: 'system',
      id: null,
      label: 'management-import',
    });
  });
});

describe('metrics and thresholds (§5 metric/threshold)', () => {
  it('accepts all three directions with their bound shapes', () => {
    const input = validCreate();
    input.metrics = [
      { name: 'arr', unit: 'EUR-cent', direction: 'at_least', threshold: 500_000_00 },
      { name: 'churn', direction: 'at_most', threshold: 0.05 },
      { name: 'nps', unit: 'points', direction: 'in_range', lowerBound: 40, upperBound: 80 },
      { name: 'exactly-five', direction: 'in_range', lowerBound: 5, upperBound: 5 },
    ];
    const valid = validateCreateGoalInput(input);
    expect(valid.content.metrics).toHaveLength(4);
    expect(valid.content.metrics[0]).toEqual({
      name: 'arr',
      unit: 'EUR-cent',
      direction: 'at_least',
      threshold: 500_000_00,
      lowerBound: null,
      upperBound: null,
    });
    expect(valid.content.metrics[1]).toEqual({
      name: 'churn',
      unit: null,
      direction: 'at_most',
      threshold: 0.05,
      lowerBound: null,
      upperBound: null,
    });
    expect(valid.content.metrics[2]).toEqual({
      name: 'nps',
      unit: 'points',
      direction: 'in_range',
      threshold: null,
      lowerBound: 40,
      upperBound: 80,
    });
  });

  it('rejects malformed metric shapes', () => {
    const cases: unknown[] = [
      'metric',
      {},
      { name: 'm', direction: 'at_least' }, // missing threshold
      { name: 'm', direction: 'at_most' }, // missing threshold
      { name: 'm', direction: 'at_least', threshold: 1, lowerBound: 0 }, // bounds on at_least
      { name: 'm', direction: 'at_most', threshold: 1, upperBound: 2 }, // bounds on at_most
      { name: 'm', direction: 'in_range', threshold: 1 }, // threshold on in_range
      { name: 'm', direction: 'in_range', lowerBound: 1 }, // missing upper
      { name: 'm', direction: 'in_range', upperBound: 1 }, // missing lower
      { name: 'm', direction: 'in_range', lowerBound: 2, upperBound: 1 }, // lower > upper
      { name: 'm', direction: 'at_least', threshold: Number.POSITIVE_INFINITY },
      { name: 'm', direction: 'at_least', threshold: '5' },
      { name: 'M', direction: 'at_least', threshold: 1 }, // uppercase name
      { name: 'has space', direction: 'at_least', threshold: 1 },
      { name: 'm', direction: 'at_least', threshold: 1, bogus: true }, // unknown key
      { name: 'm', unit: 'x'.repeat(51), direction: 'at_least', threshold: 1 },
    ];
    for (const metric of cases) {
      const input = validCreate();
      input.metrics = [metric] as CreateGoalInput['metrics'];
      expectCode('invalid_goal_input', () => validateCreateGoalInput(input));
    }
  });

  it('rejects duplicate metric names and caps the metric count', () => {
    const duplicate = validCreate();
    duplicate.metrics = [
      { name: 'churn', direction: 'at_most', threshold: 0.05 },
      { name: 'churn', direction: 'at_most', threshold: 0.04 },
    ];
    expectCode('invalid_goal_input', () => validateCreateGoalInput(duplicate));

    const tooMany = validCreate();
    tooMany.metrics = Array.from({ length: MAX_METRICS_PER_GOAL + 1 }, (_, i) => ({
      name: `metric-${i}`,
      direction: 'at_least',
      threshold: i,
    }));
    expectCode('invalid_goal_input', () => validateCreateGoalInput(tooMany));
  });

  it('allows an empty metric set (qualitative goals)', () => {
    const input = validCreate();
    input.metrics = [];
    expect(validateCreateGoalInput(input).content.metrics).toEqual([]);
  });
});

describe('validateReviseGoalInput (the patch surface)', () => {
  it('accepts a single-field patch and normalizes it', () => {
    const valid = validateReviseGoalInput(validRevision());
    expect(valid.goalId).toBe(UUID_A);
    expect(valid.patch.title).toBe('Q4 churn reduction (updated)');
    expect(valid.patch.status).toBeUndefined();
    expect(valid.actor).toEqual({ kind: 'person', id: UUID_A, label: null });
    expect(valid.rationale).toBeNull();
  });

  it('rejects non-object input and unknown fields — audit fields cannot be smuggled', () => {
    expectCode('invalid_revision_input', () =>
      validateReviseGoalInput(null as unknown as ReviseGoalInput),
    );
    for (const smuggled of ['version', 'changeKind', 'recordedAt', 'changedByPrincipal', 'id']) {
      const input = validRevision() as unknown as Record<string, unknown>;
      input[smuggled] = 'anything';
      expectCode('invalid_revision_input', () =>
        validateReviseGoalInput(input as unknown as ReviseGoalInput),
      );
    }
  });

  it('requires a uuid goal id', () => {
    const input = validRevision();
    input.goalId = 'not-a-uuid';
    expectCode('invalid_revision_input', () => validateReviseGoalInput(input));
  });

  it('requires at least one changed field', () => {
    const input = validRevision();
    delete input.title;
    expectCode('invalid_revision_input', () => validateReviseGoalInput(input));
  });

  it('enforces surgical lifecycle transitions (status must be the only change)', () => {
    const surgical: ReviseGoalInput = {
      goalId: UUID_A,
      status: 'archived',
      actor: { kind: 'person', id: UUID_A },
    };
    expect(validateReviseGoalInput(surgical).patch.status).toBe('archived');

    const extras: unknown[] = [
      { title: 'x' },
      { objective: 'x' },
      { desiredState: 'x' },
      { metrics: [] },
      { horizonStart: T0 },
      { horizonEnd: T2 },
      { owner: { kind: 'person', id: UUID_A } },
      { priority: 'low' },
      { evidenceSources: [] },
      { successCriteria: 'x' },
    ];
    for (const extra of extras) {
      const input = {
        ...validRevision(),
        status: 'archived',
        ...(extra as object),
      } as unknown as ReviseGoalInput;
      expectCode('invalid_revision_input', () => validateReviseGoalInput(input));
    }
  });

  it('treats horizonStart as tri-state (omitted / null / value)', () => {
    const omitted = validateReviseGoalInput(validRevision());
    expect(omitted.patch.horizonStart).toBeUndefined();

    const cleared = validateReviseGoalInput({ ...validRevision(), horizonStart: null });
    expect(cleared.patch.horizonStart).toBeNull();

    const set = validateReviseGoalInput({ ...validRevision(), horizonStart: T0 });
    expect(set.patch.horizonStart).toBe(T0);

    const bad = { ...validRevision(), horizonStart: 'yesterday' };
    expectCode('invalid_revision_input', () => validateReviseGoalInput(bad));
  });

  it('validates patch field shapes exactly like create', () => {
    const badPriority = { ...validRevision(), priority: 'urgent' } as unknown as ReviseGoalInput;
    expectCode('invalid_revision_input', () => validateReviseGoalInput(badPriority));

    const badStatus = { ...validRevision(), status: 'draft' } as unknown as ReviseGoalInput;
    expectCode('invalid_revision_input', () => validateReviseGoalInput(badStatus));

    const badMetric = { ...validRevision(), metrics: [{ name: 'm' }] } as unknown as ReviseGoalInput;
    expectCode('invalid_revision_input', () => validateReviseGoalInput(badMetric));

    const badOwner = { ...validRevision(), owner: { kind: 'manager' } } as unknown as ReviseGoalInput;
    expectCode('invalid_revision_input', () => validateReviseGoalInput(badOwner));

    const badEnd = { ...validRevision(), horizonEnd: 'nope' };
    expectCode('invalid_revision_input', () => validateReviseGoalInput(badEnd));
  });
});

describe('validateListGoalsQuery', () => {
  it('defaults to an unfiltered, bounded query', () => {
    const valid = validateListGoalsQuery({});
    expect(valid.status).toBeNull();
    expect(valid.priority).toBeNull();
    expect(valid.ownerKind).toBeNull();
    expect(valid.ownerId).toBeNull();
    expect(valid.horizonEndFrom).toBeNull();
    expect(valid.horizonEndTo).toBeNull();
    expect(valid.search).toBeNull();
    expect(valid.limit).toBe(50);
  });

  it('accepts the full filter set', () => {
    const valid = validateListGoalsQuery({
      status: 'active',
      priority: 'critical',
      ownerKind: 'person',
      ownerId: UUID_UPPER,
      horizonEndFrom: T0,
      horizonEndTo: T1,
      search: 'churn',
      limit: 1,
    } as ListGoalsQuery);
    expect(valid.status).toBe('active');
    expect(valid.priority).toBe('critical');
    expect(valid.ownerKind).toBe('person');
    expect(valid.ownerId).toBe(UUID_A);
    expect(valid.horizonEndFrom).toEqual(new Date(T0));
    expect(valid.horizonEndTo).toEqual(new Date(T1));
    expect(valid.search).toBe('churn');
    expect(valid.limit).toBe(1);
  });

  it('rejects unknown fields and malformed values', () => {
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ bogus: true } as unknown as ListGoalsQuery),
    );
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ status: 'draft' } as unknown as ListGoalsQuery),
    );
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ priority: 'urgent' } as unknown as ListGoalsQuery),
    );
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ ownerId: UUID_A } as unknown as ListGoalsQuery),
    );
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ ownerKind: 'person', ownerId: 'nope' } as unknown as ListGoalsQuery),
    );
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ horizonEndFrom: T1, horizonEndTo: T0 } as unknown as ListGoalsQuery),
    );
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ horizonEndFrom: 'yesterday' } as unknown as ListGoalsQuery),
    );
    for (const limit of [0, -1, 501, 1.5, 'many']) {
      expectCode('invalid_query', () =>
        validateListGoalsQuery({ limit } as unknown as ListGoalsQuery),
      );
    }
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ search: '' } as unknown as ListGoalsQuery),
    );
    expectCode('invalid_query', () =>
      validateListGoalsQuery({ search: 'x'.repeat(201) } as unknown as ListGoalsQuery),
    );
  });
});

describe('validateVersionQuery / validateHistoryQuery', () => {
  it('accepts well-formed queries', () => {
    expect(validateVersionQuery({ goalId: UUID_A, version: 1 })).toEqual({
      goalId: UUID_A,
      version: 1,
    });
    expect(validateHistoryQuery({ goalId: UUID_UPPER })).toEqual({ goalId: UUID_A });
  });

  it('rejects malformed queries', () => {
    expectCode('invalid_query', () =>
      validateVersionQuery({ goalId: 'nope', version: 1 } as GetGoalVersionQuery),
    );
    expectCode('invalid_query', () =>
      validateVersionQuery({ goalId: UUID_A } as GetGoalVersionQuery),
    );
    expectCode('invalid_query', () =>
      validateVersionQuery({ goalId: UUID_A, version: 0 } as GetGoalVersionQuery),
    );
    expectCode('invalid_query', () =>
      validateVersionQuery({ goalId: UUID_A, version: 1.5 } as GetGoalVersionQuery),
    );
    expectCode('invalid_query', () =>
      validateVersionQuery({ goalId: UUID_A, version: 1, extra: true } as GetGoalVersionQuery),
    );
    expectCode('invalid_query', () => validateHistoryQuery({ goalId: 'nope' } as ListGoalVersionsQuery));
    expectCode('invalid_query', () => validateHistoryQuery({} as ListGoalVersionsQuery));
    expectCode('invalid_query', () =>
      validateHistoryQuery({ goalId: UUID_A, extra: 1 } as ListGoalVersionsQuery),
    );
  });
});
