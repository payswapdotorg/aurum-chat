// Implementation of the environment module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `created_at`/`updated_at`/`recorded_at` come from
// the injectable clock and are never caller-supplied; every statement is
// scoped by the explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`watchlist_not_found` /
// `watch_entry_not_found` / `watch_signal_not_found` /
// `watch_escalation_not_found`), including through the cross-module
// validation paths.
//
// W014 acceptance — "company-specific external watchlists with entities,
// topics, geography, regulators, competitors, suppliers, freshness and
// escalation policy" — is carried by these deliberate properties, all
// tested:
//   1. COMPANY-SPECIFIC: every watchlist/entry/signal/escalation row is
//      tenant-scoped; the composite (id, tenant_id) keys + FKs make a
//      cross-tenant row unrepresentable in SQL, and another tenant's data
//      is uniformly not-found (no existence leak).
//   2. THE THREE AXES: entries are entity (refined by the §12 entity
//      vocabulary — regulators, competitors, suppliers, laws, technologies,
//      markets, government bodies, industries), topic and geography
//      subjects, scoped by canonical geography/topic slugs.
//   3. FRESHNESS: watch stale-after policies live in the freshness module
//      (W006) under the shared subject-kind 'environment.watch' — exactly
//      the wiring the freshness contract anticipates — and evaluation uses
//      freshness's PURE classifiers (classifyFreshness / evidenceAgeSeconds)
//      over the entry's newest signal evidence.
//   4. ESCALATION POLICY: a required watchlist default with per-entry
//      full-snapshot overrides; the signal arm fires on recordWatchSignal,
//      the staleness arm on the explicit escalateStaleWatches pump (this
//      module owns no background time); every escalation snapshots the
//      resolved policy and is append-only (storage-enforced).
//
// Storage shape: `watchlists` (identity + default policy; control) +
// `watch_entries` (watched subjects; control) + `watch_signals`
// (append-only evidence-linked hits) + `watch_escalations` (append-only
// policy-snapshotted escalation records).

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { getLock } from '@/infra/lock';
import type { TenantContext } from '@/infra/tenant';
import { getExecution, CognitionError } from '@/modules/cognition/contract';
import {
  classifyFreshness,
  evidenceAgeSeconds,
  FreshnessError,
  resolveFreshnessPolicy,
  setFreshnessPolicy,
  type FreshnessPolicy,
} from '@/modules/freshness/contract';
import { getObservation, ObservationsError } from '@/modules/observations/contract';
import { getEntity, WorldError } from '@/modules/world/contract';
import {
  isStaleEpisodeEscalated,
  resolveEscalationPolicy,
  severityMeetsFloor,
  severitiesAtOrAbove,
  signalEscalationSummary,
  staleEscalationSummary,
  stalenessDue,
  stalenessSchedule,
} from './escalation';
import { EnvironmentError } from './errors';
import {
  assertEnvironmentTenantContext,
  escapeLike,
  validateAddWatchEntryInput,
  validateCreateWatchlistInput,
  validateEscalateStaleWatchesQuery,
  validateEvaluateWatchFreshnessQuery,
  validateGetWatchEntryQuery,
  validateGetWatchEscalationQuery,
  validateGetWatchlistQuery,
  validateGetWatchSignalQuery,
  validateListWatchEntriesQuery,
  validateListWatchEscalationsQuery,
  validateListWatchSignalsQuery,
  validateListWatchlistsQuery,
  validateRecordSignalInput,
  validateResolveWatchFreshnessPolicyQuery,
  validateSetWatchEntryStatusInput,
  validateSetWatchFreshnessPolicyInput,
  validateSetWatchlistStatusInput,
  validateUpdateWatchEntryInput,
  validateUpdateWatchlistInput,
  WATCH_SUBJECT_KIND,
  type ValidatedAddWatchEntryInput,
  type ValidatedCreateWatchlistInput,
  type ValidatedEscalationPolicy,
  type ValidatedListEntriesQuery,
  type ValidatedListEscalationsQuery,
  type ValidatedListSignalsQuery,
  type ValidatedListWatchlistsQuery,
  type ValidatedRecordSignalInput,
  type ValidatedSetWatchFreshnessPolicyInput,
  type ValidatedUpdateWatchEntryInput,
  type ValidatedUpdateWatchlistInput,
} from './validation';
import type {
  AddWatchEntryInput,
  CreateWatchlistInput,
  EscalateStaleWatchesQuery,
  EvaluateWatchFreshnessQuery,
  GetWatchEntryQuery,
  GetWatchEscalationQuery,
  GetWatchSignalQuery,
  GetWatchlistQuery,
  ListWatchEntriesQuery,
  ListWatchEscalationsQuery,
  ListWatchSignalsQuery,
  ListWatchlistsQuery,
  RecordWatchSignalInput,
  ResolvedEscalationPolicy,
  ResolveWatchFreshnessPolicyQuery,
  SetWatchEntryStatusInput,
  SetWatchFreshnessPolicyInput,
  SetWatchlistStatusInput,
  StaleEscalationCounts,
  StaleEscalationRun,
  UpdateWatchEntryInput,
  UpdateWatchlistInput,
  WatchEscalation,
  WatchEscalationPolicy,
  WatchEntry,
  WatchFreshness,
  WatchSignal,
  WatchSignalResult,
  Watchlist,
} from './types';

/** Single-flight TTL of one stale-pump pass per tenant. */
const PUMP_LOCK_TTL_MS = 30_000;
const PUMP_LOCK_KEY_PREFIX = 'environment:stale-pump:';

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

interface WatchlistRow extends DbRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  status: string;
  escalation_policy: unknown;
  created_by_principal: string;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Entry row joined with the owning watchlist's view fields. */
interface EntryRow extends DbRow {
  id: string;
  tenant_id: string;
  watchlist_id: string;
  kind: string;
  entity_kind: string | null;
  name: string;
  description: string | null;
  world_entity_id: string | null;
  geographies: unknown;
  topics: unknown;
  escalation_policy: unknown;
  status: string;
  created_by_principal: string;
  created_at: Date | string;
  updated_at: Date | string;
  watchlist_name: string;
  watchlist_status: string;
  watchlist_escalation_policy: unknown;
}

interface SignalRow extends DbRow {
  id: string;
  tenant_id: string;
  watch_entry_id: string;
  observation_id: string;
  observed_at: Date | string;
  severity: string;
  note: string | null;
  origin_execution_id: string | null;
  recorded_by: string;
  recorded_at: Date | string;
  escalation_id: string | null;
}

interface EscalationRow extends DbRow {
  id: string;
  tenant_id: string;
  watch_entry_id: string;
  trigger_kind: string;
  severity: string;
  signal_id: string | null;
  policy_snapshot: unknown;
  summary: string;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Stored policy JSON is the validated public shape (validated at write). */
function policyFromDb(value: unknown): WatchEscalationPolicy {
  return value as WatchEscalationPolicy;
}

function serializePolicy(policy: ValidatedEscalationPolicy): string {
  return JSON.stringify(policy);
}

function mapWatchlist(
  row: WatchlistRow,
  counts: { active: number; paused: number; archived: number },
): Watchlist {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    status: row.status as Watchlist['status'],
    escalationPolicy: policyFromDb(row.escalation_policy),
    entryCounts: counts,
    createdBy: row.created_by_principal,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEntry(row: EntryRow): WatchEntry {
  const ownPolicy = row.escalation_policy === null ? null : policyFromDb(row.escalation_policy);
  const resolved = resolveEscalationPolicy(
    ownPolicy,
    policyFromDb(row.watchlist_escalation_policy),
  );
  return {
    id: row.id,
    tenantId: row.tenant_id,
    watchlistId: row.watchlist_id,
    watchlistName: row.watchlist_name,
    watchlistStatus: row.watchlist_status as WatchEntry['watchlistStatus'],
    kind: row.kind as WatchEntry['kind'],
    entityKind: row.entity_kind as WatchEntry['entityKind'],
    name: row.name,
    description: row.description,
    worldEntityId: row.world_entity_id,
    geographies: row.geographies as string[],
    topics: row.topics as string[],
    escalationPolicy: ownPolicy,
    resolvedEscalationPolicy: resolved as ResolvedEscalationPolicy,
    status: row.status as WatchEntry['status'],
    createdBy: row.created_by_principal,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapSignal(row: SignalRow): WatchSignal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    watchEntryId: row.watch_entry_id,
    observationId: row.observation_id,
    observedAt: toIso(row.observed_at),
    severity: row.severity as WatchSignal['severity'],
    note: row.note,
    originExecutionId: row.origin_execution_id,
    escalated: row.escalation_id !== null,
    escalationId: row.escalation_id,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapEscalation(row: EscalationRow): WatchEscalation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    watchEntryId: row.watch_entry_id,
    trigger: row.trigger_kind as WatchEscalation['trigger'],
    severity: row.severity as WatchEscalation['severity'],
    signalId: row.signal_id,
    policySnapshot: row.policy_snapshot as ResolvedEscalationPolicy,
    summary: row.summary,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

/** True when `error` is a PostgreSQL unique violation naming `constraint`. */
function isDuplicateKeyOn(error: unknown, constraint: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(constraint)
  );
}

// ---------------------------------------------------------------------------
// Row loaders
// ---------------------------------------------------------------------------

async function loadWatchlistRow(ctx: TenantContext, watchlistId: string): Promise<WatchlistRow> {
  const rows = await getDb().query<WatchlistRow>(
    `SELECT * FROM watchlists WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, watchlistId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EnvironmentError(
      'watchlist_not_found',
      `no watchlist '${watchlistId}' exists in this tenant`,
    );
  }
  return row;
}

const ENTRY_SELECT = `
  SELECT e.*,
         w.name AS watchlist_name,
         w.status AS watchlist_status,
         w.escalation_policy AS watchlist_escalation_policy
    FROM watch_entries e
    JOIN watchlists w ON w.tenant_id = e.tenant_id AND w.id = e.watchlist_id`;

async function loadEntryRow(ctx: TenantContext, watchEntryId: string): Promise<EntryRow> {
  const rows = await getDb().query<EntryRow>(
    `${ENTRY_SELECT} WHERE e.tenant_id = $1 AND e.id = $2`,
    [ctx.tenantId, watchEntryId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EnvironmentError(
      'watch_entry_not_found',
      `no watch entry '${watchEntryId}' exists in this tenant`,
    );
  }
  return row;
}

async function entryCountsOf(
  ctx: TenantContext,
  watchlistId: string,
): Promise<{ active: number; paused: number; archived: number }> {
  const rows = await getDb().query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int AS count FROM watch_entries
       WHERE tenant_id = $1 AND watchlist_id = $2 GROUP BY status`,
    [ctx.tenantId, watchlistId],
  );
  const counts = { active: 0, paused: 0, archived: 0 };
  for (const row of rows.rows) {
    if (row.status === 'active' || row.status === 'paused' || row.status === 'archived') {
      counts[row.status] = row.count;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Cross-module validation (contracts only — never sibling tables)
// ---------------------------------------------------------------------------

/** The world entity a watch entry binds to must be readable in this tenant (W005). */
async function validateWorldEntityRef(ctx: TenantContext, worldEntityId: string): Promise<void> {
  try {
    await getEntity(ctx, worldEntityId);
  } catch (error) {
    if (error instanceof WorldError) {
      throw new EnvironmentError(
        'invalid_world_ref',
        `world entity '${worldEntityId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/** The observation backing a signal must be readable in this tenant (W004). */
async function validateObservationRef(ctx: TenantContext, observationId: string) {
  try {
    return await getObservation(ctx, observationId);
  } catch (error) {
    if (error instanceof ObservationsError) {
      throw new EnvironmentError(
        'invalid_observation_ref',
        `observation '${observationId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/** The originating cognitive execution must be readable in this tenant (W013). */
async function validateOriginExecution(ctx: TenantContext, executionId: string): Promise<void> {
  try {
    await getExecution(ctx, { executionId });
  } catch (error) {
    if (error instanceof CognitionError) {
      throw new EnvironmentError(
        'invalid_execution_ref',
        `originating execution '${executionId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/** Maps a FreshnessError from the watch-freshness wiring onto this module's vocabulary. */
function mapFreshnessError(error: unknown, code: 'invalid_policy_input' | 'invalid_watch_query'): Error {
  if (error instanceof FreshnessError) {
    return new EnvironmentError(code, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

export async function createWatchlist(
  ctx: TenantContext,
  input: CreateWatchlistInput,
): Promise<Watchlist> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedCreateWatchlistInput = validateCreateWatchlistInput(input);
  const timestamp = now();
  let inserted: WatchlistRow;
  try {
    const result = await getDb().query<WatchlistRow>(
      `INSERT INTO watchlists (
         tenant_id, name, description, escalation_policy, created_by_principal,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)
       RETURNING *`,
      [
        ctx.tenantId,
        valid.name,
        valid.description,
        serializePolicy(valid.escalationPolicy),
        ctx.principalId,
        timestamp,
      ],
    );
    inserted = result.rows[0]!;
  } catch (error) {
    if (isDuplicateKeyOn(error, 'watchlists_tenant_name_unique')) {
      throw new EnvironmentError(
        'watchlist_name_conflict',
        `a watchlist named '${valid.name}' already exists in this tenant`,
      );
    }
    throw error;
  }
  return mapWatchlist(inserted, { active: 0, paused: 0, archived: 0 });
}

export async function getWatchlist(
  ctx: TenantContext,
  query: GetWatchlistQuery,
): Promise<Watchlist> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateGetWatchlistQuery(query);
  const row = await loadWatchlistRow(ctx, valid.id);
  return mapWatchlist(row, await entryCountsOf(ctx, row.id));
}

export async function listWatchlists(
  ctx: TenantContext,
  query: ListWatchlistsQuery,
): Promise<Watchlist[]> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedListWatchlistsQuery = validateListWatchlistsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.search !== null) {
    params.push(`%${escapeLike(valid.search)}%`);
    const placeholder = `$${params.length}`;
    conditions.push(
      `(name ILIKE ${placeholder} ESCAPE '\\' OR description ILIKE ${placeholder} ESCAPE '\\')`,
    );
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<WatchlistRow>(
    `SELECT * FROM watchlists WHERE ${conditions.join(' AND ')}
       ORDER BY name ASC, id ASC LIMIT ${limitPlaceholder}`,
    params,
  );
  if (rows.rows.length === 0) return [];

  const ids = rows.rows.map((row) => row.id);
  const idParams: unknown[] = [ctx.tenantId, ...ids];
  const inList = ids.map((_, index) => `$${index + 2}`).join(', ');
  const grouped = await getDb().query<{ watchlist_id: string; status: string; count: number }>(
    `SELECT watchlist_id, status, COUNT(*)::int AS count FROM watch_entries
       WHERE tenant_id = $1 AND watchlist_id IN (${inList})
       GROUP BY watchlist_id, status`,
    idParams,
  );
  const countsByList = new Map<string, { active: number; paused: number; archived: number }>();
  for (const row of grouped.rows) {
    const bucket =
      countsByList.get(row.watchlist_id) ?? { active: 0, paused: 0, archived: 0 };
    if (row.status === 'active' || row.status === 'paused' || row.status === 'archived') {
      bucket[row.status] = row.count;
    }
    countsByList.set(row.watchlist_id, bucket);
  }
  return rows.rows.map((row) =>
    mapWatchlist(row, countsByList.get(row.id) ?? { active: 0, paused: 0, archived: 0 }),
  );
}

export async function updateWatchlist(
  ctx: TenantContext,
  input: UpdateWatchlistInput,
): Promise<Watchlist> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedUpdateWatchlistInput = validateUpdateWatchlistInput(input);
  await loadWatchlistRow(ctx, valid.watchlistId);

  const assignments: string[] = [];
  const values: unknown[] = [];
  if (valid.name !== null) {
    values.push(valid.name);
    assignments.push(`name = $${values.length}`);
  }
  if (valid.setDescription) {
    values.push(valid.description);
    assignments.push(`description = $${values.length}`);
  }
  if (valid.setEscalationPolicy) {
    values.push(serializePolicy(valid.escalationPolicy!));
    assignments.push(`escalation_policy = $${values.length}::jsonb`);
  }
  const timestamp = now();
  values.push(timestamp);
  assignments.push(`updated_at = $${values.length}`);
  values.push(ctx.tenantId, valid.watchlistId);

  let updated: WatchlistRow;
  try {
    const result = await getDb().query<WatchlistRow>(
      `UPDATE watchlists SET ${assignments.join(', ')}
         WHERE tenant_id = $${values.length - 1} AND id = $${values.length}
         RETURNING *`,
      values,
    );
    updated = result.rows[0]!;
  } catch (error) {
    if (isDuplicateKeyOn(error, 'watchlists_tenant_name_unique')) {
      throw new EnvironmentError(
        'watchlist_name_conflict',
        `a watchlist named '${valid.name}' already exists in this tenant`,
      );
    }
    throw error;
  }
  return mapWatchlist(updated, await entryCountsOf(ctx, updated.id));
}

export async function setWatchlistStatus(
  ctx: TenantContext,
  input: SetWatchlistStatusInput,
): Promise<Watchlist> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateSetWatchlistStatusInput(input);
  const existing = await loadWatchlistRow(ctx, valid.watchlistId);
  if (existing.status === valid.status) {
    throw new EnvironmentError(
      'watchlist_status_conflict',
      `watchlist '${valid.watchlistId}' is already '${valid.status}'`,
    );
  }
  const timestamp = now();
  const result = await getDb().query<WatchlistRow>(
    `UPDATE watchlists SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, valid.watchlistId, valid.status, timestamp],
  );
  return mapWatchlist(result.rows[0]!, await entryCountsOf(ctx, valid.watchlistId));
}

// ---------------------------------------------------------------------------
// Watch entries
// ---------------------------------------------------------------------------

export async function addWatchEntry(
  ctx: TenantContext,
  input: AddWatchEntryInput,
): Promise<WatchEntry> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedAddWatchEntryInput = validateAddWatchEntryInput(input);
  const watchlist = await loadWatchlistRow(ctx, valid.watchlistId);
  if (watchlist.status !== 'active') {
    throw new EnvironmentError(
      'watchlist_archived',
      `watchlist '${valid.watchlistId}' is archived — reactivate it before adding entries`,
    );
  }
  if (valid.worldEntityId !== null) {
    await validateWorldEntityRef(ctx, valid.worldEntityId);
  }

  const timestamp = now();
  try {
    const result = await getDb().query<EntryRow>(
      `INSERT INTO watch_entries (
         tenant_id, watchlist_id, kind, entity_kind, name, description,
         world_entity_id, geographies, topics, escalation_policy, status,
         created_by_principal, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, 'active', $11, $12, $12)
       RETURNING *`,
      [
        ctx.tenantId,
        valid.watchlistId,
        valid.kind,
        valid.entityKind,
        valid.name,
        valid.description,
        valid.worldEntityId,
        JSON.stringify(valid.geographies),
        JSON.stringify(valid.topics),
        valid.escalationPolicy === null ? null : serializePolicy(valid.escalationPolicy),
        ctx.principalId,
        timestamp,
      ],
    );
    // Denormalized watchlist view fields merged in memory — the list was
    // verified active above; its name/policy are read from the same row.
    return mapEntry({
      ...result.rows[0]!,
      watchlist_name: watchlist.name,
      watchlist_status: watchlist.status,
      watchlist_escalation_policy: watchlist.escalation_policy,
    });
  } catch (error) {
    if (isDuplicateKeyOn(error, 'watch_entries_identity_unique')) {
      throw new EnvironmentError(
        'watch_entry_conflict',
        `an entry named '${valid.name}' of this kind already exists in this watchlist`,
      );
    }
    throw error;
  }
}

export async function getWatchEntry(
  ctx: TenantContext,
  query: GetWatchEntryQuery,
): Promise<WatchEntry> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateGetWatchEntryQuery(query);
  return mapEntry(await loadEntryRow(ctx, valid.id));
}

export async function listWatchEntries(
  ctx: TenantContext,
  query: ListWatchEntriesQuery,
): Promise<WatchEntry[]> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedListEntriesQuery = validateListWatchEntriesQuery(query);

  const conditions: string[] = ['e.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.watchlistId !== null) {
    params.push(valid.watchlistId);
    conditions.push(`e.watchlist_id = $${params.length}`);
  }
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`e.kind = $${params.length}`);
  }
  if (valid.entityKind !== null) {
    params.push(valid.entityKind);
    conditions.push(`e.entity_kind = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`e.status = $${params.length}`);
  }
  if (valid.geography !== null) {
    params.push(JSON.stringify([valid.geography]));
    conditions.push(`e.geographies @> $${params.length}::jsonb`);
  }
  if (valid.topic !== null) {
    params.push(JSON.stringify([valid.topic]));
    conditions.push(`e.topics @> $${params.length}::jsonb`);
  }
  if (valid.search !== null) {
    params.push(`%${escapeLike(valid.search)}%`);
    const placeholder = `$${params.length}`;
    conditions.push(
      `(e.name ILIKE ${placeholder} ESCAPE '\\' OR e.description ILIKE ${placeholder} ESCAPE '\\')`,
    );
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<EntryRow>(
    `${ENTRY_SELECT} WHERE ${conditions.join(' AND ')}
       ORDER BY e.name ASC, e.id ASC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapEntry);
}

export async function updateWatchEntry(
  ctx: TenantContext,
  input: UpdateWatchEntryInput,
): Promise<WatchEntry> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedUpdateWatchEntryInput = validateUpdateWatchEntryInput(input);
  const existing = await loadEntryRow(ctx, valid.watchEntryId);

  // Identity-dependent rule the pure validation cannot check: a geography
  // entry never carries geographies (the entry itself is the geography).
  if (valid.geographies !== null && valid.geographies.length > 0 && existing.kind === 'geography') {
    throw new EnvironmentError(
      'invalid_watch_entry_input',
      'geographies must stay empty for geography entries (the entry itself is the geography; use topics to focus it)',
    );
  }
  if (valid.setWorldEntityId && valid.worldEntityId !== null) {
    await validateWorldEntityRef(ctx, valid.worldEntityId);
  }

  const assignments: string[] = [];
  const values: unknown[] = [];
  if (valid.name !== null) {
    values.push(valid.name);
    assignments.push(`name = $${values.length}`);
  }
  if (valid.setDescription) {
    values.push(valid.description);
    assignments.push(`description = $${values.length}`);
  }
  if (valid.setWorldEntityId) {
    values.push(valid.worldEntityId);
    assignments.push(`world_entity_id = $${values.length}`);
  }
  if (valid.geographies !== null) {
    values.push(JSON.stringify(valid.geographies));
    assignments.push(`geographies = $${values.length}::jsonb`);
  }
  if (valid.topics !== null) {
    values.push(JSON.stringify(valid.topics));
    assignments.push(`topics = $${values.length}::jsonb`);
  }
  if (valid.setEscalationPolicy) {
    values.push(valid.escalationPolicy === null ? null : serializePolicy(valid.escalationPolicy));
    assignments.push(`escalation_policy = $${values.length}::jsonb`);
  }
  const timestamp = now();
  values.push(timestamp);
  assignments.push(`updated_at = $${values.length}`);
  values.push(ctx.tenantId, valid.watchEntryId);

  let updated: DbRow;
  try {
    const result = await getDb().query<DbRow>(
      `UPDATE watch_entries SET ${assignments.join(', ')}
         WHERE tenant_id = $${values.length - 1} AND id = $${values.length}
         RETURNING *`,
      values,
    );
    updated = result.rows[0]!;
  } catch (error) {
    if (isDuplicateKeyOn(error, 'watch_entries_identity_unique')) {
      throw new EnvironmentError(
        'watch_entry_conflict',
        `an entry named '${valid.name}' of this kind already exists in this watchlist`,
      );
    }
    throw error;
  }
  return mapEntry({
    ...updated,
    watchlist_name: existing.watchlist_name,
    watchlist_status: existing.watchlist_status,
    watchlist_escalation_policy: existing.watchlist_escalation_policy,
  } as EntryRow);
}

export async function setWatchEntryStatus(
  ctx: TenantContext,
  input: SetWatchEntryStatusInput,
): Promise<WatchEntry> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateSetWatchEntryStatusInput(input);
  const existing = await loadEntryRow(ctx, valid.watchEntryId);
  if (existing.status === valid.status) {
    throw new EnvironmentError(
      'watch_entry_status_conflict',
      `watch entry '${valid.watchEntryId}' is already '${valid.status}'`,
    );
  }
  const timestamp = now();
  const result = await getDb().query<DbRow>(
    `UPDATE watch_entries SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
    [ctx.tenantId, valid.watchEntryId, valid.status, timestamp],
  );
  return mapEntry({
    ...result.rows[0]!,
    watchlist_name: existing.watchlist_name,
    watchlist_status: existing.watchlist_status,
    watchlist_escalation_policy: existing.watchlist_escalation_policy,
  } as EntryRow);
}

// ---------------------------------------------------------------------------
// Freshness wiring (W006 — subject kind 'environment.watch')
// ---------------------------------------------------------------------------

export async function setWatchFreshnessPolicy(
  ctx: TenantContext,
  input: SetWatchFreshnessPolicyInput,
): Promise<FreshnessPolicy> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedSetWatchFreshnessPolicyInput =
    validateSetWatchFreshnessPolicyInput(input);
  // A specific policy refines ONE existing watch entry (the freshness
  // module cannot know entry existence — this module owns that check).
  if (valid.watchEntryId !== null) {
    await loadEntryRow(ctx, valid.watchEntryId);
  }
  try {
    return await setFreshnessPolicy(ctx, {
      subjectKind: WATCH_SUBJECT_KIND,
      subjectId: valid.watchEntryId,
      staleAfterSeconds: valid.staleAfterSeconds,
      agingAfterSeconds: valid.agingAfterSeconds,
      maxLatencySeconds: valid.maxLatencySeconds,
      note: valid.note,
    });
  } catch (error) {
    throw mapFreshnessError(error, 'invalid_policy_input');
  }
}

export async function resolveWatchFreshnessPolicy(
  ctx: TenantContext,
  query: ResolveWatchFreshnessPolicyQuery,
): Promise<FreshnessPolicy | null> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateResolveWatchFreshnessPolicyQuery(query);
  await loadEntryRow(ctx, valid.watchEntryId);
  try {
    return await resolveFreshnessPolicy(ctx, {
      subjectKind: WATCH_SUBJECT_KIND,
      subjectId: valid.watchEntryId,
    });
  } catch (error) {
    throw mapFreshnessError(error, 'invalid_watch_query');
  }
}

export async function evaluateWatchFreshness(
  ctx: TenantContext,
  query: EvaluateWatchFreshnessQuery,
): Promise<WatchFreshness> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateEvaluateWatchFreshnessQuery(query);
  const entry = mapEntry(await loadEntryRow(ctx, valid.watchEntryId));
  const asOf = valid.asOf ?? now();
  const asOfIso = asOf.toISOString();

  let policy: FreshnessPolicy | null;
  try {
    policy = await resolveFreshnessPolicy(ctx, {
      subjectKind: WATCH_SUBJECT_KIND,
      subjectId: valid.watchEntryId,
    });
  } catch (error) {
    throw mapFreshnessError(error, 'invalid_watch_query');
  }

  // Newest evidence: the entry's newest signal by observedAt (then commit
  // time, then id — deterministic even on timestamp ties).
  const latest = await getDb().query<{ id: string; observed_at: Date | string }>(
    `SELECT id, observed_at FROM watch_signals
       WHERE tenant_id = $1 AND watch_entry_id = $2
       ORDER BY observed_at DESC, recorded_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, valid.watchEntryId],
  );
  const latestRow = latest.rows[0] ?? null;

  const escalation = entry.resolvedEscalationPolicy;
  const grace = escalation.policy.staleGraceSeconds;
  const armed = grace !== null;

  if (policy === null || latestRow === null) {
    // No policy to age against, or no evidence to age — the freshness
    // module's 'unknown' discipline (never stale: "never observed" is
    // attention's territory, W051, not a staleness pump's).
    return {
      watchEntryId: entry.id,
      tenantId: entry.tenantId,
      evaluatedAt: asOfIso,
      status: 'unknown',
      latestSignalId: latestRow?.id ?? null,
      latestObservedAt: latestRow === null ? null : toIso(latestRow.observed_at),
      ageSeconds: null,
      policy,
      escalationPolicy: escalation,
      staleSince: null,
      staleForSeconds: null,
      escalationDueAt: null,
      staleEscalationRecorded: false,
    };
  }

  const latestObservedAt = toIso(latestRow.observed_at);
  const ageSeconds = evidenceAgeSeconds(latestObservedAt, asOfIso);
  const status = classifyFreshness(
    { staleAfterSeconds: policy.staleAfterSeconds, agingAfterSeconds: policy.agingAfterSeconds },
    ageSeconds,
  );

  let staleSince: string | null = null;
  let staleForSeconds: number | null = null;
  let escalationDueAt: string | null = null;
  let staleEscalationRecorded = false;
  if (status === 'stale') {
    const schedule = stalenessSchedule(latestObservedAt, policy.staleAfterSeconds, grace ?? 0);
    staleSince = schedule.staleSince.toISOString();
    staleForSeconds = ageSeconds - policy.staleAfterSeconds;
    if (armed) {
      escalationDueAt = schedule.escalateAt.toISOString();
      const lastStale = await getDb().query<{ recorded_at: Date | string }>(
        `SELECT recorded_at FROM watch_escalations
           WHERE tenant_id = $1 AND watch_entry_id = $2 AND trigger_kind = 'stale'
           ORDER BY recorded_at DESC LIMIT 1`,
        [ctx.tenantId, valid.watchEntryId],
      );
      const lastIso = lastStale.rows[0] === undefined ? null : toIso(lastStale.rows[0]!.recorded_at);
      staleEscalationRecorded = isStaleEpisodeEscalated(lastIso, schedule.staleSince);
    }
  } else if (armed) {
    // The forward schedule: when the watch WILL escalate if nothing
    // fresher arrives (informative before staleness begins).
    const schedule = stalenessSchedule(latestObservedAt, policy.staleAfterSeconds, grace!);
    escalationDueAt = schedule.escalateAt.toISOString();
  }

  return {
    watchEntryId: entry.id,
    tenantId: entry.tenantId,
    evaluatedAt: asOfIso,
    status,
    latestSignalId: latestRow.id,
    latestObservedAt,
    ageSeconds,
    policy,
    escalationPolicy: escalation,
    staleSince,
    staleForSeconds,
    escalationDueAt,
    staleEscalationRecorded,
  };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export async function recordWatchSignal(
  ctx: TenantContext,
  input: RecordWatchSignalInput,
): Promise<WatchSignalResult> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedRecordSignalInput = validateRecordSignalInput(input);

  const entryRow = await loadEntryRow(ctx, valid.watchEntryId);
  if (entryRow.status !== 'active' || entryRow.watchlist_status !== 'active') {
    throw new EnvironmentError(
      'watch_entry_inactive',
      `watch entry '${valid.watchEntryId}' is not actively watched (entry '${entryRow.status}', watchlist '${entryRow.watchlist_status}') — only active entries on active watchlists collect signals`,
    );
  }
  const observation = await validateObservationRef(ctx, valid.observationId);
  if (valid.originExecutionId !== null) {
    await validateOriginExecution(ctx, valid.originExecutionId);
  }

  const escalationPolicy = resolveEscalationPolicy(
    entryRow.escalation_policy === null ? null : policyFromDb(entryRow.escalation_policy),
    policyFromDb(entryRow.watchlist_escalation_policy),
  )!;
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    let signalRow: DbRow;
    try {
      const inserted = await tx.query<DbRow>(
        `INSERT INTO watch_signals (
           tenant_id, watch_entry_id, observation_id, observed_at, severity,
           note, origin_execution_id, recorded_by, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          ctx.tenantId,
          valid.watchEntryId,
          valid.observationId,
          observation.observedAt,
          valid.severity,
          valid.note,
          valid.originExecutionId,
          ctx.principalId,
          timestamp,
        ],
      );
      signalRow = inserted.rows[0]!;
    } catch (error) {
      if (isDuplicateKeyOn(error, 'watch_signals_entry_observation_unique')) {
        throw new EnvironmentError(
          'signal_conflict',
          `observation '${valid.observationId}' is already linked as a signal on this watch entry`,
        );
      }
      throw error;
    }

    // The signal arm: at/above the floor, escalate immediately — with the
    // resolved policy SNAPSHOTTED on the escalation row.
    let escalation: WatchEscalation | null = null;
    if (severityMeetsFloor(valid.severity, escalationPolicy.policy.signalSeverityFloor)) {
      const snapshot = JSON.stringify(escalationPolicy);
      const summary = signalEscalationSummary(valid.severity, valid.note, valid.observationId);
      try {
        const escalationInserted = await tx.query<EscalationRow>(
          `INSERT INTO watch_escalations (
             tenant_id, watch_entry_id, trigger_kind, severity, signal_id,
             policy_snapshot, summary, recorded_by, recorded_at
           ) VALUES ($1, $2, 'signal', $3, $4, $5::jsonb, $6, $7, $8)
           RETURNING *`,
          [
            ctx.tenantId,
            valid.watchEntryId,
            valid.severity,
            signalRow.id,
            snapshot,
            summary,
            ctx.principalId,
            timestamp,
          ],
        );
        escalation = mapEscalation(escalationInserted.rows[0]!);
      } catch (error) {
        if (isDuplicateKeyOn(error, 'watch_escalations_signal_unique')) {
          // One escalation per signal, ever — a concurrent recorder won;
          // the signal itself was committed by THIS call.
          escalation = null;
        } else {
          throw error;
        }
      }
    }

    const signal: WatchSignal = {
      id: signalRow.id as string,
      tenantId: signalRow.tenant_id as string,
      watchEntryId: signalRow.watch_entry_id as string,
      observationId: signalRow.observation_id as string,
      observedAt: toIso(signalRow.observed_at as Date | string),
      severity: signalRow.severity as WatchSignal['severity'],
      note: signalRow.note as string | null,
      originExecutionId: signalRow.origin_execution_id as string | null,
      escalated: escalation !== null,
      escalationId: escalation === null ? null : escalation.id,
      recordedBy: signalRow.recorded_by as string,
      recordedAt: toIso(signalRow.recorded_at as Date | string),
    };
    return { signal, escalation };
  });
}

export async function getWatchSignal(
  ctx: TenantContext,
  query: GetWatchSignalQuery,
): Promise<WatchSignal> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateGetWatchSignalQuery(query);
  const rows = await getDb().query<SignalRow>(
    `SELECT s.*, x.id AS escalation_id
       FROM watch_signals s
       LEFT JOIN watch_escalations x
         ON x.tenant_id = s.tenant_id AND x.signal_id = s.id
      WHERE s.tenant_id = $1 AND s.id = $2`,
    [ctx.tenantId, valid.id],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EnvironmentError(
      'watch_signal_not_found',
      `no watch signal '${valid.id}' exists in this tenant`,
    );
  }
  return mapSignal(row);
}

export async function listWatchSignals(
  ctx: TenantContext,
  query: ListWatchSignalsQuery,
): Promise<WatchSignal[]> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedListSignalsQuery = validateListWatchSignalsQuery(query);

  const conditions: string[] = ['s.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.watchEntryId !== null) {
    params.push(valid.watchEntryId);
    conditions.push(`s.watch_entry_id = $${params.length}`);
  }
  if (valid.watchlistId !== null) {
    params.push(valid.watchlistId);
    conditions.push(
      `s.watch_entry_id IN (SELECT e.id FROM watch_entries e
         WHERE e.tenant_id = $1 AND e.watchlist_id = $${params.length})`,
    );
  }
  if (valid.minSeverity !== null) {
    const severities = severitiesAtOrAbove(valid.minSeverity);
    const placeholders = severities.map((severity) => {
      params.push(severity);
      return `$${params.length}`;
    });
    conditions.push(`s.severity IN (${placeholders.join(', ')})`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<SignalRow>(
    `SELECT s.*, x.id AS escalation_id
       FROM watch_signals s
       LEFT JOIN watch_escalations x
         ON x.tenant_id = s.tenant_id AND x.signal_id = s.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.recorded_at DESC, s.id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapSignal);
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------

export async function getWatchEscalation(
  ctx: TenantContext,
  query: GetWatchEscalationQuery,
): Promise<WatchEscalation> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateGetWatchEscalationQuery(query);
  const rows = await getDb().query<EscalationRow>(
    `SELECT * FROM watch_escalations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.id],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EnvironmentError(
      'watch_escalation_not_found',
      `no watch escalation '${valid.id}' exists in this tenant`,
    );
  }
  return mapEscalation(row);
}

export async function listWatchEscalations(
  ctx: TenantContext,
  query: ListWatchEscalationsQuery,
): Promise<WatchEscalation[]> {
  assertEnvironmentTenantContext(ctx);
  const valid: ValidatedListEscalationsQuery = validateListWatchEscalationsQuery(query);

  const conditions: string[] = ['a.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.watchEntryId !== null) {
    params.push(valid.watchEntryId);
    conditions.push(`a.watch_entry_id = $${params.length}`);
  }
  if (valid.watchlistId !== null) {
    params.push(valid.watchlistId);
    conditions.push(
      `a.watch_entry_id IN (SELECT e.id FROM watch_entries e
         WHERE e.tenant_id = $1 AND e.watchlist_id = $${params.length})`,
    );
  }
  if (valid.trigger !== null) {
    params.push(valid.trigger);
    conditions.push(`a.trigger_kind = $${params.length}`);
  }
  if (valid.minSeverity !== null) {
    const severities = severitiesAtOrAbove(valid.minSeverity);
    const placeholders = severities.map((severity) => {
      params.push(severity);
      return `$${params.length}`;
    });
    conditions.push(`a.severity IN (${placeholders.join(', ')})`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<EscalationRow>(
    `SELECT a.* FROM watch_escalations a
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.recorded_at DESC, a.id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapEscalation);
}

// ---------------------------------------------------------------------------
// The staleness pump (workers call it on a schedule; this module owns no
// background time — the notifications module's due-processing discipline)
// ---------------------------------------------------------------------------

export async function escalateStaleWatches(
  ctx: TenantContext,
  query: EscalateStaleWatchesQuery,
): Promise<StaleEscalationRun> {
  assertEnvironmentTenantContext(ctx);
  const valid = validateEscalateStaleWatchesQuery(query);
  if (valid.watchlistId !== null) {
    // Existence check only — pumping an archived list considers nothing.
    await loadWatchlistRow(ctx, valid.watchlistId);
  }

  // Single-flight per tenant: two concurrent passes would race their
  // episode-dedupe checks (the storage-level NOT EXISTS below still
  // protects the write; the lock keeps the accounting honest).
  const lock = getLock();
  const token = await lock.acquire(`${PUMP_LOCK_KEY_PREFIX}${ctx.tenantId}`, PUMP_LOCK_TTL_MS);
  if (token === null) {
    throw new EnvironmentError(
      'escalation_busy',
      `another staleness pass is running for this tenant — retry once it completes (safe: episodes are deduplicated)`,
    );
  }

  try {
    const asOf = now();
    const asOfIso = asOf.toISOString();
    const counts: StaleEscalationCounts = {
      fresh: 0,
      unknown: 0,
      disarmed: 0,
      notDue: 0,
      deduplicated: 0,
    };
    const recorded: WatchEscalation[] = [];

    // Candidate entries: ACTIVE entries on ACTIVE watchlists, oldest
    // first (deterministic), bounded by the query limit.
    const conditions = ['e.tenant_id = $1', 'e.status = \'active\'', 'w.status = \'active\''];
    const params: unknown[] = [ctx.tenantId];
    if (valid.watchlistId !== null) {
      params.push(valid.watchlistId);
      conditions.push(`e.watchlist_id = $${params.length}`);
    }
    params.push(valid.limit);
    const limitPlaceholder = `$${params.length}`;
    const candidates = await getDb().query<EntryRow>(
      `${ENTRY_SELECT} WHERE ${conditions.join(' AND ')}
         ORDER BY e.created_at ASC, e.id ASC LIMIT ${limitPlaceholder}`,
      params,
    );

    if (candidates.rows.length === 0) {
      return { evaluatedAt: asOfIso, considered: 0, recorded, counts };
    }

    // Newest evidence per candidate, in ONE grouped query (the entry's
    // newest signal by observed_at).
    const ids = candidates.rows.map((row) => row.id);
    const evidenceParams: unknown[] = [ctx.tenantId, ...ids];
    const inList = ids.map((_, index) => `$${index + 2}`).join(', ');
    const evidence = await getDb().query<{ watch_entry_id: string; latest: Date | string }>(
      `SELECT watch_entry_id, MAX(observed_at) AS latest FROM watch_signals
         WHERE tenant_id = $1 AND watch_entry_id IN (${inList})
         GROUP BY watch_entry_id`,
      evidenceParams,
    );
    const latestByEntry = new Map(
      evidence.rows.map((row) => [row.watch_entry_id, toIso(row.latest)]),
    );

    for (const candidate of candidates.rows) {
      const escalationPolicy = resolveEscalationPolicy(
        candidate.escalation_policy === null ? null : policyFromDb(candidate.escalation_policy),
        policyFromDb(candidate.watchlist_escalation_policy),
      )!;
      const grace = escalationPolicy.policy.staleGraceSeconds;

      let policy: FreshnessPolicy | null = null;
      try {
        policy = await resolveFreshnessPolicy(ctx, {
          subjectKind: WATCH_SUBJECT_KIND,
          subjectId: candidate.id,
        });
      } catch (error) {
        throw mapFreshnessError(error, 'invalid_watch_query');
      }
      const latestObservedAt = latestByEntry.get(candidate.id) ?? null;

      if (policy === null || latestObservedAt === null) {
        // No stale-after policy, or no evidence ever — 'unknown', never
        // stale (W006 discipline; never-observed discovery is W051's).
        counts.unknown += 1;
        continue;
      }
      const ageSeconds = evidenceAgeSeconds(latestObservedAt, asOfIso);
      const status = classifyFreshness(
        {
          staleAfterSeconds: policy.staleAfterSeconds,
          agingAfterSeconds: policy.agingAfterSeconds,
        },
        ageSeconds,
      );
      if (status !== 'stale') {
        counts.fresh += 1;
        continue;
      }
      if (grace === null) {
        counts.disarmed += 1;
        continue;
      }
      const schedule = stalenessSchedule(latestObservedAt, policy.staleAfterSeconds, grace);
      if (!stalenessDue(asOf, schedule.escalateAt)) {
        counts.notDue += 1;
        continue;
      }

      // Episode dedupe, storage-level: an escalation recorded at/after
      // this episode's stale boundary belongs to this episode — the
      // INSERT simply does not fire. (Pre-checked here so the accounting
      // is honest even when the write is suppressed by a racing pass.)
      const lastStale = await getDb().query<{ recorded_at: Date | string }>(
        `SELECT recorded_at FROM watch_escalations
           WHERE tenant_id = $1 AND watch_entry_id = $2 AND trigger_kind = 'stale'
           ORDER BY recorded_at DESC LIMIT 1`,
        [ctx.tenantId, candidate.id],
      );
      const lastIso =
        lastStale.rows[0] === undefined ? null : toIso(lastStale.rows[0]!.recorded_at);
      if (isStaleEpisodeEscalated(lastIso, schedule.staleSince)) {
        counts.deduplicated += 1;
        continue;
      }

      const inserted = await getDb().query<EscalationRow>(
        `INSERT INTO watch_escalations (
           tenant_id, watch_entry_id, trigger_kind, severity, signal_id,
           policy_snapshot, summary, recorded_by, recorded_at
         )
         SELECT $1, $2, 'stale', $3, NULL, $4::jsonb, $5, $6, $7
          WHERE NOT EXISTS (
            SELECT 1 FROM watch_escalations
             WHERE tenant_id = $1 AND watch_entry_id = $2 AND trigger_kind = 'stale'
               AND recorded_at >= $8
          )
         RETURNING *`,
        [
          ctx.tenantId,
          candidate.id,
          escalationPolicy.policy.staleSeverity,
          JSON.stringify(escalationPolicy),
          staleEscalationSummary(latestObservedAt, policy.staleAfterSeconds, grace),
          ctx.principalId,
          asOf,
          schedule.staleSince,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        recorded.push(mapEscalation(inserted.rows[0]));
      } else {
        counts.deduplicated += 1;
      }
    }

    return { evaluatedAt: asOfIso, considered: candidates.rows.length, recorded, counts };
  } finally {
    await lock.release(`${PUMP_LOCK_KEY_PREFIX}${ctx.tenantId}`, token);
  }
}
