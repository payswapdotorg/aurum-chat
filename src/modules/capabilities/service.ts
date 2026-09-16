// Implementation of the capabilities module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`capability_not_found` / `supply_not_found` /
// `requirement_not_found` and their version counterparts), including on
// versions, supplies and requirements.
//
// W017 acceptance — "Model capabilities supplied by employees, teams,
// agents, software, suppliers and partners; identify gaps and available
// alternatives" — is carried by these deliberate properties, all tested:
//   1. THE GRAPH IS VERSIONED UNDERSTANDING: each of the three record kinds
//      (capability / supply / requirement) is an identity plus an
//      append-only chain of full-snapshot versions in the goals (W008)
//      discipline. Revising appends version N+1; no update/delete operation
//      exists on the contract, and PostgreSQL itself rejects
//      UPDATE/DELETE/TRUNCATE on versions and DELETE/TRUNCATE on identities
//      (migration 001 triggers). Identity keys are immutable: the capability
//      name, the supply's supplier and the requirement's source can only be
//      expressed by NEW records, never by rewriting one.
//   2. THE SIX SUPPLY CHANNELS ARE FIRST-CLASS: a supply's supplier is one
//      of employee/team/agent/software/supplier/partner (the work item's
//      verbatim list), carried through storage CHECKs, listings and the
//      gap analysis's alternatives grouping.
//   3. GAPS AND ALTERNATIVES ARE DERIVED, NEVER STORED: `analyzeGaps` is a
//      deterministic pure function (gap.ts) over the CURRENT records, so it
//      can never drift from the state it summarizes (lock 10). Alternatives
//      are the capability's active supplies (each an available alternative
//      to the others, grouped by supplier kind) plus its retired supplies
//      (reactivation candidates).
//   4. LIFECYCLE IS SURGICAL: a status change must be the only change in
//      its revision, a retired record accepts nothing but reactivation, and
//      a supply cannot be asserted against a retired capability (the goals
//      module's transition discipline).
//   5. CONCURRENCY: every append runs inside one transaction that holds the
//      identity row lock (FOR UPDATE) and advances the pointer under an
//      optimistic `current_version = expected` guard — a losing writer
//      fails cleanly with `capability_conflict` / `supply_conflict` /
//      `requirement_conflict`.
//
// Storage shape: `capabilities` + `capability_versions`,
// `capability_supplies` + `capability_supply_versions`,
// `capability_requirements` + `capability_requirement_versions`.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { CapabilitiesError } from './errors';
import { computeCapabilityGaps, type GapResult } from './gap';
import {
  assertCapabilitiesTenantContext,
  escapeLike,
  isUuid,
  MAX_ANALYSIS_CAPABILITIES,
  partyKeyOf,
  validateAnalyzeGapsQuery,
  validateCapabilityHistoryQuery,
  validateCapabilityVersionQuery,
  validateListCapabilitiesQuery,
  validateListRequirementsQuery,
  validateListSuppliesQuery,
  validateRegisterCapabilityInput,
  validateRegisterRequirementInput,
  validateRegisterSupplyInput,
  validateRequirementHistoryQuery,
  validateRequirementVersionQuery,
  validateReviseCapabilityInput,
  validateReviseRequirementInput,
  validateReviseSupplyInput,
  validateSupplyHistoryQuery,
  validateSupplyVersionQuery,
  type ValidatedParty,
  type ValidatedRegisterCapabilityInput,
  type ValidatedRegisterRequirementInput,
  type ValidatedRegisterSupplyInput,
  type ValidatedReviseCapabilityInput,
  type ValidatedReviseRequirementInput,
  type ValidatedReviseSupplyInput,
} from './validation';
import type {
  Capability,
  CapabilityActor,
  CapabilityRequirement,
  CapabilityRequirementSummary,
  CapabilityRequirementVersion,
  CapabilitySupply,
  CapabilitySupplySummary,
  CapabilitySupplyVersion,
  CapabilityVersion,
  CapabilityRecordStatus,
  ListCapabilitiesQuery,
  ListRequirementsQuery,
  ListSuppliesQuery,
  AnalyzeGapsQuery,
  RegisterCapabilityInput,
  RegisterRequirementInput,
  RegisterSupplyInput,
  RequirementSource,
  ReviseCapabilityInput,
  ReviseRequirementInput,
  ReviseSupplyInput,
  CapabilitySupplier,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

interface CapabilityVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  capability_id: string;
  version: number | string;
  change_kind: string;
  name: string;
  description: string | null;
  world_entity_id: string | null;
  status: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the capability current-view join (capabilities ⋈ current versions). */
interface CapabilityRow extends DbRow {
  capability_id: string;
  capability_tenant_id: string;
  capability_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  name: string;
  description: string | null;
  world_entity_id: string | null;
  status: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface SupplyVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  supply_id: string;
  capability_id: string;
  version: number | string;
  change_kind: string;
  supplier_kind: string;
  supplier_key: string;
  supplier_id: string | null;
  supplier_label: string | null;
  level: number;
  capacity: number | null;
  status: string;
  evidence_observation_ids: unknown;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the supply current-view join (supplies ⋈ current versions). */
interface SupplyRow extends DbRow {
  supply_id: string;
  supply_tenant_id: string;
  capability_id: string;
  supply_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  supplier_kind: string;
  supplier_id: string | null;
  supplier_label: string | null;
  level: number;
  capacity: number | null;
  status: string;
  evidence_observation_ids: unknown;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface RequirementVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  requirement_id: string;
  capability_id: string;
  version: number | string;
  change_kind: string;
  source_kind: string;
  source_key: string;
  source_id: string | null;
  source_label: string | null;
  level: number;
  capacity: number | null;
  status: string;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the requirement current-view join (requirements ⋈ current versions). */
interface RequirementRow extends DbRow {
  requirement_id: string;
  requirement_tenant_id: string;
  capability_id: string;
  requirement_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  source_kind: string;
  source_id: string | null;
  source_label: string | null;
  level: number;
  capacity: number | null;
  status: string;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

/** jsonb arrays arrive parsed on both backends; storage is write-validated. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function mapActorOf(row: {
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
}): CapabilityActor {
  return {
    kind: row.actor_kind as CapabilityActor['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

function mapChangeOf(row: {
  change_kind: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}): Capability['lastChange'] {
  return {
    kind: row.change_kind as Capability['lastChange']['kind'], // CHECK-constrained
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapCapabilityVersion(row: CapabilityVersionRow): CapabilityVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    capabilityId: row.capability_id,
    version: toInt(row.version),
    changeKind: row.change_kind as CapabilityVersion['changeKind'], // CHECK-constrained
    name: row.name,
    description: row.description,
    worldEntityId: row.world_entity_id,
    status: row.status as CapabilityVersion['status'], // CHECK-constrained
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapSupplyVersion(row: SupplyVersionRow): CapabilitySupplyVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    supplyId: row.supply_id,
    capabilityId: row.capability_id,
    version: toInt(row.version),
    changeKind: row.change_kind as CapabilitySupplyVersion['changeKind'], // CHECK-constrained
    supplier: mapSupplierOf(row),
    level: row.level,
    capacity: row.capacity,
    status: row.status as CapabilitySupplyVersion['status'], // CHECK-constrained
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    note: row.note,
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapRequirementVersion(row: RequirementVersionRow): CapabilityRequirementVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requirementId: row.requirement_id,
    capabilityId: row.capability_id,
    version: toInt(row.version),
    changeKind: row.change_kind as CapabilityRequirementVersion['changeKind'], // CHECK-constrained
    source: mapSourceOf(row),
    level: row.level,
    capacity: row.capacity,
    status: row.status as CapabilityRequirementVersion['status'], // CHECK-constrained
    note: row.note,
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapSupplierOf(row: {
  supplier_kind: string;
  supplier_id: string | null;
  supplier_label: string | null;
}): CapabilitySupplier {
  return {
    kind: row.supplier_kind as CapabilitySupplier['kind'], // CHECK-constrained
    id: row.supplier_id,
    label: row.supplier_label,
  };
}

function mapSourceOf(row: {
  source_kind: string;
  source_id: string | null;
  source_label: string | null;
}): RequirementSource {
  return {
    kind: row.source_kind as RequirementSource['kind'], // CHECK-constrained
    id: row.source_id,
    label: row.source_label,
  };
}

function mapCapability(
  row: CapabilityRow,
  supplySummary: CapabilitySupplySummary,
  requirementSummary: CapabilityRequirementSummary,
): Capability {
  return {
    id: row.capability_id,
    tenantId: row.capability_tenant_id,
    name: row.name,
    version: toInt(row.version_number),
    description: row.description,
    worldEntityId: row.world_entity_id,
    status: row.status as Capability['status'], // CHECK-constrained
    supplySummary,
    requirementSummary,
    createdAt: toIso(row.capability_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: mapChangeOf(row),
  };
}

function mapSupply(row: SupplyRow): CapabilitySupply {
  return {
    id: row.supply_id,
    tenantId: row.supply_tenant_id,
    capabilityId: row.capability_id,
    supplier: mapSupplierOf(row),
    version: toInt(row.version_number),
    level: row.level,
    capacity: row.capacity,
    status: row.status as CapabilitySupply['status'], // CHECK-constrained
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    note: row.note,
    createdAt: toIso(row.supply_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: mapChangeOf(row),
  };
}

function mapRequirement(row: RequirementRow): CapabilityRequirement {
  return {
    id: row.requirement_id,
    tenantId: row.requirement_tenant_id,
    capabilityId: row.capability_id,
    source: mapSourceOf(row),
    version: toInt(row.version_number),
    level: row.level,
    capacity: row.capacity,
    status: row.status as CapabilityRequirement['status'], // CHECK-constrained
    note: row.note,
    createdAt: toIso(row.requirement_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: mapChangeOf(row),
  };
}

function emptySupplySummary(): CapabilitySupplySummary {
  return {
    activeCount: 0,
    retiredCount: 0,
    activeByKind: { employee: 0, team: 0, agent: 0, software: 0, supplier: 0, partner: 0 },
  };
}

function emptyRequirementSummary(): CapabilityRequirementSummary {
  return { activeCount: 0, retiredCount: 0 };
}

function capabilityNotFound(capabilityId: string): CapabilitiesError {
  return new CapabilitiesError(
    'capability_not_found',
    `capability '${capabilityId}' does not exist in this tenant`,
  );
}

function supplyNotFound(supplyId: string): CapabilitiesError {
  return new CapabilitiesError(
    'supply_not_found',
    `supply '${supplyId}' does not exist in this tenant`,
  );
}

function requirementNotFound(requirementId: string): CapabilitiesError {
  return new CapabilitiesError(
    'requirement_not_found',
    `requirement '${requirementId}' does not exist in this tenant`,
  );
}

/** True when `error` is a PostgreSQL unique violation naming `table`. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

/** Service-derived change kind of a lifecycle/content revision (goals discipline). */
function deriveChangeKind(
  currentStatus: CapabilityRecordStatus,
  nextStatus: CapabilityRecordStatus,
): 'revised' | 'retired' | 'reactivated' {
  if (currentStatus === 'active' && nextStatus === 'retired') return 'retired';
  if (currentStatus === 'retired' && nextStatus === 'active') return 'reactivated';
  return 'revised';
}

// ---------------------------------------------------------------------------
// Shared SQL of the version appends
// ---------------------------------------------------------------------------

async function capabilityVersionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    capabilityId: string;
    version: number;
    changeKind: CapabilityVersion['changeKind'];
    name: string;
    description: string | null;
    worldEntityId: string | null;
    status: CapabilityRecordStatus;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<CapabilityVersionRow>> {
  return tx.query<CapabilityVersionRow>(
    `INSERT INTO capability_versions (
       tenant_id, capability_id, version, change_kind, name, description, world_entity_id, status,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)
     RETURNING *`,
    [
      params.tenantId,
      params.capabilityId,
      params.version,
      params.changeKind,
      params.name,
      params.description,
      params.worldEntityId,
      params.status,
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

async function supplyVersionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    supplyId: string;
    capabilityId: string;
    version: number;
    changeKind: CapabilitySupplyVersion['changeKind'];
    supplier: ValidatedParty;
    level: number;
    capacity: number | null;
    status: CapabilityRecordStatus;
    evidenceObservationIds: string[];
    note: string | null;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<SupplyVersionRow>> {
  return tx.query<SupplyVersionRow>(
    `INSERT INTO capability_supply_versions (
       tenant_id, supply_id, capability_id, version, change_kind,
       supplier_kind, supplier_key, supplier_id, supplier_label,
       level, capacity, status, evidence_observation_ids, note,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13::jsonb, $14,
       $15, $16, $17, $18, $19, $20::timestamptz
     ) RETURNING *`,
    [
      params.tenantId,
      params.supplyId,
      params.capabilityId,
      params.version,
      params.changeKind,
      params.supplier.kind,
      partyKeyOf(params.supplier),
      params.supplier.id,
      params.supplier.label,
      params.level,
      params.capacity,
      params.status,
      JSON.stringify(params.evidenceObservationIds),
      params.note,
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

async function requirementVersionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    requirementId: string;
    capabilityId: string;
    version: number;
    changeKind: CapabilityRequirementVersion['changeKind'];
    source: ValidatedParty;
    level: number;
    capacity: number | null;
    status: CapabilityRecordStatus;
    note: string | null;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<RequirementVersionRow>> {
  return tx.query<RequirementVersionRow>(
    `INSERT INTO capability_requirement_versions (
       tenant_id, requirement_id, capability_id, version, change_kind,
       source_kind, source_key, source_id, source_label,
       level, capacity, status, note,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19::timestamptz
     ) RETURNING *`,
    [
      params.tenantId,
      params.requirementId,
      params.capabilityId,
      params.version,
      params.changeKind,
      params.source.kind,
      partyKeyOf(params.source),
      params.source.id,
      params.source.label,
      params.level,
      params.capacity,
      params.status,
      params.note,
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// Current-view SQL fragments
// ---------------------------------------------------------------------------

const CAPABILITY_VIEW_FROM = `FROM capabilities c
  INNER JOIN capability_versions cv
    ON cv.capability_id = c.id AND cv.tenant_id = c.tenant_id AND cv.version = c.current_version`;

const CAPABILITY_VIEW_COLUMNS = `SELECT
    c.id AS capability_id, c.tenant_id AS capability_tenant_id, c.created_at AS capability_created_at,
    cv.version AS version_number, cv.change_kind, cv.name, cv.description, cv.world_entity_id, cv.status,
    cv.actor_kind, cv.actor_id, cv.actor_label,
    cv.changed_by_principal, cv.rationale, cv.recorded_at`;

const SUPPLY_VIEW_FROM = `FROM capability_supplies cs
  INNER JOIN capability_supply_versions csv
    ON csv.supply_id = cs.id AND csv.tenant_id = cs.tenant_id AND csv.version = cs.current_version`;

const SUPPLY_VIEW_COLUMNS = `SELECT
    cs.id AS supply_id, cs.tenant_id AS supply_tenant_id, cs.capability_id, cs.created_at AS supply_created_at,
    csv.version AS version_number, csv.change_kind,
    csv.supplier_kind, csv.supplier_id, csv.supplier_label,
    csv.level, csv.capacity, csv.status, csv.evidence_observation_ids, csv.note,
    csv.actor_kind, csv.actor_id, csv.actor_label,
    csv.changed_by_principal, csv.rationale, csv.recorded_at`;

const REQUIREMENT_VIEW_FROM = `FROM capability_requirements cr
  INNER JOIN capability_requirement_versions crv
    ON crv.requirement_id = cr.id AND crv.tenant_id = cr.tenant_id AND crv.version = cr.current_version`;

const REQUIREMENT_VIEW_COLUMNS = `SELECT
    cr.id AS requirement_id, cr.tenant_id AS requirement_tenant_id, cr.capability_id, cr.created_at AS requirement_created_at,
    crv.version AS version_number, crv.change_kind,
    crv.source_kind, crv.source_id, crv.source_label,
    crv.level, crv.capacity, crv.status, crv.note,
    crv.actor_kind, crv.actor_id, crv.actor_label,
    crv.changed_by_principal, crv.rationale, crv.recorded_at`;

/**
 * Supply + requirement summaries of the CURRENT versions for a page of
 * capabilities, in two grouped queries (the processes module's
 * currentFindingCounts precedent).
 */
async function currentSummaries(
  q: Queryable,
  ctx: TenantContext,
  capabilityIds: string[],
): Promise<Map<string, { supply: CapabilitySupplySummary; requirement: CapabilityRequirementSummary }>> {
  const summaries = new Map<
    string,
    { supply: CapabilitySupplySummary; requirement: CapabilityRequirementSummary }
  >();
  if (capabilityIds.length === 0) return summaries;

  const supplyRows = await q.query<{
    capability_id: string;
    status: string;
    supplier_kind: string;
    n: number | string;
  }>(
    `SELECT cs.capability_id, csv.status, cs.supplier_kind, count(*) AS n
       FROM capability_supplies cs
       INNER JOIN capability_supply_versions csv
         ON csv.supply_id = cs.id AND csv.tenant_id = cs.tenant_id AND csv.version = cs.current_version
      WHERE cs.tenant_id = $1 AND cs.capability_id = ANY($2::uuid[])
      GROUP BY cs.capability_id, csv.status, cs.supplier_kind`,
    [ctx.tenantId, capabilityIds],
  );
  for (const row of supplyRows.rows) {
    const entry = summaries.get(row.capability_id) ?? {
      supply: emptySupplySummary(),
      requirement: emptyRequirementSummary(),
    };
    const n = toInt(row.n);
    if (row.status === 'active') {
      entry.supply.activeCount += n;
      if (row.supplier_kind in entry.supply.activeByKind) {
        entry.supply.activeByKind[row.supplier_kind as keyof CapabilitySupplySummary['activeByKind']] += n;
      }
    } else {
      entry.supply.retiredCount += n;
    }
    summaries.set(row.capability_id, entry);
  }

  const requirementRows = await q.query<{ capability_id: string; status: string; n: number | string }>(
    `SELECT cr.capability_id, crv.status, count(*) AS n
       FROM capability_requirements cr
       INNER JOIN capability_requirement_versions crv
         ON crv.requirement_id = cr.id AND crv.tenant_id = cr.tenant_id AND crv.version = cr.current_version
      WHERE cr.tenant_id = $1 AND cr.capability_id = ANY($2::uuid[])
      GROUP BY cr.capability_id, crv.status`,
    [ctx.tenantId, capabilityIds],
  );
  for (const row of requirementRows.rows) {
    const entry = summaries.get(row.capability_id) ?? {
      supply: emptySupplySummary(),
      requirement: emptyRequirementSummary(),
    };
    if (row.status === 'active') entry.requirement.activeCount += toInt(row.n);
    else entry.requirement.retiredCount += toInt(row.n);
    summaries.set(row.capability_id, entry);
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Capability register / revise
// ---------------------------------------------------------------------------

export async function registerCapability(
  ctx: TenantContext,
  input: RegisterCapabilityInput,
): Promise<Capability> {
  assertCapabilitiesTenantContext(ctx);
  const valid: ValidatedRegisterCapabilityInput = validateRegisterCapabilityInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Identity row first (id minted by PostgreSQL); version 1 follows in the
    // same transaction — a capability never exists without its initial
    // registration. The name is the immutable tenant-unique graph key.
    let created: DbResult<{ id: string; created_at: Date | string }>;
    try {
      created = await tx.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO capabilities (tenant_id, name, created_at) VALUES ($1, $2, $3)
           RETURNING id, created_at`,
        [ctx.tenantId, valid.name, recordedAt],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'capabilities')) {
        throw new CapabilitiesError(
          'capability_name_conflict',
          `a capability named '${valid.name}' already exists in this tenant; revise it instead of registering the name again`,
        );
      }
      throw error;
    }
    const identity = created.rows[0]!;

    const inserted = await capabilityVersionInsert(tx, {
      tenantId: ctx.tenantId,
      capabilityId: identity.id,
      version: 1,
      changeKind: 'created',
      name: valid.name,
      description: valid.description,
      worldEntityId: valid.worldEntityId,
      status: 'active', // capabilities are active upon registration
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapCapabilityVersion(inserted.rows[0]!);

    return {
      id: identity.id,
      tenantId: ctx.tenantId,
      name: version.name,
      version: version.version,
      description: version.description,
      worldEntityId: version.worldEntityId,
      status: version.status,
      supplySummary: emptySupplySummary(),
      requirementSummary: emptyRequirementSummary(),
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

/** Loads the current version row of one capability inside `tx` (tenant-scoped). */
async function loadCurrentCapabilityVersion(
  tx: Queryable,
  ctx: TenantContext,
  capabilityId: string,
): Promise<CapabilityVersionRow> {
  const rows = await tx.query<CapabilityVersionRow>(
    `SELECT cv.* FROM capability_versions cv
       INNER JOIN capabilities c ON c.id = cv.capability_id AND c.tenant_id = cv.tenant_id
      WHERE cv.tenant_id = $1 AND cv.capability_id = $2 AND cv.version = c.current_version`,
    [ctx.tenantId, capabilityId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw capabilityNotFound(capabilityId);
  return row;
}

export async function reviseCapability(
  ctx: TenantContext,
  input: ReviseCapabilityInput,
): Promise<Capability> {
  assertCapabilitiesTenantContext(ctx);
  const valid: ValidatedReviseCapabilityInput = validateReviseCapabilityInput(input);

  if (!isUuid(valid.capabilityId)) {
    // Malformed ids are indistinguishable from missing capabilities (no leak).
    throw capabilityNotFound(valid.capabilityId);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Row lock on the identity: concurrent revisers of one capability
    // serialize here, which is what keeps the version chain gapless.
    const locked = await tx.query<{
      id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, current_version, created_at FROM capabilities
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.capabilityId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw capabilityNotFound(valid.capabilityId);
    const currentVersionNumber = toInt(identity.current_version);

    const current = mapCapabilityVersion(
      await loadCurrentCapabilityVersion(tx, ctx, valid.capabilityId),
    );

    // --- lifecycle transition gate (surgical, service-level) ---
    const patch = valid.patch;
    if (patch.status !== undefined && patch.status === current.status) {
      throw new CapabilitiesError(
        'invalid_transition',
        `capability '${valid.capabilityId}' is already ${patch.status} — a status revision must change the lifecycle`,
      );
    }
    if (current.status === 'retired' && patch.status !== 'active') {
      throw new CapabilitiesError(
        'invalid_transition',
        `capability '${valid.capabilityId}' is retired — the only accepted change is a reactivation (status: 'active'); retirement rationale lives on the retirement version`,
      );
    }

    // --- merge patch into the current content (undefined = carry over,
    //     null = clear — the goals module's tri-state discipline) ---
    const description = patch.description !== undefined ? patch.description : current.description;
    const worldEntityId =
      patch.worldEntityId !== undefined ? patch.worldEntityId : current.worldEntityId;
    const nextStatus = patch.status ?? current.status;
    const changeKind = deriveChangeKind(current.status, nextStatus);

    const nextVersion = currentVersionNumber + 1;
    // Optimistic guard: the pointer moves exactly one step from the version
    // this revision was based on (defense in depth on top of the row lock).
    const moved = await tx.query(
      `UPDATE capabilities SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.capabilityId, nextVersion, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new CapabilitiesError(
        'capability_conflict',
        'a concurrent revision moved this capability forward; re-read it and retry',
      );
    }

    let inserted: DbResult<CapabilityVersionRow>;
    try {
      inserted = await capabilityVersionInsert(tx, {
        tenantId: ctx.tenantId,
        capabilityId: valid.capabilityId,
        version: nextVersion,
        changeKind,
        name: current.name, // immutable graph key
        description,
        worldEntityId,
        status: nextStatus,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'capability_versions')) {
        throw new CapabilitiesError(
          'capability_conflict',
          'a concurrent revision appended this version number first; re-read the capability and retry',
        );
      }
      throw error;
    }
    const version = mapCapabilityVersion(inserted.rows[0]!);
    const summaries = await currentSummaries(tx, ctx, [valid.capabilityId]);
    const summary = summaries.get(valid.capabilityId);

    return {
      id: valid.capabilityId,
      tenantId: ctx.tenantId,
      name: version.name,
      version: version.version,
      description: version.description,
      worldEntityId: version.worldEntityId,
      status: version.status,
      supplySummary: summary?.supply ?? emptySupplySummary(),
      requirementSummary: summary?.requirement ?? emptyRequirementSummary(),
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Supply register / revise
// ---------------------------------------------------------------------------

export async function registerSupply(
  ctx: TenantContext,
  input: RegisterSupplyInput,
): Promise<CapabilitySupply> {
  assertCapabilitiesTenantContext(ctx);
  const valid: ValidatedRegisterSupplyInput = validateRegisterSupplyInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Lock the capability identity: the supply append serializes against a
    // concurrent capability retirement (which holds the same lock), and the
    // capability must exist and be active — a retired capability is out of
    // the graph's operating scope and accepts no new supply.
    const locked = await tx.query<{ id: string }>(
      `SELECT id FROM capabilities WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.capabilityId],
    );
    if (locked.rows.length === 0) throw capabilityNotFound(valid.capabilityId);
    const current = await loadCurrentCapabilityVersion(tx, ctx, valid.capabilityId);
    if (current.status !== 'active') {
      throw new CapabilitiesError(
        'invalid_transition',
        `capability '${valid.capabilityId}' is retired — a retired capability accepts no new supply; reactivate it first`,
      );
    }

    let created: DbResult<{ id: string; created_at: Date | string }>;
    try {
      created = await tx.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO capability_supplies (
           tenant_id, capability_id, supplier_kind, supplier_key, supplier_id, supplier_label, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at`,
        [
          ctx.tenantId,
          valid.capabilityId,
          valid.supplier.kind,
          partyKeyOf(valid.supplier),
          valid.supplier.id,
          valid.supplier.label,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'capability_supplies')) {
        throw new CapabilitiesError(
          'supply_conflict',
          `a supply of capability '${valid.capabilityId}' by this ${valid.supplier.kind} is already registered in this tenant; revise it instead of registering the pair again`,
        );
      }
      throw error;
    }
    const identity = created.rows[0]!;

    const inserted = await supplyVersionInsert(tx, {
      tenantId: ctx.tenantId,
      supplyId: identity.id,
      capabilityId: valid.capabilityId,
      version: 1,
      changeKind: 'asserted',
      supplier: valid.supplier,
      level: valid.level,
      capacity: valid.capacity,
      status: 'active', // supplies are active upon assertion
      evidenceObservationIds: valid.evidenceObservationIds,
      note: valid.note,
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapSupplyVersion(inserted.rows[0]!);

    return {
      id: identity.id,
      tenantId: ctx.tenantId,
      capabilityId: valid.capabilityId,
      supplier: version.supplier,
      version: version.version,
      level: version.level,
      capacity: version.capacity,
      status: version.status,
      evidenceObservationIds: version.evidenceObservationIds,
      note: version.note,
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

/** Loads the current version row of one supply inside `tx` (tenant-scoped). */
async function loadCurrentSupplyVersion(
  tx: Queryable,
  ctx: TenantContext,
  supplyId: string,
): Promise<SupplyVersionRow> {
  const rows = await tx.query<SupplyVersionRow>(
    `SELECT csv.* FROM capability_supply_versions csv
       INNER JOIN capability_supplies cs ON cs.id = csv.supply_id AND cs.tenant_id = csv.tenant_id
      WHERE csv.tenant_id = $1 AND csv.supply_id = $2 AND csv.version = cs.current_version`,
    [ctx.tenantId, supplyId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw supplyNotFound(supplyId);
  return row;
}

export async function reviseSupply(
  ctx: TenantContext,
  input: ReviseSupplyInput,
): Promise<CapabilitySupply> {
  assertCapabilitiesTenantContext(ctx);
  const valid: ValidatedReviseSupplyInput = validateReviseSupplyInput(input);

  if (!isUuid(valid.supplyId)) throw supplyNotFound(valid.supplyId);

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    const locked = await tx.query<{
      id: string;
      capability_id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, capability_id, current_version, created_at FROM capability_supplies
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.supplyId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw supplyNotFound(valid.supplyId);
    const currentVersionNumber = toInt(identity.current_version);

    const current = mapSupplyVersion(await loadCurrentSupplyVersion(tx, ctx, valid.supplyId));

    // --- lifecycle transition gate ---
    const patch = valid.patch;
    if (patch.status !== undefined && patch.status === current.status) {
      throw new CapabilitiesError(
        'invalid_transition',
        `supply '${valid.supplyId}' is already ${patch.status} — a status revision must change the lifecycle`,
      );
    }
    if (current.status === 'retired' && patch.status !== 'active') {
      throw new CapabilitiesError(
        'invalid_transition',
        `supply '${valid.supplyId}' is retired — the only accepted change is a reactivation (status: 'active'); retirement rationale lives on the retirement version`,
      );
    }

    // --- merge patch (undefined = carry over, null = clear) ---
    const level = patch.level !== undefined ? patch.level : current.level;
    const capacity = patch.capacity !== undefined ? patch.capacity : current.capacity;
    const evidenceObservationIds =
      patch.evidenceObservationIds !== undefined
        ? patch.evidenceObservationIds
        : current.evidenceObservationIds;
    const note = patch.note !== undefined ? patch.note : current.note;
    const nextStatus = patch.status ?? current.status;
    const changeKind = deriveChangeKind(current.status, nextStatus);

    const nextVersion = currentVersionNumber + 1;
    const moved = await tx.query(
      `UPDATE capability_supplies SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.supplyId, nextVersion, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new CapabilitiesError(
        'supply_conflict',
        'a concurrent revision moved this supply forward; re-read it and retry',
      );
    }

    let inserted: DbResult<SupplyVersionRow>;
    try {
      inserted = await supplyVersionInsert(tx, {
        tenantId: ctx.tenantId,
        supplyId: valid.supplyId,
        capabilityId: identity.capability_id,
        version: nextVersion,
        changeKind,
        supplier: {
          kind: current.supplier.kind,
          id: current.supplier.id ?? null,
          label: current.supplier.label ?? null,
        }, // immutable identity content
        level,
        capacity,
        status: nextStatus,
        evidenceObservationIds,
        note,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'capability_supply_versions')) {
        throw new CapabilitiesError(
          'supply_conflict',
          'a concurrent revision appended this version number first; re-read the supply and retry',
        );
      }
      throw error;
    }
    const version = mapSupplyVersion(inserted.rows[0]!);

    return {
      id: valid.supplyId,
      tenantId: ctx.tenantId,
      capabilityId: version.capabilityId,
      supplier: version.supplier,
      version: version.version,
      level: version.level,
      capacity: version.capacity,
      status: version.status,
      evidenceObservationIds: version.evidenceObservationIds,
      note: version.note,
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Requirement register / revise
// ---------------------------------------------------------------------------

export async function registerRequirement(
  ctx: TenantContext,
  input: RegisterRequirementInput,
): Promise<CapabilityRequirement> {
  assertCapabilitiesTenantContext(ctx);
  const valid: ValidatedRegisterRequirementInput = validateRegisterRequirementInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Same capability gate as registerSupply: exist + active + serialized
    // against retirement.
    const locked = await tx.query<{ id: string }>(
      `SELECT id FROM capabilities WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.capabilityId],
    );
    if (locked.rows.length === 0) throw capabilityNotFound(valid.capabilityId);
    const current = await loadCurrentCapabilityVersion(tx, ctx, valid.capabilityId);
    if (current.status !== 'active') {
      throw new CapabilitiesError(
        'invalid_transition',
        `capability '${valid.capabilityId}' is retired — a retired capability accepts no new requirement; reactivate it first`,
      );
    }

    let created: DbResult<{ id: string; created_at: Date | string }>;
    try {
      created = await tx.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO capability_requirements (
           tenant_id, capability_id, source_kind, source_key, source_id, source_label, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at`,
        [
          ctx.tenantId,
          valid.capabilityId,
          valid.source.kind,
          partyKeyOf(valid.source),
          valid.source.id,
          valid.source.label,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'capability_requirements')) {
        throw new CapabilitiesError(
          'requirement_conflict',
          `a requirement of capability '${valid.capabilityId}' from this ${valid.source.kind} is already registered in this tenant; revise it instead of registering the pair again`,
        );
      }
      throw error;
    }
    const identity = created.rows[0]!;

    const inserted = await requirementVersionInsert(tx, {
      tenantId: ctx.tenantId,
      requirementId: identity.id,
      capabilityId: valid.capabilityId,
      version: 1,
      changeKind: 'declared',
      source: valid.source,
      level: valid.level,
      capacity: valid.capacity,
      status: 'active', // requirements are active upon declaration
      note: valid.note,
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapRequirementVersion(inserted.rows[0]!);

    return {
      id: identity.id,
      tenantId: ctx.tenantId,
      capabilityId: valid.capabilityId,
      source: version.source,
      version: version.version,
      level: version.level,
      capacity: version.capacity,
      status: version.status,
      note: version.note,
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

/** Loads the current version row of one requirement inside `tx` (tenant-scoped). */
async function loadCurrentRequirementVersion(
  tx: Queryable,
  ctx: TenantContext,
  requirementId: string,
): Promise<RequirementVersionRow> {
  const rows = await tx.query<RequirementVersionRow>(
    `SELECT crv.* FROM capability_requirement_versions crv
       INNER JOIN capability_requirements cr
         ON cr.id = crv.requirement_id AND cr.tenant_id = crv.tenant_id
      WHERE crv.tenant_id = $1 AND crv.requirement_id = $2 AND crv.version = cr.current_version`,
    [ctx.tenantId, requirementId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw requirementNotFound(requirementId);
  return row;
}

export async function reviseRequirement(
  ctx: TenantContext,
  input: ReviseRequirementInput,
): Promise<CapabilityRequirement> {
  assertCapabilitiesTenantContext(ctx);
  const valid: ValidatedReviseRequirementInput = validateReviseRequirementInput(input);

  if (!isUuid(valid.requirementId)) throw requirementNotFound(valid.requirementId);

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    const locked = await tx.query<{
      id: string;
      capability_id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, capability_id, current_version, created_at FROM capability_requirements
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.requirementId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw requirementNotFound(valid.requirementId);
    const currentVersionNumber = toInt(identity.current_version);

    const current = mapRequirementVersion(
      await loadCurrentRequirementVersion(tx, ctx, valid.requirementId),
    );

    // --- lifecycle transition gate ---
    const patch = valid.patch;
    if (patch.status !== undefined && patch.status === current.status) {
      throw new CapabilitiesError(
        'invalid_transition',
        `requirement '${valid.requirementId}' is already ${patch.status} — a status revision must change the lifecycle`,
      );
    }
    if (current.status === 'retired' && patch.status !== 'active') {
      throw new CapabilitiesError(
        'invalid_transition',
        `requirement '${valid.requirementId}' is retired — the only accepted change is a reactivation (status: 'active'); retirement rationale lives on the retirement version`,
      );
    }

    // --- merge patch (undefined = carry over, null = clear) ---
    const level = patch.level !== undefined ? patch.level : current.level;
    const capacity = patch.capacity !== undefined ? patch.capacity : current.capacity;
    const note = patch.note !== undefined ? patch.note : current.note;
    const nextStatus = patch.status ?? current.status;
    const changeKind = deriveChangeKind(current.status, nextStatus);

    const nextVersion = currentVersionNumber + 1;
    const moved = await tx.query(
      `UPDATE capability_requirements SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.requirementId, nextVersion, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new CapabilitiesError(
        'requirement_conflict',
        'a concurrent revision moved this requirement forward; re-read it and retry',
      );
    }

    let inserted: DbResult<RequirementVersionRow>;
    try {
      inserted = await requirementVersionInsert(tx, {
        tenantId: ctx.tenantId,
        requirementId: valid.requirementId,
        capabilityId: identity.capability_id,
        version: nextVersion,
        changeKind,
        source: {
          kind: current.source.kind,
          id: current.source.id ?? null,
          label: current.source.label ?? null,
        }, // immutable identity content
        level,
        capacity,
        status: nextStatus,
        note,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'capability_requirement_versions')) {
        throw new CapabilitiesError(
          'requirement_conflict',
          'a concurrent revision appended this version number first; re-read the requirement and retry',
        );
      }
      throw error;
    }
    const version = mapRequirementVersion(inserted.rows[0]!);

    return {
      id: valid.requirementId,
      tenantId: ctx.tenantId,
      capabilityId: version.capabilityId,
      source: version.source,
      version: version.version,
      level: version.level,
      capacity: version.capacity,
      status: version.status,
      note: version.note,
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Reads — capabilities
// ---------------------------------------------------------------------------

export async function getCapability(
  ctx: TenantContext,
  capabilityId: string,
): Promise<Capability> {
  assertCapabilitiesTenantContext(ctx);
  if (!isUuid(capabilityId)) throw capabilityNotFound(capabilityId);

  const rows = await getDb().query<CapabilityRow>(
    `${CAPABILITY_VIEW_COLUMNS} ${CAPABILITY_VIEW_FROM}
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [ctx.tenantId, capabilityId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw capabilityNotFound(capabilityId);
  const summaries = await currentSummaries(getDb(), ctx, [row.capability_id]);
  const summary = summaries.get(row.capability_id);
  return mapCapability(
    row,
    summary?.supply ?? emptySupplySummary(),
    summary?.requirement ?? emptyRequirementSummary(),
  );
}

export async function listCapabilities(
  ctx: TenantContext,
  query: ListCapabilitiesQuery,
): Promise<Capability[]> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateListCapabilitiesQuery(query);

  const conditions: string[] = ['c.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.name !== null) add('cv.name = $#', valid.name);
  if (valid.search !== null) {
    // escaped substring match on the name — caller text is never a wildcard
    // pattern (the missions module's ILIKE discipline).
    add("cv.name ILIKE '%' || $# || '%' ESCAPE '\\'", escapeLike(valid.search));
  }
  if (valid.status !== null) add('cv.status = $#', valid.status);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<CapabilityRow>(
    `${CAPABILITY_VIEW_COLUMNS} ${CAPABILITY_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY cv.name ASC, c.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  if (rows.rows.length === 0) return [];
  const summaries = await currentSummaries(
    getDb(),
    ctx,
    rows.rows.map((row) => row.capability_id),
  );
  return rows.rows.map((row) => {
    const summary = summaries.get(row.capability_id);
    return mapCapability(
      row,
      summary?.supply ?? emptySupplySummary(),
      summary?.requirement ?? emptyRequirementSummary(),
    );
  });
}

export async function getCapabilityVersion(
  ctx: TenantContext,
  query: { capabilityId: string; version: number },
): Promise<CapabilityVersion> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateCapabilityVersionQuery(query);
  const rows = await getDb().query<CapabilityVersionRow>(
    `SELECT * FROM capability_versions WHERE tenant_id = $1 AND capability_id = $2 AND version = $3`,
    [ctx.tenantId, valid.capabilityId!, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new CapabilitiesError(
      'capability_version_not_found',
      `version ${valid.version} of capability '${valid.capabilityId}' does not exist in this tenant`,
    );
  }
  return mapCapabilityVersion(row);
}

export async function listCapabilityVersions(
  ctx: TenantContext,
  query: { capabilityId: string },
): Promise<CapabilityVersion[]> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateCapabilityHistoryQuery(query);
  const rows = await getDb().query<CapabilityVersionRow>(
    `SELECT * FROM capability_versions WHERE tenant_id = $1 AND capability_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.capabilityId!],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such capability in this tenant" from "a capability
    // without history" (impossible by construction) — a foreign-tenant
    // capability id reads the same as a missing one either way.
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM capabilities WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.capabilityId!],
    );
    if (exists.rows.length === 0) throw capabilityNotFound(valid.capabilityId!);
  }
  return rows.rows.map(mapCapabilityVersion);
}

// ---------------------------------------------------------------------------
// Reads — supplies
// ---------------------------------------------------------------------------

export async function getSupply(ctx: TenantContext, supplyId: string): Promise<CapabilitySupply> {
  assertCapabilitiesTenantContext(ctx);
  if (!isUuid(supplyId)) throw supplyNotFound(supplyId);

  const rows = await getDb().query<SupplyRow>(
    `${SUPPLY_VIEW_COLUMNS} ${SUPPLY_VIEW_FROM}
      WHERE cs.tenant_id = $1 AND cs.id = $2`,
    [ctx.tenantId, supplyId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw supplyNotFound(supplyId);
  return mapSupply(row);
}

export async function listSupplies(
  ctx: TenantContext,
  query: ListSuppliesQuery,
): Promise<CapabilitySupply[]> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateListSuppliesQuery(query);

  const conditions: string[] = ['cs.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.capabilityId !== null) add('cs.capability_id = $#', valid.capabilityId);
  if (valid.supplierKind !== null) add('cs.supplier_kind = $#', valid.supplierKind);
  if (valid.supplierId !== null) add('cs.supplier_id = $#', valid.supplierId);
  if (valid.status !== null) add('csv.status = $#', valid.status);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<SupplyRow>(
    `${SUPPLY_VIEW_COLUMNS} ${SUPPLY_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY cs.capability_id ASC, cs.supplier_kind ASC, cs.supplier_key ASC, cs.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapSupply);
}

export async function getSupplyVersion(
  ctx: TenantContext,
  query: { supplyId: string; version: number },
): Promise<CapabilitySupplyVersion> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateSupplyVersionQuery(query);
  const rows = await getDb().query<SupplyVersionRow>(
    `SELECT * FROM capability_supply_versions WHERE tenant_id = $1 AND supply_id = $2 AND version = $3`,
    [ctx.tenantId, valid.supplyId!, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new CapabilitiesError(
      'supply_version_not_found',
      `version ${valid.version} of supply '${valid.supplyId}' does not exist in this tenant`,
    );
  }
  return mapSupplyVersion(row);
}

export async function listSupplyVersions(
  ctx: TenantContext,
  query: { supplyId: string },
): Promise<CapabilitySupplyVersion[]> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateSupplyHistoryQuery(query);
  const rows = await getDb().query<SupplyVersionRow>(
    `SELECT * FROM capability_supply_versions WHERE tenant_id = $1 AND supply_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.supplyId!],
  );
  if (rows.rows.length === 0) {
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM capability_supplies WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.supplyId!],
    );
    if (exists.rows.length === 0) throw supplyNotFound(valid.supplyId!);
  }
  return rows.rows.map(mapSupplyVersion);
}

// ---------------------------------------------------------------------------
// Reads — requirements
// ---------------------------------------------------------------------------

export async function getRequirement(
  ctx: TenantContext,
  requirementId: string,
): Promise<CapabilityRequirement> {
  assertCapabilitiesTenantContext(ctx);
  if (!isUuid(requirementId)) throw requirementNotFound(requirementId);

  const rows = await getDb().query<RequirementRow>(
    `${REQUIREMENT_VIEW_COLUMNS} ${REQUIREMENT_VIEW_FROM}
      WHERE cr.tenant_id = $1 AND cr.id = $2`,
    [ctx.tenantId, requirementId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw requirementNotFound(requirementId);
  return mapRequirement(row);
}

export async function listRequirements(
  ctx: TenantContext,
  query: ListRequirementsQuery,
): Promise<CapabilityRequirement[]> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateListRequirementsQuery(query);

  const conditions: string[] = ['cr.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.capabilityId !== null) add('cr.capability_id = $#', valid.capabilityId);
  if (valid.sourceKind !== null) add('cr.source_kind = $#', valid.sourceKind);
  if (valid.sourceId !== null) add('cr.source_id = $#', valid.sourceId);
  if (valid.status !== null) add('crv.status = $#', valid.status);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<RequirementRow>(
    `${REQUIREMENT_VIEW_COLUMNS} ${REQUIREMENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY cr.capability_id ASC, cr.source_kind ASC, cr.source_key ASC, cr.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapRequirement);
}

export async function getRequirementVersion(
  ctx: TenantContext,
  query: { requirementId: string; version: number },
): Promise<CapabilityRequirementVersion> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateRequirementVersionQuery(query);
  const rows = await getDb().query<RequirementVersionRow>(
    `SELECT * FROM capability_requirement_versions WHERE tenant_id = $1 AND requirement_id = $2 AND version = $3`,
    [ctx.tenantId, valid.requirementId!, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new CapabilitiesError(
      'requirement_version_not_found',
      `version ${valid.version} of requirement '${valid.requirementId}' does not exist in this tenant`,
    );
  }
  return mapRequirementVersion(row);
}

export async function listRequirementVersions(
  ctx: TenantContext,
  query: { requirementId: string },
): Promise<CapabilityRequirementVersion[]> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateRequirementHistoryQuery(query);
  const rows = await getDb().query<RequirementVersionRow>(
    `SELECT * FROM capability_requirement_versions WHERE tenant_id = $1 AND requirement_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.requirementId!],
  );
  if (rows.rows.length === 0) {
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM capability_requirements WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.requirementId!],
    );
    if (exists.rows.length === 0) throw requirementNotFound(valid.requirementId!);
  }
  return rows.rows.map(mapRequirementVersion);
}

// ---------------------------------------------------------------------------
// Gap analysis
// ---------------------------------------------------------------------------

export async function analyzeGaps(
  ctx: TenantContext,
  query: AnalyzeGapsQuery,
): Promise<GapResult[]> {
  assertCapabilitiesTenantContext(ctx);
  const valid = validateAnalyzeGapsQuery(query);

  let capabilityRows: CapabilityRow[];
  if (valid.capabilityId !== null) {
    if (!isUuid(valid.capabilityId)) throw capabilityNotFound(valid.capabilityId);
    const rows = await getDb().query<CapabilityRow>(
      `${CAPABILITY_VIEW_COLUMNS} ${CAPABILITY_VIEW_FROM}
        WHERE c.tenant_id = $1 AND c.id = $2`,
      [ctx.tenantId, valid.capabilityId],
    );
    const row = rows.rows[0];
    if (row === undefined) throw capabilityNotFound(valid.capabilityId);
    capabilityRows = [row];
  } else {
    // Candidates: ACTIVE capabilities carrying at least one ACTIVE
    // requirement, in the canonical (name, id) order, bounded by the
    // documented analysis window (the observations module's bounded-window
    // precedent). The result `limit` applies after the status filter.
    capabilityRows = (
      await getDb().query<CapabilityRow>(
        `${CAPABILITY_VIEW_COLUMNS} ${CAPABILITY_VIEW_FROM}
          WHERE c.tenant_id = $1 AND cv.status = 'active'
            AND EXISTS (
              SELECT 1 FROM capability_requirements cr
                INNER JOIN capability_requirement_versions crv
                  ON crv.requirement_id = cr.id
                 AND crv.tenant_id = cr.tenant_id
                 AND crv.version = cr.current_version
                WHERE cr.tenant_id = c.tenant_id
                  AND cr.capability_id = c.id
                  AND crv.status = 'active'
            )
          ORDER BY cv.name ASC, c.id ASC
          LIMIT ${MAX_ANALYSIS_CAPABILITIES}`,
        [ctx.tenantId],
      )
    ).rows;
  }
  if (capabilityRows.length === 0) return [];

  const capabilityIds = capabilityRows.map((row) => row.capability_id);

  // Current supplies (both statuses — retired supplies are the alternatives)
  // and ACTIVE requirements of every candidate, in two bounded queries.
  const supplyRows = (
    await getDb().query<SupplyRow>(
      `${SUPPLY_VIEW_COLUMNS} ${SUPPLY_VIEW_FROM}
        WHERE cs.tenant_id = $1 AND cs.capability_id = ANY($2::uuid[])`,
      [ctx.tenantId, capabilityIds],
    )
  ).rows;
  const requirementRows = (
    await getDb().query<RequirementRow>(
      `${REQUIREMENT_VIEW_COLUMNS} ${REQUIREMENT_VIEW_FROM}
        WHERE cr.tenant_id = $1 AND cr.capability_id = ANY($2::uuid[]) AND crv.status = 'active'`,
      [ctx.tenantId, capabilityIds],
    )
  ).rows;

  const suppliesByCapability = new Map<string, CapabilitySupply[]>();
  for (const row of supplyRows) {
    const list = suppliesByCapability.get(row.capability_id) ?? [];
    list.push(mapSupply(row));
    suppliesByCapability.set(row.capability_id, list);
  }
  const requirementsByCapability = new Map<string, CapabilityRequirement[]>();
  for (const row of requirementRows) {
    const list = requirementsByCapability.get(row.capability_id) ?? [];
    list.push(mapRequirement(row));
    requirementsByCapability.set(row.capability_id, list);
  }

  const summaries = await currentSummaries(getDb(), ctx, capabilityIds);
  const gaps = computeCapabilityGaps(
    capabilityRows.map((row) => {
      const summary = summaries.get(row.capability_id);
      return {
        capability: mapCapability(
          row,
          summary?.supply ?? emptySupplySummary(),
          summary?.requirement ?? emptyRequirementSummary(),
        ),
        supplies: suppliesByCapability.get(row.capability_id) ?? [],
        activeRequirements: requirementsByCapability.get(row.capability_id) ?? [],
      };
    }),
  );

  const filtered =
    valid.status !== null ? gaps.filter((gap) => gap.status === valid.status) : gaps;
  return filtered.slice(0, valid.limit);
}
