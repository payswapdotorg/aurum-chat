// Implementation of the events module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and is
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`event_not_found`), including causation references.
//
// W003 acceptance — "verify ordering metadata and idempotency keys" — is
// carried by four deliberate properties, all tested:
//   1. ORDERING: `sequence` is allocated per tenant from the
//      `event_sequences` counter inside the append transaction (atomic
//      INSERT ... ON CONFLICT DO UPDATE ... RETURNING), so it is strictly
//      increasing and unique per tenant — the canonical replay order
//      (ORDER BY sequence), with `recorded_at` never going backwards along
//      it. Only a rare idempotency race can leave a harmless gap.
//   2. IDEMPOTENCY: `(tenant_id, idempotency_key)` is UNIQUE; a replay
//      returns the originally recorded event (first write wins) without
//      consuming a sequence number; keys are tenant-scoped.
//   3. CORRELATION COMPLETENESS: an explicit correlation id wins; a caused
//      event otherwise inherits its cause's correlation id; a root event
//      otherwise correlates to itself — every event carries a correlation
//      id (ARCHITECTURE.md §25) and whole flows are listable by it.
//   4. IMMUTABILITY: the contract exposes append/read/list/causation-chain
//      ONLY — no update, no delete — and PostgreSQL itself rejects
//      UPDATE/DELETE/TRUNCATE on events (migration 001 triggers). The
//      per-tenant counters may be incremented (that is their job) but can
//      never be deleted or truncated (migration 002 triggers): a lost
//      counter would restart numbering and collide with history.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { EventsError } from './errors';
import {
  ENVELOPE_VERSION,
  assertEventTenantContext,
  isUuid,
  validateAppendEventInput,
  validateListEventsQuery,
  type ValidatedAppendInput,
  type ValidatedListQuery,
} from './validation';
import type {
  AppendEventInput,
  Event,
  EventActorKind,
  EventCausationChain,
  EventSourceKind,
  ListEventsQuery,
} from './types';

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  envelope_version: number | string;
  type: string;
  type_version: number | string;
  payload: unknown;
  occurred_at: Date | string;
  recorded_at: Date | string;
  sequence: number | string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  source_kind: string;
  source_id: string | null;
  source_label: string | null;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string | null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

// bigint columns arrive as strings on both backends (pg, PGlite); per-tenant
// sequence numbers stay far below Number.MAX_SAFE_INTEGER.
function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

function mapEvent(row: EventRow): Event {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    envelopeVersion: toInt(row.envelope_version),
    type: row.type,
    typeVersion: toInt(row.type_version),
    payload: row.payload,
    occurredAt: toIso(row.occurred_at),
    recordedAt: toIso(row.recorded_at),
    sequence: toInt(row.sequence),
    actor: {
      kind: row.actor_kind as EventActorKind, // CHECK-constrained by migration 001
      id: row.actor_id,
      label: row.actor_label,
    },
    source: {
      kind: row.source_kind as EventSourceKind, // CHECK-constrained by migration 001
      id: row.source_id,
      label: row.source_label,
    },
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    idempotencyKey: row.idempotency_key,
  };
}

function notFound(eventId: string): EventsError {
  return new EventsError(
    'event_not_found',
    `event '${eventId}' does not exist in this tenant`,
  );
}

async function loadEventRow(ctx: TenantContext, eventId: string): Promise<EventRow> {
  if (!isUuid(eventId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw notFound(eventId);
  }
  const result = await getDb().query<EventRow>(
    `SELECT * FROM events WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, eventId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw notFound(eventId);
  }
  return row;
}

async function findByIdempotencyKey(
  db: Queryable,
  ctx: TenantContext,
  idempotencyKey: string,
): Promise<EventRow | null> {
  const result = await db.query<EventRow>(
    `SELECT * FROM events WHERE tenant_id = $1 AND idempotency_key = $2`,
    [ctx.tenantId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically allocate the tenant's next sequence number. The counter row
 * lock (held until the append transaction commits) serializes appends per
 * tenant, which is what makes `sequence` the canonical replay order.
 */
async function allocateSequence(tx: Queryable, tenantId: string): Promise<number> {
  const result = await tx.query<{ last_sequence: number | string }>(
    `INSERT INTO event_sequences (tenant_id, last_sequence) VALUES ($1, 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_sequence = event_sequences.last_sequence + 1
       RETURNING last_sequence`,
    [tenantId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('event sequence allocation returned no row (internal invariant violation)');
  }
  return toInt(row.last_sequence);
}

export async function appendEvent(ctx: TenantContext, input: AppendEventInput): Promise<Event> {
  assertEventTenantContext(ctx);
  const valid: ValidatedAppendInput = validateAppendEventInput(input);

  // Idempotent fast path: a recorded key replays the original event —
  // before any sequence number is touched.
  if (valid.idempotencyKey !== null) {
    const existing = await findByIdempotencyKey(getDb(), ctx, valid.idempotencyKey);
    if (existing !== null) return mapEvent(existing);
  }

  // The cause must exist in THIS tenant (cross-tenant causes are
  // indistinguishable from missing ones). Events are immutable, so the
  // cause — and its correlation id — cannot change afterwards.
  let causeCorrelation: string | null = null;
  if (valid.causationId !== null) {
    const cause = await loadEventRow(ctx, valid.causationId);
    causeCorrelation = cause.correlation_id;
  }
  // Explicit correlation wins; a caused event inherits its cause's flow.
  // Only a root event without an explicit id reaches the INSERT with null,
  // where the envelope correlates it to its own minted id (SQL COALESCE
  // over the id minted in the same statement — see below).
  const correlationId = valid.correlationId ?? causeCorrelation;

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Re-check inside the transaction: a key committed between the fast
    // path and now also replays without consuming a sequence number.
    if (valid.idempotencyKey !== null) {
      const raced = await findByIdempotencyKey(tx, ctx, valid.idempotencyKey);
      if (raced !== null) return mapEvent(raced);
    }

    const sequence = await allocateSequence(tx, ctx.tenantId);

    // The envelope id is minted by PostgreSQL (`gen_random_uuid()`); the
    // COALESCE makes a root event without an explicit correlation id
    // correlate to that freshly minted id, in the same statement.
    const inserted = await tx.query<EventRow>(
      `WITH minted AS (SELECT gen_random_uuid() AS event_id)
       INSERT INTO events (
         id, tenant_id, type, type_version, envelope_version, payload,
         occurred_at, recorded_at, sequence,
         actor_kind, actor_id, actor_label,
         source_kind, source_id, source_label,
         correlation_id, causation_id, idempotency_key
       )
       SELECT
         minted.event_id, $1, $2, $3, $4, $5::jsonb,
         $6::timestamptz, $7::timestamptz, $8::bigint,
         $9, $10, $11,
         $12, $13, $14,
         COALESCE($15::uuid, minted.event_id), $16::uuid, $17::text
       FROM minted
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        ctx.tenantId,
        valid.type,
        valid.typeVersion,
        ENVELOPE_VERSION,
        JSON.stringify(valid.payload),
        new Date(valid.occurredAt),
        recordedAt,
        sequence,
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        valid.source.kind,
        valid.source.id,
        valid.source.label,
        correlationId,
        valid.causationId,
        valid.idempotencyKey,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return mapEvent(row);

    // ON CONFLICT swallowed the insert: another append of the same key won
    // the race between the in-transaction re-check and the INSERT. Replay
    // its event. (The allocated sequence number is not re-used — a rare,
    // harmless gap; ordering stays strictly increasing.)
    if (valid.idempotencyKey !== null) {
      const winner = await findByIdempotencyKey(tx, ctx, valid.idempotencyKey);
      if (winner !== null) return mapEvent(winner);
    }
    throw new Error(
      'event insert returned no row without an idempotency conflict (internal invariant violation)',
    );
  });
}

export async function getEvent(ctx: TenantContext, eventId: string): Promise<Event> {
  assertEventTenantContext(ctx);
  return mapEvent(await loadEventRow(ctx, eventId));
}

export async function listEvents(ctx: TenantContext, query: ListEventsQuery): Promise<Event[]> {
  assertEventTenantContext(ctx);
  const valid: ValidatedListQuery = validateListEventsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.type !== null) {
    add('type = $#', valid.type);
    if (valid.typeVersion !== null) add('type_version = $#', valid.typeVersion);
  }
  if (valid.actorKind !== null) {
    add('actor_kind = $#', valid.actorKind);
    if (valid.actorId !== null) add('actor_id = $#', valid.actorId);
  }
  if (valid.sourceKind !== null) {
    add('source_kind = $#', valid.sourceKind);
    if (valid.sourceId !== null) add('source_id = $#', valid.sourceId);
  }
  if (valid.correlationId !== null) add('correlation_id = $#', valid.correlationId);
  if (valid.causationId !== null) add('causation_id = $#', valid.causationId);
  if (valid.idempotencyKey !== null) add('idempotency_key = $#', valid.idempotencyKey);
  if (valid.occurredFrom !== null) add('occurred_at >= $#', valid.occurredFrom);
  if (valid.occurredTo !== null) add('occurred_at <= $#', valid.occurredTo);
  if (valid.sequenceFrom !== null) add('sequence >= $#', valid.sequenceFrom);
  if (valid.sequenceTo !== null) add('sequence <= $#', valid.sequenceTo);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Direction is a validated two-value enum — the only interpolated token.
  const direction = valid.order === 'desc' ? 'DESC' : 'ASC';
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM events WHERE ${conditions.join(' AND ')}
       ORDER BY sequence ${direction} LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapEvent(row));
}

export async function getEventCausationChain(
  ctx: TenantContext,
  eventId: string,
): Promise<EventCausationChain> {
  assertEventTenantContext(ctx);
  if (!isUuid(eventId)) throw notFound(eventId);

  // Single-parent causation (each event has at most one cause) makes the
  // ancestry a line, not a tree; causes always pre-exist their effects, so
  // the recursion terminates. The tenant-consistent join never follows a
  // causation id across tenants (also impossible via the storage-level FK
  // in migrations/001-events.sql).
  const rows = await getDb().query<EventRow>(
    `WITH RECURSIVE ancestry AS (
       SELECT * FROM events WHERE tenant_id = $1 AND id = $2
       UNION ALL
       SELECT e.* FROM events e
         INNER JOIN ancestry a ON e.tenant_id = a.tenant_id AND e.id = a.causation_id
     )
     SELECT * FROM ancestry ORDER BY sequence DESC`,
    [ctx.tenantId, eventId],
  );
  const mapped = rows.rows.map((row) => mapEvent(row));
  const event = mapped[0];
  if (event === undefined) throw notFound(eventId);
  return { event, causes: mapped.slice(1) };
}
