// Integration tests for the suppliers module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W020
// acceptance: "Score suppliers/subcontractors on price, quality,
// reliability, capacity, compliance, geography, switching cost and
// alternatives."
//
//  * THE REGISTRY IS MODELED: suppliers and subcontractors (tenant-unique
//    immutable names, immutable kind), each an identity plus an
//    append-only version chain, with system-minted identity/tenancy/
//    version/change-kind/commit-time/principal audit fields.
//  * ALL EIGHT DIMENSIONS ARE SCORED: scorecards carry price, quality,
//    reliability, capacity, compliance, geography, switchingCost and
//    alternatives (each [0, 1] or null = unscored, ≥ 1 scored per
//    snapshot), with evidence observation references and notes; revisions
//    append tri-state merges ('reassessed').
//  * THE DERIVED LAYER: rankSuppliers orders by the weighted overall
//    (default weights = plain mean; read-time weights reorder), reports
//    per-dimension breakdown and completeness, filters by kind, drops
//    retired and unscored suppliers; the supplier view embeds the
//    default-weight assessment summary.
//  * ALTERNATIVES ARE GROUNDED IN THE CAPABILITY GRAPH (W017 contract):
//    the intelligence view lists the supplier's supplied capabilities
//    (linkage by party id === supplier uuid OR party label === supplier
//    name, kind 'supplier' only) and, per actively-supplied capability,
//    the other parties' supplies — resolvable alternative suppliers with
//    their derived overall under the analysis weights, internal channels
//    and retired supplies (reactivation candidates).
//  * VERSIONED/AUDITABLE: revisions append (carry-over merge, tri-state
//    clears), lifecycle transitions are surgical, retired records accept
//    nothing but reactivation, histories are deep-linkable, and the
//    storage layer rejects UPDATE/DELETE/TRUNCATE on version tables and
//    DELETE/TRUNCATE on identity tables outright (triggers).
//  * CONFLICTS: duplicate names and duplicate scorecards per supplier
//    fail with the documented conflict codes; assessments against retired
//    suppliers are refused.
//  * TENANT ISOLATION (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks): foreign-tenant suppliers,
//    scorecards and their versions read as missing; listings, rankings and
//    the intelligence analysis never leak across tenants.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as capabilitiesContract from '@/modules/capabilities/contract';
import { SuppliersError } from '../errors';
import * as suppliersContract from '../contract';
import type { Supplier, SupplierIntelligence, SupplierRanking, SupplierScorecard } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const { registerCapability, registerSupply } = capabilitiesContract;
const {
  getScorecard,
  getScorecardVersion,
  getSupplier,
  getSupplierIntelligence,
  getSupplierVersion,
  listScorecardVersions,
  listSupplierVersions,
  listSuppliers,
  rankSuppliers,
  recordScorecard,
  registerSupplier,
  reviseScorecard,
  reviseSupplier,
} = suppliersContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantMain = newId(); // the intelligence scenario (registry + graph + ranking)
const tenantVersioned = newId(); // versioning / audit / conflicts / triggers
const tenantIso = newId(); // the other tenant (isolation checks)

const PERSON_PROC = { kind: 'person' as const, id: newId(), label: 'Procurement lead' };
const OBS_1 = '00000000-0000-4000-8000-000000000001';
const OBS_2 = '00000000-0000-4000-8000-000000000002';
const WORLD_ENTITY = '00000000-0000-4000-8000-00000000000f';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
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

/** Raw SQL rejection assertion (the storage triggers). */
async function expectSqlRejection(sql: string): Promise<void> {
  await expect(getDb().query(sql)).rejects.toThrow();
}

// The full eight-dimension scorecards of the main scenario (means are
// asserted to the digit — the derived overall is the plain mean under
// default weights).
const ACME_SCORES = {
  price: 0.6,
  quality: 0.9,
  reliability: 0.85,
  capacity: 0.7,
  compliance: 0.95,
  geography: 0.8,
  switchingCost: 0.4,
  alternatives: 0.5,
}; // mean 0.7125
const BIRGO_SCORES = {
  price: 0.9,
  quality: 0.6,
  reliability: 0.5,
  capacity: 0.8,
  compliance: 0.7,
  geography: 0.6,
  switchingCost: 0.9,
  alternatives: 0.9,
}; // mean 0.7375

// ---------------------------------------------------------------------------
// The main scenario: a freight-buying org with suppliers, a subcontractor,
// capabilities supplied through the W017 graph, and scorecards
// ---------------------------------------------------------------------------

describe('supplier intelligence — the main scenario', () => {
  const ctx = member(tenantMain);

  let acme: Supplier;
  let birgo: Supplier;
  let craftworks: Supplier;
  let durable: Supplier;
  let oldRail: Supplier;
  let acmeScorecard: SupplierScorecard;
  let birgoScorecard: SupplierScorecard;
  let craftworksScorecard: SupplierScorecard;
  let intelligence: SupplierIntelligence;
  let defaultRanking: SupplierRanking[];
  let weightedRanking: SupplierRanking[];
  let freightId: string;
  let customsId: string;

  beforeAll(async () => {
    // --- capabilities (through the capabilities contract — W017) ---
    const freight = await registerCapability(ctx, {
      name: 'Freight transport',
      description: 'Road freight across the EU',
      actor: PERSON_PROC,
    });
    const customs = await registerCapability(ctx, {
      name: 'Customs brokerage',
      actor: PERSON_PROC,
    });
    const warehousing = await registerCapability(ctx, {
      name: 'Warehousing',
      actor: PERSON_PROC,
    });
    freightId = freight.id;
    customsId = customs.id;

    // --- suppliers (the registry: two suppliers, one subcontractor, and
    //     one never-assessed supplier; Old Rail is retired mid-scenario) ---
    acme = await registerSupplier(ctx, {
      name: 'Acme Logistics',
      kind: 'supplier',
      description: 'Full-service freight forwarder',
      actor: PERSON_PROC,
      rationale: 'Onboarding the DACH lane',
    });
    birgo = await registerSupplier(ctx, {
      name: 'Birgo Freight',
      kind: 'supplier',
      actor: PERSON_PROC,
    });
    craftworks = await registerSupplier(ctx, {
      name: 'Craftworks',
      kind: 'subcontractor',
      description: 'Bespoke customs paperwork',
      worldEntityId: WORLD_ENTITY,
      actor: PERSON_PROC,
    });
    durable = await registerSupplier(ctx, {
      name: 'Durable Parts',
      kind: 'supplier',
      actor: PERSON_PROC,
    });
    oldRail = await registerSupplier(ctx, {
      name: 'Old Rail',
      kind: 'supplier',
      actor: PERSON_PROC,
    });
    oldRail = await reviseSupplier(ctx, {
      supplierId: oldRail.id,
      status: 'retired',
      actor: PERSON_PROC,
      rationale: 'Rail concession ended',
    });

    // --- capability supplies: Acme links by party id; Birgo links by party
    //     label (its registry name); Craftworks links by party id; a
    //     partner party carrying Acme's uuid is NOT an own supply (kind
    //     discipline); KyivHaul is a retired reactivation candidate. ---
    await registerSupply(ctx, {
      capabilityId: freight.id,
      supplier: { kind: 'supplier', id: acme.id, label: 'Acme Logistics' },
      level: 0.9,
      capacity: 100,
      actor: PERSON_PROC,
    });
    await registerSupply(ctx, {
      capabilityId: freight.id,
      supplier: { kind: 'supplier', label: 'Birgo Freight' },
      level: 0.8,
      capacity: 80,
      actor: PERSON_PROC,
    });
    await registerSupply(ctx, {
      capabilityId: freight.id,
      supplier: { kind: 'employee', label: 'Dana' },
      level: 0.5,
      actor: PERSON_PROC,
    });
    const kyiv = await registerSupply(ctx, {
      capabilityId: freight.id,
      supplier: { kind: 'partner', label: 'KyivHaul' },
      level: 0.7,
      actor: PERSON_PROC,
    });
    await capabilitiesContract.reviseSupply(ctx, {
      supplyId: kyiv.id,
      status: 'retired',
      actor: PERSON_PROC,
      rationale: 'Concession ended',
    });
    await registerSupply(ctx, {
      capabilityId: freight.id,
      // id matches Acme's uuid, but the party kind is 'partner', not
      // 'supplier' — the linkage convention does not claim it
      supplier: { kind: 'partner', id: acme.id },
      level: 0.55,
      actor: PERSON_PROC,
    });
    await registerSupply(ctx, {
      capabilityId: customs.id,
      supplier: { kind: 'supplier', id: craftworks.id },
      level: 0.6,
      actor: PERSON_PROC,
    });
    await registerSupply(ctx, {
      capabilityId: customs.id,
      supplier: { kind: 'supplier', id: acme.id },
      level: 0.7,
      actor: PERSON_PROC,
    });
    await registerSupply(ctx, {
      capabilityId: warehousing.id,
      // label matches Acme's registry name — the label half of the
      // linkage convention
      supplier: { kind: 'supplier', label: 'Acme Logistics' },
      level: 0.4,
      actor: PERSON_PROC,
    });

    // --- scorecards (the eight dimensions) ---
    acmeScorecard = await recordScorecard(ctx, {
      supplierId: acme.id,
      scores: ACME_SCORES,
      evidenceObservationIds: [OBS_1, OBS_2],
      note: 'Annual vendor review',
      actor: PERSON_PROC,
    });
    birgoScorecard = await recordScorecard(ctx, {
      supplierId: birgo.id,
      scores: BIRGO_SCORES,
      actor: PERSON_PROC,
    });
    craftworksScorecard = await recordScorecard(ctx, {
      supplierId: craftworks.id,
      // a thin assessment: two of eight dimensions (completeness 0.25)
      scores: { price: 0.5, quality: 1 },
      actor: PERSON_PROC,
    });
    // Durable Parts is never assessed; Old Rail is retired and unscored.

    intelligence = await getSupplierIntelligence(ctx, { supplierId: acme.id });
    defaultRanking = await rankSuppliers(ctx, {});
    weightedRanking = await rankSuppliers(ctx, { weights: { price: 4 } });
  });

  it('registers suppliers and subcontractors with immutable identity + minted audit', () => {
    expect(acme.name).toBe('Acme Logistics');
    expect(acme.kind).toBe('supplier');
    expect(acme.version).toBe(1);
    expect(acme.status).toBe('active');
    expect(acme.tenantId).toBe(tenantMain);
    expect(acme.lastChange.kind).toBe('created');
    expect(acme.lastChange.actor.label).toBe('Procurement lead');
    expect(acme.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(craftworks.kind).toBe('subcontractor');
    expect(craftworks.worldEntityId).toBe(WORLD_ENTITY);
    expect(oldRail.status).toBe('retired');
  });

  it('scores all eight dimensions and derives the default-weight assessment summary', async () => {
    expect(acmeScorecard.supplierId).toBe(acme.id);
    expect(acmeScorecard.version).toBe(1);
    expect(acmeScorecard.lastChange.kind).toBe('assessed');
    expect(acmeScorecard.scores).toEqual(ACME_SCORES);
    expect(acmeScorecard.evidenceObservationIds).toEqual([OBS_1, OBS_2]);
    expect(acmeScorecard.note).toBe('Annual vendor review');

    // the supplier view embeds the default-weight summary
    const view = await getSupplier(ctx, acme.id);
    expect(view.assessment).not.toBeNull();
    expect(view.assessment!.scorecardId).toBe(acmeScorecard.id);
    expect(view.assessment!.version).toBe(1);
    expect(view.assessment!.scoredDimensions).toBe(8);
    expect(view.assessment!.totalDimensions).toBe(8);
    expect(view.assessment!.completeness).toBe(1);
    expect(view.assessment!.overall).toBeCloseTo(0.7125, 10);

    // unassessed suppliers carry no summary
    const durableView = await getSupplier(ctx, durable.id);
    expect(durableView.assessment).toBeNull();

    // thin assessments keep their completeness visible
    const craftView = await getSupplier(ctx, craftworks.id);
    expect(craftView.assessment!.scoredDimensions).toBe(2);
    expect(craftView.assessment!.completeness).toBeCloseTo(0.25, 10);
    expect(craftView.assessment!.overall).toBeCloseTo(0.75, 10);
  });

  it('ranks active assessed suppliers by the derived overall (default weights)', () => {
    // Craftworks (0.75, thin) > Birgo (0.7375) > Acme (0.7125); Durable
    // Parts (unscored) and retired Old Rail never rank.
    expect(defaultRanking.map((entry) => entry.supplier.name)).toEqual([
      'Craftworks',
      'Birgo Freight',
      'Acme Logistics',
    ]);
    expect(defaultRanking.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(defaultRanking[0]!.scoring.overall).toBeCloseTo(0.75, 10);
    expect(defaultRanking[0]!.scoring.completeness).toBeCloseTo(0.25, 10);
    expect(defaultRanking[0]!.scoring.scoredDimensions).toBe(2);
    expect(defaultRanking[2]!.scoring.overall).toBeCloseTo(0.7125, 10);
    expect(defaultRanking[2]!.scoring.dimensions).toHaveLength(8);
    expect(defaultRanking[2]!.scoring.dimensions.map((d) => d.dimension)).toEqual([
      'price',
      'quality',
      'reliability',
      'capacity',
      'compliance',
      'geography',
      'switching_cost',
      'alternatives',
    ]);
    expect(defaultRanking[0]!.scorecard.id).toBe(craftworksScorecard.id);
    expect(defaultRanking[1]!.scorecard.id).toBe(birgoScorecard.id);
    expect(defaultRanking[2]!.scorecard.id).toBe(acmeScorecard.id);
    expect(defaultRanking[2]!.supplier.kind).toBe('supplier');
  });

  it('reorders under read-time weights without persisting anything', async () => {
    // price×4, everything else default 1: Birgo (0.9·4+5.0)/11 ≈ 0.7818,
    // Acme (0.6·4+5.1)/11 ≈ 0.6818, Craftworks (0.5·4+1)/5 = 0.6
    expect(weightedRanking.map((entry) => entry.supplier.name)).toEqual([
      'Birgo Freight',
      'Acme Logistics',
      'Craftworks',
    ]);
    expect(weightedRanking[0]!.scoring.overall).toBeCloseTo(8.6 / 11, 10);
    expect(weightedRanking[1]!.scoring.overall).toBeCloseTo(7.5 / 11, 10);
    // the stored scorecards are untouched — weights are read-time only
    const reread = await getScorecard(ctx, acmeScorecard.id);
    expect(reread.scores).toEqual(ACME_SCORES);
    const again = await rankSuppliers(ctx, {});
    expect(again.map((entry) => entry.supplier.name)).toEqual([
      'Craftworks',
      'Birgo Freight',
      'Acme Logistics',
    ]);
  });

  it('filters the ranking by kind and honors limit', async () => {
    const subs = await rankSuppliers(ctx, { kind: 'subcontractor' });
    expect(subs.map((entry) => entry.supplier.name)).toEqual(['Craftworks']);
    const top2 = await rankSuppliers(ctx, { limit: 2 });
    expect(top2.map((entry) => entry.supplier.name)).toEqual(['Craftworks', 'Birgo Freight']);
    expect(top2.map((entry) => entry.rank)).toEqual([1, 2]);
  });

  it('lists suppliers with filters in canonical name order', async () => {
    const all = await listSuppliers(ctx, {});
    expect(all.map((s) => s.name)).toEqual([
      'Acme Logistics',
      'Birgo Freight',
      'Craftworks',
      'Durable Parts',
      'Old Rail',
    ]);
    const bySearch = await listSuppliers(ctx, { search: 'freight' });
    expect(bySearch.map((s) => s.name)).toEqual(['Birgo Freight']);
    const byName = await listSuppliers(ctx, { name: 'Acme Logistics' });
    expect(byName.map((s) => s.name)).toEqual(['Acme Logistics']);
    const retired = await listSuppliers(ctx, { status: 'retired' });
    expect(retired.map((s) => s.name)).toEqual(['Old Rail']);
    const suppliersOnly = await listSuppliers(ctx, { kind: 'supplier' });
    expect(suppliersOnly.map((s) => s.name)).toEqual([
      'Acme Logistics',
      'Birgo Freight',
      'Durable Parts',
      'Old Rail',
    ]);
  });

  it('reads the supplier intelligence view with capability-graph-grounded alternatives', () => {
    expect(intelligence.supplier.id).toBe(acme.id);
    expect(intelligence.scorecard!.id).toBe(acmeScorecard.id);
    expect(intelligence.scoring!.overall).toBeCloseTo(0.7125, 10);
    expect(intelligence.scoring!.completeness).toBe(1);

    // every supply linked to Acme: freight (by id), customs (by id),
    // warehousing (by label)
    expect(intelligence.suppliedCapabilities).toHaveLength(3);
    const byName = new Map(
      intelligence.suppliedCapabilities.map((entry) => [entry.capability.name, entry]),
    );
    expect(byName.get('Freight transport')!.capability.id).toBe(freightId);
    expect(byName.get('Freight transport')!.capability.status).toBe('active');
    expect(byName.get('Freight transport')!.level).toBe(0.9);
    expect(byName.get('Freight transport')!.capacity).toBe(100);
    expect(byName.get('Customs brokerage')!.capability.id).toBe(customsId);
    expect(byName.get('Customs brokerage')!.level).toBe(0.7);
    expect(byName.get('Customs brokerage')!.capacity).toBeNull();
    expect(byName.get('Warehousing')!.level).toBe(0.4); // label-linkage

    // alternatives per actively-supplied capability
    const alternativesByName = new Map(
      intelligence.alternatives.map((entry) => [entry.capability.name, entry]),
    );
    expect(alternativesByName.size).toBe(3);

    const freight = alternativesByName.get('Freight transport')!;
    expect(freight.ownSupplies).toHaveLength(1);
    expect(freight.ownSupplies[0]!.level).toBe(0.9);
    expect(freight.activeAlternativeCount).toBe(3);
    expect(freight.activeByKind).toEqual({
      employee: 1,
      team: 0,
      agent: 0,
      software: 0,
      supplier: 1,
      partner: 1,
    });
    // canonical (kind, key) order: employee Dana, the partner party carrying
    // Acme's uuid (NOT own — kind discipline), then supplier Birgo
    expect(freight.activeAlternatives.map((a) => a.supplier.kind)).toEqual([
      'employee',
      'partner',
      'supplier',
    ]);
    const birgoAlternative = freight.activeAlternatives.find(
      (a) => a.supplier.kind === 'supplier',
    )!;
    expect(birgoAlternative.supplier.label).toBe('Birgo Freight');
    expect(birgoAlternative.level).toBe(0.8);
    // the alternative supplier resolves back to the registry, score-backed
    // under the analysis's (default) weights
    expect(birgoAlternative.resolvedSupplier).not.toBeNull();
    expect(birgoAlternative.resolvedSupplier!.id).toBe(birgo.id);
    expect(birgoAlternative.resolvedSupplier!.name).toBe('Birgo Freight');
    expect(birgoAlternative.resolvedSupplier!.kind).toBe('supplier');
    expect(birgoAlternative.resolvedSupplier!.overall).toBeCloseTo(0.7375, 10);
    // internal channels and the id-matching partner stay unresolved
    expect(freight.activeAlternatives.find((a) => a.supplier.kind === 'employee')!.resolvedSupplier).toBeNull();
    expect(freight.activeAlternatives.find((a) => a.supplier.kind === 'partner')!.resolvedSupplier).toBeNull();
    expect(freight.activeAlternatives.find((a) => a.supplier.kind === 'partner')!.supplier.id).toBe(acme.id);
    // KyivHaul's retired supply is a reactivation candidate
    expect(freight.retiredAlternatives).toHaveLength(1);
    expect(freight.retiredAlternatives[0]!.supplier.label).toBe('KyivHaul');
    expect(freight.retiredAlternatives[0]!.status).toBe('retired');

    const customs = alternativesByName.get('Customs brokerage')!;
    expect(customs.activeAlternativeCount).toBe(1);
    const craftworksAlternative = customs.activeAlternatives[0]!;
    expect(craftworksAlternative.resolvedSupplier!.id).toBe(craftworks.id);
    expect(craftworksAlternative.resolvedSupplier!.kind).toBe('subcontractor');
    expect(craftworksAlternative.resolvedSupplier!.overall).toBeCloseTo(0.75, 10);

    // warehousing has no alternatives at all — the honest thin case
    const warehousing = alternativesByName.get('Warehousing')!;
    expect(warehousing.activeAlternativeCount).toBe(0);
    expect(warehousing.activeAlternatives).toEqual([]);
    expect(warehousing.retiredAlternatives).toEqual([]);
  });

  it('applies the analysis weights to the intelligence scoring and resolved overalls', async () => {
    const weighted = await getSupplierIntelligence(ctx, {
      supplierId: acme.id,
      weights: { price: 4 },
    });
    expect(weighted.scoring!.overall).toBeCloseTo(7.5 / 11, 10);
    const freight = weighted.alternatives.find(
      (entry) => entry.capability.name === 'Freight transport',
    )!;
    const birgoAlternative = freight.activeAlternatives.find((a) => a.supplier.kind === 'supplier')!;
    expect(birgoAlternative.resolvedSupplier!.overall).toBeCloseTo(8.6 / 11, 10); // price×4
    const customs = weighted.alternatives.find(
      (entry) => entry.capability.name === 'Customs brokerage',
    )!;
    expect(customs.activeAlternatives[0]!.resolvedSupplier!.overall).toBeCloseTo(0.6, 10);
  });

  it('reports empty intelligence for a supplier with no capabilities and no scorecard', async () => {
    const view = await getSupplierIntelligence(ctx, { supplierId: durable.id });
    expect(view.supplier.id).toBe(durable.id);
    expect(view.scorecard).toBeNull();
    expect(view.scoring).toBeNull();
    expect(view.suppliedCapabilities).toEqual([]);
    expect(view.alternatives).toEqual([]);
  });

  it('mirrors alternatives from the other side (Craftworks sees Acme as an alternative)', async () => {
    const view = await getSupplierIntelligence(ctx, { supplierId: craftworks.id });
    expect(view.suppliedCapabilities).toHaveLength(1);
    expect(view.suppliedCapabilities[0]!.capability.name).toBe('Customs brokerage');
    expect(view.alternatives).toHaveLength(1);
    const acmeAlternative = view.alternatives[0]!.activeAlternatives[0]!;
    expect(acmeAlternative.resolvedSupplier!.id).toBe(acme.id);
    expect(acmeAlternative.resolvedSupplier!.overall).toBeCloseTo(0.7125, 10);
  });
});

// ---------------------------------------------------------------------------
// Versioning, lifecycle, conflicts, storage guarantees
// ---------------------------------------------------------------------------

describe('supplier registry — versioning, lifecycle and storage', () => {
  const ctx = member(tenantVersioned);

  let nordwind: Supplier;
  let scorecard: SupplierScorecard;
  let retiredView: Supplier;

  beforeAll(async () => {
    nordwind = await registerSupplier(ctx, {
      name: 'Nordwind Metal',
      kind: 'supplier',
      description: 'Sheet metal',
      actor: PERSON_PROC,
    });
    // v2: content revision (carry-over + set)
    nordwind = await reviseSupplier(ctx, {
      supplierId: nordwind.id,
      description: 'Sheet metal and alloys',
      worldEntityId: WORLD_ENTITY,
      actor: PERSON_PROC,
    });
    // v3: tri-state clears
    nordwind = await reviseSupplier(ctx, {
      supplierId: nordwind.id,
      description: null,
      worldEntityId: null,
      actor: PERSON_PROC,
    });
    // v4: retirement (surgical)
    retiredView = await reviseSupplier(ctx, {
      supplierId: nordwind.id,
      status: 'retired',
      actor: PERSON_PROC,
      rationale: 'Contract ended',
    });
    // v5: reactivation (the only change a retired supplier accepts)
    nordwind = await reviseSupplier(ctx, {
      supplierId: nordwind.id,
      status: 'active',
      actor: PERSON_PROC,
    });

    scorecard = await recordScorecard(ctx, {
      supplierId: nordwind.id,
      scores: { price: 0.7, quality: 0.8 },
      evidenceObservationIds: [OBS_1, OBS_2],
      note: 'First assessment',
      actor: PERSON_PROC,
    });
    scorecard = await reviseScorecard(ctx, {
      scorecardId: scorecard.id,
      // tri-state: set price, clear quality, set reliability; rest carry
      scores: { price: 0.9, quality: null, reliability: 0.6 },
      evidenceObservationIds: [OBS_2], // replaces wholesale
      note: null, // cleared
      actor: PERSON_PROC,
      rationale: 'Quarterly refresh',
    });
  });

  it('appends versions with carry-over merges and surgical lifecycle transitions', async () => {
    const versions = await listSupplierVersions(ctx, { supplierId: nordwind.id });
    expect(versions.map((v) => v.changeKind)).toEqual([
      'created',
      'revised',
      'revised',
      'retired',
      'reactivated',
    ]);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5]);
    // the immutable identity content is snapshotted on every version
    for (const version of versions) {
      expect(version.name).toBe('Nordwind Metal');
      expect(version.kind).toBe('supplier');
    }
    // v2 carried and set; v3 cleared; v4 retired; v5 reactivated
    expect(versions[1]!.description).toBe('Sheet metal and alloys');
    expect(versions[1]!.worldEntityId).toBe(WORLD_ENTITY);
    expect(versions[2]!.description).toBeNull();
    expect(versions[2]!.worldEntityId).toBeNull();
    expect(versions[3]!.status).toBe('retired');
    expect(versions[3]!.rationale).toBe('Contract ended');
    expect(versions[4]!.status).toBe('active');
    expect(retiredView.status).toBe('retired');
    expect(retiredView.version).toBe(4);
    expect(nordwind.version).toBe(5);
    expect(nordwind.status).toBe('active');
    // the CURRENT view reflects the scorecard that was recorded afterwards
    // (the v5 return value predates it — assessment summaries are read-time)
    const currentView = await getSupplier(ctx, nordwind.id);
    expect(currentView.assessment!.version).toBe(2);

    // audit deep links
    const v4 = await getSupplierVersion(ctx, { supplierId: nordwind.id, version: 4 });
    expect(v4.changeKind).toBe('retired');
    expect(v4.recordedAt).toBe(retiredView.lastChange.recordedAt);
    await expectCode(
      'supplier_version_not_found',
      () => getSupplierVersion(ctx, { supplierId: nordwind.id, version: 6 }),
    );
  });

  it('rejects non-surgical lifecycle transitions, no-op and retired-record edits', async () => {
    await expectCode(
      'invalid_transition',
      () =>
        reviseSupplier(ctx, {
          supplierId: nordwind.id,
          status: 'active', // already active — a status revision must change the lifecycle
          actor: PERSON_PROC,
        }),
    );
    // a status change bundled with content is refused at the validation
    // gate (surgical transitions — the capabilities discipline)
    await expectCode(
      'invalid_supplier_input',
      () =>
        reviseSupplier(ctx, {
          supplierId: nordwind.id,
          status: 'retired',
          description: 'retiring and editing at once',
          actor: PERSON_PROC,
        }),
    );
    // a revision that changes nothing is refused as well
    await expectCode(
      'invalid_supplier_input',
      () => reviseSupplier(ctx, { supplierId: nordwind.id, actor: PERSON_PROC }),
    );
  });

  it('rejects duplicate names with the documented conflict code', async () => {
    await expectCode(
      'supplier_name_conflict',
      () =>
        registerSupplier(ctx, {
          name: 'Nordwind Metal',
          kind: 'subcontractor',
          actor: PERSON_PROC,
        }),
    );
  });

  it('records one scorecard per supplier and appends reassessments tri-state', async () => {
    expect(scorecard.version).toBe(2);
    expect(scorecard.lastChange.kind).toBe('reassessed');
    expect(scorecard.scores).toEqual({
      price: 0.9,
      quality: null, // cleared
      reliability: 0.6, // set
      capacity: null, // carried (was unscored)
      compliance: null,
      geography: null,
      switchingCost: null,
      alternatives: null,
    });
    expect(scorecard.evidenceObservationIds).toEqual([OBS_2]); // replaced wholesale
    expect(scorecard.note).toBeNull(); // cleared
    expect(scorecard.lastChange.rationale).toBe('Quarterly refresh');

    // one chain per supplier
    await expectCode(
      'scorecard_conflict',
      () =>
        recordScorecard(ctx, {
          supplierId: nordwind.id,
          scores: { price: 0.5 },
          actor: PERSON_PROC,
        }),
    );

    // the audit deep link keeps the original assessment
    const v1 = await getScorecardVersion(ctx, { scorecardId: scorecard.id, version: 1 });
    expect(v1.changeKind).toBe('assessed');
    expect(v1.scores.price).toBe(0.7);
    expect(v1.scores.quality).toBe(0.8);
    expect(v1.evidenceObservationIds).toEqual([OBS_1, OBS_2]);
    expect(v1.note).toBe('First assessment');
    const history = await listScorecardVersions(ctx, { scorecardId: scorecard.id });
    expect(history.map((v) => v.version)).toEqual([1, 2]);
    await expectCode(
      'scorecard_version_not_found',
      () => getScorecardVersion(ctx, { scorecardId: scorecard.id, version: 3 }),
    );

    // a merged snapshot that scores nothing is refused
    await expectCode(
      'invalid_scorecard_input',
      () =>
        reviseScorecard(ctx, {
          scorecardId: scorecard.id,
          scores: { price: null, reliability: null },
          actor: PERSON_PROC,
        }),
    );
  });

  it('refuses assessments against retired suppliers', async () => {
    const retiredSupplier = await registerSupplier(ctx, {
      name: 'Frozen Freight',
      kind: 'supplier',
      actor: PERSON_PROC,
    });
    await reviseSupplier(ctx, {
      supplierId: retiredSupplier.id,
      status: 'retired',
      actor: PERSON_PROC,
    });
    await expectCode(
      'invalid_transition',
      () =>
        recordScorecard(ctx, {
          supplierId: retiredSupplier.id,
          scores: { price: 0.5 },
          actor: PERSON_PROC,
        }),
    );
    // and reactivation reopens assessment
    await reviseSupplier(ctx, {
      supplierId: retiredSupplier.id,
      status: 'active',
      actor: PERSON_PROC,
    });
    const fresh = await recordScorecard(ctx, {
      supplierId: retiredSupplier.id,
      scores: { price: 0.5 },
      actor: PERSON_PROC,
    });
    expect(fresh.version).toBe(1);
    // retire again, then a revision of the live scorecard is also refused
    await reviseSupplier(ctx, {
      supplierId: retiredSupplier.id,
      status: 'retired',
      actor: PERSON_PROC,
    });
    await expectCode(
      'invalid_transition',
      () =>
        reviseScorecard(ctx, {
          scorecardId: fresh.id,
          scores: { price: 0.6 },
          actor: PERSON_PROC,
        }),
    );
  });

  it('rejects raw UPDATE/DELETE/TRUNCATE on the audit trail (storage-level)', async () => {
    await expectSqlRejection(`UPDATE supplier_versions SET description = 'forged'`);
    await expectSqlRejection(`DELETE FROM supplier_versions`);
    await expectSqlRejection(`UPDATE supplier_scorecard_versions SET price_score = 1`);
    await expectSqlRejection(`DELETE FROM supplier_scorecard_versions`);
    await expectSqlRejection(`DELETE FROM suppliers`);
    await expectSqlRejection(`DELETE FROM supplier_scorecards`);
    await expectSqlRejection(`TRUNCATE supplier_scorecard_versions`);
    await expectSqlRejection(`TRUNCATE suppliers`);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('supplier intelligence — tenant isolation', () => {
  const ctxMain = member(tenantMain);
  const ctxVersioned = member(tenantVersioned);
  const ctxIso = member(tenantIso);

  it('reads foreign-tenant suppliers, scorecards and versions as missing', async () => {
    const foreign = await listSuppliers(ctxMain, { name: 'Acme Logistics' });
    const foreignAcme = foreign[0]!;
    const foreignScorecard = foreignAcme.assessment!.scorecardId;
    const versioned = await listSuppliers(ctxVersioned, { name: 'Nordwind Metal' });
    const foreignNordwind = versioned[0]!;

    await expectCode('supplier_not_found', () => getSupplier(ctxIso, foreignAcme.id));
    await expectCode(
      'supplier_not_found',
      () => listSupplierVersions(ctxIso, { supplierId: foreignNordwind.id }),
    );
    await expectCode(
      'supplier_version_not_found',
      () => getSupplierVersion(ctxIso, { supplierId: foreignNordwind.id, version: 1 }),
    );
    await expectCode('scorecard_not_found', () => getScorecard(ctxIso, foreignScorecard));
    await expectCode(
      'scorecard_version_not_found',
      () => getScorecardVersion(ctxIso, { scorecardId: foreignScorecard, version: 1 }),
    );
    await expectCode(
      'scorecard_not_found',
      () => listScorecardVersions(ctxIso, { scorecardId: foreignScorecard }),
    );
    await expectCode(
      'supplier_not_found',
      () => getSupplierIntelligence(ctxIso, { supplierId: foreignAcme.id }),
    );
  });

  it('treats foreign-tenant supplier/scorecard ids on writes as missing', async () => {
    const foreign = (await listSuppliers(ctxMain, { name: 'Acme Logistics' }))[0]!;
    const foreignScorecard = foreign.assessment!.scorecardId;
    await expectCode(
      'supplier_not_found',
      () =>
        recordScorecard(ctxIso, {
          supplierId: foreign.id,
          scores: { price: 0.5 },
          actor: PERSON_PROC,
        }),
    );
    await expectCode(
      'scorecard_not_found',
      () =>
        reviseScorecard(ctxIso, {
          scorecardId: foreignScorecard,
          scores: { price: 0.5 },
          actor: PERSON_PROC,
        }),
    );
    await expectCode(
      'supplier_not_found',
      () =>
        reviseSupplier(ctxIso, {
          supplierId: foreign.id,
          description: 'cross-tenant edit',
          actor: PERSON_PROC,
        }),
    );
  });

  it('never leaks foreign data through listings, rankings or intelligence', async () => {
    // the isolation tenant registers exactly one supplier of its own
    const isoCorp = await registerSupplier(ctxIso, {
      name: 'Iso Corp',
      kind: 'supplier',
      actor: PERSON_PROC,
    });
    await recordScorecard(ctxIso, {
      supplierId: isoCorp.id,
      scores: { price: 1 },
      actor: PERSON_PROC,
    });

    expect(await listSuppliers(ctxIso, {})).toHaveLength(1);
    const ranking = await rankSuppliers(ctxIso, {});
    expect(ranking).toHaveLength(1);
    expect(ranking[0]!.supplier.name).toBe('Iso Corp');

    // the intelligence view sees only this tenant's capability graph —
    // the main tenant's supplies never leak in
    const view = await getSupplierIntelligence(ctxIso, { supplierId: isoCorp.id });
    expect(view.suppliedCapabilities).toEqual([]);
    expect(view.alternatives).toEqual([]);
    expect(view.scoring!.overall).toBe(1);
  });

  it('keeps malformed ids and bad contexts uniform', async () => {
    await expectCode('supplier_not_found', () => getSupplier(ctxMain, 'not-a-uuid'));
    await expectCode('scorecard_not_found', () => getScorecard(ctxMain, 'not-a-uuid'));
    await expectCode('supplier_not_found', () => getSupplier(ctxMain, newId()));
    const broken = { tenantId: '', principalId: newId(), authority: [] } as TenantContext;
    await expectCode('invalid_context', () => listSuppliers(broken, {}));
    await expectCode('invalid_context', () => rankSuppliers(broken, {}));
    await expectCode(
      'invalid_context',
      () => getSupplierIntelligence(broken, { supplierId: newId() }),
    );
    await expectCode(
      'invalid_query',
      () => rankSuppliers(ctxMain, { weights: { price: -1 } as never }),
    );
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
