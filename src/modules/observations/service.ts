// Implementation of the observations module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`observation_not_found`), including for lineage parents.
//
// W004 acceptance — "verify observation cannot be mutated into authoritative
// truth" — is carried by four deliberate properties, all tested:
//   1. the contract exposes record/read/list/lineage ONLY: there is no
//      update, no delete, no correction, no promotion operation;
//   2. PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on observations and
//      observation_lineage (migrations 001/002 triggers) — even a caller
//      bypassing the service cannot rewrite evidence;
//   3. `recordedAt` is minted by the service clock and caller-supplied
//      `id`/`tenantId`/`recordedAt` fields are rejected at validation;
//   4. contradictions and corrections are NEW observations (lock 12) — the
//      original evidence stays exactly as recorded, and an LLM-extracted
//      observation (lineage method `inference` with extractor metadata)
//      remains evidence with lineage and confidence, never authoritative
//      truth (lock 10).
//
// Read permissions: `principal` visibility is enforced on every read path
// (single-principal evidence is only retrievable by that principal, and
// derivation from such evidence requires being that principal). `workspace`
// visibility is recorded with its workspace id; workspace-membership
// enforcement arrives with the policy layer (W009) — W004 enforces the
// tenant boundary, which every read already carries.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { ObservationsError } from './errors';
import {
  assertObservationTenantContext,
  isUuid,
  validateListObservationsQuery,
  validateRecordObservationInput,
  type ValidatedListQuery,
  type ValidatedObservationInput,
} from './validation';
import type {
  ExtractorInfo,
  LineageMethod,
  ListObservationsQuery,
  Observation,
  ObservationLineageEdge,
  ObservationLineageResult,
  ObservationSource,
  ObservationVisibility,
  RecordObservationInput,
} from './types';

interface ObservationRow extends DbRow {
  id: string;
  tenant_id: string;
  kind: string;
  payload: unknown;
  observed_at: Date | string;
  recorded_at: Date | string;
  source_kind: string;
  source_id: string | null;
  source_label: string | null;
  channel: string;
  lineage_method: string;
  extractor: { provider: string; model: string; notes?: string | null } | null;
  visibility: string;
  visibility_workspace_id: string | null;
  visibility_principal_id: string | null;
  usage_tags: string[];
  confidence_value: number;
  confidence_method: string;
  confidence_basis: string | null;
}

interface LineageEdgeRow extends DbRow {
  observation_id: string;
  parent_observation_id: string;
  position: number;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapObservation(row: ObservationRow, parents: string[]): Observation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    payload: row.payload,
    observedAt: toIso(row.observed_at),
    recordedAt: toIso(row.recorded_at),
    source: {
      kind: row.source_kind as ObservationSource['kind'], // CHECK-constrained by migration 001
      id: row.source_id,
      label: row.source_label,
    },
    channel: row.channel,
    lineage: {
      method: row.lineage_method as LineageMethod, // CHECK-constrained by migration 001
      parents,
      extractor: (row.extractor ?? null) as ExtractorInfo | null,
    },
    permissions: {
      visibility: row.visibility as ObservationVisibility, // CHECK-constrained by migration 001
      workspaceId: row.visibility_workspace_id,
      principalId: row.visibility_principal_id,
      usage: row.usage_tags,
    },
    confidence: {
      value: row.confidence_value,
      method: row.confidence_method,
      basis: row.confidence_basis,
    },
  };
}

/**
 * Read guard: `principal`-scoped evidence is only readable by its principal.
 * `workspace` scoping is recorded for the policy layer (W009) — the tenant
 * boundary is enforced by every caller's TenantContext.
 */
function assertReadable(ctx: TenantContext, row: ObservationRow): void {
  if (
    row.visibility === 'principal' &&
    (row.visibility_principal_id === null || row.visibility_principal_id !== ctx.principalId)
  ) {
    throw new ObservationsError(
      'observation_forbidden',
      `observation '${row.id}' is restricted to its permissioned principal`,
    );
  }
}

async function loadObservationRow(ctx: TenantContext, observationId: string): Promise<ObservationRow> {
  if (!isUuid(observationId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new ObservationsError(
      'observation_not_found',
      `observation '${observationId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ObservationRow>(
    `SELECT * FROM observations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, observationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ObservationsError(
      'observation_not_found',
      `observation '${observationId}' does not exist in this tenant`,
    );
  }
  return row;
}

/** Parent ids of one observation, in the order the recording call supplied. */
async function loadParentsOf(db: Queryable, ctx: TenantContext, observationId: string): Promise<string[]> {
  const edges = await db.query<LineageEdgeRow>(
    `SELECT observation_id, parent_observation_id FROM observation_lineage
       WHERE tenant_id = $1 AND observation_id = $2
       ORDER BY position`,
    [ctx.tenantId, observationId],
  );
  return edges.rows.map((edge) => edge.parent_observation_id);
}

/** Parent ids per observation id for a batch of observations (one query). */
async function loadParentsFor(
  db: Queryable,
  ctx: TenantContext,
  observationIds: string[],
): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>();
  if (observationIds.length === 0) return byId;
  const edges = await db.query<LineageEdgeRow>(
    `SELECT observation_id, parent_observation_id FROM observation_lineage
       WHERE tenant_id = $1 AND observation_id = ANY($2::uuid[])
       ORDER BY observation_id, position`,
    [ctx.tenantId, observationIds],
  );
  for (const edge of edges.rows) {
    const list = byId.get(edge.observation_id) ?? [];
    list.push(edge.parent_observation_id);
    byId.set(edge.observation_id, list);
  }
  return byId;
}

export async function recordObservation(
  ctx: TenantContext,
  input: RecordObservationInput,
): Promise<Observation> {
  assertObservationTenantContext(ctx);
  const valid: ValidatedObservationInput = validateRecordObservationInput(input);

  // Parents must exist in THIS tenant and be readable by the recording
  // principal — derived evidence cannot be built from restricted evidence.
  // (Parents cannot disappear afterwards: DELETE is impossible by trigger.)
  if (valid.lineage.parents.length > 0) {
    const db = getDb();
    const parentRows = await db.query<ObservationRow>(
      `SELECT id, visibility, visibility_principal_id FROM observations
         WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [ctx.tenantId, valid.lineage.parents],
    );
    const found = new Set(parentRows.rows.map((row) => row.id));
    for (const parentId of valid.lineage.parents) {
      if (!found.has(parentId)) {
        // Cross-tenant parents are indistinguishable from missing ones.
        throw new ObservationsError(
          'observation_not_found',
          `parent observation '${parentId}' does not exist in this tenant`,
        );
      }
    }
    for (const parent of parentRows.rows) {
      assertReadable(ctx, parent);
    }
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    const inserted = await tx.query<ObservationRow>(
      `INSERT INTO observations (
         tenant_id, kind, payload, observed_at, recorded_at,
         source_kind, source_id, source_label, channel,
         lineage_method, extractor, visibility, visibility_workspace_id, visibility_principal_id,
         usage_tags, confidence_value, confidence_method, confidence_basis
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13, $14,
         $15, $16, $17, $18
       ) RETURNING *`,
      [
        ctx.tenantId,
        valid.kind,
        JSON.stringify(valid.payload),
        new Date(valid.observedAt),
        recordedAt,
        valid.source.kind,
        valid.source.id,
        valid.source.label,
        valid.channel,
        valid.lineage.method,
        valid.lineage.extractor === null ? null : JSON.stringify(valid.lineage.extractor),
        valid.permissions.visibility,
        valid.permissions.workspaceId,
        valid.permissions.principalId,
        JSON.stringify(valid.permissions.usage),
        valid.confidence.value,
        valid.confidence.method,
        valid.confidence.basis,
      ],
    );
    const row = inserted.rows[0]!;
    for (const [position, parentId] of valid.lineage.parents.entries()) {
      await tx.query(
        `INSERT INTO observation_lineage (tenant_id, observation_id, parent_observation_id, position)
           VALUES ($1, $2, $3, $4)`,
        [ctx.tenantId, row.id, parentId, position],
      );
    }
    return mapObservation(row, [...valid.lineage.parents]);
  });
}

export async function getObservation(
  ctx: TenantContext,
  observationId: string,
): Promise<Observation> {
  assertObservationTenantContext(ctx);
  const row = await loadObservationRow(ctx, observationId);
  assertReadable(ctx, row);
  const parents = await loadParentsOf(getDb(), ctx, row.id);
  return mapObservation(row, parents);
}

export async function listObservations(
  ctx: TenantContext,
  query: ListObservationsQuery,
): Promise<Observation[]> {
  assertObservationTenantContext(ctx);
  const valid: ValidatedListQuery = validateListObservationsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.kind !== null) add('kind = $#', valid.kind);
  if (valid.channel !== null) add('channel = $#', valid.channel);
  if (valid.sourceKind !== null) {
    add('source_kind = $#', valid.sourceKind);
    if (valid.sourceId !== null) add('source_id = $#', valid.sourceId);
  }
  if (valid.observedFrom !== null) add('observed_at >= $#', valid.observedFrom);
  if (valid.observedTo !== null) add('observed_at <= $#', valid.observedTo);
  // Principal-scoped evidence never surfaces in another principal's list.
  add(
    "(visibility <> 'principal' OR visibility_principal_id = $#)",
    ctx.principalId,
  );

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<ObservationRow>(
    `SELECT * FROM observations WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );

  const parents = await loadParentsFor(
    getDb(),
    ctx,
    rows.rows.map((row) => row.id),
  );
  return rows.rows.map((row) => mapObservation(row, parents.get(row.id) ?? []));
}

export async function getObservationLineage(
  ctx: TenantContext,
  observationId: string,
): Promise<ObservationLineageResult> {
  assertObservationTenantContext(ctx);
  const observation = await getObservation(ctx, observationId); // read-enforced
  const db = getDb();

  // Transitive ancestor edges within this tenant. UNION (not UNION ALL)
  // deduplicates; the edge set is a DAG by construction (parents always
  // pre-exist their children), so the recursion terminates. `position` rides
  // along so parents keep the order the recording call supplied.
  const edgeRows = await db.query<LineageEdgeRow>(
    `WITH RECURSIVE lineage AS (
       SELECT observation_id, parent_observation_id, position FROM observation_lineage
         WHERE tenant_id = $1 AND observation_id = $2
       UNION
       SELECT e.observation_id, e.parent_observation_id, e.position FROM observation_lineage e
         INNER JOIN lineage l ON e.tenant_id = $1 AND e.observation_id = l.parent_observation_id
     )
     SELECT observation_id, parent_observation_id, position FROM lineage`,
    [ctx.tenantId, observation.id],
  );

  const ancestorIds = [...new Set(edgeRows.rows.map((edge) => edge.parent_observation_id))];
  const ancestorRows =
    ancestorIds.length === 0
      ? []
      : (
          await db.query<ObservationRow>(
            `SELECT * FROM observations WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
            [ctx.tenantId, ancestorIds],
          )
        ).rows;

  // Only ancestors the caller may read are exposed; unreadable ancestors
  // drop together with their edges (partial lineage view, no leak).
  const readableIds = new Set<string>([observation.id]);
  for (const row of ancestorRows) {
    if (row.visibility !== 'principal' || row.visibility_principal_id === ctx.principalId) {
      readableIds.add(row.id);
    }
  }
  const edges: ObservationLineageEdge[] = edgeRows.rows
    .filter((edge) => readableIds.has(edge.observation_id) && readableIds.has(edge.parent_observation_id))
    .sort((a, b) =>
      a.observation_id === b.observation_id
        ? a.position - b.position
        : a.observation_id.localeCompare(b.observation_id),
    )
    .map((edge) => ({
      observationId: edge.observation_id,
      parentObservationId: edge.parent_observation_id,
    }));

  const parentsByAncestor = new Map<string, string[]>();
  for (const edge of [...edgeRows.rows].sort((a, b) => a.position - b.position)) {
    const list = parentsByAncestor.get(edge.observation_id) ?? [];
    list.push(edge.parent_observation_id);
    parentsByAncestor.set(edge.observation_id, list);
  }
  const ancestors = ancestorRows
    .filter((row) => readableIds.has(row.id))
    .map((row) => mapObservation(row, parentsByAncestor.get(row.id) ?? []))
    .sort((a, b) =>
      a.observedAt === b.observedAt
        ? a.id.localeCompare(b.id)
        : a.observedAt.localeCompare(b.observedAt),
    );

  return { observation, edges, ancestors };
}
