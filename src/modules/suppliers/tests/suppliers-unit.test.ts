// Unit tests for the suppliers module's PURE logic — scoring.ts (the
// deterministic function from a supplier's current scorecard to the derived
// overall, completeness and ranking) and validation.ts (the input/query
// guards). No database.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCORE_WEIGHTS,
  buildRanking,
  computeOverall,
  computeScoring,
  effectiveWeights,
  rankingCompare,
  type RankingRecord,
} from '../scoring';
import {
  DEFAULT_LIST_LIMIT,
  DIMENSION_FIELD,
  MAX_LIST_LIMIT,
  SCORE_DIMENSIONS,
  assertSuppliersTenantContext,
  isScoreDimension,
  isSupplierKind,
  isSupplierRecordStatus,
  mergeScorePatch,
  scoredDimensionCount,
  validateListSuppliersQuery,
  validateRankSuppliersQuery,
  validateRecordScorecardInput,
  validateRegisterSupplierInput,
  validateReviseScorecardInput,
  validateReviseSupplierInput,
  validateSupplierIntelligenceQuery,
} from '../validation';
import { SuppliersError } from '../errors';
import type { SupplierDimensionScores } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTOR = { kind: 'person' as const, id: 'person-1', label: 'Ops lead' };
const SUPPLIER_ID = '00000000-0000-4000-8000-0000000000aa';
const SCORECARD_ID = '00000000-0000-4000-8000-0000000000bb';
const OBS_1 = '00000000-0000-4000-8000-000000000001';
const OBS_2 = '00000000-0000-4000-8000-000000000002';

function allNull(): SupplierDimensionScores {
  return {
    price: null,
    quality: null,
    reliability: null,
    capacity: null,
    compliance: null,
    geography: null,
    switchingCost: null,
    alternatives: null,
  };
}

function scoresOf(overrides: Partial<SupplierDimensionScores>): SupplierDimensionScores {
  return { ...allNull(), ...overrides };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(SuppliersError);
    expect((error as SuppliersError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// The eight dimensions
// ---------------------------------------------------------------------------

describe('SCORE_DIMENSIONS (the work item verbatim)', () => {
  it('is the eight dimensions in canonical work-item order', () => {
    expect([...SCORE_DIMENSIONS]).toEqual([
      'price',
      'quality',
      'reliability',
      'capacity',
      'compliance',
      'geography',
      'switching_cost',
      'alternatives',
    ]);
  });

  it('maps every dimension to a scorecard field', () => {
    for (const dimension of SCORE_DIMENSIONS) {
      expect(DIMENSION_FIELD[dimension] in allNull()).toBe(true);
    }
    expect(DIMENSION_FIELD.switching_cost).toBe('switchingCost');
  });

  it('guards recognize the dimensions and the vocabularies', () => {
    for (const dimension of SCORE_DIMENSIONS) expect(isScoreDimension(dimension)).toBe(true);
    expect(isScoreDimension('switchingCost')).toBe(false); // the scorecard FIELD is camelCase
    expect(isScoreDimension('score')).toBe(false);
    expect(isSupplierKind('supplier')).toBe(true);
    expect(isSupplierKind('subcontractor')).toBe(true);
    expect(isSupplierKind('partner')).toBe(false); // capabilities vocabulary, not ours
    expect(isSupplierRecordStatus('active')).toBe(true);
    expect(isSupplierRecordStatus('deleted')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoring.ts — computeScoring / computeOverall
// ---------------------------------------------------------------------------

describe('computeScoring', () => {
  it('defaults to the plain mean of all eight scored dimensions', () => {
    const scoring = computeScoring(
      scoresOf({
        price: 1,
        quality: 0.8,
        reliability: 0.6,
        capacity: 0.4,
        compliance: 0.2,
        geography: 0,
        switchingCost: 0.5,
        alternatives: 0.5,
      }),
    );
    expect(scoring.overall).toBeCloseTo((1 + 0.8 + 0.6 + 0.4 + 0.2 + 0 + 0.5 + 0.5) / 8, 12);
    expect(scoring.scoredDimensions).toBe(8);
    expect(scoring.totalDimensions).toBe(8);
    expect(scoring.completeness).toBe(1);
    expect(scoring.dimensions).toHaveLength(8);
    expect(scoring.dimensions.map((entry) => entry.dimension)).toEqual([...SCORE_DIMENSIONS]);
    expect(DEFAULT_SCORE_WEIGHTS.price).toBe(1);
    for (const entry of scoring.dimensions) expect(entry.weight).toBe(1);
  });

  it('excludes unscored dimensions from numerator AND denominator (missing data is never a grade)', () => {
    const scoring = computeScoring(scoresOf({ price: 0.8 }));
    expect(scoring.overall).toBe(0.8);
    expect(scoring.scoredDimensions).toBe(1);
    expect(scoring.completeness).toBeCloseTo(1 / 8, 12);
    expect(scoring.dimensions[0]).toEqual({ dimension: 'price', score: 0.8, weight: 1 });
    expect(scoring.dimensions[1]!.score).toBeNull(); // quality unscored
  });

  it('returns overall null when nothing is scored', () => {
    const scoring = computeScoring(allNull());
    expect(scoring.overall).toBeNull();
    expect(scoring.scoredDimensions).toBe(0);
    expect(scoring.completeness).toBe(0);
  });

  it('weights the scored dimensions (read-time weights)', () => {
    const scoring = computeScoring(scoresOf({ price: 0.9, quality: 0.5 }), {
      price: 3,
      quality: 1,
    });
    expect(scoring.overall).toBeCloseTo((0.9 * 3 + 0.5 * 1) / 4, 12);
    expect(scoring.dimensions.find((e) => e.dimension === 'price')!.weight).toBe(3);
  });

  it('treats a zero weight as "do not count this dimension for this read"', () => {
    const scoring = computeScoring(scoresOf({ price: 1, quality: 0.5 }), { price: 0 });
    expect(scoring.overall).toBe(0.5); // only quality counts
    expect(scoring.scoredDimensions).toBe(2); // but both are scored
    expect(scoring.completeness).toBeCloseTo(2 / 8, 12);
  });

  it('returns overall null when every scored dimension carries a zero weight', () => {
    const scoring = computeScoring(scoresOf({ price: 1 }), { price: 0 });
    expect(scoring.overall).toBeNull();
    expect(scoring.scoredDimensions).toBe(1);
  });

  it('computeOverall is the overall alone', () => {
    expect(computeOverall(scoresOf({ price: 0.5, quality: 1 }))).toBeCloseTo(0.75, 12);
    expect(computeOverall(allNull())).toBeNull();
  });
});

describe('effectiveWeights', () => {
  it('defaults every dimension to 1', () => {
    const effective = effectiveWeights(undefined);
    expect(Object.keys(effective)).toHaveLength(8);
    for (const dimension of SCORE_DIMENSIONS) expect(effective[dimension]).toBe(1);
  });

  it('overrides only the provided dimensions', () => {
    const effective = effectiveWeights({ price: 0, quality: 4 });
    expect(effective.price).toBe(0);
    expect(effective.quality).toBe(4);
    expect(effective.reliability).toBe(1);
    expect(effective.alternatives).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scoring.ts — ranking
// ---------------------------------------------------------------------------

describe('rankingCompare / buildRanking', () => {
  it('orders by overall DESC, then name ASC, then id ASC; null overalls last', () => {
    const entries = [
      { overall: 0.5 as number | null, name: 'b', id: '2' },
      { overall: 0.9 as number | null, name: 'z', id: '9' },
      { overall: 0.5 as number | null, name: 'a', id: '3' },
      { overall: null, name: 'first-alphabetically', id: '1' },
      { overall: 0.5 as number | null, name: 'a', id: '1' },
    ];
    const sorted = [...entries].sort(rankingCompare);
    expect(sorted.map((e) => e.name)).toEqual([
      'z', // 0.9
      'a', // 0.5, name a, id 1
      'a', // 0.5, name a, id 3
      'b', // 0.5, name b
      'first-alphabetically', // null overall last
    ]);
  });

  it('builds gapless 1-based ranks in overall-descending order', () => {
    const ranking = buildRanking([
      {
        supplier: { id: 'id-b', tenantId: 't', name: 'Beta', kind: 'supplier', status: 'active' },
        scorecard: { id: 'sc-b', version: 1, assessedAt: '2026-01-01T00:00:00Z' },
        scores: scoresOf({ price: 0.6 }),
      },
      {
        supplier: { id: 'id-a', tenantId: 't', name: 'Alpha', kind: 'supplier', status: 'active' },
        scorecard: { id: 'sc-a', version: 2, assessedAt: '2026-01-02T00:00:00Z' },
        scores: scoresOf({ price: 0.9 }),
      },
      {
        supplier: { id: 'id-c', tenantId: 't', name: 'Gamma', kind: 'supplier', status: 'active' },
        scorecard: { id: 'sc-c', version: 1, assessedAt: '2026-01-03T00:00:00Z' },
        scores: scoresOf({ price: 1 }),
      },
      {
        supplier: { id: 'id-d', tenantId: 't', name: 'Delta', kind: 'supplier', status: 'active' },
        scorecard: { id: 'sc-d', version: 1, assessedAt: '2026-01-04T00:00:00Z' },
        scores: scoresOf({ price: 1 }),
      },
    ]);
    // Gamma and Delta tie at overall 1.0 → name ASC decides: Delta first
    expect(ranking.map((entry) => entry.supplier.name)).toEqual(['Delta', 'Gamma', 'Alpha', 'Beta']);
    expect(ranking.map((entry) => entry.rank)).toEqual([1, 2, 3, 4]);
    expect(ranking[0]!.scoring.overall).toBe(1); // Delta: price 1 alone
    expect(ranking[0]!.scoring.completeness).toBeCloseTo(1 / 8, 12);
    expect(ranking[0]!.scorecard.version).toBe(1);
  });

  it('reorders under read-time weights and skips null-overall entries', () => {
    const records: RankingRecord[] = [
      {
        supplier: { id: 'id-a', tenantId: 't', name: 'Alpha', kind: 'supplier', status: 'active' },
        scorecard: { id: 'sc-a', version: 1, assessedAt: '2026-01-01T00:00:00Z' },
        scores: scoresOf({ price: 1, quality: 0.5 }),
      },
      {
        supplier: { id: 'id-b', tenantId: 't', name: 'Beta', kind: 'supplier', status: 'active' },
        scorecard: { id: 'sc-b', version: 1, assessedAt: '2026-01-01T00:00:00Z' },
        scores: scoresOf({ price: 0, quality: 1 }),
      },
    ];
    // default weights: Alpha (0.75) beats Beta (0.5)
    expect(buildRanking(records).map((e) => e.supplier.name)).toEqual(['Alpha', 'Beta']);
    // price weighted 0: Beta (1.0 on quality) beats Alpha (0.5 on quality)
    expect(buildRanking(records, { price: 0 }).map((e) => e.supplier.name)).toEqual(['Beta', 'Alpha']);
    // every scored dimension zero-weighted: nothing can rank
    expect(buildRanking([records[0]!], { price: 0, quality: 0 })).toEqual([]);
    expect(buildRanking([records[0]!])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// validation.ts — supplier register / revise
// ---------------------------------------------------------------------------

describe('validateRegisterSupplierInput', () => {
  it('normalizes a valid registration', () => {
    const valid = validateRegisterSupplierInput({
      name: '  Acme Logistics  ',
      kind: 'supplier',
      description: 'Freight',
      worldEntityId: SUPPLIER_ID.toUpperCase(),
      actor: ACTOR,
      rationale: 'Onboarding',
    });
    expect(valid.name).toBe('Acme Logistics');
    expect(valid.kind).toBe('supplier');
    expect(valid.description).toBe('Freight');
    expect(valid.worldEntityId).toBe(SUPPLIER_ID);
    expect(valid.actor).toEqual({ kind: 'person', id: 'person-1', label: 'Ops lead' });
  });

  it('rejects malformed registrations with precise codes', async () => {
    await expectCode(
      'invalid_supplier_input',
      () => validateRegisterSupplierInput({ kind: 'supplier', actor: ACTOR } as never),
    );
    await expectCode(
      'invalid_supplier_input',
      () =>
        validateRegisterSupplierInput({
          name: 'Acme',
          kind: 'supplier',
          actor: ACTOR,
          extra: 'no',
        } as never),
    );
    await expectCode(
      'invalid_supplier_input',
      () => validateRegisterSupplierInput({ name: '   ', kind: 'supplier', actor: ACTOR }),
    );
    await expectCode(
      'invalid_supplier_input',
      () => validateRegisterSupplierInput({ name: 'Acme', kind: 'partner' as never, actor: ACTOR }),
    );
    await expectCode(
      'invalid_supplier_input',
      () =>
        validateRegisterSupplierInput({ name: 'Acme', kind: 'supplier', actor: { kind: 'person' } }),
    );
    await expectCode(
      'invalid_supplier_input',
      () =>
        validateRegisterSupplierInput({
          name: 'Acme',
          kind: 'supplier',
          worldEntityId: 'not-a-uuid',
          actor: ACTOR,
        }),
    );
    await expectCode(
      'invalid_supplier_input',
      () =>
        validateRegisterSupplierInput({
          name: 'x'.repeat(201),
          kind: 'supplier',
          actor: ACTOR,
        }),
    );
  });
});

describe('validateReviseSupplierInput', () => {
  it('keeps only explicitly provided patch fields (tri-state)', () => {
    const valid = validateReviseSupplierInput({
      supplierId: SUPPLIER_ID,
      description: null,
      actor: ACTOR,
    });
    expect(valid.patch).toEqual({ description: null });
    expect(valid.patch.status).toBeUndefined();
    expect(valid.patch.worldEntityId).toBeUndefined();
  });

  it('rejects status/uuid/unknown-key/no-op/surgical mistakes', async () => {
    await expectCode(
      'invalid_supplier_input',
      () => validateReviseSupplierInput({ supplierId: 'no', actor: ACTOR }),
    );
    await expectCode(
      'invalid_supplier_input',
      () =>
        validateReviseSupplierInput({
          supplierId: SUPPLIER_ID,
          status: 'deleted' as never,
          actor: ACTOR,
        }),
    );
    // the name and kind are immutable identity content — not acceptable keys
    await expectCode(
      'invalid_supplier_input',
      () =>
        validateReviseSupplierInput({
          supplierId: SUPPLIER_ID,
          name: 'New name',
          actor: ACTOR,
        } as never),
    );
    await expectCode(
      'invalid_supplier_input',
      () =>
        validateReviseSupplierInput({
          supplierId: SUPPLIER_ID,
          kind: 'subcontractor',
          actor: ACTOR,
        } as never),
    );
    // a status change must be the only change (surgical transitions)
    await expectCode(
      'invalid_supplier_input',
      () =>
        validateReviseSupplierInput({
          supplierId: SUPPLIER_ID,
          status: 'retired',
          description: 'retiring and editing at once',
          actor: ACTOR,
        }),
    );
    // a revision that changes nothing is refused
    await expectCode(
      'invalid_supplier_input',
      () => validateReviseSupplierInput({ supplierId: SUPPLIER_ID, actor: ACTOR }),
    );
  });
});

// ---------------------------------------------------------------------------
// validation.ts — scorecard record / revise
// ---------------------------------------------------------------------------

describe('validateRecordScorecardInput', () => {
  it('normalizes a valid first assessment (omitted scores are unscored)', () => {
    const valid = validateRecordScorecardInput({
      supplierId: SUPPLIER_ID,
      scores: { price: 0.7, quality: 1, switchingCost: 0 },
      evidenceObservationIds: [OBS_1, OBS_2, OBS_1], // deduplicated in order
      note: 'First look',
      actor: ACTOR,
    });
    expect(valid.scores).toEqual(scoresOf({ price: 0.7, quality: 1, switchingCost: 0 }));
    expect(valid.evidenceObservationIds).toEqual([OBS_1, OBS_2]);
    expect(valid.note).toBe('First look');
  });

  it('rejects an assessment that scores nothing', async () => {
    await expectCode(
      'invalid_scorecard_input',
      () => validateRecordScorecardInput({ supplierId: SUPPLIER_ID, actor: ACTOR }),
    );
    await expectCode(
      'invalid_scorecard_input',
      () =>
        validateRecordScorecardInput({
          supplierId: SUPPLIER_ID,
          scores: { price: null },
          actor: ACTOR,
        }),
    );
  });

  it('rejects out-of-range scores and unknown dimension keys', async () => {
    await expectCode(
      'invalid_scorecard_input',
      () =>
        validateRecordScorecardInput({
          supplierId: SUPPLIER_ID,
          scores: { price: 1.5 },
          actor: ACTOR,
        }),
    );
    await expectCode(
      'invalid_scorecard_input',
      () =>
        validateRecordScorecardInput({
          supplierId: SUPPLIER_ID,
          scores: { quality: -0.1 },
          actor: ACTOR,
        }),
    );
    await expectCode(
      'invalid_scorecard_input',
      () =>
        validateRecordScorecardInput({
          supplierId: SUPPLIER_ID,
          scores: { price: Number.NaN },
          actor: ACTOR,
        }),
    );
    // snake_case is the DIMENSION name, not the scorecard field
    await expectCode(
      'invalid_scorecard_input',
      () =>
        validateRecordScorecardInput({
          supplierId: SUPPLIER_ID,
          scores: { switching_cost: 0.5 },
          actor: ACTOR,
        } as never),
    );
  });
});

describe('validateReviseScorecardInput', () => {
  it('keeps only explicit score keys and optional evidence/note', () => {
    const valid = validateReviseScorecardInput({
      scorecardId: SCORECARD_ID,
      scores: { price: 0.9, quality: null },
      note: 'Refreshed',
      actor: ACTOR,
    });
    expect(valid.patch).toEqual({ price: 0.9, quality: null });
    expect(valid.evidenceObservationIds).toBeUndefined(); // carry over
    expect(valid.note).toBe('Refreshed');
  });

  it('rejects unknown keys and malformed ids', async () => {
    await expectCode(
      'invalid_scorecard_input',
      () => validateReviseScorecardInput({ scorecardId: 'no', actor: ACTOR }),
    );
    await expectCode(
      'invalid_scorecard_input',
      () =>
        validateReviseScorecardInput({
          scorecardId: SCORECARD_ID,
          scores: { vendor: 0.5 },
          actor: ACTOR,
        } as never),
    );
  });
});

describe('mergeScorePatch / scoredDimensionCount', () => {
  it('merges tri-state: set / clear / carry over', () => {
    const current = scoresOf({ price: 0.5, quality: 0.8, reliability: 0.3 });
    const merged = mergeScorePatch(current, { price: 0.9, quality: null });
    expect(merged).toEqual(scoresOf({ price: 0.9, reliability: 0.3 }));
    expect(scoredDimensionCount(merged)).toBe(2);
    expect(scoredDimensionCount(allNull())).toBe(0);
    expect(scoredDimensionCount(scoresOf({ alternatives: 0 }))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// validation.ts — queries
// ---------------------------------------------------------------------------

describe('query validation', () => {
  it('normalizes list queries with defaults', () => {
    const valid = validateListSuppliersQuery({});
    expect(valid).toEqual({
      name: null,
      search: null,
      kind: null,
      status: null,
      limit: DEFAULT_LIST_LIMIT,
    });
    const filtered = validateListSuppliersQuery({
      name: 'Acme',
      search: 'log',
      kind: 'subcontractor',
      status: 'retired',
      limit: MAX_LIST_LIMIT,
    });
    expect(filtered.kind).toBe('subcontractor');
    expect(filtered.status).toBe('retired');
  });

  it('rejects malformed list queries', async () => {
    await expectCode('invalid_query', () => validateListSuppliersQuery({ limit: 0 } as never));
    await expectCode('invalid_query', () => validateListSuppliersQuery({ limit: 501 } as never));
    await expectCode('invalid_query', () => validateListSuppliersQuery({ kind: 'vendor' } as never));
    await expectCode('invalid_query', () => validateListSuppliersQuery({ nope: 1 } as never));
  });

  it('validates ranking weights and rejects degenerate weight sets', async () => {
    const valid = validateRankSuppliersQuery({
      weights: { price: 2, quality: 0 },
      limit: 10,
    });
    expect(valid.weights).toEqual({ price: 2, quality: 0 });
    expect(valid.limit).toBe(10);
    expect(valid.kind).toBeNull();

    await expectCode(
      'invalid_query',
      () => validateRankSuppliersQuery({ weights: { vendor: 1 } } as never),
    );
    await expectCode(
      'invalid_query',
      () => validateRankSuppliersQuery({ weights: { price: -1 } } as never),
    );
    await expectCode(
      'invalid_query',
      () => validateRankSuppliersQuery({ weights: { price: 'high' } } as never),
    );
    // all-zero weights rank nothing — a caller mistake, not an empty analysis
    await expectCode(
      'invalid_query',
      () =>
        validateRankSuppliersQuery({
          weights: {
            price: 0,
            quality: 0,
            reliability: 0,
            capacity: 0,
            compliance: 0,
            geography: 0,
            switching_cost: 0,
            alternatives: 0,
          },
        }),
    );
    // zero on SOME dimensions is fine (the rest default to 1)
    expect(validateRankSuppliersQuery({ weights: { price: 0 } }).weights).toEqual({ price: 0 });
  });

  it('validates intelligence queries', async () => {
    const valid = validateSupplierIntelligenceQuery({ supplierId: SUPPLIER_ID });
    expect(valid.supplierId).toBe(SUPPLIER_ID);
    expect(valid.weights).toEqual({});
    await expectCode(
      'invalid_query',
      () => validateSupplierIntelligenceQuery({ supplierId: 'no' } as never),
    );
    await expectCode(
      'invalid_query',
      () => validateSupplierIntelligenceQuery({ supplierId: SUPPLIER_ID, extra: true } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// validation.ts — tenant context
// ---------------------------------------------------------------------------

describe('assertSuppliersTenantContext', () => {
  it('rejects broken contexts with invalid_context', () => {
    expect(() =>
      assertSuppliersTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    ).toThrow(SuppliersError);
    expect(() =>
      assertSuppliersTenantContext({ tenantId: 't', principalId: ' ', authority: [] }),
    ).toThrow(SuppliersError);
    expect(() =>
      assertSuppliersTenantContext({ tenantId: 't', principalId: 'p', authority: 'admin' as never }),
    ).toThrow(SuppliersError);
    expect(() =>
      assertSuppliersTenantContext({ tenantId: 't', principalId: 'p', authority: [] }),
    ).not.toThrow();
  });
});
