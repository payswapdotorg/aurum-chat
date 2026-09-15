// Implementation of the memory module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`knowledge_entry_not_found` / `transactive_entry_not_found`),
// including for evidence citations.
//
// W010 acceptance — "evidence-backed organizational knowledge and
// transactive memory" — is carried by these deliberate properties, all
// tested:
//   1. the evidence gate: every entry cites at least one observation that
//      exists in THIS tenant and is readable by the recording principal
//      (lock 11), verified through the observations module's public
//      contract — never its tables. Unavailable evidence (missing, foreign
//      or restricted) is uniformly `invalid_provenance` — no leak;
//   2. organizational memory is APPEND-ONLY: the contract exposes
//      record/read/list/evidence operations ONLY — there is no update, no
//      delete, no correction, no promotion operation — and PostgreSQL
//      triggers reject UPDATE/DELETE/TRUNCATE outright (migrations/001 and
//      /002), so even a caller bypassing the service cannot rewrite what
//      the organization remembered;
//   3. entries carry no truth semantics (lock 10): no confidence or
//      authoritative flag of their own — contradictory entries coexist
//      untouched (lock 12) and truth-weighing is the epistemics module's
//      job (W007), derived ON TOP of this memory;
//   4. `recordedAt` is minted by the service clock and caller-supplied
//      `id`/`tenantId`/`recordedAt` fields are rejected at validation;
//   5. evidence resolution returns a partial view: supporting observations
//      the calling principal may not read are omitted, never leaked (the
//      observations module's lineage-view discipline).
//
// Cross-module integration: this module reads observations ONLY through the
// observations contract (getObservation) — mirroring how the freshness
// module consumes it.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  getObservation,
  ObservationsError,
  type Observation,
} from '@/modules/observations/contract';
import { MemoryError } from './errors';
import {
  assertMemoryTenantContext,
  escapeLikePattern,
  isUuid,
  validateListKnowledgeEntriesQuery,
  validateListTransactiveEntriesQuery,
  validateRecordKnowledgeEntryInput,
  validateRecordTransactiveEntryInput,
  type ValidatedKnowledgeInput,
  type ValidatedKnowledgeListQuery,
  type ValidatedTransactiveInput,
  type ValidatedTransactiveListQuery,
} from './validation';
import type {
  KnowledgeEntry,
  KnowledgeEntryEvidence,
  KnowledgeEntryKind,
  ListKnowledgeEntriesQuery,
  ListTransactiveEntriesQuery,
  MemoryEntityRef,
  RecordKnowledgeEntryInput,
  RecordTransactiveEntryInput,
  TransactiveActorKind,
  TransactiveActorRef,
  TransactiveEntry,
  TransactiveEntryEvidence,
  TransactiveRelation,
} from './types';

interface KnowledgeRow extends DbRow {
  id: string;
  tenant_id: string;
  kind: string;
  title: string;
  summary: string;
  topics: string[];
  entities: MemoryEntityRef[];
  evidence_observation_ids: string[];
  notes: string | null;
  recorded_at: Date | string;
}

interface TransactiveRow extends DbRow {
  id: string;
  tenant_id: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  relation: string;
  subject_label: string;
  topics: string[];
  entities: MemoryEntityRef[];
  evidence_observation_ids: string[];
  notes: string | null;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function normalizeEntities(entities: MemoryEntityRef[]): MemoryEntityRef[] {
  return entities.map((ref) => ({ kind: ref.kind, id: ref.id ?? null, label: ref.label ?? null }));
}

function mapKnowledge(row: KnowledgeRow): KnowledgeEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as KnowledgeEntryKind, // CHECK-constrained by migration 001
    title: row.title,
    summary: row.summary,
    topics: [...row.topics].sort(),
    entities: normalizeEntities(row.entities),
    evidenceObservationIds: [...row.evidence_observation_ids].sort(),
    notes: row.notes,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapTransactive(row: TransactiveRow): TransactiveEntry {
  const actor: TransactiveActorRef = {
    kind: row.actor_kind as TransactiveActorKind, // CHECK-constrained by migration 002
    id: row.actor_id,
    label: row.actor_label,
  };
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actor,
    relation: row.relation as TransactiveRelation, // CHECK-constrained by migration 002
    subjectLabel: row.subject_label,
    topics: [...row.topics].sort(),
    entities: normalizeEntities(row.entities),
    evidenceObservationIds: [...row.evidence_observation_ids].sort(),
    notes: row.notes,
    recordedAt: toIso(row.recorded_at),
  };
}

/**
 * Evidence gate: every supporting observation must exist in THIS tenant and
 * be readable by the recording principal. Cross-tenant and restricted
 * evidence are uniformly `invalid_provenance` — no existence leak. The
 * checks run before the write; observations are immutable, so the evidence
 * cannot disappear afterwards (DELETE is impossible by trigger).
 */
async function assertEvidenceReadable(
  ctx: TenantContext,
  observationIds: string[],
): Promise<void> {
  for (const observationId of observationIds) {
    try {
      await getObservation(ctx, observationId);
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw new MemoryError(
          'invalid_provenance',
          `supporting observation '${observationId}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
  }
}

/**
 * Evidence resolution: the supporting observations READABLE by the calling
 * principal. Unreadable observations (principal-scoped evidence of another
 * principal) are skipped — a partial view, never a leak. Ordered by
 * `observedAt`, then id, so callers can pair the evidence directly with the
 * freshness module's classifiers (W006).
 */
async function resolveReadableEvidence(
  ctx: TenantContext,
  observationIds: string[],
): Promise<Observation[]> {
  const evidence: Observation[] = [];
  for (const observationId of observationIds) {
    try {
      evidence.push(await getObservation(ctx, observationId));
    } catch (error) {
      if (error instanceof ObservationsError) continue;
      throw error;
    }
  }
  evidence.sort((a, b) =>
    a.observedAt === b.observedAt ? a.id.localeCompare(b.id) : a.observedAt.localeCompare(b.observedAt),
  );
  return evidence;
}

async function loadKnowledgeRow(ctx: TenantContext, knowledgeEntryId: string): Promise<KnowledgeRow> {
  if (!isUuid(knowledgeEntryId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new MemoryError(
      'knowledge_entry_not_found',
      `knowledge entry '${knowledgeEntryId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<KnowledgeRow>(
    `SELECT * FROM memory_knowledge_entries WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, knowledgeEntryId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MemoryError(
      'knowledge_entry_not_found',
      `knowledge entry '${knowledgeEntryId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function loadTransactiveRow(
  ctx: TenantContext,
  transactiveEntryId: string,
): Promise<TransactiveRow> {
  if (!isUuid(transactiveEntryId)) {
    throw new MemoryError(
      'transactive_entry_not_found',
      `transactive entry '${transactiveEntryId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<TransactiveRow>(
    `SELECT * FROM memory_transactive_entries WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, transactiveEntryId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MemoryError(
      'transactive_entry_not_found',
      `transactive entry '${transactiveEntryId}' does not exist in this tenant`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Organizational knowledge
// ---------------------------------------------------------------------------

export async function recordKnowledgeEntry(
  ctx: TenantContext,
  input: RecordKnowledgeEntryInput,
): Promise<KnowledgeEntry> {
  assertMemoryTenantContext(ctx);
  const valid: ValidatedKnowledgeInput = validateRecordKnowledgeEntryInput(input);
  await assertEvidenceReadable(ctx, valid.evidenceObservationIds);

  const recordedAt = now();
  const inserted = await getDb().query<KnowledgeRow>(
    `INSERT INTO memory_knowledge_entries (
       tenant_id, kind, title, summary, topics, entities, evidence_observation_ids, notes, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.kind,
      valid.title,
      valid.summary,
      valid.topics,
      JSON.stringify(valid.entities),
      JSON.stringify(valid.evidenceObservationIds),
      valid.notes,
      recordedAt,
    ],
  );
  return mapKnowledge(inserted.rows[0]!);
}

export async function getKnowledgeEntry(
  ctx: TenantContext,
  knowledgeEntryId: string,
): Promise<KnowledgeEntry> {
  assertMemoryTenantContext(ctx);
  const row = await loadKnowledgeRow(ctx, knowledgeEntryId);
  return mapKnowledge(row);
}

export async function listKnowledgeEntries(
  ctx: TenantContext,
  query: ListKnowledgeEntriesQuery,
): Promise<KnowledgeEntry[]> {
  assertMemoryTenantContext(ctx);
  const valid: ValidatedKnowledgeListQuery = validateListKnowledgeEntriesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.kind !== null) add('kind = $#', valid.kind);
  // ANY-of topic matching via the array overlap operator.
  if (valid.topics !== null) add('(topics && $#::text[])', valid.topics);
  // Containment on the jsonb entity array: matches any entity reference
  // carrying this kind (optionally narrowed to this id — extra keys such
  // as a label do not affect jsonb containment semantics).
  if (valid.entityKind !== null) {
    const containment =
      valid.entityId !== null
        ? [{ kind: valid.entityKind, id: valid.entityId }]
        : [{ kind: valid.entityKind }];
    add('entities @> $#::jsonb', JSON.stringify(containment));
  }
  // Containment on the jsonb evidence array: entries citing this observation.
  if (valid.evidenceObservationId !== null) {
    add(
      'evidence_observation_ids @> $#::jsonb',
      JSON.stringify([valid.evidenceObservationId]),
    );
  }
  if (valid.text !== null) {
    params.push(`%${escapeLikePattern(valid.text)}%`);
    conditions.push(`(title ILIKE $${params.length} ESCAPE '\\' OR summary ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (valid.recordedFrom !== null) add('recorded_at >= $#', valid.recordedFrom);
  if (valid.recordedTo !== null) add('recorded_at <= $#', valid.recordedTo);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<KnowledgeRow>(
    `SELECT * FROM memory_knowledge_entries WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapKnowledge);
}

export async function getKnowledgeEntryEvidence(
  ctx: TenantContext,
  knowledgeEntryId: string,
): Promise<KnowledgeEntryEvidence> {
  assertMemoryTenantContext(ctx);
  const row = await loadKnowledgeRow(ctx, knowledgeEntryId);
  const entry = mapKnowledge(row);
  const evidence = await resolveReadableEvidence(ctx, entry.evidenceObservationIds);
  return { entry, evidence };
}

// ---------------------------------------------------------------------------
// Transactive memory
// ---------------------------------------------------------------------------

export async function recordTransactiveEntry(
  ctx: TenantContext,
  input: RecordTransactiveEntryInput,
): Promise<TransactiveEntry> {
  assertMemoryTenantContext(ctx);
  const valid: ValidatedTransactiveInput = validateRecordTransactiveEntryInput(input);
  await assertEvidenceReadable(ctx, valid.evidenceObservationIds);

  const recordedAt = now();
  const inserted = await getDb().query<TransactiveRow>(
    `INSERT INTO memory_transactive_entries (
       tenant_id, actor_kind, actor_id, actor_label, relation, subject_label,
       topics, entities, evidence_observation_ids, notes, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.actor.kind,
      valid.actor.id,
      valid.actor.label,
      valid.relation,
      valid.subjectLabel,
      valid.topics,
      JSON.stringify(valid.entities),
      JSON.stringify(valid.evidenceObservationIds),
      valid.notes,
      recordedAt,
    ],
  );
  return mapTransactive(inserted.rows[0]!);
}

export async function getTransactiveEntry(
  ctx: TenantContext,
  transactiveEntryId: string,
): Promise<TransactiveEntry> {
  assertMemoryTenantContext(ctx);
  const row = await loadTransactiveRow(ctx, transactiveEntryId);
  return mapTransactive(row);
}

export async function listTransactiveEntries(
  ctx: TenantContext,
  query: ListTransactiveEntriesQuery,
): Promise<TransactiveEntry[]> {
  assertMemoryTenantContext(ctx);
  const valid: ValidatedTransactiveListQuery = validateListTransactiveEntriesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.topics !== null) add('(topics && $#::text[])', valid.topics);
  if (valid.relation !== null) add('relation = $#', valid.relation);
  if (valid.actorKind !== null) add('actor_kind = $#', valid.actorKind);
  if (valid.actorKind !== null && valid.actorId !== null) add('actor_id = $#', valid.actorId);
  if (valid.evidenceObservationId !== null) {
    add(
      'evidence_observation_ids @> $#::jsonb',
      JSON.stringify([valid.evidenceObservationId]),
    );
  }
  if (valid.text !== null) {
    params.push(`%${escapeLikePattern(valid.text)}%`);
    conditions.push(
      `(subject_label ILIKE $${params.length} ESCAPE '\\' OR notes ILIKE $${params.length} ESCAPE '\\')`,
    );
  }
  if (valid.recordedFrom !== null) add('recorded_at >= $#', valid.recordedFrom);
  if (valid.recordedTo !== null) add('recorded_at <= $#', valid.recordedTo);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<TransactiveRow>(
    `SELECT * FROM memory_transactive_entries WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapTransactive);
}

export async function getTransactiveEntryEvidence(
  ctx: TenantContext,
  transactiveEntryId: string,
): Promise<TransactiveEntryEvidence> {
  assertMemoryTenantContext(ctx);
  const row = await loadTransactiveRow(ctx, transactiveEntryId);
  const entry = mapTransactive(row);
  const evidence = await resolveReadableEvidence(ctx, entry.evidenceObservationIds);
  return { entry, evidence };
}
