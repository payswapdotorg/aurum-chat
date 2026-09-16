// Integration tests for the capabilities module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W017
// acceptance: "Model capabilities supplied by employees, teams, agents,
// software, suppliers and partners; identify gaps and available
// alternatives."
//
//  * THE GRAPH IS MODELED: capabilities (tenant-unique immutable names),
//    supplies by ALL SIX supplier kinds (employee, team, agent, software,
//    supplier, partner) with level/capacity/evidence/note, and requirements
//    from the five source kinds (goal, process, project, opportunity,
//    manual) — each an identity plus an append-only version chain, with
//    system-minted identity/tenancy/version/change-kind/commit-time/
//    principal audit fields.
//  * VERSIONED/AUDITABLE: revisions append (carry-over merge, tri-state
//    clears), lifecycle transitions are surgical, retired records accept
//    nothing but reactivation, histories are deep-linkable, and the storage
//    layer rejects UPDATE/DELETE/TRUNCATE on version tables and DELETE/
//    TRUNCATE on identity tables outright (triggers) — while the identity's
//    version POINTER may still advance (that is its only job).
//  * GAPS AND ALTERNATIVES: analyzeGaps classifies the four statuses
//    (covered / level_shortfall / capacity_shortfall / uncovered) with
//    exact shortfall values, available alternatives (active supplies
//    grouped by kind + retired supplies as reactivation candidates), and
//    the documented scope rules (active capabilities, active demand,
//    retired supplies as alternatives), with status/capability/limit
//    filters.
//  * CONFLICTS: duplicate names, duplicate (capability, supplier) pairs
//    and duplicate (capability, source) pairs fail with the documented
//    conflict codes; a supply cannot be asserted against a retired
//    capability.
//  * TENANT ISOLATION (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks): foreign-tenant capabilities,
//    supplies, requirements and their versions read as missing; foreign
//    capability ids on supply/requirement registration read as missing;
//    listings and gap analysis never leak across tenants.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { CapabilitiesError } from '../errors';
import * as capabilitiesContract from '../contract';
import type {
  Capability,
  CapabilityGap,
  CapabilitySupply,
  CapabilityRequirement,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  analyzeGaps,
  getCapability,
  getCapabilityVersion,
  getRequirement,
  getRequirementVersion,
  getSupply,
  getSupplyVersion,
  listCapabilities,
  listCapabilityVersions,
  listRequirements,
  listRequirementVersions,
  listSupplies,
  listSupplyVersions,
  registerCapability,
  registerRequirement,
  registerSupply,
  reviseCapability,
  reviseRequirement,
  reviseSupply,
} = capabilitiesContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantMain = newId(); // the full scenario (graph + gaps + alternatives)
const tenantIso = newId(); // the other tenant (isolation checks)
const tenantVersioned = newId(); // versioning / audit / conflicts / triggers

const PERSON_OPS = { kind: 'person' as const, id: newId(), label: 'Ops lead' };
// Fixed uuids so within-kind key ordering is deterministic (Ada < Bob < Cara).
const EMPLOYEE_ADA = '00000000-0000-4000-8000-0000000000a1';
const EMPLOYEE_BOB = '00000000-0000-4000-8000-0000000000a2';
const EMPLOYEE_CARA = '00000000-0000-4000-8000-0000000000a3';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilitiesError);
    expect((error as CapabilitiesError).code).toBe(code);
  }
}

/** Raw SQL rejection assertion (the storage triggers). */
async function expectSqlRejection(sql: string): Promise<void> {
  await expect(getDb().query(sql)).rejects.toThrow();
}

// ---------------------------------------------------------------------------
// The main scenario: a multilingual support + engineering org
// ---------------------------------------------------------------------------

describe('capability graph — the main scenario', () => {
  const ctx = member(tenantMain);

  let german: Capability;
  let invoice: Capability;
  let ukrainian: Capability;
  let rust: Capability;
  let coffee: Capability;
  let legacy: Capability;
  let gaps: CapabilityGap[];

  beforeAll(async () => {
    // --- capabilities ---
    german = await registerCapability(ctx, {
      name: 'German-language support',
      description: 'Customer-facing support in German',
      actor: PERSON_OPS,
      rationale: 'Onboarding the DACH desk',
    });
    invoice = await registerCapability(ctx, {
      name: 'Invoice processing',
      actor: PERSON_OPS,
    });
    ukrainian = await registerCapability(ctx, {
      name: 'Ukrainian-language support',
      actor: PERSON_OPS,
    });
    rust = await registerCapability(ctx, {
      name: 'Rust development',
      actor: PERSON_OPS,
    });
    coffee = await registerCapability(ctx, { name: 'Coffee brewing', actor: PERSON_OPS });
    legacy = await registerCapability(ctx, { name: 'Legacy COBOL maintenance', actor: PERSON_OPS });
    // active requirement on a capability that is THEN retired (out of scope)
    await registerRequirement(ctx, {
      capabilityId: legacy.id,
      source: { kind: 'manual', label: 'Audit retention' },
      actor: PERSON_OPS,
    });
    // retire the legacy capability (demand on it goes out of scope with it)
    legacy = await reviseCapability(ctx, {
      capabilityId: legacy.id,
      status: 'retired',
      actor: PERSON_OPS,
      rationale: 'The mainframe is gone',
    });

    // --- supplies (the six kinds; German: employee + software active,
    //     one retired employee as a reactivation candidate) ---
    await registerSupply(ctx, {
      capabilityId: german.id,
      supplier: { kind: 'employee', id: EMPLOYEE_ADA, label: 'Ada' },
      level: 0.9,
      capacity: 40,
      evidenceObservationIds: [newId(), newId()],
      note: 'C2 certified',
      actor: PERSON_OPS,
    });
    await registerSupply(ctx, {
      capabilityId: german.id,
      supplier: { kind: 'software', label: 'Trados' },
      level: 0.7,
      actor: PERSON_OPS,
    });
    const germanBob = await registerSupply(ctx, {
      capabilityId: german.id,
      supplier: { kind: 'employee', id: EMPLOYEE_BOB, label: 'Bob' },
      level: 0.8,
      actor: PERSON_OPS,
    });
    await reviseSupply(ctx, {
      supplyId: germanBob.id,
      status: 'retired',
      actor: PERSON_OPS,
      rationale: 'Bob moved to the Nordics desk',
    });

    await registerSupply(ctx, {
      capabilityId: invoice.id,
      supplier: { kind: 'employee', id: EMPLOYEE_BOB, label: 'Bob' },
      level: 0.8,
      capacity: 60,
      actor: PERSON_OPS,
    });
    await registerSupply(ctx, {
      capabilityId: invoice.id,
      supplier: { kind: 'agent', label: 'ocr-bot' },
      level: 1,
      capacity: 400,
      actor: PERSON_OPS,
    });

    const kyiv = await registerSupply(ctx, {
      capabilityId: ukrainian.id,
      supplier: { kind: 'partner', label: 'KyivTranslations' },
      level: 0.9,
      actor: PERSON_OPS,
    });
    await reviseSupply(ctx, {
      supplyId: kyiv.id,
      status: 'retired',
      actor: PERSON_OPS,
      rationale: 'Contract ended',
    });

    await registerSupply(ctx, {
      capabilityId: rust.id,
      supplier: { kind: 'employee', id: EMPLOYEE_CARA, label: 'Cara' },
      level: 0.3,
      actor: PERSON_OPS,
    });
    await registerSupply(ctx, {
      capabilityId: coffee.id,
      supplier: { kind: 'team', label: 'Office crew' },
      actor: PERSON_OPS,
    });
    await registerSupply(ctx, {
      capabilityId: coffee.id,
      supplier: { kind: 'supplier', label: 'BeanThere' },
      actor: PERSON_OPS,
    });

    // --- requirements ---
    await registerRequirement(ctx, {
      capabilityId: german.id,
      source: { kind: 'process', id: newId(), label: 'Invoice approval' },
      level: 0.6,
      actor: PERSON_OPS,
    });
    await registerRequirement(ctx, {
      capabilityId: german.id,
      source: { kind: 'manual', label: 'Ops wish' },
      capacity: 60,
      actor: PERSON_OPS,
    });
    await registerRequirement(ctx, {
      capabilityId: invoice.id,
      source: { kind: 'process', label: 'Invoice approval' },
      level: 0.5,
      capacity: 100,
      actor: PERSON_OPS,
    });
    await registerRequirement(ctx, {
      capabilityId: ukrainian.id,
      source: { kind: 'goal', id: newId(), label: 'Expand to Ukraine' },
      level: 0.8,
      actor: PERSON_OPS,
    });
    await registerRequirement(ctx, {
      capabilityId: rust.id,
      source: { kind: 'project', label: 'Payments rewrite' },
      level: 0.9,
      actor: PERSON_OPS,
    });
    await registerRequirement(ctx, {
      capabilityId: invoice.id,
      source: { kind: 'opportunity', label: 'Café popup' },
      actor: PERSON_OPS,
    });
    // (coffee carries supplies only — no demand, therefore no gap)
    // retired requirement on rust (excluded from demand)
    const rustOld = await registerRequirement(ctx, {
      capabilityId: rust.id,
      source: { kind: 'manual', label: 'Old wish' },
      level: 0.99,
      actor: PERSON_OPS,
    });
    await reviseRequirement(ctx, {
      requirementId: rustOld.id,
      status: 'retired',
      actor: PERSON_OPS,
    });

    gaps = await analyzeGaps(ctx, {});
  });

  // -- the records --

  it('registers capabilities with system-minted audit fields', () => {
    expect(german.tenantId).toBe(tenantMain);
    expect(german.version).toBe(1);
    expect(german.status).toBe('active');
    expect(german.description).toBe('Customer-facing support in German');
    expect(german.lastChange.kind).toBe('created');
    expect(german.lastChange.actor).toEqual(PERSON_OPS);
    expect(german.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(german.lastChange.rationale).toBe('Onboarding the DACH desk');
    expect(german.createdAt).toBe(german.updatedAt);
    expect(invoice.description).toBeNull();
    expect(invoice.worldEntityId).toBeNull();
  });

  it('asserts supplies with defaults and evidence round-trip', async () => {
    const supplies = await listSupplies(ctx, { capabilityId: german.id, limit: 500 });
    expect(supplies).toHaveLength(3);

    const ada = supplies.find((supply) => supply.supplier.id === EMPLOYEE_ADA)!;
    expect(ada.supplier).toEqual({ kind: 'employee', id: EMPLOYEE_ADA, label: 'Ada' });
    expect(ada.level).toBe(0.9);
    expect(ada.capacity).toBe(40);
    expect(ada.evidenceObservationIds).toHaveLength(2);
    expect(ada.note).toBe('C2 certified');
    expect(ada.status).toBe('active');
    expect(ada.version).toBe(1);
    expect(ada.lastChange.kind).toBe('asserted');

    const trados = supplies.find((supply) => supply.supplier.label === 'Trados')!;
    expect(trados.level).toBe(0.7);
    expect(trados.capacity).toBeNull(); // default: undeclared
    expect(trados.evidenceObservationIds).toEqual([]);

    // canonical order: capability, then supplier kind (alphabetical:
    // agent < employee < partner < software < supplier < team), then key
    expect(supplies.map((supply) => supply.supplier.label)).toEqual(['Ada', 'Bob', 'Trados']);
  });

  it('declares requirements with the default level 0 (presence suffices)', async () => {
    const requirements = await listRequirements(ctx, { capabilityId: german.id });
    expect(requirements).toHaveLength(2);
    const manual = requirements.find((requirement) => requirement.source.kind === 'manual')!;
    expect(manual.level).toBe(0);
    expect(manual.capacity).toBe(60);
    expect(manual.lastChange.kind).toBe('declared');
    const process = requirements.find((requirement) => requirement.source.kind === 'process')!;
    expect(process.level).toBe(0.6);
  });

  it('summarizes supplies and requirements on the capability view', async () => {
    const view = await getCapability(ctx, german.id);
    expect(view.supplySummary).toEqual({
      activeCount: 2,
      retiredCount: 1,
      activeByKind: { employee: 1, team: 0, agent: 0, software: 1, supplier: 0, partner: 0 },
    });
    expect(view.requirementSummary).toEqual({ activeCount: 2, retiredCount: 0 });
    expect(view.version).toBe(1);
  });

  // -- the gap analysis --

  it('analyzes exactly the active, demand-bearing capabilities', () => {
    expect(gaps.map((gap) => gap.capability.name)).toEqual([
      'German-language support',
      'Invoice processing',
      'Rust development',
      'Ukrainian-language support',
    ]);
  });

  it('classifies a capacity shortfall with the exact values', () => {
    const gap = gaps.find((gap) => gap.capability.name === 'German-language support')!;
    expect(gap.status).toBe('capacity_shortfall');
    expect(gap.bestActiveLevel).toBe(0.9);
    expect(gap.totalActiveCapacity).toBe(40);
    expect(gap.activeSuppliesWithKnownCapacity).toBe(1);
    expect(gap.activeSupplyCount).toBe(2);
    expect(gap.activeRequirementCount).toBe(2);
    expect(gap.unmet).toHaveLength(1);
    expect(gap.unmet[0]!.requirement.source.kind).toBe('manual');
    expect(gap.unmet[0]!.levelShortfall).toBeNull();
    expect(gap.unmet[0]!.capacityShortfall).toEqual({ required: 60, available: 40 });
    // available alternatives: the two active supplies (each an alternative
    // to the other), grouped by kind; Bob is the retired reactivation candidate
    expect(gap.alternatives.activeByKind).toEqual({
      employee: 1,
      team: 0,
      agent: 0,
      software: 1,
      supplier: 0,
      partner: 0,
    });
    expect(gap.alternatives.activeSupplies.map((supply) => supply.supplier.label)).toEqual([
      'Ada',
      'Trados',
    ]);
    expect(gap.alternatives.retiredSupplies.map((supply) => supply.supplier.label)).toEqual([
      'Bob',
    ]);
  });

  it('classifies covered when both dimensions satisfy every requirement', () => {
    const gap = gaps.find((gap) => gap.capability.name === 'Invoice processing')!;
    expect(gap.status).toBe('covered');
    expect(gap.unmet).toEqual([]);
    expect(gap.activeRequirementCount).toBe(2); // process + opportunity
    expect(gap.bestActiveLevel).toBe(1);
    expect(gap.totalActiveCapacity).toBe(460);
    expect(gap.activeSupplyCount).toBe(2);
  });

  it('classifies a level shortfall and ignores retired requirements', () => {
    const gap = gaps.find((gap) => gap.capability.name === 'Rust development')!;
    expect(gap.status).toBe('level_shortfall');
    expect(gap.activeRequirementCount).toBe(1); // the retired 'Old wish' is excluded
    expect(gap.unmet).toHaveLength(1);
    expect(gap.unmet[0]!.levelShortfall).toEqual({ required: 0.9, bestAvailable: 0.3 });
  });

  it('classifies uncovered with the retired supply as the available alternative', () => {
    const gap = gaps.find((gap) => gap.capability.name === 'Ukrainian-language support')!;
    expect(gap.status).toBe('uncovered');
    expect(gap.activeSupplyCount).toBe(0);
    expect(gap.bestActiveLevel).toBeNull();
    expect(gap.totalActiveCapacity).toBe(0);
    expect(gap.unmet).toHaveLength(1);
    expect(gap.unmet[0]!.levelShortfall).toBeNull(); // nothing to compare against
    expect(gap.unmet[0]!.capacityShortfall).toBeNull();
    expect(gap.alternatives.activeSupplies).toEqual([]);
    expect(gap.alternatives.retiredSupplies.map((supply) => supply.supplier.label)).toEqual([
      'KyivTranslations',
    ]);
  });

  it('supports the status / capability / limit filters', async () => {
    expect((await analyzeGaps(ctx, { status: 'uncovered' })).map((gap) => gap.capability.name)).toEqual([
      'Ukrainian-language support',
    ]);
    expect((await analyzeGaps(ctx, { status: 'covered' })).map((gap) => gap.capability.name)).toEqual([
      'Invoice processing',
    ]);
    const one = await analyzeGaps(ctx, { capabilityId: ukrainian.id });
    expect(one).toHaveLength(1);
    expect(one[0]!.status).toBe('uncovered');

    // no active demand → not in the analysis
    expect(await analyzeGaps(ctx, { capabilityId: coffee.id })).toEqual([]);
    // retired capability → out of scope entirely
    expect(await analyzeGaps(ctx, { capabilityId: legacy.id })).toEqual([]);

    expect((await analyzeGaps(ctx, { limit: 2 })).map((gap) => gap.capability.name)).toEqual([
      'German-language support',
      'Invoice processing',
    ]);
  });

  // -- the listings --

  it('lists capabilities with name/search/status filters', async () => {
    const all = await listCapabilities(ctx, {});
    expect(all.map((capability) => capability.name)).toEqual([
      'Coffee brewing',
      'German-language support',
      'Invoice processing',
      'Legacy COBOL maintenance',
      'Rust development',
      'Ukrainian-language support',
    ]);
    expect((await listCapabilities(ctx, { name: 'Rust development' })).map((c) => c.name)).toEqual([
      'Rust development',
    ]);
    expect((await listCapabilities(ctx, { search: 'language' })).map((c) => c.name)).toEqual([
      'German-language support',
      'Ukrainian-language support',
    ]);
    const retired = await listCapabilities(ctx, { status: 'retired' });
    expect(retired.map((c) => c.name)).toEqual(['Legacy COBOL maintenance']);
    expect(retired[0]!.lastChange.kind).toBe('retired');
    expect(retired[0]!.lastChange.rationale).toBe('The mainframe is gone');
  });

  it('lists supplies by supplier kind, supplier id and status', async () => {
    const employees = await listSupplies(ctx, { supplierKind: 'employee', status: 'active' });
    expect(employees.map((supply) => supply.supplier.label).sort()).toEqual(['Ada', 'Bob', 'Cara']);
    const bySupplier = await listSupplies(ctx, { supplierId: EMPLOYEE_BOB });
    expect(bySupplier).toHaveLength(2);
    expect(bySupplier.map((supply) => supply.capabilityId).sort()).toEqual(
      [german.id, invoice.id].sort(),
    );
    const retiredSupplies = await listSupplies(ctx, { status: 'retired' });
    expect(retiredSupplies.map((supply) => supply.supplier.label).sort()).toEqual(
      ['Bob', 'KyivTranslations'].sort(),
    );
    const teams = await listSupplies(ctx, { supplierKind: 'team' });
    expect(teams.map((supply) => supply.supplier.label)).toEqual(['Office crew']);
    expect(teams[0]!.level).toBe(1); // default: full strength
    const suppliers = await listSupplies(ctx, { supplierKind: 'supplier' });
    expect(suppliers.map((supply) => supply.supplier.label)).toEqual(['BeanThere']);
    expect(suppliers[0]!.level).toBe(1); // default: full strength
  });

  it('lists requirements by source kind, source id and status', async () => {
    expect((await listRequirements(ctx, { sourceKind: 'process' })).map((r) => r.capabilityId).sort()).toEqual(
      [german.id, invoice.id].sort(),
    );
    expect((await listRequirements(ctx, { sourceKind: 'goal' })).map((r) => r.capabilityId)).toEqual([
      ukrainian.id,
    ]);
    expect((await listRequirements(ctx, { sourceKind: 'opportunity' })).map((r) => r.capabilityId)).toEqual([
      invoice.id,
    ]);
    const retired = await listRequirements(ctx, { status: 'retired' });
    expect(retired.map((r) => r.source.label)).toEqual(['Old wish']);
  });
});

// ---------------------------------------------------------------------------
// Versioning, revisions, conflicts and the storage triggers
// ---------------------------------------------------------------------------

describe('versioning, revisions and conflicts', () => {
  const ctx = member(tenantVersioned);

  let capability: Capability;
  let supply: CapabilitySupply;
  let requirement: CapabilityRequirement;

  beforeAll(async () => {
    capability = await registerCapability(ctx, {
      name: 'Technical writing',
      description: 'Docs people actually read',
      worldEntityId: newId(),
      actor: PERSON_OPS,
      rationale: 'Docs initiative',
    });
    supply = await registerSupply(ctx, {
      capabilityId: capability.id,
      supplier: { kind: 'employee', label: 'Dana' },
      level: 0.5,
      capacity: 10,
      evidenceObservationIds: [newId()],
      note: 'Junior',
      actor: PERSON_OPS,
    });
    requirement = await registerRequirement(ctx, {
      capabilityId: capability.id,
      source: { kind: 'goal', label: 'Docs excellence' },
      level: 0.7,
      note: 'Needs a senior',
      actor: PERSON_OPS,
    });
  });

  it('rejects duplicate capability names with capability_name_conflict', async () => {
    await expectCode(
      'capability_name_conflict',
      () => registerCapability(ctx, { name: 'Technical writing', actor: PERSON_OPS }),
    );
  });

  it('rejects duplicate (capability, supplier) pairs with supply_conflict', async () => {
    await expectCode(
      'supply_conflict',
      () =>
        registerSupply(ctx, {
          capabilityId: capability.id,
          supplier: { kind: 'employee', label: 'Dana' }, // same kind + key
          actor: PERSON_OPS,
        }),
    );
    // a different supplier kind is a different supply channel — no conflict
    await registerSupply(ctx, {
      capabilityId: capability.id,
      supplier: { kind: 'software', label: 'Dana' },
      actor: PERSON_OPS,
    });
  });

  it('rejects duplicate (capability, source) pairs with requirement_conflict', async () => {
    await expectCode(
      'requirement_conflict',
      () =>
        registerRequirement(ctx, {
          capabilityId: capability.id,
          source: { kind: 'goal', label: 'Docs excellence' },
          actor: PERSON_OPS,
        }),
    );
  });

  it('revises capabilities with carry-over merge and tri-state clears', async () => {
    const worldEntityId = newId();
    const revised = await reviseCapability(ctx, {
      capabilityId: capability.id,
      description: 'Docs people quote',
      actor: PERSON_OPS,
      rationale: 'Sharper wording',
    });
    expect(revised.version).toBe(2);
    expect(revised.description).toBe('Docs people quote');
    expect(revised.worldEntityId).toBe(capability.worldEntityId); // carried over
    expect(revised.lastChange.kind).toBe('revised');
    expect(revised.updatedAt).toBe(revised.lastChange.recordedAt);

    const cleared = await reviseCapability(ctx, {
      capabilityId: capability.id,
      worldEntityId, // set
      actor: PERSON_OPS,
    });
    expect(cleared.worldEntityId).toBe(worldEntityId);
    const cleared2 = await reviseCapability(ctx, {
      capabilityId: capability.id,
      worldEntityId: null, // cleared
      description: null, // cleared
      actor: PERSON_OPS,
    });
    expect(cleared2.worldEntityId).toBeNull();
    expect(cleared2.description).toBeNull();
    expect(cleared2.version).toBe(4);
  });

  it('keeps the version chain append-only and deep-linkable', async () => {
    const history = await listCapabilityVersions(ctx, { capabilityId: capability.id });
    expect(history.map((version) => version.changeKind)).toEqual([
      'created',
      'revised',
      'revised',
      'revised',
    ]);
    expect(history.map((version) => version.version)).toEqual([1, 2, 3, 4]);
    // every version is a full self-contained snapshot
    expect(history[0]!.description).toBe('Docs people actually read');
    expect(history[1]!.description).toBe('Docs people quote');
    expect(history[3]!.worldEntityId).toBeNull();

    const second = await getCapabilityVersion(ctx, { capabilityId: capability.id, version: 2 });
    expect(second.changeKind).toBe('revised');
    expect(second.description).toBe('Docs people quote');
    await expectCode(
      'capability_version_not_found',
      () => getCapabilityVersion(ctx, { capabilityId: capability.id, version: 99 }),
    );
  });

  it('enforces surgical lifecycle transitions on capabilities', async () => {
    await expectCode(
      'invalid_transition',
      () =>
        reviseCapability(ctx, {
          capabilityId: capability.id,
          status: 'active', // already active
          actor: PERSON_OPS,
        }),
    );
    const retired = await reviseCapability(ctx, {
      capabilityId: capability.id,
      status: 'retired',
      actor: PERSON_OPS,
      rationale: 'Merged into engineering',
    });
    expect(retired.status).toBe('retired');
    expect(retired.lastChange.kind).toBe('retired');
    await expectCode(
      'invalid_transition',
      () =>
        reviseCapability(ctx, {
          capabilityId: capability.id,
          description: 'nope', // a retired record accepts nothing but reactivation
          actor: PERSON_OPS,
        }),
    );
    const reactivated = await reviseCapability(ctx, {
      capabilityId: capability.id,
      status: 'active',
      actor: PERSON_OPS,
      rationale: 'Docs are back',
    });
    expect(reactivated.status).toBe('active');
    expect(reactivated.lastChange.kind).toBe('reactivated');
  });

  it('refuses new supply against a retired capability', async () => {
    const retiredOne = await registerCapability(ctx, { name: 'Fax handling', actor: PERSON_OPS });
    await reviseCapability(ctx, {
      capabilityId: retiredOne.id,
      status: 'retired',
      actor: PERSON_OPS,
    });
    await expectCode(
      'invalid_transition',
      () =>
        registerSupply(ctx, {
          capabilityId: retiredOne.id,
          supplier: { kind: 'employee', label: 'Eve' },
          actor: PERSON_OPS,
        }),
    );
    await expectCode(
      'invalid_transition',
      () =>
        registerRequirement(ctx, {
          capabilityId: retiredOne.id,
          source: { kind: 'manual', label: 'Wish' },
          actor: PERSON_OPS,
        }),
    );
  });

  it('revises supplies with wholesale evidence replacement and lifecycle', async () => {
    const newEvidence = [newId(), newId(), newId()];
    const revised = await reviseSupply(ctx, {
      supplyId: supply.id,
      level: 0.85,
      capacity: 20,
      evidenceObservationIds: newEvidence,
      note: 'Senior',
      actor: PERSON_OPS,
      rationale: 'Promotion',
    });
    expect(revised.version).toBe(2);
    expect(revised.level).toBe(0.85);
    expect(revised.capacity).toBe(20);
    expect(revised.evidenceObservationIds).toEqual(newEvidence);
    expect(revised.note).toBe('Senior');
    expect(revised.supplier).toEqual({ kind: 'employee', id: null, label: 'Dana' }); // immutable

    const cleared = await reviseSupply(ctx, {
      supplyId: supply.id,
      note: null, // cleared
      capacity: null, // cleared
      actor: PERSON_OPS,
    });
    expect(cleared.note).toBeNull();
    expect(cleared.capacity).toBeNull();

    const retired = await reviseSupply(ctx, {
      supplyId: supply.id,
      status: 'retired',
      actor: PERSON_OPS,
      rationale: 'Dana left',
    });
    expect(retired.status).toBe('retired');
    expect(retired.lastChange.kind).toBe('retired');
    await expectCode(
      'invalid_transition',
      () =>
        reviseSupply(ctx, {
          supplyId: supply.id,
          level: 0.9, // a retired supply accepts nothing but reactivation
          actor: PERSON_OPS,
        }),
    );
    const reactivated = await reviseSupply(ctx, {
      supplyId: supply.id,
      status: 'active',
      actor: PERSON_OPS,
    });
    expect(reactivated.status).toBe('active');
    expect(reactivated.lastChange.kind).toBe('reactivated');

    // the history keeps every snapshot
    const history = await listSupplyVersions(ctx, { supplyId: supply.id });
    expect(history.map((version) => version.changeKind)).toEqual([
      'asserted',
      'revised',
      'revised',
      'retired',
      'reactivated',
    ]);
    expect(history[0]!.level).toBe(0.5);
    expect(history[0]!.evidenceObservationIds).toHaveLength(1);
    expect(history[0]!.supplier).toEqual({ kind: 'employee', id: null, label: 'Dana' });
    const deep = await getSupplyVersion(ctx, { supplyId: supply.id, version: 4 });
    expect(deep.changeKind).toBe('retired');
    await expectCode(
      'supply_version_not_found',
      () => getSupplyVersion(ctx, { supplyId: supply.id, version: 99 }),
    );
  });

  it('revises requirements with lifecycle and deep-linkable history', async () => {
    const revised = await reviseRequirement(ctx, {
      requirementId: requirement.id,
      level: 0.6,
      note: null,
      actor: PERSON_OPS,
    });
    expect(revised.level).toBe(0.6);
    expect(revised.note).toBeNull();
    expect(revised.source).toEqual({ kind: 'goal', id: null, label: 'Docs excellence' });

    const retired = await reviseRequirement(ctx, {
      requirementId: requirement.id,
      status: 'retired',
      actor: PERSON_OPS,
    });
    expect(retired.lastChange.kind).toBe('retired');
    await expectCode(
      'invalid_transition',
      () =>
        reviseRequirement(ctx, {
          requirementId: requirement.id,
          level: 0.1, // a retired requirement accepts nothing but reactivation
          actor: PERSON_OPS,
        }),
    );
    const reactivated = await reviseRequirement(ctx, {
      requirementId: requirement.id,
      status: 'active',
      actor: PERSON_OPS,
    });
    expect(reactivated.lastChange.kind).toBe('reactivated');

    const history = await listRequirementVersions(ctx, { requirementId: requirement.id });
    expect(history.map((version) => version.changeKind)).toEqual([
      'declared',
      'revised',
      'retired',
      'reactivated',
    ]);
    const deep = await getRequirementVersion(ctx, { requirementId: requirement.id, version: 1 });
    expect(deep.level).toBe(0.7);
    expect(deep.note).toBe('Needs a senior');
    await expectCode(
      'requirement_version_not_found',
      () => getRequirementVersion(ctx, { requirementId: requirement.id, version: 99 }),
    );
  });

  it('rejects caller attempts to smuggle system-minted fields', async () => {
    await expectCode(
      'invalid_capability_input',
      () =>
        registerCapability(ctx, {
          name: 'Smuggling',
          actor: PERSON_OPS,
          tenantId: 'not-yours',
        } as never),
    );
    await expectCode(
      'invalid_supply_input',
      () =>
        registerSupply(ctx, {
          capabilityId: capability.id,
          supplier: { kind: 'employee', label: 'X' },
          actor: PERSON_OPS,
          version: 42,
        } as never),
    );
  });

  it('enforces the append-only storage guarantees (triggers)', async () => {
    await expectSqlRejection(`UPDATE capability_versions SET description = 'forged'`);
    await expectSqlRejection(`DELETE FROM capability_versions`);
    await expectSqlRejection(`TRUNCATE TABLE capability_versions`);
    await expectSqlRejection(`UPDATE capability_supply_versions SET level = 1`);
    await expectSqlRejection(`DELETE FROM capability_supply_versions`);
    await expectSqlRejection(`TRUNCATE TABLE capability_supply_versions`);
    await expectSqlRejection(`UPDATE capability_requirement_versions SET level = 1`);
    await expectSqlRejection(`DELETE FROM capability_requirement_versions`);
    await expectSqlRejection(`TRUNCATE TABLE capability_requirement_versions`);
    await expectSqlRejection(`DELETE FROM capabilities`);
    await expectSqlRejection(`TRUNCATE TABLE capabilities`);
    await expectSqlRejection(`DELETE FROM capability_supplies`);
    await expectSqlRejection(`TRUNCATE TABLE capability_supplies`);
    await expectSqlRejection(`DELETE FROM capability_requirements`);
    await expectSqlRejection(`TRUNCATE TABLE capability_requirements`);
    // the identity pointer may still advance — that is its only job (and the
    // service does exactly that on every revision)
    const current = await getCapability(ctx, capability.id);
    expect(current.version).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  const ctxMain = member(tenantMain);
  const ctxIso = member(tenantIso);

  let foreignCapability: Capability;
  let foreignSupply: CapabilitySupply;
  let foreignRequirement: CapabilityRequirement;

  beforeAll(async () => {
    const capabilities = await listCapabilities(ctxMain, { limit: 500 });
    foreignCapability = capabilities.find((c) => c.name === 'German-language support')!;
    const supplies = await listSupplies(ctxMain, { capabilityId: foreignCapability.id, limit: 500 });
    foreignSupply = supplies.find((supply) => supply.supplier.label === 'Ada')!;
    const requirements = await listRequirements(ctxMain, {
      capabilityId: foreignCapability.id,
      limit: 500,
    });
    foreignRequirement = requirements[0]!;
  });

  it('reads foreign records as missing (no existence leak)', async () => {
    await expectCode('capability_not_found', () => getCapability(ctxIso, foreignCapability.id));
    await expectCode(
      'capability_not_found',
      () =>
        reviseCapability(ctxIso, {
          capabilityId: foreignCapability.id,
          description: 'takeover',
          actor: PERSON_OPS,
        }),
    );
    await expectCode('supply_not_found', () => getSupply(ctxIso, foreignSupply.id));
    await expectCode(
      'supply_not_found',
      () =>
        reviseSupply(ctxIso, { supplyId: foreignSupply.id, level: 0.1, actor: PERSON_OPS }),
    );
    await expectCode('requirement_not_found', () => getRequirement(ctxIso, foreignRequirement.id));
    await expectCode(
      'requirement_not_found',
      () =>
        reviseRequirement(ctxIso, {
          requirementId: foreignRequirement.id,
          level: 0.1,
          actor: PERSON_OPS,
        }),
    );
  });

  it('reads foreign versions as missing', async () => {
    await expectCode(
      'capability_version_not_found',
      () =>
        getCapabilityVersion(ctxIso, { capabilityId: foreignCapability.id, version: 1 }),
    );
    // history listings of a foreign identity read as the identity's
    // not-found (the processes module's listProcessVersions precedent)
    await expectCode(
      'capability_not_found',
      () => listCapabilityVersions(ctxIso, { capabilityId: foreignCapability.id }),
    );
    await expectCode(
      'supply_version_not_found',
      () => getSupplyVersion(ctxIso, { supplyId: foreignSupply.id, version: 1 }),
    );
    await expectCode(
      'supply_not_found',
      () => listSupplyVersions(ctxIso, { supplyId: foreignSupply.id }),
    );
    await expectCode(
      'requirement_version_not_found',
      () => getRequirementVersion(ctxIso, { requirementId: foreignRequirement.id, version: 1 }),
    );
    await expectCode(
      'requirement_not_found',
      () => listRequirementVersions(ctxIso, { requirementId: foreignRequirement.id }),
    );
  });

  it('registers supplies/requirements against foreign capabilities as missing', async () => {
    await expectCode(
      'capability_not_found',
      () =>
        registerSupply(ctxIso, {
          capabilityId: foreignCapability.id,
          supplier: { kind: 'employee', label: 'Intruder' },
          actor: PERSON_OPS,
        }),
    );
    await expectCode(
      'capability_not_found',
      () =>
        registerRequirement(ctxIso, {
          capabilityId: foreignCapability.id,
          source: { kind: 'manual', label: 'Intruder wish' },
          actor: PERSON_OPS,
        }),
    );
  });

  it('never leaks foreign data through listings or gap analysis', async () => {
    // the isolation tenant registered nothing — every listing is empty
    expect(await listCapabilities(ctxIso, {})).toEqual([]);
    expect(await listSupplies(ctxIso, {})).toEqual([]);
    expect(await listRequirements(ctxIso, {})).toEqual([]);
    expect(await analyzeGaps(ctxIso, {})).toEqual([]);
    // and a foreign capability id produces the uniform not-found
    await expectCode('capability_not_found', () => analyzeGaps(ctxIso, { capabilityId: foreignCapability.id }));
  });

  it('keeps malformed ids and bad contexts uniform', async () => {
    await expectCode('capability_not_found', () => getCapability(ctxMain, 'not-a-uuid'));
    await expectCode('supply_not_found', () => getSupply(ctxMain, 'not-a-uuid'));
    await expectCode('requirement_not_found', () => getRequirement(ctxMain, 'not-a-uuid'));
    const broken = { tenantId: '', principalId: newId(), authority: [] } as TenantContext;
    await expectCode('invalid_context', () => listCapabilities(broken, {}));
    await expectCode('invalid_context', () => analyzeGaps(broken, {}));
  });
});

// ---------------------------------------------------------------------------
// Boot / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});
