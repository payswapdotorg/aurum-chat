// Implementation of the destinations module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and are
// never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`destination_not_found` / `delivery_not_found`), no
// existence leak.
//
// W037 acceptance — "Provider-independent outbound destinations for BI,
// warehouses, CRM/ERP, spreadsheets, APIs and webhooks with authorization
// and provenance" — is carried by these deliberate properties, all tested:
//   1. PROVIDER INDEPENDENCE (ADR-0015 / MODULE-DEPENDENCY-MAP provider
//      boundaries): provider-native request bodies exist ONLY inside
//      `adapters/`; every operation receives canonical inputs and persists
//      canonical outputs; adapter AND transport output is re-validated
//      before anything reaches the ledger or the transport port (a buggy
//      adapter or transport cannot smuggle provider shapes past the
//      boundary). The only provider-minted values on this surface are
//      OPAQUE strings (account ids, delivery ids).
//   2. AUTHORIZATION, three layers:
//      a) PROVIDER authorization — OAuth/credentials isolation exactly as
//         the sources module: credential VALUES never cross this contract
//         (the delivery transport receives the OPAQUE `credentialRef`);
//         a lapsed recorded OAuth grant fails delivery fast
//         (`destination_authorization_expired`); a transport that REFRESHED
//         a grant reports the new expiry and the recorded state moves.
//      b) ACTION authorization — every delivery is gated through the
//         actions module's authority matrix as 'data-export' @ EXECUTE
//         before any transport call. Under the built-in default matrix
//         EXECUTE is approval-gated, so exports wait for an explicit human
//         decision until tenant policy says otherwise (GOVERNANCE:
//         high-impact actions are policy-gated). The gate is authorized
//         ONCE per delivery (stable idempotency key) and replayed ever
//         after — re-checks return the request's CURRENT status, which is
//         how a human approval between retries unlocks a gated delivery
//         without duplicating gate history (the notifications module's
//         discipline).
//      c) EVIDENCE-level authorization — a delivery referencing
//         observations may only export evidence the calling principal may
//         read (the observations contract enforces tenant/principal
//         visibility) and NEVER evidence tagged 'no-export' (the W004
//         usage-constraint tag this module consumes, exactly as the
//         actions module's dependency posture anticipated for W037).
//   3. PROVENANCE — the delivery ledger records requester, request time,
//      kind, the canonical batch, evidence references, the gate request id
//      and the replay origin; one append-only attempt row per physical
//      delivery carries the EXACT adapter-formatted envelope that left the
//      system plus the provider's opaque acknowledgment (storage-level
//      triggers keep both immutable, migrations/002).
//   4. §10 DELIVERY GUARANTEES — idempotency (caller keys replay the
//      original delivery; the gate replays per delivery), checkpointing
//      (the append-only ledger IS the outbound checkpoint — see types.ts),
//      retries (retryDelivery on 'pending'/'failed'), replay/reprocessing
//      (replayDelivery re-delivers a recorded payload as a NEW delivery
//      under a fresh full gate authorization), audit (attempts +
//      forward-only ledger).
//   5. ADR-0009 — destinations never become domain truth: this module
//      records NO observations and exposes no promotion path; delivery
//      rows are outbound audit state only.
//
// Deliberately NOT re-checked on retry: the evidence-level authorization
// of a recorded delivery (it was checked by the DISPATCHING principal;
// observations and their usage tags are immutable, and a pump principal
// must be able to complete an approved delivery without inheriting the
// requester's read scope). The authority gate and provider authorization
// ARE re-checked — policy and grants move.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { getLock } from '@/infra/lock';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  type ActionRequest,
  type AuthorityLevel,
} from '@/modules/actions/contract';
import {
  ObservationsError,
  getObservation,
  type Observation,
} from '@/modules/observations/contract';
import { allDestinationAdapters, getDestinationAdapter } from './adapters';
import { DestinationsError } from './errors';
import {
  DELIVERY_ACTION_KIND,
  EXPORT_FORBIDDING_USAGE_TAG,
  assertDestinationsTenantContext,
  assertRecordsDeliverable,
  isUuid,
  validateDispatchDeliveryInput,
  validateFormattedDelivery,
  validateGetDeliveryQuery,
  validateListDeliveryAttemptsQuery,
  validateListDeliveriesQuery,
  validateListDestinationsQuery,
  validateReplayDeliveryInput,
  validateRegisterDestinationInput,
  validateRetryDeliveryInput,
  validateSetDestinationStatusInput,
  validateTransportReceipt,
  type ValidatedDispatchDeliveryInput,
  type ValidatedListDeliveriesQuery,
  type ValidatedListDestinationsQuery,
} from './validation';
import type {
  CanonicalOutboundRecord,
  Delivery,
  DeliveryAttempt,
  DeliveryStatus,
  Destination,
  DestinationAuthKind,
  DestinationDeliveryRequest,
  DestinationProvider,
  DestinationStatus,
  DestinationTransport,
  DispatchDeliveryInput,
  DispatchDeliveryResult,
  FormattedDelivery,
  GetDeliveryQuery,
  ListDeliveryAttemptsQuery,
  ListDeliveriesQuery,
  ListDestinationsQuery,
  RegisterDestinationInput,
  RegisterDestinationResult,
  ReplayDeliveryInput,
  RetryDeliveryInput,
  RetryDeliveryResult,
  SetDestinationStatusInput,
  TransportReceipt,
} from './types';

// How long one delivery attempt may hold the delivery's attempt lock.
const DELIVERY_LOCK_TTL_MS = 60_000;

/** The authority level outbound exports are gated at (§20 — consequential execution). */
const DELIVERY_AUTHORITY_LEVEL: AuthorityLevel = 'EXECUTE';

/** The stable per-delivery idempotency key of the authority-gate request. */
function deliveryGateKey(deliveryId: string): string {
  return `destinations:delivery:${deliveryId}`;
}

interface DestinationRow extends DbRow {
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

interface DeliveryRow extends DbRow {
  id: string;
  tenant_id: string;
  destination_id: string;
  provider: string;
  kind: string;
  records: CanonicalOutboundRecord[];
  provenance_observation_ids: string[];
  idempotency_key: string | null;
  action_request_id: string | null;
  replayed_from_id: string | null;
  status: string;
  requested_by: string;
  requested_at: Date | string;
  updated_at: Date | string;
}

interface AttemptRow extends DbRow {
  id: string;
  tenant_id: string;
  delivery_id: string;
  attempt_number: number;
  envelope: FormattedDelivery;
  outcome: string;
  provider_delivery_id: string | null;
  detail: string | null;
  started_at: Date | string;
  completed_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapDestination(row: DestinationRow): Destination {
  const adapter = getDestinationAdapter(row.provider);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as DestinationProvider, // CHECK-constrained by migration 001
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    authKind: row.auth_kind as DestinationAuthKind, // CHECK-constrained by migration 001
    credentialRef: row.credential_ref,
    oauthScopes: row.oauth_scopes,
    oauthExpiresAt: row.oauth_expires_at === null ? null : toIso(row.oauth_expires_at),
    status: row.status as DestinationStatus, // CHECK-constrained by migration 001
    category: adapter.category,
    requiresObjectRecords: adapter.requiresObjectRecords,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    destinationId: row.destination_id,
    provider: row.provider as DestinationProvider, // CHECK-constrained by migration 002
    kind: row.kind,
    records: row.records,
    provenanceObservationIds: row.provenance_observation_ids,
    idempotencyKey: row.idempotency_key,
    actionRequestId: row.action_request_id,
    replayedFromId: row.replayed_from_id,
    status: row.status as DeliveryStatus, // CHECK-constrained by migration 002
    requestedBy: row.requested_by,
    requestedAt: toIso(row.requested_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    attemptNumber: row.attempt_number,
    envelope: row.envelope,
    outcome: row.outcome as DeliveryAttempt['outcome'], // CHECK-constrained by migration 002
    providerDeliveryId: row.provider_delivery_id,
    detail: row.detail,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
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
// Transport port (provider-neutral delivery; implementations live inside adapters/)
// ---------------------------------------------------------------------------

let destinationTransport: DestinationTransport | null = null;

/**
 * Infrastructure wiring for the delivery port. Real transports (provider
 * SDKs / HTTP) are implemented inside `src/modules/destinations/adapters/`
 * and wired once at process start; tests substitute a scripted transport.
 * `null` restores the default "no provider available" state.
 */
export function setDestinationTransport(transport: DestinationTransport | null): void {
  destinationTransport = transport;
}

/** The currently wired transport (null when none — deliveries then fail `provider_unavailable`). */
export function getDestinationTransport(): DestinationTransport | null {
  return destinationTransport;
}

// ---------------------------------------------------------------------------
// Destination loading helpers (uniform not-found discipline — ADR-0001)
// ---------------------------------------------------------------------------

async function loadDestinationRow(ctx: TenantContext, destinationId: string): Promise<DestinationRow> {
  if (!isUuid(destinationId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new DestinationsError(
      'destination_not_found',
      `destination '${destinationId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<DestinationRow>(
    `SELECT * FROM destinations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, destinationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DestinationsError(
      'destination_not_found',
      `destination '${destinationId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function loadDestination(ctx: TenantContext, destinationId: string): Promise<Destination> {
  return mapDestination(await loadDestinationRow(ctx, destinationId));
}

async function loadActiveDestination(ctx: TenantContext, destinationId: string): Promise<Destination> {
  const destination = await loadDestination(ctx, destinationId);
  if (destination.status !== 'active') {
    throw new DestinationsError(
      'destination_disabled',
      `destination '${destination.id}' (${destination.provider}) is disabled`,
    );
  }
  return destination;
}

/**
 * Authorization guard: a recorded OAuth grant that has lapsed blocks
 * delivery until the tenant re-authorizes (fail fast — "publish authorized
 * findings", ARCHITECTURE.md §10). Transports keep a healthy grant current
 * by reporting refreshed expiries; once lapsed, only re-registration (the
 * re-authorization path) unblocks the destination.
 */
function assertAuthorizationCurrent(destination: Destination, at: Date): void {
  if (destination.authKind === 'oauth' && destination.oauthExpiresAt !== null) {
    if (at.getTime() >= Date.parse(destination.oauthExpiresAt)) {
      throw new DestinationsError(
        'destination_authorization_expired',
        `the OAuth grant of destination '${destination.id}' (${destination.provider}) expired at ${destination.oauthExpiresAt} — re-register the destination to re-authorize`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Evidence-level authorization (the W004 usage tags this module consumes)
// ---------------------------------------------------------------------------

/**
 * A delivery may only export evidence the calling principal may read
 * (tenant and principal visibility are enforced by the observations
 * contract — evidence-level permissions stay with the evidence-owning
 * module) and NEVER evidence tagged `no-export`.
 */
async function assertEvidenceExportable(
  ctx: TenantContext,
  provenanceObservationIds: readonly string[],
): Promise<void> {
  for (const observationId of provenanceObservationIds) {
    let observation: Observation;
    try {
      observation = await getObservation(ctx, observationId);
    } catch (error) {
      if (error instanceof ObservationsError) {
        // Missing, foreign-tenant or not readable by this principal —
        // uniformly indistinguishable (no existence leak).
        throw new DestinationsError(
          'evidence_not_found',
          `provenance observation '${observationId}' does not exist or is not readable in this tenant`,
        );
      }
      throw error;
    }
    if (observation.permissions.usage.includes(EXPORT_FORBIDDING_USAGE_TAG)) {
      throw new DestinationsError(
        'evidence_export_forbidden',
        `provenance observation '${observationId}' is tagged '${EXPORT_FORBIDDING_USAGE_TAG}' and cannot be exported through a destination`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The authority gate (W009 'data-export' @ EXECUTE — authorized ONCE per
// delivery, replayed ever after)
// ---------------------------------------------------------------------------

/**
 * Records (or replays) the delivery's authority-gate request. The stable
 * idempotency key makes the FIRST authorization the only one: retried and
 * pumped deliveries replay the original request and read its CURRENT
 * status, so a human approval between retries unlocks a gated delivery
 * without duplicating gate history.
 */
async function authorizeDeliveryGate(
  ctx: TenantContext,
  delivery: Delivery,
  destination: Destination,
): Promise<ActionRequest> {
  const label = destination.displayName ?? destination.providerAccountId;
  try {
    return await authorizeAction(ctx, {
      actionKind: DELIVERY_ACTION_KIND,
      authorityLevel: DELIVERY_AUTHORITY_LEVEL,
      payload: {
        deliveryId: delivery.id,
        destinationId: destination.id,
        provider: destination.provider,
        kind: delivery.kind,
        recordCount: delivery.records.length,
        provenanceObservationIds: delivery.provenanceObservationIds,
      },
      justification: `export '${delivery.kind}' (${delivery.records.length} record${delivery.records.length === 1 ? '' : 's'}) to ${destination.provider} destination '${label}'`,
      idempotencyKey: deliveryGateKey(delivery.id),
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      // Our gate inputs are pre-validated; a rejection here contradicts
      // the actions contract — stay loud rather than silently undelivered.
      throw new Error(
        `the authority gate rejected a pre-validated delivery authorization (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export async function registerDestination(
  ctx: TenantContext,
  input: RegisterDestinationInput,
): Promise<RegisterDestinationResult> {
  assertDestinationsTenantContext(ctx);
  const valid = validateRegisterDestinationInput(input);
  const adapter = getDestinationAdapter(valid.provider);
  const providerAccountId = adapter.normalizeAccountId(valid.providerAccountId);
  const at = now();
  const db = getDb();

  // Re-registering an existing destination is the RE-AUTHORIZATION path:
  // the authorization fields (kind, credential reference, scopes, expiry)
  // move to what the caller just supplied; the connector's identity
  // (provider, account, delivery history) never changes. The sources
  // module's upsert discipline (transaction + duplicate-key conflict)
  // makes the rare concurrent first-registration explicit instead of racy.
  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM destinations
         WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
      [ctx.tenantId, valid.provider, providerAccountId],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      const updated = await tx.query<DestinationRow>(
        `UPDATE destinations SET
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
      return { destination: mapDestination(updated.rows[0]!), created: false };
    }
    let inserted;
    try {
      inserted = await tx.query<DestinationRow>(
        `INSERT INTO destinations (
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
      if (isDuplicateKeyOn(error, 'destinations')) {
        throw new DestinationsError(
          'destination_conflict',
          'a destination for this provider account was created concurrently; retry the registration',
        );
      }
      throw error;
    }
    return { destination: mapDestination(inserted.rows[0]!), created: true };
  });
}

export async function getDestination(
  ctx: TenantContext,
  destinationId: string,
): Promise<Destination> {
  assertDestinationsTenantContext(ctx);
  return loadDestination(ctx, destinationId);
}

export async function listDestinations(
  ctx: TenantContext,
  query: ListDestinationsQuery,
): Promise<Destination[]> {
  assertDestinationsTenantContext(ctx);
  const valid: ValidatedListDestinationsQuery = validateListDestinationsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  } else if (valid.category !== null) {
    // Categories are derived adapter classifications (never stored) — the
    // filter resolves onto the category's provider set.
    const providers = allDestinationAdapters()
      .filter((adapter) => adapter.category === valid.category)
      .map((adapter) => adapter.provider);
    params.push(providers);
    conditions.push(`provider = ANY($${params.length}::text[])`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<DestinationRow>(
    `SELECT * FROM destinations WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapDestination(row));
}

export async function setDestinationStatus(
  ctx: TenantContext,
  input: SetDestinationStatusInput,
): Promise<Destination> {
  assertDestinationsTenantContext(ctx);
  const valid = validateSetDestinationStatusInput(input);
  const result = await getDb().query<DestinationRow>(
    `UPDATE destinations SET status = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, valid.destinationId, valid.status, now()],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant destinations are indistinguishable from missing ones.
    throw new DestinationsError(
      'destination_not_found',
      `destination '${valid.destinationId}' does not exist in this tenant`,
    );
  }
  return mapDestination(row);
}

// ---------------------------------------------------------------------------
// The physical attempt (format → transport → receipt → audit)
// ---------------------------------------------------------------------------

/**
 * Performs one physical delivery attempt, serialized by the delivery's
 * attempt lock: composes the adapter envelope, hands it to the wired
 * transport, records the append-only attempt row (envelope + outcome +
 * provider acknowledgment) and moves the delivery's lifecycle forward.
 * A thrown transport call becomes a recorded 'failed' attempt (transient —
 * retryable); `provider_unavailable` is thrown BEFORE anything is
 * recorded (nothing was attempted — the sources module's discipline).
 */
async function attemptDelivery(
  ctx: TenantContext,
  destination: Destination,
  delivery: Delivery,
): Promise<DeliveryAttempt> {
  const lockKey = `destinations:deliver:${delivery.id}`;
  const lock = getLock();
  const token = await lock.acquire(lockKey, DELIVERY_LOCK_TTL_MS);
  if (token === null) {
    throw new DestinationsError(
      'delivery_busy',
      `another delivery attempt holds delivery '${delivery.id}' — retry once it completes (safe: attempts are idempotent per number)`,
    );
  }
  try {
    const transport = destinationTransport;
    if (transport === null) {
      throw new DestinationsError(
        'provider_unavailable',
        `no destination transport is wired for provider '${destination.provider}' (wire one via setDestinationTransport)`,
      );
    }

    const db = getDb();
    const numbered = await db.query<{ next: number }>(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
         FROM destination_delivery_attempts
         WHERE tenant_id = $1 AND delivery_id = $2`,
      [ctx.tenantId, delivery.id],
    );
    const attemptNumber = numbered.rows[0]!.next;

    // Adapter-composed, provider-specific STRUCTURE in a provider-neutral
    // SHAPE — re-validated before it reaches the transport or the audit
    // (defense in depth).
    const adapter = getDestinationAdapter(destination.provider);
    const formatted: FormattedDelivery = validateFormattedDelivery(
      adapter.formatDelivery({
        deliveryId: delivery.id,
        attempt: attemptNumber,
        kind: delivery.kind,
        records: delivery.records,
      }),
    );

    const request: DestinationDeliveryRequest = {
      provider: destination.provider,
      tenantId: ctx.tenantId,
      destinationId: destination.id,
      providerAccountId: destination.providerAccountId,
      credentialRef: destination.credentialRef,
      deliveryId: delivery.id,
      attempt: attemptNumber,
      kind: delivery.kind,
      envelope: formatted,
    };

    const startedAt = now();
    let receipt: TransportReceipt;
    try {
      receipt = await transport.deliver(request);
    } catch (error) {
      // Transient transport failure — a recorded, retryable attempt.
      receipt = {
        status: 'failed',
        providerDeliveryId: null,
        detail: `the ${destination.provider} transport failed to deliver: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const validated = validateTransportReceipt(receipt);
    const refreshedExpiry = validated.authorizationExpiresAt ?? null;

    // Authorization-state coherence: only OAuth grants can be refreshed.
    if (refreshedExpiry !== null && destination.authKind !== 'oauth') {
      throw new Error(
        `the ${destination.provider} transport reported an authorization expiry for a credentials-authorized destination (internal invariant violation)`,
      );
    }
    const completedAt = now();

    const inserted = await db.query<AttemptRow>(
      `INSERT INTO destination_delivery_attempts (
         tenant_id, delivery_id, attempt_number, envelope, outcome,
         provider_delivery_id, detail, started_at, completed_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        ctx.tenantId,
        delivery.id,
        attemptNumber,
        JSON.stringify(formatted),
        validated.status,
        validated.providerDeliveryId,
        validated.detail,
        startedAt,
        completedAt,
      ],
    );

    // The forward-only lifecycle transition (guard trigger, migration 002):
    // 'delivered' and 'rejected' are terminal; 'failed' stays retryable.
    await db.query(
      `UPDATE destination_deliveries SET status = $3, updated_at = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, delivery.id, validated.status, completedAt],
    );

    // A transport that refreshed the OAuth grant reports the new expiry;
    // the recorded authorization state moves with it (non-secret metadata).
    if (refreshedExpiry !== null) {
      await db.query(
        `UPDATE destinations SET oauth_expires_at = $3, updated_at = $4
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, destination.id, new Date(refreshedExpiry), completedAt],
      );
    }

    return mapAttempt(inserted.rows[0]!);
  } finally {
    await lock.release(lockKey, token);
  }
}

// ---------------------------------------------------------------------------
// Delivery loading helpers
// ---------------------------------------------------------------------------

async function loadDeliveryRow(ctx: TenantContext, deliveryId: string): Promise<DeliveryRow> {
  if (!isUuid(deliveryId)) {
    throw new DestinationsError(
      'delivery_not_found',
      `delivery '${deliveryId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<DeliveryRow>(
    `SELECT * FROM destination_deliveries WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, deliveryId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DestinationsError(
      'delivery_not_found',
      `delivery '${deliveryId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function loadDelivery(ctx: TenantContext, deliveryId: string): Promise<Delivery> {
  return mapDelivery(await loadDeliveryRow(ctx, deliveryId));
}

// ---------------------------------------------------------------------------
// Dispatch (and its replay re-use)
// ---------------------------------------------------------------------------

/**
 * The shared dispatch path: evidence authorization, provider content
 * constraint, idempotent creation, the authority gate and (when the gate
 * allows) the first physical attempt.
 */
async function dispatchValidated(
  ctx: TenantContext,
  valid: ValidatedDispatchDeliveryInput,
  replayedFromId: string | null,
): Promise<DispatchDeliveryResult> {
  // Idempotent fast path: a recorded key replays the original delivery —
  // first write wins (the events module's replay semantics), so retried
  // dispatches from asynchronous producers (lock 36) never duplicate
  // deliveries or gate history. Replays have no caller key by
  // construction.
  if (valid.idempotencyKey !== null) {
    const existing = await getDb().query<DeliveryRow>(
      `SELECT * FROM destination_deliveries WHERE tenant_id = $1 AND idempotency_key = $2`,
      [ctx.tenantId, valid.idempotencyKey],
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      return { delivery: mapDelivery(row), created: false, attempt: null };
    }
  }

  const destination = await loadActiveDestination(ctx, valid.destinationId);
  assertAuthorizationCurrent(destination, now());

  const adapter = getDestinationAdapter(destination.provider);
  // Provider content constraint — fail BEFORE the gate: an undeliverable
  // batch never burns an approval.
  assertRecordsDeliverable(adapter.requiresObjectRecords, valid.records);

  // Evidence-level authorization (the dispatching principal's read scope).
  await assertEvidenceExportable(ctx, valid.provenanceObservationIds);

  const at = now();
  let inserted;
  try {
    inserted = await getDb().query<DeliveryRow>(
      `INSERT INTO destination_deliveries (
         tenant_id, destination_id, provider, kind, records,
         provenance_observation_ids, idempotency_key, replayed_from_id,
         status, requested_by, requested_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 'pending', $9, $10, $10)
       RETURNING *`,
      [
        ctx.tenantId,
        destination.id,
        destination.provider,
        valid.kind,
        JSON.stringify(valid.records),
        JSON.stringify(valid.provenanceObservationIds),
        valid.idempotencyKey,
        replayedFromId,
        ctx.principalId,
        at,
      ],
    );
  } catch (error) {
    if (isDuplicateKeyOn(error, 'destination_deliveries')) {
      throw new DestinationsError(
        'delivery_conflict',
        'a delivery with this idempotency key was created concurrently; retry the dispatch (it will replay the recorded delivery)',
      );
    }
    throw error;
  }
  let delivery = mapDelivery(inserted.rows[0]!);

  // The authority gate: deterministic 'data-export' @ EXECUTE evaluation
  // (allowed → attempt now; approval_required → wait for a human;
  // forbidden → terminal rejection).
  const request = await authorizeDeliveryGate(ctx, delivery, destination);
  if (delivery.actionRequestId === null) {
    await getDb().query(
      `UPDATE destination_deliveries SET action_request_id = $3
         WHERE tenant_id = $1 AND id = $2 AND action_request_id IS NULL`,
      [ctx.tenantId, delivery.id, request.id],
    );
    delivery = { ...delivery, actionRequestId: request.id };
  }

  if (request.status === 'rejected') {
    // The gate forbade the export — terminal, auditable, no transport call.
    const updated = await getDb().query<DeliveryRow>(
      `UPDATE destination_deliveries SET status = 'rejected', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [ctx.tenantId, delivery.id, now()],
    );
    return { delivery: mapDelivery(updated.rows[0]!), created: true, attempt: null };
  }
  if (request.status === 'approved') {
    const attempt = await attemptDelivery(ctx, destination, delivery);
    return { delivery: await loadDelivery(ctx, delivery.id), created: true, attempt };
  }
  // Still gated ('pending'): a human decision (or a policy change plus a
  // retry) unlocks the delivery; nothing left the system.
  return { delivery, created: true, attempt: null };
}

export async function dispatchDelivery(
  ctx: TenantContext,
  input: DispatchDeliveryInput,
): Promise<DispatchDeliveryResult> {
  assertDestinationsTenantContext(ctx);
  const valid = validateDispatchDeliveryInput(input);
  return dispatchValidated(ctx, valid, null);
}

// ---------------------------------------------------------------------------
// Retry (pending unlock / transient failure re-attempt)
// ---------------------------------------------------------------------------

export async function retryDelivery(
  ctx: TenantContext,
  input: RetryDeliveryInput,
): Promise<RetryDeliveryResult> {
  assertDestinationsTenantContext(ctx);
  const valid = validateRetryDeliveryInput(input);
  let delivery = await loadDelivery(ctx, valid.deliveryId);

  if (delivery.status === 'delivered' || delivery.status === 'rejected') {
    throw new DestinationsError(
      'delivery_not_retryable',
      `delivery '${delivery.id}' is ${delivery.status} (terminal) — use replayDelivery to re-deliver recorded content under a fresh authorization`,
    );
  }

  // Provider authorization and lifecycle re-checked on every pump: a
  // destination disabled or lapsed since dispatch blocks the attempt.
  const destination = await loadActiveDestination(ctx, delivery.destinationId);
  assertAuthorizationCurrent(destination, now());

  // The gate replays (stable key): an approval that landed between pumps
  // unlocks the delivery here WITHOUT duplicating gate history; a
  // rejection terminates it.
  const request = await authorizeDeliveryGate(ctx, delivery, destination);
  if (delivery.actionRequestId === null) {
    await getDb().query(
      `UPDATE destination_deliveries SET action_request_id = $3
         WHERE tenant_id = $1 AND id = $2 AND action_request_id IS NULL`,
      [ctx.tenantId, delivery.id, request.id],
    );
    delivery = { ...delivery, actionRequestId: request.id };
  }

  if (request.status === 'rejected') {
    const updated = await getDb().query<DeliveryRow>(
      `UPDATE destination_deliveries SET status = 'rejected', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [ctx.tenantId, delivery.id, now()],
    );
    return { delivery: mapDelivery(updated.rows[0]!), attempt: null };
  }
  if (request.status === 'approved') {
    const attempt = await attemptDelivery(ctx, destination, delivery);
    return { delivery: await loadDelivery(ctx, delivery.id), attempt };
  }
  // Still gated — nothing attempted; the pump may poll again.
  return { delivery, attempt: null };
}

// ---------------------------------------------------------------------------
// Replay (reprocessing of recorded content — a NEW delivery)
// ---------------------------------------------------------------------------

export async function replayDelivery(
  ctx: TenantContext,
  input: ReplayDeliveryInput,
): Promise<DispatchDeliveryResult> {
  assertDestinationsTenantContext(ctx);
  const valid = validateReplayDeliveryInput(input);
  const original = await loadDelivery(ctx, valid.deliveryId);

  // The replay re-validates the recorded content through the SAME dispatch
  // path (records shape, size, provenance) and re-runs evidence-level
  // authorization with the CURRENT principal (visibility is
  // principal-enforced at the observations contract) plus a FRESH full
  // gate authorization — a replay is a new consequential export, not a
  // replayed approval.
  const reconstructed = validateDispatchDeliveryInput({
    destinationId: original.destinationId,
    kind: original.kind,
    records: original.records,
    provenanceObservationIds: original.provenanceObservationIds,
  });
  return dispatchValidated(ctx, reconstructed, original.id);
}

// ---------------------------------------------------------------------------
// Delivery reads (the outbound checkpoint surface)
// ---------------------------------------------------------------------------

export async function getDelivery(
  ctx: TenantContext,
  query: GetDeliveryQuery,
): Promise<Delivery> {
  assertDestinationsTenantContext(ctx);
  const valid = validateGetDeliveryQuery(query);
  return loadDelivery(ctx, valid.deliveryId);
}

export async function listDeliveries(
  ctx: TenantContext,
  query: ListDeliveriesQuery,
): Promise<Delivery[]> {
  assertDestinationsTenantContext(ctx);
  const valid: ValidatedListDeliveriesQuery = validateListDeliveriesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.destinationId !== null) {
    params.push(valid.destinationId);
    conditions.push(`destination_id = $${params.length}`);
  }
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<DeliveryRow>(
    `SELECT * FROM destination_deliveries WHERE ${conditions.join(' AND ')}
       ORDER BY requested_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapDelivery(row));
}

export async function listDeliveryAttempts(
  ctx: TenantContext,
  query: ListDeliveryAttemptsQuery,
): Promise<DeliveryAttempt[]> {
  assertDestinationsTenantContext(ctx);
  const valid = validateListDeliveryAttemptsQuery(query);
  // The delivery check enforces tenancy before any attempt state is
  // revealed.
  await loadDelivery(ctx, valid.deliveryId);
  const rows = await getDb().query<AttemptRow>(
    `SELECT * FROM destination_delivery_attempts
       WHERE tenant_id = $1 AND delivery_id = $2
       ORDER BY attempt_number ASC LIMIT $3`,
    [ctx.tenantId, valid.deliveryId, valid.limit],
  );
  return rows.rows.map((row) => mapAttempt(row));
}
