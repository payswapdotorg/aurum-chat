// Unit tests for the capabilities module's PURE logic — gap.ts (the
// deterministic function from current capability-graph records to gaps and
// available alternatives) and validation.ts (the input/query guards). No
// database.

import { describe, expect, it } from 'vitest';
import {
  alternativesOf,
  computeCapabilityGap,
  computeCapabilityGaps,
  emptySuppliersByKind,
  GAP_STATUS_RANK,
  supplyCompare,
  SUPPLIER_KIND_ORDER,
} from '../gap';
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_REQUIREMENT_LEVEL,
  DEFAULT_SUPPLY_LEVEL,
  isCapabilitySupplierKind,
  isGapStatus,
  isRequirementSourceKind,
  validateAnalyzeGapsQuery,
  validateListCapabilitiesQuery,
  validateListRequirementsQuery,
  validateListSuppliesQuery,
  validateRegisterCapabilityInput,
  validateRegisterRequirementInput,
  validateRegisterSupplyInput,
  validateReviseCapabilityInput,
  validateReviseRequirementInput,
  validateReviseSupplyInput,
} from '../validation';
import { CapabilitiesError } from '../errors';
import type {
  Capability,
  CapabilityRequirement,
  CapabilitySupply,
  GapStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OBS_1 = '00000000-0000-4000-8000-000000000001';
const OBS_2 = '00000000-0000-4000-8000-000000000002';

function capabilityOf(overrides: Partial<Capability> = {}): Capability {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    tenantId: '00000000-0000-4000-8000-0000000000e1',
    name: 'German-language support',
    version: 1,
    description: null,
    worldEntityId: null,
    status: 'active',
    supplySummary: {
      activeCount: 0,
      retiredCount: 0,
      activeByKind: emptySuppliersByKind(),
    },
    requirementSummary: { activeCount: 0, retiredCount: 0 },
    createdAt: '2026-09-14T08:00:00Z',
    updatedAt: '2026-09-14T08:00:00Z',
    lastChange: {
      kind: 'created',
      actor: { kind: 'person', id: 'p1', label: null },
      changedByPrincipal: 'principal-1',
      rationale: null,
      recordedAt: '2026-09-14T08:00:00Z',
    },
    ...overrides,
  };
}

function supplyOf(overrides: Partial<CapabilitySupply> = {}): CapabilitySupply {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    tenantId: '00000000-0000-4000-8000-0000000000e1',
    capabilityId: '00000000-0000-4000-8000-0000000000c1',
    supplier: { kind: 'employee', id: 'employee-1', label: 'Ada' },
    version: 1,
    level: 1,
    capacity: null,
    status: 'active',
    evidenceObservationIds: [],
    note: null,
    createdAt: '2026-09-14T08:00:00Z',
    updatedAt: '2026-09-14T08:00:00Z',
    lastChange: {
      kind: 'asserted',
      actor: { kind: 'person', id: 'p1', label: null },
      changedByPrincipal: 'principal-1',
      rationale: null,
      recordedAt: '2026-09-14T08:00:00Z',
    },
    ...overrides,
  };
}

function requirementOf(overrides: Partial<CapabilityRequirement> = {}): CapabilityRequirement {
  return {
    id: '00000000-0000-4000-8000-0000000000b1',
    tenantId: '00000000-0000-4000-8000-0000000000e1',
    capabilityId: '00000000-0000-4000-8000-0000000000c1',
    source: { kind: 'process', id: 'process-1', label: 'Invoice approval' },
    version: 1,
    level: 0,
    capacity: null,
    status: 'active',
    note: null,
    createdAt: '2026-09-14T08:00:00Z',
    updatedAt: '2026-09-14T08:00:00Z',
    lastChange: {
      kind: 'declared',
      actor: { kind: 'person', id: 'p1', label: null },
      changedByPrincipal: 'principal-1',
      rationale: null,
      recordedAt: '2026-09-14T08:00:00Z',
    },
    ...overrides,
  };
}

const ACTOR = { kind: 'person' as const, id: 'person-1', label: 'Ops lead' };

// ---------------------------------------------------------------------------
// gap.ts — computeCapabilityGap
// ---------------------------------------------------------------------------

describe('computeCapabilityGap', () => {
  it('returns null for a retired capability (out of gap-analysis scope)', () => {
    const gap = computeCapabilityGap(
      capabilityOf({ status: 'retired' }),
      [supplyOf()],
      [requirementOf()],
    );
    expect(gap).toBeNull();
  });

  it('returns null without active requirements (no demand, no gap)', () => {
    expect(computeCapabilityGap(capabilityOf(), [supplyOf()], [])).toBeNull();
    expect(
      computeCapabilityGap(capabilityOf(), [supplyOf()], [requirementOf({ status: 'retired' })]),
    ).toBeNull();
  });

  it('classifies uncovered when active demand has no active supply', () => {
    const retired = supplyOf({ status: 'retired', supplier: { kind: 'agent', id: 'agent-1' } });
    const gap = computeCapabilityGap(capabilityOf(), [retired], [requirementOf()])!;
    expect(gap.status).toBe('uncovered');
    expect(gap.activeSupplyCount).toBe(0);
    expect(gap.bestActiveLevel).toBeNull();
    expect(gap.totalActiveCapacity).toBe(0);
    expect(gap.unmet).toHaveLength(1);
    expect(gap.unmet[0]!.levelShortfall).toBeNull(); // no supply to compare against
    expect(gap.unmet[0]!.capacityShortfall).toBeNull();
    // the retired supply is the available alternative (reactivation candidate)
    expect(gap.alternatives.activeSupplies).toEqual([]);
    expect(gap.alternatives.retiredSupplies).toEqual([retired]);
  });

  it('classifies covered when an active supply satisfies the requirement', () => {
    const gap = computeCapabilityGap(
      capabilityOf(),
      [supplyOf({ level: 0.8 })],
      [requirementOf({ level: 0.8 })],
    )!;
    expect(gap.status).toBe('covered');
    expect(gap.unmet).toEqual([]);
    expect(gap.activeRequirementCount).toBe(1);
    expect(gap.activeSupplyCount).toBe(1);
    expect(gap.bestActiveLevel).toBe(0.8);
  });

  it('detects a level shortfall with the exact required/best values', () => {
    const gap = computeCapabilityGap(
      capabilityOf(),
      [supplyOf({ level: 0.4 }), supplyOf({ level: 0.6 })],
      [requirementOf({ level: 0.9 })],
    )!;
    expect(gap.status).toBe('level_shortfall');
    expect(gap.bestActiveLevel).toBe(0.6);
    expect(gap.unmet).toHaveLength(1);
    expect(gap.unmet[0]!.levelShortfall).toEqual({ required: 0.9, bestAvailable: 0.6 });
    expect(gap.unmet[0]!.capacityShortfall).toBeNull();
  });

  it('detects a capacity shortfall; undeclared capacities contribute 0', () => {
    const gap = computeCapabilityGap(
      capabilityOf(),
      [supplyOf({ capacity: 30 }), supplyOf({ capacity: null })],
      [requirementOf({ capacity: 100 })],
    )!;
    expect(gap.status).toBe('capacity_shortfall');
    expect(gap.totalActiveCapacity).toBe(30);
    expect(gap.activeSuppliesWithKnownCapacity).toBe(1);
    expect(gap.unmet[0]!.capacityShortfall).toEqual({ required: 100, available: 30 });
    expect(gap.unmet[0]!.levelShortfall).toBeNull();
  });

  it('sums declared capacities across active supplies and ignores retired ones', () => {
    const gap = computeCapabilityGap(
      capabilityOf(),
      [
        supplyOf({ id: 's-a', capacity: 40 }),
        supplyOf({ id: 's-b', capacity: 60, supplier: { kind: 'software', label: 'Trados' } }),
        supplyOf({ id: 's-c', capacity: 500, status: 'retired' }),
      ],
      [requirementOf({ capacity: 100 })],
    )!;
    expect(gap.status).toBe('covered');
    expect(gap.totalActiveCapacity).toBe(100);
    expect(gap.activeSuppliesWithKnownCapacity).toBe(2);
  });

  it('reports level shortfall ahead of capacity shortfall without discarding either', () => {
    const gap = computeCapabilityGaps([
      {
        capability: capabilityOf(),
        supplies: [supplyOf({ level: 0.2, capacity: 5 })],
        activeRequirements: [
          requirementOf({ id: 'r-1', level: 0.9 }),
          requirementOf({ id: 'r-2', capacity: 50 }),
        ],
      },
    ])[0]!;
    expect(gap.status).toBe('level_shortfall'); // severity rank
    expect(gap.unmet).toHaveLength(2);
    expect(gap.unmet.map((entry) => entry.requirement.id)).toEqual(['r-1', 'r-2']); // id order
    expect(gap.unmet[0]!.levelShortfall).toEqual({ required: 0.9, bestAvailable: 0.2 });
    expect(gap.unmet[0]!.capacityShortfall).toBeNull();
    expect(gap.unmet[1]!.levelShortfall).toBeNull();
    expect(gap.unmet[1]!.capacityShortfall).toEqual({ required: 50, available: 5 });
  });

  it('treats requirement level 0 (presence suffices) as always reached', () => {
    const gap = computeCapabilityGap(
      capabilityOf(),
      [supplyOf({ level: 0.1 })],
      [requirementOf({ level: 0 })],
    )!;
    expect(gap.status).toBe('covered');
  });

  it('skips retired requirements when counting demand', () => {
    const gap = computeCapabilityGap(
      capabilityOf(),
      [supplyOf({ level: 0.1 })],
      [
        requirementOf({ id: 'r-active', level: 0.9 }),
        requirementOf({ id: 'r-retired', level: 0.9, status: 'retired' }),
      ],
    )!;
    expect(gap.activeRequirementCount).toBe(1);
    expect(gap.unmet.map((entry) => entry.requirement.id)).toEqual(['r-active']);
  });
});

// ---------------------------------------------------------------------------
// gap.ts — alternatives and ordering
// ---------------------------------------------------------------------------

describe('alternativesOf', () => {
  it('groups active supplies by the six supplier kinds and lists retired ones separately', () => {
    const employee = supplyOf({ id: 's-emp', supplier: { kind: 'employee', id: 'e1' } });
    const agent = supplyOf({ id: 's-agt', supplier: { kind: 'agent', id: 'a1' } });
    const software = supplyOf({ id: 's-sft', supplier: { kind: 'software', label: 'Trados' } });
    const partner = supplyOf({
      id: 's-prt',
      supplier: { kind: 'partner', label: 'Acme BV' },
      status: 'retired',
    });
    const alternatives = alternativesOf([employee, agent, software, partner]);
    expect(alternatives.activeByKind).toEqual({
      employee: 1,
      team: 0,
      agent: 1,
      software: 1,
      supplier: 0,
      partner: 0,
    });
    expect(alternatives.activeSupplies).toEqual([agent, employee, software]);
    expect(alternatives.retiredSupplies).toEqual([partner]);
  });

  it('orders supplies by kind, then key, then id (deterministic)', () => {
    const supplies = [
      supplyOf({ id: 's-2', supplier: { kind: 'employee', id: 'b-employee' } }),
      supplyOf({ id: 's-1', supplier: { kind: 'employee', id: 'a-employee' } }),
      supplyOf({ id: 's-4', supplier: { kind: 'agent', id: 'z-agent' } }),
      supplyOf({ id: 's-3', supplier: { kind: 'agent', id: 'a-agent' } }),
    ];
    expect(supplies.sort(supplyCompare).map((supply) => supply.id)).toEqual([
      's-3',
      's-4',
      's-1',
      's-2',
    ]);
  });
});

describe('computeCapabilityGaps', () => {
  it('orders results by capability name then id and skips out-of-scope capabilities', () => {
    const gaps = computeCapabilityGaps([
      {
        capability: capabilityOf({ id: 'c-2', name: 'Zebra ops' }),
        supplies: [],
        activeRequirements: [requirementOf()],
      },
      {
        capability: capabilityOf({ id: 'c-1', name: 'Zebra ops' }),
        supplies: [supplyOf()],
        activeRequirements: [requirementOf()],
      },
      {
        capability: capabilityOf({ id: 'c-3', name: 'No demand' }),
        supplies: [supplyOf()],
        activeRequirements: [],
      },
      {
        capability: capabilityOf({ id: 'c-4', name: 'Retired', status: 'retired' }),
        supplies: [],
        activeRequirements: [requirementOf()],
      },
    ]);
    expect(gaps.map((gap) => gap.capability.id)).toEqual(['c-1', 'c-2']);
    expect(gaps[0]!.status).toBe('covered');
    expect(gaps[1]!.status).toBe('uncovered');
  });

  it('exposes the gap status severity rank and the six-kind order as constants', () => {
    expect(GAP_STATUS_RANK.uncovered).toBeLessThan(GAP_STATUS_RANK.level_shortfall);
    expect(GAP_STATUS_RANK.level_shortfall).toBeLessThan(GAP_STATUS_RANK.capacity_shortfall);
    expect(GAP_STATUS_RANK.capacity_shortfall).toBeLessThan(GAP_STATUS_RANK.covered);
    expect(SUPPLIER_KIND_ORDER).toEqual([
      'agent',
      'employee',
      'partner',
      'software',
      'supplier',
      'team',
    ]);
  });
});

// ---------------------------------------------------------------------------
// validation.ts — capability register / revise
// ---------------------------------------------------------------------------

describe('validateRegisterCapabilityInput', () => {
  it('normalizes a full registration and applies the documented defaults', () => {
    const valid = validateRegisterCapabilityInput({
      name: '  German-language support  ',
      description: '  Customer support in German  ',
      worldEntityId: '00000000-0000-4000-8000-0000000000D1'.toLowerCase(),
      actor: ACTOR,
      rationale: ' onboarding  ',
    });
    expect(valid).toEqual({
      name: 'German-language support',
      description: 'Customer support in German',
      worldEntityId: '00000000-0000-4000-8000-0000000000d1',
      actor: { kind: 'person', id: 'person-1', label: 'Ops lead' },
      rationale: 'onboarding',
    });
  });

  it('treats omitted optional fields as null', () => {
    const valid = validateRegisterCapabilityInput({ name: 'Invoice processing', actor: ACTOR });
    expect(valid.description).toBeNull();
    expect(valid.worldEntityId).toBeNull();
    expect(valid.rationale).toBeNull();
  });

  it('rejects unknown keys, missing actor, bad uuid and over-long names', () => {
    const cases: [string, unknown][] = [
      ['unknown key', { name: 'X', actor: ACTOR, tenantId: 'nope' }],
      ['missing actor', { name: 'X' }],
      ['bad worldEntityId', { name: 'X', actor: ACTOR, worldEntityId: 'not-a-uuid' }],
      ['empty name', { name: '   ', actor: ACTOR }],
      ['over-long name', { name: 'x'.repeat(201), actor: ACTOR }],
      ['actor without id/label', { name: 'X', actor: { kind: 'person' } }],
      ['bad actor kind', { name: 'X', actor: { kind: 'wizard', label: 'Gandalf' } }],
    ];
    for (const [label, input] of cases) {
      try {
        validateRegisterCapabilityInput(input as never);
        expect.unreachable(`should have rejected: ${label}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilitiesError);
        expect((error as CapabilitiesError).code).toBe('invalid_capability_input');
      }
    }
  });
});

describe('validateReviseCapabilityInput', () => {
  it('validates a tri-state patch (undefined carry-over, null clear, value set)', () => {
    const valid = validateReviseCapabilityInput({
      capabilityId: '00000000-0000-4000-8000-0000000000c1',
      description: null,
      worldEntityId: '00000000-0000-4000-8000-0000000000d2',
      actor: ACTOR,
    });
    expect(valid.patch).toEqual({
      description: null,
      worldEntityId: '00000000-0000-4000-8000-0000000000d2',
    });
  });

  it('requires at least one change and surgical status transitions', () => {
    const id = '00000000-0000-4000-8000-0000000000c1';
    const cases: [string, unknown, string][] = [
      ['no change', { capabilityId: id, actor: ACTOR }, 'invalid_capability_input'],
      [
        'status mixed with content',
        { capabilityId: id, status: 'retired', description: 'x', actor: ACTOR },
        'invalid_capability_input',
      ],
      ['bad status', { capabilityId: id, status: 'paused', actor: ACTOR }, 'invalid_capability_input'],
      ['bad id', { capabilityId: 'nope', description: 'x', actor: ACTOR }, 'invalid_capability_input'],
    ];
    for (const [label, input, code] of cases) {
      try {
        validateReviseCapabilityInput(input as never);
        expect.unreachable(`should have rejected: ${label}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilitiesError);
        expect((error as CapabilitiesError).code).toBe(code);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// validation.ts — supply register / revise
// ---------------------------------------------------------------------------

describe('validateRegisterSupplyInput', () => {
  it('defaults level to 1 (full strength) and capacity to undeclared', () => {
    const valid = validateRegisterSupplyInput({
      capabilityId: '00000000-0000-4000-8000-0000000000c1',
      supplier: { kind: 'employee', label: 'Ada' },
      actor: ACTOR,
    });
    expect(valid.level).toBe(DEFAULT_SUPPLY_LEVEL);
    expect(valid.capacity).toBeNull();
    expect(valid.evidenceObservationIds).toEqual([]);
  });

  it('accepts all six supplier kinds and deduplicates evidence ids in order', () => {
    for (const kind of ['employee', 'team', 'agent', 'software', 'supplier', 'partner'] as const) {
      const valid = validateRegisterSupplyInput({
        capabilityId: '00000000-0000-4000-8000-0000000000c1',
        supplier: { kind, label: `A ${kind}` },
        actor: ACTOR,
      });
      expect(valid.supplier.kind).toBe(kind);
    }
    const valid = validateRegisterSupplyInput({
      capabilityId: '00000000-0000-4000-8000-0000000000c1',
      supplier: { kind: 'partner', label: 'Acme' },
      evidenceObservationIds: [OBS_1, OBS_2, OBS_1],
      actor: ACTOR,
    });
    expect(valid.evidenceObservationIds).toEqual([OBS_1, OBS_2]);
  });

  it('rejects out-of-range levels, bad capacities, bad kinds and unknown keys', () => {
    const capabilityId = '00000000-0000-4000-8000-0000000000c1';
    const cases: [string, unknown][] = [
      ['level > 1', { capabilityId, supplier: { kind: 'employee', label: 'A' }, level: 1.2, actor: ACTOR }],
      ['level < 0', { capabilityId, supplier: { kind: 'employee', label: 'A' }, level: -0.1, actor: ACTOR }],
      ['non-finite level', { capabilityId, supplier: { kind: 'employee', label: 'A' }, level: Number.NaN, actor: ACTOR }],
      ['negative capacity', { capabilityId, supplier: { kind: 'employee', label: 'A' }, capacity: -1, actor: ACTOR }],
      ['oversized capacity', { capabilityId, supplier: { kind: 'employee', label: 'A' }, capacity: 2e9, actor: ACTOR }],
      ['supplier kind not in six', { capabilityId, supplier: { kind: 'manager', label: 'A' }, actor: ACTOR }],
      ['supplier without id/label', { capabilityId, supplier: { kind: 'employee' }, actor: ACTOR }],
      ['bad capability uuid', { capabilityId: 'nope', supplier: { kind: 'employee', label: 'A' }, actor: ACTOR }],
      ['bad evidence id', { capabilityId, supplier: { kind: 'employee', label: 'A' }, evidenceObservationIds: ['x'], actor: ACTOR }],
      ['unknown key', { capabilityId, supplier: { kind: 'employee', label: 'A' }, actor: ACTOR, levelAgain: 1 }],
    ];
    for (const [label, input] of cases) {
      try {
        validateRegisterSupplyInput(input as never);
        expect.unreachable(`should have rejected: ${label}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilitiesError);
        expect((error as CapabilitiesError).code).toBe('invalid_supply_input');
      }
    }
  });
});

describe('validateReviseSupplyInput', () => {
  it('validates a patch, keeps evidence wholesale-replace semantics, requires change', () => {
    const supplyId = '00000000-0000-4000-8000-0000000000a1';
    const valid = validateReviseSupplyInput({
      supplyId,
      level: 0.7,
      capacity: null,
      evidenceObservationIds: [OBS_2],
      actor: ACTOR,
    });
    expect(valid.patch).toEqual({
      level: 0.7,
      capacity: null,
      evidenceObservationIds: [OBS_2],
    });

    const cases: [string, unknown, string][] = [
      ['no change', { supplyId, actor: ACTOR }, 'invalid_supply_input'],
      [
        'status mixed with content',
        { supplyId, status: 'retired', level: 0.5, actor: ACTOR },
        'invalid_supply_input',
      ],
      [
        'supplier immutable — unknown key',
        { supplyId, supplier: { kind: 'agent', label: 'X' }, actor: ACTOR },
        'invalid_supply_input',
      ],
      ['bad id', { supplyId: 'nope', level: 0.5, actor: ACTOR }, 'invalid_supply_input'],
    ];
    for (const [label, input, code] of cases) {
      try {
        validateReviseSupplyInput(input as never);
        expect.unreachable(`should have rejected: ${label}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilitiesError);
        expect((error as CapabilitiesError).code).toBe(code);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// validation.ts — requirement register / revise
// ---------------------------------------------------------------------------

describe('validateRegisterRequirementInput', () => {
  it('defaults level to 0 (presence suffices) and validates the five source kinds', () => {
    const valid = validateRegisterRequirementInput({
      capabilityId: '00000000-0000-4000-8000-0000000000c1',
      source: { kind: 'manual', label: 'Ops wish' },
      actor: ACTOR,
    });
    expect(valid.level).toBe(DEFAULT_REQUIREMENT_LEVEL);
    expect(valid.capacity).toBeNull();

    for (const kind of ['goal', 'process', 'project', 'opportunity', 'manual'] as const) {
      expect(
        validateRegisterRequirementInput({
          capabilityId: '00000000-0000-4000-8000-0000000000c1',
          source: { kind, id: `id-${kind}` },
          actor: ACTOR,
        }).source.kind,
      ).toBe(kind);
    }

    try {
      validateRegisterRequirementInput({
        capabilityId: '00000000-0000-4000-8000-0000000000c1',
        source: { kind: 'wish' as never, label: 'X' },
        actor: ACTOR,
      });
      expect.unreachable('should have rejected the bad source kind');
    } catch (error) {
      expect((error as CapabilitiesError).code).toBe('invalid_requirement_input');
    }
  });
});

describe('validateReviseRequirementInput', () => {
  it('validates a patch and enforces the surgical rules', () => {
    const requirementId = '00000000-0000-4000-8000-0000000000b1';
    expect(
      validateReviseRequirementInput({ requirementId, level: 0.5, actor: ACTOR }).patch,
    ).toEqual({ level: 0.5 });

    const cases: [string, unknown, string][] = [
      ['no change', { requirementId, actor: ACTOR }, 'invalid_requirement_input'],
      [
        'status mixed with content',
        { requirementId, status: 'retired', note: 'x', actor: ACTOR },
        'invalid_requirement_input',
      ],
      [
        'source immutable — unknown key',
        { requirementId, source: { kind: 'goal', label: 'X' }, actor: ACTOR },
        'invalid_requirement_input',
      ],
    ];
    for (const [label, input, code] of cases) {
      try {
        validateReviseRequirementInput(input as never);
        expect.unreachable(`should have rejected: ${label}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilitiesError);
        expect((error as CapabilitiesError).code).toBe(code);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// validation.ts — queries
// ---------------------------------------------------------------------------

describe('query validation', () => {
  it('applies the list defaults and rejects bad shapes', () => {
    expect(validateListCapabilitiesQuery({})).toEqual({
      name: null,
      search: null,
      status: null,
      limit: DEFAULT_LIST_LIMIT,
    });
    expect(
      validateListSuppliesQuery({ supplierKind: 'software', status: 'active', limit: 10 }),
    ).toEqual({
      capabilityId: null,
      supplierKind: 'software',
      supplierId: null,
      status: 'active',
      limit: 10,
    });
    expect(
      validateListRequirementsQuery({ sourceKind: 'goal', sourceId: 'goal-1' }),
    ).toEqual({
      capabilityId: null,
      sourceKind: 'goal',
      sourceId: 'goal-1',
      status: null,
      limit: DEFAULT_LIST_LIMIT,
    });

    const bad: [string, () => unknown][] = [
      ['limit 0', () => validateListCapabilitiesQuery({ limit: 0 })],
      ['limit 501', () => validateListCapabilitiesQuery({ limit: 501 })],
      ['bad status', () => validateListCapabilitiesQuery({ status: 'paused' as never })],
      ['unknown key', () => validateListCapabilitiesQuery({ nope: 1 } as never)],
      ['bad supplierKind', () => validateListSuppliesQuery({ supplierKind: 'manager' as never })],
      ['bad sourceKind', () => validateListRequirementsQuery({ sourceKind: 'wish' as never })],
      ['bad uuid capabilityId', () => validateListSuppliesQuery({ capabilityId: 'nope' })],
      ['bad gap status', () => validateAnalyzeGapsQuery({ status: 'meh' as never })],
      ['bad gap capabilityId', () => validateAnalyzeGapsQuery({ capabilityId: 'nope' })],
    ];
    for (const [label, fn] of bad) {
      try {
        fn();
        expect.unreachable(`should have rejected: ${label}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilitiesError);
        expect((error as CapabilitiesError).code).toBe('invalid_query');
      }
    }
  });

  it('accepts every gap status through the query guard', () => {
    const statuses: GapStatus[] = ['uncovered', 'level_shortfall', 'capacity_shortfall', 'covered'];
    for (const status of statuses) {
      expect(isGapStatus(status)).toBe(true);
      expect(validateAnalyzeGapsQuery({ status, limit: 5 })).toMatchObject({ status, limit: 5 });
    }
    expect(isCapabilitySupplierKind('employee')).toBe(true);
    expect(isCapabilitySupplierKind('manager')).toBe(false);
    expect(isRequirementSourceKind('opportunity')).toBe(true);
    expect(isRequirementSourceKind('dream')).toBe(false);
  });
});
