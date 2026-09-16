// Implementation of the sources module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`source_not_found` / `checkpoint_not_found`), no
// existence leak.
//
// W036 acceptance — "Provider-independent inbound connectors with
// OAuth/credentials isolation, polling/webhooks, checkpointing, replay and
// dedupe" — is carried by these deliberate properties, all tested:
//   1. PROVIDER INDEPENDENCE (lock 16 / MODULE-DEPENDENCY-MAP provider
//      boundaries): provider-native webhook envelopes exist ONLY inside
//      `adapters/`; every operation receives canonical inputs and persists
//      canonical outputs; adapter AND transport output is re-validated
//      before anything reaches the ledger or the observations contract
//      (a buggy adapter cannot smuggle provider shapes past the boundary).
//      The only provider-minted values on this surface are OPAQUE strings
//      (account ids, record ids, cursors);
//   2. OAUTH/CREDENTIALS ISOLATION: credential VALUES never cross this
//      contract — the fetch transport receives the OPAQUE `credentialRef`
//      and resolves secrets itself; the domain tracks only non-secret
//      authorization state (kind, scopes, expiry). A lapsed recorded OAuth
//      grant fails ingestion fast (`source_authorization_expired`); a
//      transport that REFRESHED a grant reports the new expiry and the
//      service records it (re-registration is the re-authorization path);
//   3. POLLING/WEBHOOKS: polls go through the provider-neutral fetch port
//      (no transport wired → explicit `provider_unavailable`, never a fake
//      success); webhooks are parsed by the provider's PRIVATE adapter and
//      resolved onto the tenant's registered source for that account;
//   4. CHECKPOINTING: each source has ONE opaque cursor; a poll advances
//      it only AFTER the batch is ingested, and only when the provider
//      produced a new cursor — a failed or crashed poll leaves the cursor
//      where it was, so the retry re-fetches the same window;
//   5. REPLAY: rewinding the cursor to any recorded checkpoint-history
//      entry (or to the beginning) re-fetches that window on the next
//      poll — every rewind is itself recorded in the append-only history;
//   6. DEDUPE: the append-only `source_records` ledger is the authority —
//      one observation per (tenant, source, provider record id), ever.
//      Claims precede observations; the one-way link is filled after the
//      observation exists; a claim that never linked (crash between claim
//      and observation) is RE-OBSERVED when the provider delivers the
//      record again (no record is lost to a crash window). Ingestion of
//      one source is serialized through the lock port; concurrent
//      ingestion attempts fail explicitly with `ingestion_busy`;
//   7. EVIDENCE + AUDIT: every ingested record becomes an immutable
//      OBSERVATION through the observations contract (W004) with lineage
//      method `connector`, provenance `{ kind: 'source', id }` and the
//      provider key as channel — the ledger's observation link makes
//      "record → evidence" reconstructable (ARCHITECTURE.md §24).

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { getLock } from '@/infra/lock';
import type { TenantContext } from '@/infra/tenant';
import { ObservationsError, recordObservation } from '@/modules/observations/contract';
import { getSourceAdapter } from './adapters';
import { SourcesError } from './errors';
import {
  assertSourcesTenantContext,
  cursorAdvance,
  isUuid,
  validateFetchResult,
  validateGetSourceCheckpointQuery,
  validateListSourceCheckpointsQuery,
  validateListSourcesQuery,
  validatePollSourceInput,
  validateReceiveWebhookInput,
  validateRegisterSourceInput,
  validateReplaySourceInput,
  validateSetSourceStatusInput,
  validateWebhookParseResult,
  type ValidatedListCheckpointsQuery,
  type ValidatedListSourcesQuery,
  type ValidatedRecord,
} from './validation';
import type {
  IngestedRecord,
  ListSourceCheckpointsQuery,
  ListSourcesQuery,
  PollResult,
  PollSourceInput,
  ReceiveWebhookInput,
  RegisterSourceInput,
  RegisterSourceResult,
  ReplayResult,
  ReplaySourceInput,
  SetSourceStatusInput,
  Source,
  SourceAuthKind,
  SourceCheckpoint,
  SourceCheckpointEntry,
  SourceFetchResult,
  SourceProvider,
  SourceStatus,
  SourceTransport,
  WebhookResult,
} from './types';

// How long one ingestion pass may hold a source's ingestion lock.
const INGESTION_LOCK_TTL_MS = 60_000;

interface SourceRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_account_id: string;
  display_name: string | null;
  auth_kind: string;
  credential_ref: string;
  oauth_scopes: string[];
  oauth_expires_at: Date | string | null;
  status: string;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CheckpointRow extends DbRow {
  id: string;
  tenant_id: string;
  source_id: string;
  cursor: string | null;
  updated_at: Date | string;
}

interface CheckpointHistoryRow extends DbRow {
  id: string;
  tenant_id: string;
  source_id: string;
  cursor: string | null;
  origin: string;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapSource(row: SourceRow): Source {
  const adapter = getSourceAdapter(row.provider);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as SourceProvider, // CHECK-constrained by migration 001
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    authKind: row.auth_kind as SourceAuthKind, // CHECK-constrained by migration 001
    credentialRef: row.credential_ref,
    oauthScopes: row.oauth_scopes,
    oauthExpiresAt: row.oauth_expires_at === null ? null : toIso(row.oauth_expires_at),
    status: row.status as SourceStatus, // CHECK-constrained by migration 001
    modes: [...adapter.modes],
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapCheckpoint(row: CheckpointRow): SourceCheckpoint {
  return {
    sourceId: row.source_id,
    cursor: row.cursor,
    updatedAt: toIso(row.updated_at),
  };
}

function mapCheckpointEntry(row: CheckpointHistoryRow): SourceCheckpointEntry {
  return {
    id: row.id,
    sourceId: row.source_id,
    cursor: row.cursor,
    origin: row.origin as SourceCheckpointEntry['origin'], // CHECK-constrained by migration 002
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

// ---------------------------------------------------------------------------
// Transport port (provider-neutral polling; implementations live inside adapters/)
// ---------------------------------------------------------------------------

let sourceTransport: SourceTransport | null = null;

/**
 * Infrastructure wiring for the fetch port. Real transports (provider
 * SDKs / HTTP) are implemented inside `src/modules/sources/adapters/` and
 * wired once at process start; tests substitute a scripted transport.
 * `null` restores the default "no provider available" state.
 */
export function setSourceTransport(transport: SourceTransport | null): void {
  sourceTransport = transport;
}

/** The currently wired transport (null when none — polls then fail `provider_unavailable`). */
export function getSourceTransport(): SourceTransport | null {
  return sourceTransport;
}

// ---------------------------------------------------------------------------
// Source loading helpers (uniform not-found discipline — ADR-0001)
// ---------------------------------------------------------------------------

async function loadSourceRow(ctx: TenantContext, sourceId: string): Promise<SourceRow> {
  if (!isUuid(sourceId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new SourcesError(
      'source_not_found',
      `source '${sourceId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<SourceRow>(
    `SELECT * FROM sources WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, sourceId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SourcesError(
      'source_not_found',
      `source '${sourceId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function loadSource(ctx: TenantContext, sourceId: string): Promise<Source> {
  return mapSource(await loadSourceRow(ctx, sourceId));
}

async function loadActiveSource(ctx: TenantContext, sourceId: string): Promise<Source> {
  const source = await loadSource(ctx, sourceId);
  if (source.status !== 'active') {
    throw new SourcesError(
      'source_disabled',
      `source '${source.id}' (${source.provider}) is disabled`,
    );
  }
  return source;
}

async function loadSourceByAccount(
  ctx: TenantContext,
  provider: SourceProvider,
  providerAccountId: string,
): Promise<Source> {
  const result = await getDb().query<SourceRow>(
    `SELECT * FROM sources WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
    [ctx.tenantId, provider, providerAccountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SourcesError(
      'source_not_found',
      `no ${provider} source for account '${providerAccountId}' exists in this tenant`,
    );
  }
  return mapSource(row);
}

/**
 * Authorization guard: a recorded OAuth grant that has lapsed blocks
 * ingestion until the tenant re-authorizes (fail fast — "ingest authorized
 * information", ARCHITECTURE.md §10). Transports keep a healthy grant
 * current by reporting refreshed expiries; once lapsed, only
 * re-registration (the re-authorization path) unblocks the source.
 */
function assertAuthorizationCurrent(source: Source, at: Date): void {
  if (source.authKind === 'oauth' && source.oauthExpiresAt !== null) {
    if (at.getTime() >= Date.parse(source.oauthExpiresAt)) {
      throw new SourcesError(
        'source_authorization_expired',
        `the OAuth grant of source '${source.id}' (${source.provider}) expired at ${source.oauthExpiresAt} — re-register the source to re-authorize`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export async function registerSource(
  ctx: TenantContext,
  input: RegisterSourceInput,
): Promise<RegisterSourceResult> {
  assertSourcesTenantContext(ctx);
  const valid = validateRegisterSourceInput(input);
  const adapter = getSourceAdapter(valid.provider);
  const providerAccountId = adapter.normalizeAccountId(valid.providerAccountId);
  const at = now();
  const db = getDb();

  // Re-registering an existing source is the RE-AUTHORIZATION path: the
  // authorization fields (kind, credential reference, scopes, expiry) move
  // to what the caller just supplied; the connector's identity (provider,
  // account, provenance history) never changes. The notifications module's
  // upsert discipline (transaction + duplicate-key conflict) makes the
  // rare concurrent first-registration explicit instead of racy.
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM sources
         WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
      [ctx.tenantId, valid.provider, providerAccountId],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      const updated = await tx.query<SourceRow>(
        `UPDATE sources SET
           auth_kind = $4, credential_ref = $5, oauth_scopes = $6::jsonb,
           oauth_expires_at = $7, updated_at = $8
         WHERE tenant_id = $1 AND id = $2 AND provider = $3
         RETURNING *`,
        [
          ctx.tenantId,
          existingId,
          valid.provider,
          valid.authKind,
          valid.credentialRef,
          JSON.stringify(valid.oauthScopes),
          valid.oauthExpiresAt === null ? null : new Date(valid.oauthExpiresAt),
          at,
        ],
      );
      return { source: mapSource(updated.rows[0]!), created: false };
    }
    let inserted;
    try {
      inserted = await tx.query<SourceRow>(
        `INSERT INTO sources (
           tenant_id, provider, provider_account_id, display_name, auth_kind,
           credential_ref, oauth_scopes, oauth_expires_at, status, created_by,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'active', $9, $10, $10)
         RETURNING *`,
        [
          ctx.tenantId,
          valid.provider,
          providerAccountId,
          valid.displayName,
          valid.authKind,
          valid.credentialRef,
          JSON.stringify(valid.oauthScopes),
          valid.oauthExpiresAt === null ? null : new Date(valid.oauthExpiresAt),
          ctx.principalId,
          at,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'sources')) {
        throw new SourcesError(
          'source_conflict',
          'a source for this provider account was created concurrently; retry the registration',
        );
      }
      throw error;
    }
    return { source: mapSource(inserted.rows[0]!), created: true };
  });
}

export async function getSource(ctx: TenantContext, sourceId: string): Promise<Source> {
  assertSourcesTenantContext(ctx);
  return loadSource(ctx, sourceId);
}

export async function listSources(
  ctx: TenantContext,
  query: ListSourcesQuery,
): Promise<Source[]> {
  assertSourcesTenantContext(ctx);
  const valid: ValidatedListSourcesQuery = validateListSourcesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<SourceRow>(
    `SELECT * FROM sources WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapSource(row));
}

export async function setSourceStatus(
  ctx: TenantContext,
  input: SetSourceStatusInput,
): Promise<Source> {
  assertSourcesTenantContext(ctx);
  const valid = validateSetSourceStatusInput(input);
  const result = await getDb().query<SourceRow>(
    `UPDATE sources SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, valid.sourceId, valid.status, now()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant sources are indistinguishable from missing ones.
    throw new SourcesError(
      'source_not_found',
      `source '${valid.sourceId}' does not exist in this tenant`,
    );
  }
  return mapSource(row);
}

// ---------------------------------------------------------------------------
// Ingestion core — claim, observe, link (the shared polling/webhook path)
// ---------------------------------------------------------------------------

/**
 * Ingests one validated batch into a source: claims each provider record
 * id on the append-only ledger, records an observation per newly claimable
 * record, fills the one-way link, and reports what happened. Serialized by
 * the per-source ingestion lock.
 */
async function ingestRecords(
  ctx: TenantContext,
  source: Source,
  records: ValidatedRecord[],
  via: 'polling' | 'webhook',
): Promise<{ ingested: number; duplicates: number; observations: IngestedRecord[] }> {
  if (records.length === 0) {
    return { ingested: 0, duplicates: 0, observations: [] };
  }

  const lockKey = `sources:ingest:${source.id}`;
  const lock = getLock();
  const token = await lock.acquire(lockKey, INGESTION_LOCK_TTL_MS);
  if (token === null) {
    throw new SourcesError(
      'ingestion_busy',
      `another ingestion pass holds source '${source.id}' — retry once it completes (safe: ingestion is idempotent)`,
    );
  }
  try {
    const db = getDb();
    const at = now();

    // 1. Claim: fresh provider record ids enter the ledger; ids already
    //    linked (or claimed by a live concurrent pass — impossible under
    //    the lock, but guarded anyway) are duplicates.
    const claimParams: unknown[] = [ctx.tenantId, source.id, at, via];
    const claimTuples = records.map((record, index) => `($1, $2, $${5 + index}, $4, $3)`);
    for (const record of records) claimParams.push(record.providerRecordId);
    const claimed = await db.query<{ provider_record_id: string }>(
      `INSERT INTO source_records (
         tenant_id, source_id, provider_record_id, ingested_via, claimed_at
       ) VALUES ${claimTuples.join(', ')}
       ON CONFLICT (tenant_id, source_id, provider_record_id) DO NOTHING
       RETURNING provider_record_id`,
      claimParams,
    );
    const freshIds = new Set(claimed.rows.map((row) => row.provider_record_id));

    // 2. Crash recovery: a PREVIOUS pass may have claimed ids whose
    //    observation never got recorded or linked (process died between
    //    claim and link). Those unlinked claims are re-ingestible — the
    //    provider's latest delivery of the record is observed now.
    const conflictIds = records
      .filter((record) => !freshIds.has(record.providerRecordId))
      .map((record) => record.providerRecordId);
    const recoverableIds = new Set<string>();
    if (conflictIds.length > 0) {
      const recovery = await db.query<{ provider_record_id: string }>(
        `SELECT provider_record_id FROM source_records
           WHERE tenant_id = $1 AND source_id = $2
             AND provider_record_id = ANY($3::text[])
             AND observation_id IS NULL`,
        [ctx.tenantId, source.id, conflictIds],
      );
      for (const row of recovery.rows) recoverableIds.add(row.provider_record_id);
    }

    const claimable = records.filter(
      (record) => freshIds.has(record.providerRecordId) || recoverableIds.has(record.providerRecordId),
    );
    const duplicates = records.length - claimable.length;

    // 3. Observe: one immutable observation per claimable record, recorded
    //    through the observations contract (W004). The provider key is the
    //    channel (lock 16: neutral keys, never provider objects); lineage
    //    method `connector` marks connector-ingested evidence.
    const observations: IngestedRecord[] = [];
    for (const record of claimable) {
      const observation = await recordObservationThroughContract(ctx, source, record);
      observations.push({
        providerRecordId: record.providerRecordId,
        observationId: observation,
      });
      // 4. Link: fill the one-way ledger link. The NULL-guard keeps a
      //    concurrent writer from double-linking (defense in depth on top
      //    of the lock).
      await db.query(
        `UPDATE source_records SET observation_id = $4, ingested_at = $5
           WHERE tenant_id = $1 AND source_id = $2 AND provider_record_id = $3
             AND observation_id IS NULL`,
        [ctx.tenantId, source.id, record.providerRecordId, observation, at],
      );
    }

    return { ingested: claimable.length, duplicates, observations };
  } finally {
    await lock.release(lockKey, token);
  }
}

/**
 * Records one canonical provider record as an observation through the
 * observations contract, mapping sibling errors onto module codes.
 */
async function recordObservationThroughContract(
  ctx: TenantContext,
  source: Source,
  record: ValidatedRecord,
): Promise<string> {
  try {
    const observation = await recordObservation(ctx, {
      kind: record.kind,
      payload: record.payload,
      observedAt: record.occurredAt,
      source: { kind: 'source', id: source.id, label: null },
      channel: source.provider,
      lineage: { method: 'connector', parents: [], extractor: null },
      permissions: { visibility: 'tenant', workspaceId: null, principalId: null, usage: [] },
      confidence: {
        value: 1,
        method: 'source_gateway',
        basis: `verbatim ${source.provider} record delivered by the source gateway (W036)`,
      },
    });
    return observation.id;
  } catch (error) {
    if (error instanceof ObservationsError) {
      // Every rejection here contradicts a pre-validated canonical record —
      // stay loud rather than wrong (the channels module's discipline for
      // sibling-contract rejections).
      throw new Error(
        `the observations contract rejected a canonical source record (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export async function pollSource(ctx: TenantContext, input: PollSourceInput): Promise<PollResult> {
  assertSourcesTenantContext(ctx);
  const valid = validatePollSourceInput(input);
  const source = await loadActiveSource(ctx, valid.sourceId);
  const adapter = getSourceAdapter(source.provider);
  if (!adapter.modes.includes('polling')) {
    throw new SourcesError(
      'ingestion_mode_unsupported',
      `provider '${source.provider}' supports no polling — its records arrive through webhooks`,
    );
  }
  assertAuthorizationCurrent(source, now());

  const transport = sourceTransport;
  if (transport === null) {
    throw new SourcesError(
      'provider_unavailable',
      `no source transport is wired for provider '${source.provider}' (wire one via setSourceTransport)`,
    );
  }

  const checkpointRow = await loadCheckpointRow(ctx, source.id);
  const cursor = checkpointRow?.cursor ?? null;

  let fetched: SourceFetchResult;
  try {
    fetched = await transport.fetch({
      provider: source.provider,
      tenantId: ctx.tenantId,
      sourceId: source.id,
      providerAccountId: source.providerAccountId,
      credentialRef: source.credentialRef,
      cursor,
      maxRecords: valid.maxRecords,
    });
  } catch (error) {
    throw new SourcesError(
      'fetch_failed',
      `the ${source.provider} transport failed to fetch records for source '${source.id}'${
        error instanceof Error ? `: ${error.message}` : ''
      } (transient — the checkpoint is unchanged and the poll may be retried)`,
    );
  }

  // Defense in depth: transport output is re-validated before anything is
  // persisted or handed to the observations contract.
  const result = validateFetchResult(fetched);
  if (result.authorizationExpiresAt !== null && source.authKind !== 'oauth') {
    throw new Error(
      `the ${source.provider} transport reported an authorization expiry for a credentials-authorized source (internal invariant violation)`,
    );
  }

  // Ingest FIRST, checkpoint SECOND: a crash between the two re-fetches the
  // same window on the next poll and dedupe suppresses re-observation.
  const ingest = await ingestRecords(ctx, source, result.records, 'polling');

  let checkpoint: SourceCheckpoint | null = checkpointRow === null ? null : mapCheckpoint(checkpointRow);
  if (cursorAdvance(cursor, result.nextCursor)) {
    checkpoint = await advanceCheckpoint(ctx, source.id, result.nextCursor, 'poll');
  }

  // A transport that refreshed the OAuth grant reports the new expiry; the
  // recorded authorization state moves with it (non-secret metadata).
  let current = source;
  if (result.authorizationExpiresAt !== null) {
    const updated = await getDb().query<SourceRow>(
      `UPDATE sources SET oauth_expires_at = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [ctx.tenantId, source.id, new Date(result.authorizationExpiresAt), now()],
    );
    const row = updated.rows[0];
    if (row !== undefined) current = mapSource(row);
  }

  return {
    source: current,
    fetched: result.records.length,
    ingested: ingest.ingested,
    duplicates: ingest.duplicates,
    observations: ingest.observations,
    checkpoint,
    hasMore: result.hasMore,
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function receiveSourceWebhook(
  ctx: TenantContext,
  input: ReceiveWebhookInput,
): Promise<WebhookResult> {
  assertSourcesTenantContext(ctx);
  const valid = validateReceiveWebhookInput(input);
  const adapter = getSourceAdapter(valid.provider);
  if (!adapter.modes.includes('webhook')) {
    throw new SourcesError(
      'ingestion_mode_unsupported',
      `provider '${valid.provider}' supports no webhook ingestion — it is polled through the fetch transport`,
    );
  }

  // Provider-native payload → canonical records (adapter-private; the raw
  // envelope never advances past this line).
  const parsed = adapter.parseWebhook(input.payload);
  // Defense in depth: adapter output is re-validated before anything is
  // persisted or handed to a sibling contract.
  const canonical = validateWebhookParseResult(parsed);

  // The envelope's account resolves onto THIS tenant's registered source —
  // a foreign tenant's connector is indistinguishable from an unknown
  // account (ADR-0001, no existence leak).
  const source = await loadSourceByAccount(
    ctx,
    valid.provider,
    adapter.normalizeAccountId(canonical.providerAccountId),
  );
  if (source.status !== 'active') {
    throw new SourcesError(
      'source_disabled',
      `source '${source.id}' (${source.provider}) is disabled`,
    );
  }
  assertAuthorizationCurrent(source, now());

  const ingest = await ingestRecords(ctx, source, canonical.records, 'webhook');
  return {
    source,
    fetched: canonical.records.length,
    ingested: ingest.ingested,
    duplicates: ingest.duplicates,
    observations: ingest.observations,
  };
}

// ---------------------------------------------------------------------------
// Checkpoints and replay
// ---------------------------------------------------------------------------

async function loadCheckpointRow(ctx: TenantContext, sourceId: string): Promise<CheckpointRow | null> {
  const result = await getDb().query<CheckpointRow>(
    `SELECT * FROM source_checkpoints WHERE tenant_id = $1 AND source_id = $2`,
    [ctx.tenantId, sourceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Moves a source's current cursor and records the movement in the
 * append-only history. Used by poll advances (origin 'poll') and replay
 * rewinds (origin 'replay'); `cursor` null means the beginning.
 */
async function advanceCheckpoint(
  ctx: TenantContext,
  sourceId: string,
  cursor: string | null,
  origin: 'poll' | 'replay',
): Promise<SourceCheckpoint> {
  const db = getDb();
  const at = now();
  const checkpoint = await db.transaction(async (tx) => {
    const upserted = await tx.query<CheckpointRow>(
      `INSERT INTO source_checkpoints (tenant_id, source_id, cursor, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, source_id) DO UPDATE SET cursor = $3, updated_at = $4
       RETURNING *`,
      [ctx.tenantId, sourceId, cursor, at],
    );
    await tx.query(
      `INSERT INTO source_checkpoint_history (
         tenant_id, source_id, cursor, origin, recorded_by, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.tenantId, sourceId, cursor, origin, ctx.principalId, at],
    );
    return upserted.rows[0]!;
  });
  return mapCheckpoint(checkpoint);
}

export async function getSourceCheckpoint(
  ctx: TenantContext,
  query: { sourceId: string },
): Promise<SourceCheckpoint | null> {
  assertSourcesTenantContext(ctx);
  const valid = validateGetSourceCheckpointQuery(query);
  // The source check enforces tenancy before any cursor state is revealed.
  await loadSource(ctx, valid.sourceId);
  const row = await loadCheckpointRow(ctx, valid.sourceId);
  return row === null ? null : mapCheckpoint(row);
}

export async function listSourceCheckpoints(
  ctx: TenantContext,
  query: ListSourceCheckpointsQuery,
): Promise<SourceCheckpointEntry[]> {
  assertSourcesTenantContext(ctx);
  const valid: ValidatedListCheckpointsQuery = validateListSourceCheckpointsQuery(query);
  await loadSource(ctx, valid.sourceId);
  const rows = await getDb().query<CheckpointHistoryRow>(
    `SELECT * FROM source_checkpoint_history
       WHERE tenant_id = $1 AND source_id = $2
       ORDER BY recorded_at DESC, id DESC LIMIT $3`,
    [ctx.tenantId, valid.sourceId, valid.limit],
  );
  return rows.rows.map((row) => mapCheckpointEntry(row));
}

export async function replaySource(
  ctx: TenantContext,
  input: ReplaySourceInput,
): Promise<ReplayResult> {
  assertSourcesTenantContext(ctx);
  const valid = validateReplaySourceInput(input);
  // Replay is checkpoint surgery, deliberately status-agnostic: a disabled
  // source may be rewound while parked and re-enabled afterwards. Tenancy
  // is enforced by the source load; the replay target must belong to the
  // same tenant's source (uniform checkpoint_not_found otherwise).
  const source = await loadSource(ctx, valid.sourceId);

  if (valid.fromStart) {
    const checkpoint = await advanceCheckpoint(ctx, source.id, null, 'replay');
    return { source, rewoundTo: null, checkpoint };
  }

  const target = await getDb().query<CheckpointHistoryRow>(
    `SELECT * FROM source_checkpoint_history
       WHERE tenant_id = $1 AND source_id = $2 AND id = $3`,
    [ctx.tenantId, source.id, valid.checkpointId],
  );
  const entry = target.rows[0];
  if (entry === undefined) {
    throw new SourcesError(
      'checkpoint_not_found',
      `checkpoint '${valid.checkpointId}' does not exist for this source in this tenant`,
    );
  }
  const checkpoint = await advanceCheckpoint(ctx, source.id, entry.cursor, 'replay');
  return { source, rewoundTo: mapCheckpointEntry(entry), checkpoint };
}
