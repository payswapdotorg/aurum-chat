// Implementation of the suppliers module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`supplier_not_found` / `scorecard_not_found` and their
// version counterparts), including on versions and scorecards.
//
// W020 acceptance — "Score suppliers/subcontractors on price, quality,
// reliability, capacity, compliance, geography, switching cost and
// alternatives" — is carried by these deliberate properties, all tested:
//   1. THE REGISTRY IS VERSIONED UNDERSTANDING: both record kinds (the
//      supplier and its scorecard) are identities plus append-only chains
//      of full-snapshot versions in the goals (W008) discipline. Revising
//      appends version N+1; no update/delete operation exists on the
//      contract, and PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on
//      versions and DELETE/TRUNCATE on identities (migration 001 triggers).
//      Identity keys are immutable: the supplier's name and kind, and the
//      scorecard's (supplier) binding, can only be expressed by NEW
//      records, never by rewriting one.
//   2. ALL EIGHT DIMENSIONS ARE FIRST-CLASS: price, quality, reliability,
//      capacity, compliance, geography, switching_cost, alternatives (the
//      work item's verbatim list) are carried through storage CHECKs, the
//      scorecard contracts and the derived scoring, each in [0, 1] or null
//      (unscored — missing data is never a grade); every snapshot scores
//      ≥ 1 dimension, and `completeness` keeps thin assessments visible.
//   3. THE DERIVED LAYER IS NEVER PERSISTED (lock 10): the weighted
//      overall, the ranking and the alternatives analysis are recomputed
//      from the CURRENT records on every read by the pure functions in
//      scoring.ts — a scorecard records the assessment, never a weighting
//      policy or a rank.
//   4. ALTERNATIVES ARE GROUNDED IN THE CAPABILITY GRAPH: the intelligence
//      view reads the supplier's capabilities through the capabilities
//      contract (W017, this module's declared dependency — the documented
//      supplier-party linkage convention: a capabilities supply party of
//      kind 'supplier' with party id === this supplier's uuid OR party
//      label === this supplier's name), and reports, per actively-supplied
//      capability, the other parties supplying it — alternative suppliers
//      (resolvable back to this registry, score-backed under the analysis's
//      effective weights), internal channels (employee/team/agent/software/
//      partner) and retired supplies (reactivation candidates).
//   5. LIFECYCLE IS SURGICAL: a status change must be the only change in
//      its revision, a retired supplier accepts nothing but a reactivation,
//      and an assessment cannot be recorded against a retired supplier
//      (the goals module's transition discipline).
//   6. CONCURRENCY: every append runs inside one transaction that holds
//      the identity row lock (FOR UPDATE) and advances the pointer under
//      an optimistic `current_version = expected` guard — a losing writer
//      fails cleanly with `supplier_conflict` / `scorecard_conflict`.
//      Lock ordering is supplier-then-scorecard everywhere, so appends
//      never deadlock against each other.
//
// Storage shape: `suppliers` + `supplier_versions`,
// `supplier_scorecards` + `supplier_scorecard_versions`.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getCapability, listSupplies } from '@/modules/capabilities/contract';
import type { CapabilitySupply } from '@/modules/capabilities/contract';
import { SuppliersError } from './errors';
import { buildRanking, computeScoring } from './scoring';
import {
  assertSuppliersTenantContext,
  escapeLike,
  isUuid,
  MAX_ANALYSIS_CAPABILITIES,
  MAX_ANALYSIS_SUPPLIES,
  MAX_RANK_CANDIDATES,
  mergeScorePatch,
  scoredDimensionCount,
  validateListSuppliersQuery,
  validateRankSuppliersQuery,
  validateRecordScorecardInput,
  validateRegisterSupplierInput,
  validateReviseScorecardInput,
  validateReviseSupplierInput,
  validateScorecardHistoryQuery,
  validateScorecardVersionQuery,
  validateSupplierHistoryQuery,
  validateSupplierIntelligenceQuery,
  validateSupplierVersionQuery,
  type ValidatedParty,
  type ValidatedRecordScorecardInput,
  type ValidatedRegisterSupplierInput,
  type ValidatedReviseScorecardInput,
  type ValidatedReviseSupplierInput,
} from './validation';
import type {
  AlternativeSupply,
  CapabilityAlternatives,
  GetScorecardVersionQuery,
  GetSupplierIntelligenceQuery,
  GetSupplierVersionQuery,
  ListScorecardVersionsQuery,
  ListSupplierVersionsQuery,
  ListSuppliersQuery,
  RankSuppliersQuery,
  RecordScorecardInput,
  RegisterSupplierInput,
  ReviseScorecardInput,
  ReviseSupplierInput,
  ScoringSummary,
  Supplier,
  SupplierActor,
  SupplierAssessmentSummary,
  SupplierChangeSummary,
  SupplierDimensionScores,
  SupplierIntelligence,
  SupplierKind,
  SupplierRanking,
  SupplierRecordStatus,
  SupplierScorecard,
  SupplierScorecardVersion,
  SupplierVersion,
  SuppliedCapability,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

interface SupplierVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  version: number | string;
  change_kind: string;
  name: string;
  supplier_kind: string;
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

interface ScorecardVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  scorecard_id: string;
  supplier_id: string;
  version: number | string;
  change_kind: string;
  price_score: number | null;
  quality_score: number | null;
  reliability_score: number | null;
  capacity_score: number | null;
  compliance_score: number | null;
  geography_score: number | null;
  switching_cost_score: number | null;
  alternatives_score: number | null;
  evidence_observation_ids: unknown;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/**
 * Row shape of the supplier current-view join (suppliers ⋈ current versions
 * ⋈ optional current scorecard version) — the LEFT JOIN carries the current
 * assessment columns, all null when the supplier was never assessed.
 */
interface SupplierRow extends DbRow {
  supplier_id: string;
  supplier_tenant_id: string;
  supplier_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  name: string;
  supplier_kind: string;
  description: string | null;
  world_entity_id: string | null;
  status: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
  scorecard_id: string | null;
  scorecard_version: number | string | null;
  assessed_at: Date | string | null;
  price_score: number | null;
  quality_score: number | null;
  reliability_score: number | null;
  capacity_score: number | null;
  compliance_score: number | null;
  geography_score: number | null;
  switching_cost_score: number | null;
  alternatives_score: number | null;
}

/** Row shape of the scorecard current-view join (scorecards ⋈ current versions). */
interface ScorecardRow extends DbRow {
  scorecard_id: string;
  scorecard_tenant_id: string;
  supplier_id: string;
  scorecard_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  price_score: number | null;
  quality_score: number | null;
  reliability_score: number | null;
  capacity_score: number | null;
  compliance_score: number | null;
  geography_score: number | null;
  switching_cost_score: number | null;
  alternatives_score: number | null;
  evidence_observation_ids: unknown;
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
}): SupplierActor {
  return {
    kind: row.actor_kind as SupplierActor['kind'], // CHECK-constrained by migration 001
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
}): SupplierChangeSummary {
  return {
    kind: row.change_kind as SupplierChangeSummary['kind'], // CHECK-constrained
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

/** The eight dimension scores of a row carrying the eight *_score columns. */
function scoresOf(row: {
  price_score: number | null;
  quality_score: number | null;
  reliability_score: number | null;
  capacity_score: number | null;
  compliance_score: number | null;
  geography_score: number | null;
  switching_cost_score: number | null;
  alternatives_score: number | null;
}): SupplierDimensionScores {
  return {
    price: row.price_score,
    quality: row.quality_score,
    reliability: row.reliability_score,
    capacity: row.capacity_score,
    compliance: row.compliance_score,
    geography: row.geography_score,
    switchingCost: row.switching_cost_score,
    alternatives: row.alternatives_score,
  };
}

function mapSupplierVersion(row: SupplierVersionRow): SupplierVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    supplierId: row.supplier_id,
    version: toInt(row.version),
    changeKind: row.change_kind as SupplierVersion['changeKind'], // CHECK-constrained
    name: row.name,
    kind: row.supplier_kind as SupplierVersion['kind'], // CHECK-constrained
    description: row.description,
    worldEntityId: row.world_entity_id,
    status: row.status as SupplierVersion['status'], // CHECK-constrained
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapScorecardVersion(row: ScorecardVersionRow): SupplierScorecardVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scorecardId: row.scorecard_id,
    supplierId: row.supplier_id,
    version: toInt(row.version),
    changeKind: row.change_kind as SupplierScorecardVersion['changeKind'], // CHECK-constrained
    scores: scoresOf(row),
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    note: row.note,
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

/** The assessment summary of a current-view row (null when never assessed). */
function assessmentOf(row: SupplierRow): SupplierAssessmentSummary | null {
  if (row.scorecard_id === null || row.scorecard_version === null) return null;
  const scoring = computeScoring(scoresOf(row)); // DEFAULT weights in summary views
  return {
    scorecardId: row.scorecard_id,
    version: toInt(row.scorecard_version),
    scoredDimensions: scoring.scoredDimensions,
    totalDimensions: scoring.totalDimensions,
    completeness: scoring.completeness,
    overall: scoring.overall,
    assessedAt: toIso(row.assessed_at as Date | string),
  };
}

function mapSupplier(row: SupplierRow): Supplier {
  return {
    id: row.supplier_id,
    tenantId: row.supplier_tenant_id,
    name: row.name,
    kind: row.supplier_kind as Supplier['kind'], // CHECK-constrained
    version: toInt(row.version_number),
    description: row.description,
    worldEntityId: row.world_entity_id,
    status: row.status as Supplier['status'], // CHECK-constrained
    assessment: assessmentOf(row),
    createdAt: toIso(row.supplier_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: mapChangeOf(row),
  };
}

function mapScorecard(row: ScorecardRow): SupplierScorecard {
  return {
    id: row.scorecard_id,
    tenantId: row.scorecard_tenant_id,
    supplierId: row.supplier_id,
    version: toInt(row.version_number),
    scores: scoresOf(row),
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    note: row.note,
    createdAt: toIso(row.scorecard_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: mapChangeOf(row),
  };
}

function supplierNotFound(supplierId: string): SuppliersError {
  return new SuppliersError(
    'supplier_not_found',
    `supplier '${supplierId}' does not exist in this tenant`,
  );
}

function scorecardNotFound(scorecardId: string): SuppliersError {
  return new SuppliersError(
    'scorecard_not_found',
    `scorecard '${scorecardId}' does not exist in this tenant`,
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

/** Service-derived change kind of a supplier lifecycle/content revision (goals discipline). */
function deriveChangeKind(
  currentStatus: SupplierRecordStatus,
  nextStatus: SupplierRecordStatus,
): 'revised' | 'retired' | 'reactivated' {
  if (currentStatus === 'active' && nextStatus === 'retired') return 'retired';
  if (currentStatus === 'retired' && nextStatus === 'active') return 'reactivated';
  return 'revised';
}

/** Wraps a sibling-contract failure during the derived analysis (cause preserved). */
function analysisFailed(where: string, cause: unknown): SuppliersError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SuppliersError(
    'analysis_failed',
    `supplier intelligence analysis failed while ${where}: ${message}`,
  );
}

// ---------------------------------------------------------------------------
// Shared SQL of the version appends
// ---------------------------------------------------------------------------

async function supplierVersionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    supplierId: string;
    version: number;
    changeKind: SupplierVersion['changeKind'];
    name: string;
    kind: SupplierKind;
    description: string | null;
    worldEntityId: string | null;
    status: SupplierRecordStatus;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<SupplierVersionRow>> {
  return tx.query<SupplierVersionRow>(
    `INSERT INTO supplier_versions (
       tenant_id, supplier_id, version, change_kind, name, supplier_kind,
       description, world_entity_id, status,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)
     RETURNING *`,
    [
      params.tenantId,
      params.supplierId,
      params.version,
      params.changeKind,
      params.name,
      params.kind,
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

async function scorecardVersionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    scorecardId: string;
    supplierId: string;
    version: number;
    changeKind: SupplierScorecardVersion['changeKind'];
    scores: SupplierDimensionScores;
    evidenceObservationIds: string[];
    note: string | null;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<ScorecardVersionRow>> {
  return tx.query<ScorecardVersionRow>(
    `INSERT INTO supplier_scorecard_versions (
       tenant_id, scorecard_id, supplier_id, version, change_kind,
       price_score, quality_score, reliability_score, capacity_score,
       compliance_score, geography_score, switching_cost_score, alternatives_score,
       evidence_observation_ids, note,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13,
       $14::jsonb, $15,
       $16, $17, $18, $19, $20, $21::timestamptz
     ) RETURNING *`,
    [
      params.tenantId,
      params.scorecardId,
      params.supplierId,
      params.version,
      params.changeKind,
      params.scores.price,
      params.scores.quality,
      params.scores.reliability,
      params.scores.capacity,
      params.scores.compliance,
      params.scores.geography,
      params.scores.switchingCost,
      params.scores.alternatives,
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

// ---------------------------------------------------------------------------
// Current-view SQL fragments
// ---------------------------------------------------------------------------

const SUPPLIER_VIEW_FROM = `FROM suppliers s
  INNER JOIN supplier_versions sv
    ON sv.supplier_id = s.id AND sv.tenant_id = s.tenant_id AND sv.version = s.current_version
  LEFT JOIN supplier_scorecards sc
    ON sc.supplier_id = s.id AND sc.tenant_id = s.tenant_id
  LEFT JOIN supplier_scorecard_versions scv
    ON scv.scorecard_id = sc.id AND scv.tenant_id = sc.tenant_id AND scv.version = sc.current_version`;

const SUPPLIER_VIEW_COLUMNS = `SELECT
    s.id AS supplier_id, s.tenant_id AS supplier_tenant_id, s.created_at AS supplier_created_at,
    sv.version AS version_number, sv.change_kind, sv.name, sv.supplier_kind, sv.description, sv.world_entity_id, sv.status,
    sv.actor_kind, sv.actor_id, sv.actor_label, sv.changed_by_principal, sv.rationale, sv.recorded_at,
    sc.id AS scorecard_id, scv.version AS scorecard_version, scv.recorded_at AS assessed_at,
    scv.price_score, scv.quality_score, scv.reliability_score, scv.capacity_score,
    scv.compliance_score, scv.geography_score, scv.switching_cost_score, scv.alternatives_score`;

const SCORECARD_VIEW_FROM = `FROM supplier_scorecards sc
  INNER JOIN supplier_scorecard_versions scv
    ON scv.scorecard_id = sc.id AND scv.tenant_id = sc.tenant_id AND scv.version = sc.current_version`;

const SCORECARD_VIEW_COLUMNS = `SELECT
    sc.id AS scorecard_id, sc.tenant_id AS scorecard_tenant_id, sc.supplier_id, sc.created_at AS scorecard_created_at,
    scv.version AS version_number, scv.change_kind,
    scv.price_score, scv.quality_score, scv.reliability_score, scv.capacity_score,
    scv.compliance_score, scv.geography_score, scv.switching_cost_score, scv.alternatives_score,
    scv.evidence_observation_ids, scv.note,
    scv.actor_kind, scv.actor_id, scv.actor_label,
    scv.changed_by_principal, scv.rationale, scv.recorded_at`;

// ---------------------------------------------------------------------------
// Supplier register / revise
// ---------------------------------------------------------------------------

export async function registerSupplier(
  ctx: TenantContext,
  input: RegisterSupplierInput,
): Promise<Supplier> {
  assertSuppliersTenantContext(ctx);
  const valid: ValidatedRegisterSupplierInput = validateRegisterSupplierInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Identity row first (id minted by PostgreSQL); version 1 follows in the
    // same transaction — a supplier never exists without its initial
    // registration. The name is the immutable tenant-unique graph key.
    let created: DbResult<{ id: string; created_at: Date | string }>;
    try {
      created = await tx.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO suppliers (tenant_id, name, created_at) VALUES ($1, $2, $3)
           RETURNING id, created_at`,
        [ctx.tenantId, valid.name, recordedAt],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'suppliers')) {
        throw new SuppliersError(
          'supplier_name_conflict',
          `a supplier named '${valid.name}' already exists in this tenant; revise it instead of registering the name again`,
        );
      }
      throw error;
    }
    const identity = created.rows[0]!;

    const inserted = await supplierVersionInsert(tx, {
      tenantId: ctx.tenantId,
      supplierId: identity.id,
      version: 1,
      changeKind: 'created',
      name: valid.name,
      kind: valid.kind,
      description: valid.description,
      worldEntityId: valid.worldEntityId,
      status: 'active', // suppliers are active upon registration
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapSupplierVersion(inserted.rows[0]!);

    return {
      id: identity.id,
      tenantId: ctx.tenantId,
      name: version.name,
      kind: version.kind,
      version: version.version,
      description: version.description,
      worldEntityId: version.worldEntityId,
      status: version.status,
      assessment: null, // a fresh supplier carries no assessment
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

/** Loads the current version row of one supplier inside `tx` (tenant-scoped). */
async function loadCurrentSupplierVersion(
  tx: Queryable,
  ctx: TenantContext,
  supplierId: string,
): Promise<SupplierVersionRow> {
  const rows = await tx.query<SupplierVersionRow>(
    `SELECT sv.* FROM supplier_versions sv
       INNER JOIN suppliers s ON s.id = sv.supplier_id AND s.tenant_id = sv.tenant_id
      WHERE sv.tenant_id = $1 AND sv.supplier_id = $2 AND sv.version = s.current_version`,
    [ctx.tenantId, supplierId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw supplierNotFound(supplierId);
  return row;
}

/** The supplier's current view inside `tx` (tenant-scoped, with assessment). */
async function loadCurrentSupplier(
  tx: Queryable,
  ctx: TenantContext,
  supplierId: string,
): Promise<SupplierRow> {
  const rows = await tx.query<SupplierRow>(
    `${SUPPLIER_VIEW_COLUMNS} ${SUPPLIER_VIEW_FROM}
      WHERE s.tenant_id = $1 AND s.id = $2`,
    [ctx.tenantId, supplierId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw supplierNotFound(supplierId);
  return row;
}

export async function reviseSupplier(
  ctx: TenantContext,
  input: ReviseSupplierInput,
): Promise<Supplier> {
  assertSuppliersTenantContext(ctx);
  const valid: ValidatedReviseSupplierInput = validateReviseSupplierInput(input);

  if (!isUuid(valid.supplierId)) {
    // Malformed ids are indistinguishable from missing suppliers (no leak).
    throw supplierNotFound(valid.supplierId);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Row lock on the identity: concurrent revisers of one supplier
    // serialize here, which is what keeps the version chain gapless.
    const locked = await tx.query<{
      id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, current_version, created_at FROM suppliers
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.supplierId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw supplierNotFound(valid.supplierId);
    const currentVersionNumber = toInt(identity.current_version);

    const current = mapSupplierVersion(
      await loadCurrentSupplierVersion(tx, ctx, valid.supplierId),
    );

    // --- lifecycle transition gate (surgical, service-level) ---
    const patch = valid.patch;
    if (patch.status !== undefined && patch.status === current.status) {
      throw new SuppliersError(
        'invalid_transition',
        `supplier '${valid.supplierId}' is already ${patch.status} — a status revision must change the lifecycle`,
      );
    }
    if (current.status === 'retired' && patch.status !== 'active') {
      throw new SuppliersError(
        'invalid_transition',
        `supplier '${valid.supplierId}' is retired — the only accepted change is a reactivation (status: 'active'); retirement rationale lives on the retirement version`,
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
      `UPDATE suppliers SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.supplierId, nextVersion, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new SuppliersError(
        'supplier_conflict',
        'a concurrent revision moved this supplier forward; re-read it and retry',
      );
    }

    try {
      await supplierVersionInsert(tx, {
        tenantId: ctx.tenantId,
        supplierId: valid.supplierId,
        version: nextVersion,
        changeKind,
        name: current.name, // immutable graph key
        kind: current.kind, // immutable identity content
        description,
        worldEntityId,
        status: nextStatus,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'supplier_versions')) {
        throw new SuppliersError(
          'supplier_conflict',
          'a concurrent revision appended this version number first; re-read the supplier and retry',
        );
      }
      throw error;
    }

    // The current view (with the assessment summary) after the append.
    return mapSupplier(await loadCurrentSupplier(tx, ctx, valid.supplierId));
  });
}

// ---------------------------------------------------------------------------
// Scorecard record / revise
// ---------------------------------------------------------------------------

export async function recordScorecard(
  ctx: TenantContext,
  input: RecordScorecardInput,
): Promise<SupplierScorecard> {
  assertSuppliersTenantContext(ctx);
  const valid: ValidatedRecordScorecardInput = validateRecordScorecardInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Lock the supplier identity FIRST (the supplier→scorecard lock order):
    // the assessment append serializes against a concurrent supplier
    // retirement (which holds the same lock), and the supplier must exist
    // and be active — a retired supplier is out of procurement scope and
    // accepts no assessment.
    const locked = await tx.query<{ id: string }>(
      `SELECT id FROM suppliers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.supplierId],
    );
    if (locked.rows.length === 0) throw supplierNotFound(valid.supplierId);
    const current = await loadCurrentSupplierVersion(tx, ctx, valid.supplierId);
    if (current.status !== 'active') {
      throw new SuppliersError(
        'invalid_transition',
        `supplier '${valid.supplierId}' is retired — a retired supplier accepts no assessment; reactivate it first`,
      );
    }

    let created: DbResult<{ id: string; created_at: Date | string }>;
    try {
      created = await tx.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO supplier_scorecards (tenant_id, supplier_id, created_at) VALUES ($1, $2, $3)
           RETURNING id, created_at`,
        [ctx.tenantId, valid.supplierId, recordedAt],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'supplier_scorecards')) {
        throw new SuppliersError(
          'scorecard_conflict',
          `supplier '${valid.supplierId}' is already assessed in this tenant; revise the scorecard instead of recording another one`,
        );
      }
      throw error;
    }
    const identity = created.rows[0]!;

    const inserted = await scorecardVersionInsert(tx, {
      tenantId: ctx.tenantId,
      scorecardId: identity.id,
      supplierId: valid.supplierId,
      version: 1,
      changeKind: 'assessed',
      scores: valid.scores,
      evidenceObservationIds: valid.evidenceObservationIds,
      note: valid.note,
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapScorecardVersion(inserted.rows[0]!);

    return {
      id: identity.id,
      tenantId: ctx.tenantId,
      supplierId: valid.supplierId,
      version: version.version,
      scores: version.scores,
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

/** Loads the current version row of one scorecard inside `tx` (tenant-scoped). */
async function loadCurrentScorecardVersion(
  tx: Queryable,
  ctx: TenantContext,
  scorecardId: string,
): Promise<ScorecardVersionRow> {
  const rows = await tx.query<ScorecardVersionRow>(
    `SELECT scv.* FROM supplier_scorecard_versions scv
       INNER JOIN supplier_scorecards sc ON sc.id = scv.scorecard_id AND sc.tenant_id = scv.tenant_id
      WHERE scv.tenant_id = $1 AND scv.scorecard_id = $2 AND scv.version = sc.current_version`,
    [ctx.tenantId, scorecardId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw scorecardNotFound(scorecardId);
  return row;
}

export async function reviseScorecard(
  ctx: TenantContext,
  input: ReviseScorecardInput,
): Promise<SupplierScorecard> {
  assertSuppliersTenantContext(ctx);
  const valid: ValidatedReviseScorecardInput = validateReviseScorecardInput(input);

  if (!isUuid(valid.scorecardId)) throw scorecardNotFound(valid.scorecardId);

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Lock the supplier identity first (lock order: supplier → scorecard),
    // so the assessment append serializes against a concurrent retirement.
    // The scorecard's supplier binding is immutable, so the scalar subquery
    // is a stable resolution; a missing (or foreign-tenant) scorecard id
    // reads the same as a missing supplier row here.
    const supplierLocked = await tx.query<{ id: string }>(
      `SELECT s.id FROM suppliers s
        WHERE s.tenant_id = $1 AND s.id = (
          SELECT sc.supplier_id FROM supplier_scorecards sc
            WHERE sc.tenant_id = $1 AND sc.id = $2
        ) FOR UPDATE`,
      [ctx.tenantId, valid.scorecardId],
    );
    if (supplierLocked.rows.length === 0) throw scorecardNotFound(valid.scorecardId);
    const supplierId = supplierLocked.rows[0]!.id;
    const supplierCurrent = await loadCurrentSupplierVersion(tx, ctx, supplierId);
    if (supplierCurrent.status !== 'active') {
      throw new SuppliersError(
        'invalid_transition',
        `supplier '${supplierId}' is retired — a retired supplier accepts no reassessment; reactivate it first`,
      );
    }

    const locked = await tx.query<{
      id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, current_version, created_at FROM supplier_scorecards
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.scorecardId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw scorecardNotFound(valid.scorecardId);
    const currentVersionNumber = toInt(identity.current_version);

    const current = mapScorecardVersion(
      await loadCurrentScorecardVersion(tx, ctx, valid.scorecardId),
    );

    // --- merge patch into the current content (tri-state per score:
    //     undefined = carry over, null = clear to unscored, number = set) ---
    const scores = mergeScorePatch(current.scores, valid.patch);
    if (scoredDimensionCount(scores) === 0) {
      throw new SuppliersError(
        'invalid_scorecard_input',
        'the merged assessment must score at least one of the eight dimensions (price, quality, reliability, capacity, compliance, geography, switchingCost, alternatives)',
      );
    }
    const evidenceObservationIds =
      valid.evidenceObservationIds !== undefined
        ? valid.evidenceObservationIds
        : current.evidenceObservationIds;
    const note = valid.note !== undefined ? valid.note : current.note;

    const nextVersion = currentVersionNumber + 1;
    const moved = await tx.query(
      `UPDATE supplier_scorecards SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.scorecardId, nextVersion, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new SuppliersError(
        'scorecard_conflict',
        'a concurrent revision moved this scorecard forward; re-read it and retry',
      );
    }

    let inserted: DbResult<ScorecardVersionRow>;
    try {
      inserted = await scorecardVersionInsert(tx, {
        tenantId: ctx.tenantId,
        scorecardId: valid.scorecardId,
        supplierId,
        version: nextVersion,
        changeKind: 'reassessed',
        scores,
        evidenceObservationIds,
        note,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'supplier_scorecard_versions')) {
        throw new SuppliersError(
          'scorecard_conflict',
          'a concurrent revision appended this version number first; re-read the scorecard and retry',
        );
      }
      throw error;
    }
    const version = mapScorecardVersion(inserted.rows[0]!);

    return {
      id: valid.scorecardId,
      tenantId: ctx.tenantId,
      supplierId,
      version: version.version,
      scores: version.scores,
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
// Reads — suppliers
// ---------------------------------------------------------------------------

export async function getSupplier(ctx: TenantContext, supplierId: string): Promise<Supplier> {
  assertSuppliersTenantContext(ctx);
  if (!isUuid(supplierId)) throw supplierNotFound(supplierId);

  const rows = await getDb().query<SupplierRow>(
    `${SUPPLIER_VIEW_COLUMNS} ${SUPPLIER_VIEW_FROM}
      WHERE s.tenant_id = $1 AND s.id = $2`,
    [ctx.tenantId, supplierId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw supplierNotFound(supplierId);
  return mapSupplier(row);
}

export async function listSuppliers(
  ctx: TenantContext,
  query: ListSuppliersQuery,
): Promise<Supplier[]> {
  assertSuppliersTenantContext(ctx);
  const valid = validateListSuppliersQuery(query);

  const conditions: string[] = ['s.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.name !== null) add('sv.name = $#', valid.name);
  if (valid.search !== null) {
    // escaped substring match on the name — caller text is never a wildcard
    // pattern (the missions module's ILIKE discipline).
    add("sv.name ILIKE '%' || $# || '%' ESCAPE '\\'", escapeLike(valid.search));
  }
  if (valid.kind !== null) add('sv.supplier_kind = $#', valid.kind);
  if (valid.status !== null) add('sv.status = $#', valid.status);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<SupplierRow>(
    `${SUPPLIER_VIEW_COLUMNS} ${SUPPLIER_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY sv.name ASC, s.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapSupplier);
}

export async function getSupplierVersion(
  ctx: TenantContext,
  query: GetSupplierVersionQuery,
): Promise<SupplierVersion> {
  assertSuppliersTenantContext(ctx);
  const valid = validateSupplierVersionQuery(query);
  const rows = await getDb().query<SupplierVersionRow>(
    `SELECT * FROM supplier_versions WHERE tenant_id = $1 AND supplier_id = $2 AND version = $3`,
    [ctx.tenantId, valid.id, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new SuppliersError(
      'supplier_version_not_found',
      `version ${valid.version} of supplier '${valid.id}' does not exist in this tenant`,
    );
  }
  return mapSupplierVersion(row);
}

export async function listSupplierVersions(
  ctx: TenantContext,
  query: ListSupplierVersionsQuery,
): Promise<SupplierVersion[]> {
  assertSuppliersTenantContext(ctx);
  const valid = validateSupplierHistoryQuery(query);
  const rows = await getDb().query<SupplierVersionRow>(
    `SELECT * FROM supplier_versions WHERE tenant_id = $1 AND supplier_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.id],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such supplier in this tenant" from "a supplier
    // without history" (impossible by construction) — a foreign-tenant
    // supplier id reads the same as a missing one either way.
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM suppliers WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.id],
    );
    if (exists.rows.length === 0) throw supplierNotFound(valid.id);
  }
  return rows.rows.map(mapSupplierVersion);
}

// ---------------------------------------------------------------------------
// Reads — scorecards
// ---------------------------------------------------------------------------

export async function getScorecard(
  ctx: TenantContext,
  scorecardId: string,
): Promise<SupplierScorecard> {
  assertSuppliersTenantContext(ctx);
  if (!isUuid(scorecardId)) throw scorecardNotFound(scorecardId);

  const rows = await getDb().query<ScorecardRow>(
    `${SCORECARD_VIEW_COLUMNS} ${SCORECARD_VIEW_FROM}
      WHERE sc.tenant_id = $1 AND sc.id = $2`,
    [ctx.tenantId, scorecardId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw scorecardNotFound(scorecardId);
  return mapScorecard(row);
}

export async function getScorecardVersion(
  ctx: TenantContext,
  query: GetScorecardVersionQuery,
): Promise<SupplierScorecardVersion> {
  assertSuppliersTenantContext(ctx);
  const valid = validateScorecardVersionQuery(query);
  const rows = await getDb().query<ScorecardVersionRow>(
    `SELECT * FROM supplier_scorecard_versions WHERE tenant_id = $1 AND scorecard_id = $2 AND version = $3`,
    [ctx.tenantId, valid.id, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new SuppliersError(
      'scorecard_version_not_found',
      `version ${valid.version} of scorecard '${valid.id}' does not exist in this tenant`,
    );
  }
  return mapScorecardVersion(row);
}

export async function listScorecardVersions(
  ctx: TenantContext,
  query: ListScorecardVersionsQuery,
): Promise<SupplierScorecardVersion[]> {
  assertSuppliersTenantContext(ctx);
  const valid = validateScorecardHistoryQuery(query);
  const rows = await getDb().query<ScorecardVersionRow>(
    `SELECT * FROM supplier_scorecard_versions WHERE tenant_id = $1 AND scorecard_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.id],
  );
  if (rows.rows.length === 0) {
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM supplier_scorecards WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.id],
    );
    if (exists.rows.length === 0) throw scorecardNotFound(valid.id);
  }
  return rows.rows.map(mapScorecardVersion);
}

// ---------------------------------------------------------------------------
// Derived — ranking
// ---------------------------------------------------------------------------

export async function rankSuppliers(
  ctx: TenantContext,
  query: RankSuppliersQuery,
): Promise<SupplierRanking[]> {
  assertSuppliersTenantContext(ctx);
  const valid = validateRankSuppliersQuery(query);

  // Candidates: ACTIVE suppliers carrying a current scorecard, bounded to
  // the documented analysis window in canonical (name, id) order (the
  // capabilities module's bounded-window precedent). The result `limit`
  // applies AFTER the deterministic ranking.
  const conditions: string[] = ['s.tenant_id = $1', "sv.status = 'active'", 'sc.id IS NOT NULL'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`sv.supplier_kind = $${params.length}`);
  }
  params.push(MAX_RANK_CANDIDATES);
  const boundPlaceholder = `$${params.length}`;
  const rows = await getDb().query<SupplierRow>(
    `${SUPPLIER_VIEW_COLUMNS} ${SUPPLIER_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY sv.name ASC, s.id ASC
      LIMIT ${boundPlaceholder}`,
    params,
  );

  const records = rows.rows.map((row) => ({
    supplier: {
      id: row.supplier_id,
      tenantId: row.supplier_tenant_id,
      name: row.name,
      kind: row.supplier_kind as SupplierKind, // CHECK-constrained
      status: row.status as SupplierRecordStatus, // CHECK-constrained
    },
    scorecard: {
      id: row.scorecard_id as string, // sc.id IS NOT NULL in this query
      version: toInt(row.scorecard_version as number | string),
      assessedAt: toIso(row.assessed_at as Date | string),
    },
    scores: scoresOf(row),
  }));

  return buildRanking(records, valid.weights).slice(0, valid.limit);
}

// ---------------------------------------------------------------------------
// Derived — supplier intelligence
// ---------------------------------------------------------------------------

export async function getSupplierIntelligence(
  ctx: TenantContext,
  query: GetSupplierIntelligenceQuery,
): Promise<SupplierIntelligence> {
  assertSuppliersTenantContext(ctx);
  const valid = validateSupplierIntelligenceQuery(query);
  if (!isUuid(valid.supplierId)) throw supplierNotFound(valid.supplierId);

  // 1. The supplier's current view (must exist in this tenant).
  const supplierRow = (
    await getDb().query<SupplierRow>(
      `${SUPPLIER_VIEW_COLUMNS} ${SUPPLIER_VIEW_FROM}
        WHERE s.tenant_id = $1 AND s.id = $2`,
      [ctx.tenantId, valid.supplierId],
    )
  ).rows[0];
  if (supplierRow === undefined) throw supplierNotFound(valid.supplierId);
  const supplier = mapSupplier(supplierRow);

  // 2. The current scorecard (full view, when assessed).
  let scorecard: SupplierScorecard | null = null;
  if (supplierRow.scorecard_id !== null) {
    const scorecardRow = (
      await getDb().query<ScorecardRow>(
        `${SCORECARD_VIEW_COLUMNS} ${SCORECARD_VIEW_FROM}
          WHERE sc.tenant_id = $1 AND sc.supplier_id = $2`,
        [ctx.tenantId, valid.supplierId],
      )
    ).rows[0];
    if (scorecardRow !== undefined) scorecard = mapScorecard(scorecardRow);
  }

  // 3. The derived scoring under the effective weights (null when unscored).
  const scoring: ScoringSummary | null =
    scorecard !== null ? computeScoring(scorecard.scores, valid.weights) : null;

  // 4. The tenant's current capability supplies through the capabilities
  //    contract (W017) — ONE bounded window in canonical
  //    (capability, kind, key) order (the observations module's
  //    documented bounded-window precedent).
  let supplies: CapabilitySupply[];
  try {
    supplies = await listSupplies(ctx, { limit: MAX_ANALYSIS_SUPPLIES });
  } catch (error) {
    throw analysisFailed('reading the capability supply graph', error);
  }

  // 5. Own supplies: the documented linkage convention — supply parties of
  //    kind 'supplier' whose party id === this supplier's uuid OR whose
  //    party label === this supplier's name (the two fields of an opaque
  //    W017 supplier party; OR-semantics, resolution precedence id-first).
  const isOwn = (supply: CapabilitySupply): boolean => {
    if (supply.supplier.kind !== 'supplier') return false;
    const partyId = supply.supplier.id ?? null;
    const partyLabel = supply.supplier.label ?? null;
    return (
      (partyId !== null && partyId.toLowerCase() === supplier.id) ||
      (partyLabel !== null && partyLabel === supplier.name)
    );
  };
  const ownSupplies = supplies.filter(isOwn);

  // 6. The distinct own capabilities (first-seen order in the canonical
  //    supply window), bounded to the documented analysis window.
  const ownCapabilityIds: string[] = [];
  const seenCapabilities = new Set<string>();
  for (const supply of ownSupplies) {
    if (seenCapabilities.has(supply.capabilityId)) continue;
    seenCapabilities.add(supply.capabilityId);
    ownCapabilityIds.push(supply.capabilityId);
    if (ownCapabilityIds.length >= MAX_ANALYSIS_CAPABILITIES) break;
  }
  const windowCapabilityIds = new Set(ownCapabilityIds);

  // 7. Capability references (name + status) through the capabilities
  //    contract, bounded by the same window.
  const capabilityById = new Map<
    string,
    { id: string; name: string; status: 'active' | 'retired' }
  >();
  for (const capabilityId of ownCapabilityIds) {
    try {
      const capability = await getCapability(ctx, capabilityId);
      capabilityById.set(capabilityId, {
        id: capability.id,
        name: capability.name,
        status: capability.status,
      });
    } catch (error) {
      throw analysisFailed(`reading capability '${capabilityId}'`, error);
    }
  }

  // 8. Every supply linked to this supplier (any status), with its capability.
  const suppliedCapabilities: SuppliedCapability[] = ownSupplies
    .filter((supply) => windowCapabilityIds.has(supply.capabilityId))
    .map((supply) => ({
      capability: capabilityById.get(supply.capabilityId)!,
      supplyId: supply.id,
      level: supply.level,
      capacity: supply.capacity,
      status: supply.status,
    }));

  // 9. Resolve alternative supplier parties (kind 'supplier', not own)
  //    against this registry — one bounded query; per-party resolution
  //    precedence: uuid party id first, then party label (supplier name).
  const alternativePartySupplies = supplies.filter(
    (supply) => supply.supplier.kind === 'supplier' && !isOwn(supply),
  );
  const byId = new Map<string, { row: SupplierRow; scoring: ScoringSummary }>();
  const byName = new Map<string, { row: SupplierRow; scoring: ScoringSummary }>();
  {
    const candidateIds: string[] = [];
    const candidateNames: string[] = [];
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const supply of alternativePartySupplies) {
      const partyId = supply.supplier.id ?? null;
      const partyLabel = supply.supplier.label ?? null;
      if (partyId !== null && isUuid(partyId) && !seenIds.has(partyId.toLowerCase())) {
        seenIds.add(partyId.toLowerCase());
        candidateIds.push(partyId.toLowerCase());
      }
      if (partyLabel !== null && !seenNames.has(partyLabel)) {
        seenNames.add(partyLabel);
        candidateNames.push(partyLabel);
      }
    }
    if (candidateIds.length > 0 || candidateNames.length > 0) {
      const rows = (
        await getDb().query<SupplierRow>(
          `${SUPPLIER_VIEW_COLUMNS} ${SUPPLIER_VIEW_FROM}
            WHERE s.tenant_id = $1 AND (s.id = ANY($2::uuid[]) OR s.name = ANY($3::text[]))`,
          [ctx.tenantId, candidateIds, candidateNames],
        )
      ).rows;
      for (const row of rows) {
        const entry = {
          row,
          scoring: computeScoring(scoresOf(row), valid.weights), // analysis weights
        };
        byId.set(row.supplier_id, entry);
        byName.set(row.name, entry);
      }
    }
  }
  const resolveParty = (supply: CapabilitySupply): AlternativeSupply['resolvedSupplier'] => {
    const partyId = supply.supplier.id ?? null;
    const partyLabel = supply.supplier.label ?? null;
    let entry: { row: SupplierRow; scoring: ScoringSummary } | undefined;
    if (partyId !== null && isUuid(partyId)) {
      entry = byId.get(partyId.toLowerCase());
    }
    if (entry === undefined && partyLabel !== null) {
      entry = byName.get(partyLabel);
    }
    if (entry === undefined) return null;
    return {
      id: entry.row.supplier_id,
      name: entry.row.name,
      kind: entry.row.supplier_kind as SupplierKind, // CHECK-constrained
      status: entry.row.status as SupplierRecordStatus, // CHECK-constrained
      overall: entry.scoring.overall,
    };
  };

  // 10. Per capability with ≥ 1 own ACTIVE supply: the alternatives — the
  //     other parties' supplies (all six channels), active (available) and
  //     retired (reactivation candidates), in the canonical supply order.
  const alternatives: CapabilityAlternatives[] = [];
  for (const capabilityId of ownCapabilityIds) {
    const capabilityOwn = ownSupplies.filter(
      (supply) => supply.capabilityId === capabilityId,
    );
    if (!capabilityOwn.some((supply) => supply.status === 'active')) continue;
    const others = supplies.filter(
      (supply) => supply.capabilityId === capabilityId && !isOwn(supply),
    );
    const mapAlternative = (supply: CapabilitySupply): AlternativeSupply => ({
      supplyId: supply.id,
      supplier: {
        // CHECK-constrained to the six supplier kinds by the capabilities
        // migration (the broad party union is the contract-level type).
        kind: supply.supplier.kind as AlternativeSupply['supplier']['kind'],
        id: supply.supplier.id ?? null,
        label: supply.supplier.label ?? null,
      },
      level: supply.level,
      capacity: supply.capacity,
      status: supply.status,
      resolvedSupplier: resolveParty(supply),
    });
    const activeAlternatives = others
      .filter((supply) => supply.status === 'active')
      .map(mapAlternative);
    const retiredAlternatives = others
      .filter((supply) => supply.status === 'retired')
      .map(mapAlternative);
    const activeByKind: CapabilityAlternatives['activeByKind'] = {
      employee: 0,
      team: 0,
      agent: 0,
      software: 0,
      supplier: 0,
      partner: 0,
    };
    for (const alternative of activeAlternatives) {
      activeByKind[alternative.supplier.kind] += 1;
    }
    alternatives.push({
      capability: capabilityById.get(capabilityId)!,
      ownSupplies: capabilityOwn.map((supply) => ({
        supplyId: supply.id,
        level: supply.level,
        capacity: supply.capacity,
        status: supply.status,
      })),
      activeAlternativeCount: activeAlternatives.length,
      activeByKind,
      activeAlternatives,
      retiredAlternatives,
    });
  }

  return {
    supplier,
    scorecard,
    scoring,
    suppliedCapabilities,
    alternatives,
  };
}
