// Implementation of the coverage module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`) except snapshot/gap ids, which the service mints
// with `newId()` so the immutable snapshot document and its gap rows are
// written in one pass with no rewrite; semantic timestamps
// (`createdAt`/`evaluatedAt`/`detectedAt`) come from the injectable clock
// and are never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from missing records (`surface_not_found` / `source_not_found` /
// `claim_not_found` / `snapshot_not_found` — no existence leak).
//
// W125 acceptance — "tenant-scoped CoverageSurface/CoverageSource/
// CoverageClaim/CoverageGap/CoverageSnapshot semantics; separate
// dimensions; the seven §5 states; derivation is evidence/connection
// based; no credentials in coverage state; coverage never becomes a
// second source of organizational truth" — is carried by these deliberate
// properties, all tested:
//   1. claims/gaps/snapshots are APPEND-ONLY from the domain perspective:
//      no update or delete operation exists on the contract and
//      PostgreSQL triggers reject UPDATE/DELETE/TRUNCATE outright
//      (migrations/001 — the audit module's append-only discipline
//      applied to derived coverage history: a later snapshot never
//      rewrites an earlier one, §3);
//   2. `evaluateSnapshot` derives every surface rollup, dimension
//      measurement and gap EXCLUSIVELY from recorded claims — the
//      evidence/connection basis — through the pure measurement model in
//      validation.ts; nothing is fabricated and the not-yet-measurable
//      dimensions honestly read UNKNOWN (§15 "coverage dimensions are
//      independently measurable");
//   3. claims may only reference REGISTERED surfaces and sources — the
//      registry is the authority on what is tracked (§2: coverage is a
//      derived view, never another organizational database);
//   4. credentials cannot enter coverage state: validation rejects
//      credential-shaped keys and raw-credential values, and the schema
//      has no credential-bearing column (§13).

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { CoverageError } from './errors';
import {
  assertCoverageTenantContext,
  deriveGaps,
  derivePolicyRestrictions,
  measureDimensions,
  rollupSurfaces,
  validateEvaluateSnapshotQuery,
  validateGetSnapshotQuery,
  validateListClaimsQuery,
  validateListGapsQuery,
  validateListSnapshotsQuery,
  validateListSourcesQuery,
  validateListSurfacesQuery,
  validateRecordClaimInput,
  validateRegisterSourceInput,
  validateRegisterSurfaceInput,
  type SnapshotDocument,
  type ValidatedListClaimsQuery,
  type ValidatedListGapsQuery,
  type ValidatedRecordClaimInput,
  type ValidatedRegisterSourceInput,
  type ValidatedRegisterSurfaceInput,
} from './validation';
import type {
  CoverageClaim,
  CoverageGap,
  CoverageSnapshot,
  CoverageSnapshotSummary,
  CoverageSource,
  CoverageSurface,
  DimensionMeasurement,
  EvaluateSnapshotQuery,
  GetSnapshotQuery,
  ListClaimsQuery,
  ListGapsQuery,
  ListSnapshotsQuery,
  ListSourcesQuery,
  ListSurfacesQuery,
  RecordClaimInput,
  RegisterSourceInput,
  RegisterSurfaceInput,
  SurfaceSummary,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface CoverageSurfaceRow extends DbRow {
  id: string;
  tenant_id: string;
  key: string;
  label: string;
  description: string | null;
  created_at: Date | string;
}

interface CoverageSourceRow extends DbRow {
  id: string;
  tenant_id: string;
  registry: string;
  ref: string;
  label: string | null;
  created_at: Date | string;
}

interface CoverageClaimRow extends DbRow {
  id: string;
  tenant_id: string;
  surface_key: string;
  source_registry: string;
  source_ref: string;
  basis_kind: string;
  basis_ids: string[];
  last_observed_at: Date | string | null;
  state: string;
  last_usable_at: Date | string | null;
  policy_max_age_seconds: number | null;
  confidence_value: string | number;
  reason: string;
  evaluated_by: string;
  evaluated_at: Date | string;
}

interface CoverageGapRow extends DbRow {
  id: string;
  tenant_id: string;
  snapshot_id: string;
  surface_key: string;
  dimension: string;
  state: string;
  reason: string;
  material: boolean;
  affected_goal_ids: string[];
  detected_at: Date | string;
}

interface CoverageSnapshotRow extends DbRow {
  id: string;
  tenant_id: string;
  document: SnapshotDocument;
  evaluated_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapSurface(row: CoverageSurfaceRow): CoverageSurface {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    label: row.label,
    description: row.description,
    createdAt: toIso(row.created_at),
  };
}

function mapSource(row: CoverageSourceRow): CoverageSource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    registry: row.registry as CoverageSource['registry'],
    ref: row.ref,
    label: row.label,
    createdAt: toIso(row.created_at),
  };
}

function mapClaim(row: CoverageClaimRow): CoverageClaim {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    surfaceKey: row.surface_key,
    source: {
      registry: row.source_registry as CoverageClaim['source']['registry'],
      ref: row.source_ref,
    },
    observationBasis: {
      kind: row.basis_kind,
      ids: row.basis_ids ?? [],
      lastObservedAt: row.last_observed_at === null ? null : toIso(row.last_observed_at),
    },
    state: row.state as CoverageClaim['state'],
    freshness: {
      lastUsableAt: row.last_usable_at === null ? null : toIso(row.last_usable_at),
      policyMaxAgeSeconds: row.policy_max_age_seconds,
    },
    confidenceValue: Number(row.confidence_value),
    reason: row.reason,
    evaluatedBy: row.evaluated_by,
    evaluatedAt: toIso(row.evaluated_at),
  };
}

function mapGap(row: CoverageGapRow): CoverageGap {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    snapshotId: row.snapshot_id,
    surfaceKey: row.surface_key,
    dimension: row.dimension as CoverageGap['dimension'],
    state: row.state as CoverageGap['state'],
    reason: row.reason,
    material: row.material,
    affectedGoalIds: row.affected_goal_ids ?? [],
    detectedAt: toIso(row.detected_at),
  };
}

/** PostgreSQL unique-violation (23505) from either db backend. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

// ---------------------------------------------------------------------------
// registerSurface / listSurfaces
// ---------------------------------------------------------------------------

export async function registerSurface(
  ctx: TenantContext,
  input: RegisterSurfaceInput,
): Promise<CoverageSurface> {
  assertCoverageTenantContext(ctx);
  const valid: ValidatedRegisterSurfaceInput = validateRegisterSurfaceInput(input);
  const db = getDb();

  const existing = await db.query<CoverageSurfaceRow>(
    `SELECT * FROM coverage_surfaces WHERE tenant_id = $1 AND key = $2`,
    [ctx.tenantId, valid.key],
  );
  if (existing.rows.length > 0) {
    throw new CoverageError(
      'surface_already_registered',
      `surface '${valid.key}' is already registered in this tenant`,
    );
  }

  try {
    const result = await db.query<CoverageSurfaceRow>(
      `INSERT INTO coverage_surfaces (tenant_id, key, label, description, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
      [ctx.tenantId, valid.key, valid.label, valid.description, now()],
    );
    return mapSurface(result.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CoverageError(
        'surface_already_registered',
        `surface '${valid.key}' is already registered in this tenant`,
      );
    }
    throw error;
  }
}

export async function listSurfaces(
  ctx: TenantContext,
  query?: ListSurfacesQuery,
): Promise<CoverageSurface[]> {
  assertCoverageTenantContext(ctx);
  const valid = validateListSurfacesQuery(query);
  const rows = await getDb().query<CoverageSurfaceRow>(
    `SELECT * FROM coverage_surfaces
       WHERE tenant_id = $1
       ORDER BY key ASC
       LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  return rows.rows.map(mapSurface);
}

// ---------------------------------------------------------------------------
// registerSource / listSources
// ---------------------------------------------------------------------------

export async function registerSource(
  ctx: TenantContext,
  input: RegisterSourceInput,
): Promise<CoverageSource> {
  assertCoverageTenantContext(ctx);
  const valid: ValidatedRegisterSourceInput = validateRegisterSourceInput(input);
  const db = getDb();

  const existing = await db.query<CoverageSourceRow>(
    `SELECT * FROM coverage_sources WHERE tenant_id = $1 AND registry = $2 AND ref = $3`,
    [ctx.tenantId, valid.registry, valid.ref],
  );
  if (existing.rows.length > 0) {
    throw new CoverageError(
      'source_already_registered',
      `source '${valid.registry}:${valid.ref}' is already registered in this tenant`,
    );
  }

  try {
    const result = await db.query<CoverageSourceRow>(
      `INSERT INTO coverage_sources (tenant_id, registry, ref, label, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
      [ctx.tenantId, valid.registry, valid.ref, valid.label, now()],
    );
    return mapSource(result.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CoverageError(
        'source_already_registered',
        `source '${valid.registry}:${valid.ref}' is already registered in this tenant`,
      );
    }
    throw error;
  }
}

export async function listSources(
  ctx: TenantContext,
  query?: ListSourcesQuery,
): Promise<CoverageSource[]> {
  assertCoverageTenantContext(ctx);
  const valid = validateListSourcesQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT * FROM coverage_sources WHERE tenant_id = $1`;
  if (valid.registry !== null) {
    params.push(valid.registry);
    sql += ` AND registry = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY registry ASC, ref ASC LIMIT $${params.length}`;
  const rows = await getDb().query<CoverageSourceRow>(sql, params);
  return rows.rows.map(mapSource);
}

// ---------------------------------------------------------------------------
// recordClaim / listClaims
// ---------------------------------------------------------------------------

export async function recordClaim(
  ctx: TenantContext,
  input: RecordClaimInput,
): Promise<CoverageClaim> {
  assertCoverageTenantContext(ctx);
  const valid: ValidatedRecordClaimInput = validateRecordClaimInput(input);
  const db = getDb();

  // §2/§3 discipline: a claim may only address a REGISTERED surface and a
  // REGISTERED source — the registry is the authority on what is tracked.
  const surface = await db.query<CoverageSurfaceRow>(
    `SELECT * FROM coverage_surfaces WHERE tenant_id = $1 AND key = $2`,
    [ctx.tenantId, valid.surfaceKey],
  );
  if (surface.rows.length === 0) {
    throw new CoverageError(
      'surface_not_found',
      `no surface '${valid.surfaceKey}' is registered in this tenant`,
    );
  }
  const source = await db.query<CoverageSourceRow>(
    `SELECT * FROM coverage_sources WHERE tenant_id = $1 AND registry = $2 AND ref = $3`,
    [ctx.tenantId, valid.sourceRegistry, valid.sourceRef],
  );
  if (source.rows.length === 0) {
    throw new CoverageError(
      'source_not_found',
      `no source '${valid.sourceRegistry}:${valid.sourceRef}' is registered in this tenant`,
    );
  }

  const evaluatedAt = now();
  const result = await db.query<CoverageClaimRow>(
    `INSERT INTO coverage_claims
       (tenant_id, surface_key, source_registry, source_ref, basis_kind, basis_ids,
        last_observed_at, state, last_usable_at, policy_max_age_seconds,
        confidence_value, reason, evaluated_by, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.surfaceKey,
      valid.sourceRegistry,
      valid.sourceRef,
      valid.basisKind,
      JSON.stringify(valid.basisIds),
      valid.lastObservedAt,
      valid.state,
      valid.lastUsableAt,
      valid.policyMaxAgeSeconds,
      valid.confidenceValue,
      valid.reason,
      ctx.principalId,
      evaluatedAt,
    ],
  );
  return mapClaim(result.rows[0]!);
}

export async function listClaims(
  ctx: TenantContext,
  query?: ListClaimsQuery,
): Promise<CoverageClaim[]> {
  assertCoverageTenantContext(ctx);
  const valid: ValidatedListClaimsQuery = validateListClaimsQuery(query);

  const conditions = [`tenant_id = $1`];
  const params: unknown[] = [ctx.tenantId];
  if (valid.surfaceKey !== null) {
    params.push(valid.surfaceKey);
    conditions.push(`surface_key = $${params.length}`);
  }
  if (valid.state !== null) {
    params.push(valid.state);
    conditions.push(`state = $${params.length}`);
  }
  if (valid.sourceRef !== null) {
    params.push(valid.sourceRef);
    conditions.push(`source_ref = $${params.length}`);
  }
  params.push(valid.limit);

  const rows = await getDb().query<CoverageClaimRow>(
    `SELECT * FROM coverage_claims
       WHERE ${conditions.join(' AND ')}
       ORDER BY evaluated_at ASC, id ASC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapClaim);
}

// ---------------------------------------------------------------------------
// evaluateSnapshot / getSnapshot / listSnapshots / listGaps
// ---------------------------------------------------------------------------

function mapSnapshot(row: CoverageSnapshotRow): CoverageSnapshot {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    evaluatedAt: toIso(row.evaluated_at),
    surfaces: row.document.surfaces,
    dimensions: row.document.dimensions,
    policyRestrictions: row.document.policyRestrictions,
    gaps: row.document.gaps,
  };
}

export async function evaluateSnapshot(
  ctx: TenantContext,
  query?: EvaluateSnapshotQuery,
): Promise<CoverageSnapshot> {
  assertCoverageTenantContext(ctx);
  const valid = validateEvaluateSnapshotQuery(query);
  const db = getDb();
  const evaluatedAt = now();

  return db.transaction(async (tx) => {
    // The considered surfaces: the requested subset, or all registered.
    const surfaceParams: unknown[] = [ctx.tenantId];
    let surfaceSql = `SELECT * FROM coverage_surfaces WHERE tenant_id = $1`;
    if (valid.surfaceKeys !== null) {
      surfaceParams.push(valid.surfaceKeys);
      surfaceSql += ` AND key = ANY($2::text[])`;
    }
    surfaceSql += ` ORDER BY key ASC`;
    const surfaces = await tx.query<CoverageSurfaceRow>(surfaceSql, surfaceParams);

    const sources = await tx.query<CoverageSourceRow>(
      `SELECT * FROM coverage_sources WHERE tenant_id = $1`,
      [ctx.tenantId],
    );

    // All current claims, then narrowed to the considered surfaces.
    const allClaims = await loadCurrentClaimsForTx(tx, ctx);
    const consideredKeys = new Set(surfaces.rows.map((row) => row.key));
    const latestClaims = allClaims.filter((claim) => consideredKeys.has(claim.surfaceKey));

    // The pure W125 measurement model (validation.ts): rollup, dimensions,
    // policy restrictions, gaps — derived EXCLUSIVELY from claims.
    const summaries: SurfaceSummary[] = rollupSurfaces(
      surfaces.rows.map((row) => ({ key: row.key })),
      latestClaims,
    );
    const dimensions: DimensionMeasurement[] = measureDimensions({
      surfaces: surfaces.rows.map((row) => ({ key: row.key })),
      latestClaims,
      sourceCount: sources.rows.length,
      referenceTime: evaluatedAt.toISOString(),
    });
    const policyRestrictions = derivePolicyRestrictions(latestClaims);
    const drafts = deriveGaps(summaries);

    // Mint identity in one pass: the snapshot id and its gap ids, so the
    // immutable document and its gap rows insert without any rewrite.
    const snapshotId = newId();
    const gaps: CoverageGap[] = drafts.map((draft) => ({
      id: newId(),
      tenantId: ctx.tenantId,
      snapshotId,
      surfaceKey: draft.surfaceKey,
      dimension: draft.dimension,
      state: draft.state,
      reason: draft.reason,
      material: draft.material,
      affectedGoalIds: [],
      detectedAt: evaluatedAt.toISOString(),
    }));

    const document: SnapshotDocument = {
      surfaces: summaries,
      dimensions,
      policyRestrictions,
      gaps,
    };

    await tx.query(
      `INSERT INTO coverage_snapshots (id, tenant_id, document, evaluated_at)
         VALUES ($1, $2, $3::jsonb, $4)`,
      [snapshotId, ctx.tenantId, JSON.stringify(document), evaluatedAt],
    );

    for (const gap of gaps) {
      await tx.query(
        `INSERT INTO coverage_gaps
           (id, tenant_id, snapshot_id, surface_key, dimension, state, reason,
            material, affected_goal_ids, detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          gap.id,
          ctx.tenantId,
          snapshotId,
          gap.surfaceKey,
          gap.dimension,
          gap.state,
          gap.reason,
          gap.material,
          JSON.stringify(gap.affectedGoalIds),
          evaluatedAt,
        ],
      );
    }

    return {
      id: snapshotId,
      tenantId: ctx.tenantId,
      evaluatedAt: evaluatedAt.toISOString(),
      ...document,
    };
  });
}

/**
 * The current (latest-per-source) claims of a tenant — the derivation
 * base of `evaluateSnapshot`, read inside its transaction. `DISTINCT ON`
 * keeps the most recent evaluation per (surface, source) pair; claims
 * are append-only history, the latest is the current statement.
 */
async function loadCurrentClaimsForTx(
  tx: { query<T extends DbRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> },
  ctx: TenantContext,
): Promise<CoverageClaim[]> {
  const rows = await tx.query<CoverageClaimRow>(
    `SELECT DISTINCT ON (surface_key, source_registry, source_ref)
       id, tenant_id, surface_key, source_registry, source_ref, basis_kind, basis_ids,
       last_observed_at, state, last_usable_at, policy_max_age_seconds,
       confidence_value, reason, evaluated_by, evaluated_at
     FROM coverage_claims
     WHERE tenant_id = $1
     ORDER BY surface_key, source_registry, source_ref, evaluated_at DESC, id DESC`,
    [ctx.tenantId],
  );
  return rows.rows.map(mapClaim);
}

export async function getSnapshot(
  ctx: TenantContext,
  query: GetSnapshotQuery,
): Promise<CoverageSnapshot> {
  assertCoverageTenantContext(ctx);
  const valid = validateGetSnapshotQuery(query);
  const result = await getDb().query<CoverageSnapshotRow>(
    `SELECT * FROM coverage_snapshots WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.snapshotId],
  );
  if (result.rows.length === 0) {
    throw new CoverageError(
      'snapshot_not_found',
      `no snapshot '${valid.snapshotId}' exists in this tenant`,
    );
  }
  return mapSnapshot(result.rows[0]!);
}

export async function listSnapshots(
  ctx: TenantContext,
  query?: ListSnapshotsQuery,
): Promise<CoverageSnapshotSummary[]> {
  assertCoverageTenantContext(ctx);
  const valid = validateListSnapshotsQuery(query);
  const rows = await getDb().query<CoverageSnapshotRow>(
    `SELECT * FROM coverage_snapshots
       WHERE tenant_id = $1
       ORDER BY evaluated_at DESC, id DESC
       LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  return rows.rows.map((row) => {
    const document = row.document;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      evaluatedAt: toIso(row.evaluated_at),
      surfaceCount: document.surfaces.length,
      gapCount: document.gaps.length,
    };
  });
}

export async function listGaps(
  ctx: TenantContext,
  query?: ListGapsQuery,
): Promise<CoverageGap[]> {
  assertCoverageTenantContext(ctx);
  const valid: ValidatedListGapsQuery = validateListGapsQuery(query);

  const conditions = [`tenant_id = $1`];
  const params: unknown[] = [ctx.tenantId];
  if (valid.snapshotId !== null) {
    params.push(valid.snapshotId);
    conditions.push(`snapshot_id = $${params.length}`);
  }
  if (valid.surfaceKey !== null) {
    params.push(valid.surfaceKey);
    conditions.push(`surface_key = $${params.length}`);
  }
  if (valid.dimension !== null) {
    params.push(valid.dimension);
    conditions.push(`dimension = $${params.length}`);
  }
  if (valid.material !== null) {
    params.push(valid.material);
    conditions.push(`material = $${params.length}`);
  }
  params.push(valid.limit);

  const rows = await getDb().query<CoverageGapRow>(
    `SELECT * FROM coverage_gaps
       WHERE ${conditions.join(' AND ')}
       ORDER BY detected_at DESC, id ASC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapGap);
}

