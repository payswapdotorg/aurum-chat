// Implementation of the connection-broker module's public operations (see
// contract.ts). W082 — Universal Connection Broker.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`) or `newId()` where the broker handshake needs the
// id first; timestamps come from the injectable clock and are never
// caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`connection_not_found` / `checkpoint_not_found`),
// no existence leak.
//
// W082 acceptance — "connect/revoke/refresh; webhook/sync checkpoints;
// provider outages are localized; credential values never enter domain
// state; broker replacement does not change domain contracts" — is
// carried by these deliberate properties, all tested:
//
//   1. BROKER PLUGGABILITY: the domain speaks ONLY the canonical
//      ConnectionBroker port. Nango (the managed candidate) and the
//      embedded alternative are wired at process start through
//      `wireConnectionBrokers`; nothing is wired by default — operations
//      then fail explicitly with `broker_unavailable`. Existing
//      connections keep operating through the broker recorded on them, so
//      swapping the ACTIVE broker changes only where NEW connections go
//      (the recorded one must stay wired). `verifyBrokerHotSwap` proves
//      the same canonical sync request executes through two DIFFERENT
//      brokers with unchanged domain semantics (GOVERNANCE provider-swap
//      evidence; the append-only verification table + the canonical W089
//      hot-swap evidence record).
//
//   2. OAUTH/TOKEN LIFECYCLE: initiate → (user completes at the broker) →
//      complete → connected; refresh rotates the recorded grant state
//      through the broker; revoke destroys the grant broker-side, parks
//      the connection 'revoked' and DISABLES the bound gateway connectors.
//      Every transition is a guarded optimistic UPDATE and every step is
//      append-only audited (broker_connection_events).
//
//   3. CREDENTIAL ISOLATION: the domain persists only the OPAQUE
//      broker-issued `credentialRef` and non-secret authorization state
//      (scopes, expiry). Token values are discarded INSIDE the adapters;
//      broker instance secrets are wiring-time configuration. The
//      gateways' connectors receive the same opaque reference through
//      their own re-authorization path (registerSource/registerDestination).
//
//   4. SYNC/WEBHOOK CHECKPOINTS: each flow carries a live checkpoint row,
//      an append-only history (the legal replay targets) and a delivery
//      ledger that dedupes by provider record id — one claim per (tenant,
//      connection, record), ever. A failed pull leaves the checkpoint
//      unchanged (the retry re-fetches the same window); replay rewinds
//      under dedupe (the sources module's exact discipline).
//
//   5. OUTAGE LOCALIZATION: every broker/provider failure is normalized
//      (W089 taxonomy) into an append-only health event for exactly ONE
//      (provider, broker) pair and rethrown as `broker_failure` carrying
//      the canonical failure — never a raw provider error, never a domain
//      fault, never a partial write. The sync path additionally fails
//      fast while a recorded outage is still cooling down
//      (`provider_outage`, the llm module's cooldown precedent); refresh
//      is deliberately NOT gated (it is the healing path); a successful
//      interaction records the recovery.
//
//   6. GATEWAY INTEGRATION (W036/W037/W081): bindings are validated
//      through the owning gateways' public contracts at initiation;
//      completion/refresh re-register the bound connector through its
//      contract (the re-authorization path — the same call whichever
//      broker is active); revocation disables it. The composition bridge
//      `createBrokerSourceTransport` hands broker-backed pulls to the
//      sources module's own polling path so records become observations
//      through W036's contract with zero provider shapes crossing.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  buildHotSwapEvidence,
  canonicalRequestDigest,
  type CanonicalErrorCategory,
  type CanonicalProviderFailure,
  type HotSwapEvidenceRecord,
} from '@/modules/provider-sdk/contract';
import { getSystem, IntegrationError } from '@/modules/integration-intelligence/contract';
import {
  getDestination,
  registerDestination,
  setDestinationStatus,
  DestinationsError,
  type DestinationProvider,
} from '@/modules/destinations/contract';
import {
  getSource,
  registerSource,
  setSourceStatus,
  SourcesError,
  type SourceFetchRequest,
  type SourceFetchResult,
  type SourceProvider,
  type SourceTransport,
} from '@/modules/sources/contract';
import { BrokerAdapterError } from './adapters/shared';
import { ConnectionBrokerError } from './errors';
import {
  cooldownExpiryFor,
  healthForFailure,
  resolveHealth,
  type HealthEventLike,
} from './health';
import {
  assertBrokerTenantContext,
  isUuid,
  syncCursorAdvance,
  validateBrokerAuthorizationSession,
  validateBrokerConnectionGrant,
  validateBrokerSyncResult,
  validateBrokerWebhookParseResult,
  validateCompleteConnectionInput,
  validateGetCheckpointQuery,
  validateGetConnectionQuery,
  validateGetProviderHealthQuery,
  validateInitiateConnectionInput,
  validateListCheckpointHistoryQuery,
  validateListConnectionEventsQuery,
  validateListConnectionsQuery,
  validateListHotSwapVerificationsQuery,
  validateListProviderHealthQuery,
  validateReceiveWebhookInput,
  validateRefreshConnectionInput,
  validateReplayCheckpointInput,
  validateRevokeConnectionInput,
  validateRunSyncInput,
  validateSetProviderHealthInput,
  validateVerifyBrokerHotSwapInput,
  webhookCursorAdvance,
  MAX_DETAIL_LENGTH,
} from './validation';
import type {
  BrokerCheckpoint,
  BrokerCheckpointEntry,
  BrokerConnection,
  BrokerConnectionGrant,
  BrokerFlow,
  BrokerHotSwapVerification,
  BrokerProvider,
  BrokerRecord,
  BrokerSyncResult,
  BrokerWebhookParseResult,
  CheckpointOrigin,
  CompleteConnectionInput,
  CompleteConnectionResult,
  ConnectionBroker,
  ConnectionEventEntry,
  ConnectionEventType,
  ConnectionStatus,
  InitiateConnectionInput,
  InitiateConnectionResult,
  ListCheckpointHistoryQuery,
  ListConnectionsQuery,
  ListConnectionEventsQuery,
  ListHotSwapVerificationsQuery,
  ListProviderHealthQuery,
  ProviderHealth,
  ProviderHealthStatus,
  ReceiveWebhookInput,
  ReplayCheckpointInput,
  ReplayCheckpointResult,
  RefreshConnectionInput,
  RefreshConnectionResult,
  RevokeConnectionInput,
  RevokeConnectionResult,
  RunSyncInput,
  SetProviderHealthInput,
  SyncResult,
  VerifyBrokerHotSwapInput,
  VerifyBrokerHotSwapResult,
  WebhookResult,
  WiredBrokerInfo,
} from './types';

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

/** Authority claim that administers provider-health overrides (the llm precedent). */
export const BROKER_AUTHORITY_ADMINISTER = 'connection-broker:administer';

/** The canonical capability a broker hot-swap verification exercises. */
export const HOT_SWAP_CAPABILITY = 'connection-sync';

/** The canonical maxRecords of a hot-swap verification pull (fixed so the request digest is stable). */
const HOT_SWAP_MAX_RECORDS = 50;

/** The principal id the composition bridge records health observations as. */
const SOURCE_TRANSPORT_OBSERVER = 'connection-broker:source-transport';

// ---------------------------------------------------------------------------
// Broker wiring (infrastructure, not domain state — the sources-transport
// and integration-verification precedents)
// ---------------------------------------------------------------------------

let wiredBrokers: ConnectionBroker[] = [];

/**
 * Wires the broker adapter set (FIRST entry = the ACTIVE broker new
 * connections use). Real adapters are created from the module's factories
 * (see the contract); tests substitute scripted ones. `null`/[] restores
 * the default "no broker available" state.
 */
export function wireConnectionBrokers(brokers: ConnectionBroker[] | null): void {
  wiredBrokers = brokers === null ? [] : [...brokers];
}

/** The wired broker adapters (read-only introspection/testing). */
export function getWiredBrokers(): ConnectionBroker[] {
  return [...wiredBrokers];
}

/** The ACTIVE broker — the first wired entry (null when none is wired). */
export function getActiveBroker(): ConnectionBroker | null {
  return wiredBrokers[0] ?? null;
}

/** Read-only broker introspection for surfaces/tests. */
export function listWiredBrokers(): WiredBrokerInfo[] {
  return wiredBrokers.map((broker) => ({
    key: broker.key,
    capabilities: [...broker.definition.describeCapabilities().capabilities],
  }));
}

function brokerByKey(key: string): ConnectionBroker | null {
  return wiredBrokers.find((broker) => broker.key === key) ?? null;
}

function requireBrokerByKey(key: string): ConnectionBroker {
  const broker = brokerByKey(key);
  if (broker === null) {
    throw new ConnectionBrokerError(
      'broker_unavailable',
      `no '${key}' broker adapter is wired (wire one via wireConnectionBrokers)`,
    );
  }
  return broker;
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface ConnectionRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  connection_key: string;
  display_name: string | null;
  broker: string;
  broker_connection_id: string | null;
  provider_account_id: string | null;
  credential_ref: string | null;
  requested_scopes: string[];
  oauth_scopes: string[];
  oauth_expires_at: Date | string | null;
  status: string;
  authorization_state: string | null;
  authorization_expires_at: Date | string | null;
  inventory_system_id: string | null;
  bind_source_id: string | null;
  bind_destination_id: string | null;
  last_refreshed_at: Date | string | null;
  revoked_by: string | null;
  revoked_at: Date | string | null;
  revocation_note: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  event: string;
  broker: string;
  detail: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

interface CheckpointRow extends DbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  flow: string;
  cursor: string | null;
  updated_at: Date | string;
}

interface CheckpointHistoryRow extends DbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  flow: string;
  cursor: string | null;
  origin: string;
  recorded_by: string;
  recorded_at: Date | string;
}

interface HealthEventRow extends DbRow {
  id: string;
  seq: number;
  tenant_id: string;
  provider: string;
  broker: string;
  state: string;
  category: string | null;
  reason: string | null;
  source: string;
  expires_at: Date | string | null;
  observed_at: Date | string;
  observed_by: string;
}

interface HotSwapRow extends DbRow {
  id: string;
  tenant_id: string;
  capability: string;
  request_digest: string;
  provider: string;
  broker_a: string;
  connection_a: string;
  result_a: string;
  broker_b: string;
  connection_b: string;
  result_b: string;
  outcome: string;
  note: string | null;
  requested_by: string;
  verified_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapConnection(row: ConnectionRow): BrokerConnection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider as BrokerProvider, // CHECK-constrained by migration 001
    connectionKey: row.connection_key,
    displayName: row.display_name,
    broker: row.broker,
    brokerConnectionId: row.broker_connection_id,
    providerAccountId: row.provider_account_id,
    credentialRef: row.credential_ref,
    requestedScopes: row.requested_scopes,
    oauthScopes: row.oauth_scopes,
    oauthExpiresAt: row.oauth_expires_at === null ? null : toIso(row.oauth_expires_at),
    status: row.status as ConnectionStatus, // CHECK-constrained by migration 001
    authorizationState: row.authorization_state,
    authorizationExpiresAt:
      row.authorization_expires_at === null ? null : toIso(row.authorization_expires_at),
    inventorySystemId: row.inventory_system_id,
    bindSourceId: row.bind_source_id,
    bindDestinationId: row.bind_destination_id,
    lastRefreshedAt: row.last_refreshed_at === null ? null : toIso(row.last_refreshed_at),
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    revocationNote: row.revocation_note,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvent(row: EventRow): ConnectionEventEntry {
  return {
    id: row.id,
    connectionId: row.connection_id,
    event: row.event as ConnectionEventType, // CHECK-constrained by migration 001
    broker: row.broker,
    detail: row.detail,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapCheckpoint(row: CheckpointRow): BrokerCheckpoint {
  return {
    connectionId: row.connection_id,
    flow: row.flow as BrokerFlow, // CHECK-constrained by migration 001
    cursor: row.cursor,
    updatedAt: toIso(row.updated_at),
  };
}

function mapCheckpointEntry(row: CheckpointHistoryRow): BrokerCheckpointEntry {
  return {
    id: row.id,
    connectionId: row.connection_id,
    flow: row.flow as BrokerFlow, // CHECK-constrained by migration 001
    cursor: row.cursor,
    origin: row.origin as CheckpointOrigin, // CHECK-constrained by migration 001
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapHealth(row: HealthEventRow, at: Date): ProviderHealthStatus {
  const resolved = resolveHealth(
    {
      state: row.state as ProviderHealth, // CHECK-constrained by migration 001
      category: row.category,
      reason: row.reason,
      expiresAt: row.expires_at,
      observedAt: row.observed_at,
    } satisfies HealthEventLike,
    at,
  );
  return {
    provider: row.provider as BrokerProvider, // CHECK-constrained by migration 001
    broker: row.broker,
    health: resolved,
    category: resolved === 'available' ? null : (row.category as CanonicalErrorCategory | null),
    reason: row.reason,
    expiresAt:
      resolved === 'available' || row.expires_at === null ? null : toIso(row.expires_at),
    observedAt: toIso(row.observed_at),
    observedBy: row.observed_by,
  };
}

function mapHotSwap(row: HotSwapRow): BrokerHotSwapVerification {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    capability: row.capability,
    requestDigest: row.request_digest,
    provider: row.provider as BrokerProvider, // CHECK-constrained by migration 001
    brokerA: row.broker_a,
    connectionAId: row.connection_a,
    resultA: row.result_a,
    brokerB: row.broker_b,
    connectionBId: row.connection_b,
    resultB: row.result_b,
    outcome: row.outcome as 'equivalent' | 'completed-divergent' | 'failed', // CHECK-constrained
    note: row.note,
    requestedBy: row.requested_by,
    verifiedAt: toIso(row.verified_at),
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
// Connection loading (uniform not-found discipline — ADR-0001)
// ---------------------------------------------------------------------------

async function loadConnectionRow(ctx: TenantContext, connectionId: string): Promise<ConnectionRow> {
  if (!isUuid(connectionId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw new ConnectionBrokerError(
      'connection_not_found',
      `connection '${connectionId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM broker_connections WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, connectionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ConnectionBrokerError(
      'connection_not_found',
      `connection '${connectionId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function loadConnection(ctx: TenantContext, connectionId: string): Promise<BrokerConnection> {
  return mapConnection(await loadConnectionRow(ctx, connectionId));
}

async function loadConnectionRowByBrokerId(
  ctx: TenantContext,
  broker: string,
  brokerConnectionId: string,
): Promise<ConnectionRow> {
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM broker_connections
       WHERE tenant_id = $1 AND broker = $2 AND broker_connection_id = $3`,
    [ctx.tenantId, broker, brokerConnectionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ConnectionBrokerError(
      'connection_not_found',
      `no ${broker}-backed connection '${brokerConnectionId}' exists in this tenant`,
    );
  }
  return row;
}

async function loadConnectionByBoundSource(
  tenantId: string,
  sourceId: string,
): Promise<ConnectionRow> {
  const result = await getDb().query<ConnectionRow>(
    `SELECT * FROM broker_connections WHERE tenant_id = $1 AND bind_source_id = $2`,
    [tenantId, sourceId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ConnectionBrokerError(
      'connection_not_found',
      `no broker-backed connection is bound to source '${sourceId}' in this tenant`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Append-only event audit
// ---------------------------------------------------------------------------

async function recordEvent(
  ctx: TenantContext,
  connectionId: string,
  event: ConnectionEventType,
  broker: string,
  detail: string | null,
): Promise<void> {
  const bounded =
    detail === null
      ? null
      : detail.length > MAX_DETAIL_LENGTH
        ? `${detail.slice(0, MAX_DETAIL_LENGTH)}…`
        : detail;
  await getDb().query(
    `INSERT INTO broker_connection_events (
       tenant_id, connection_id, event, broker, detail, recorded_by, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.tenantId, connectionId, event, broker, bounded, ctx.principalId, now()],
  );
}

// ---------------------------------------------------------------------------
// Provider health (outage localization — observed, append-only)
// ---------------------------------------------------------------------------

async function currentHealthEvent(
  tenantId: string,
  provider: string,
  broker: string,
): Promise<HealthEventRow | null> {
  const result = await getDb().query<HealthEventRow>(
    `SELECT * FROM broker_provider_health_events
       WHERE tenant_id = $1 AND provider = $2 AND broker = $3
       ORDER BY seq DESC LIMIT 1`,
    [tenantId, provider, broker],
  );
  return result.rows[0] ?? null;
}

/**
 * Records one observed broker/provider failure as append-only health
 * evidence for exactly this (provider, broker) pair. Failures whose
 * canonical health impact is 'none' (caller errors, cancellations) are NOT
 * outages and record nothing — the W089 semantics table decides, never
 * this module.
 */
async function observeFailure(
  tenantId: string,
  provider: string,
  broker: string,
  failure: CanonicalProviderFailure,
  at: Date,
  observedBy: string,
): Promise<void> {
  if (failure.healthImpact === 'none') return;
  const state = healthForFailure(failure);
  const cooldown = cooldownExpiryFor(failure, at);
  await getDb().query(
    `INSERT INTO broker_provider_health_events (
       tenant_id, provider, broker, state, category, reason, source,
       expires_at, observed_at, observed_by
     ) VALUES ($1, $2, $3, $4, $5, $6, 'execution', $7, $8, $9)`,
    [
      tenantId,
      provider,
      broker,
      state,
      failure.category,
      failure.detail,
      cooldown,
      at,
      observedBy,
    ],
  );
}

/** Records the recovery of a pair that was previously not 'available'. */
async function observeRecoveryIfNeeded(
  tenantId: string,
  provider: string,
  broker: string,
  at: Date,
  observedBy: string,
): Promise<void> {
  const current = await currentHealthEvent(tenantId, provider, broker);
  if (current === null || current.state === 'available') return;
  await getDb().query(
    `INSERT INTO broker_provider_health_events (
       tenant_id, provider, broker, state, category, reason, source,
       expires_at, observed_at, observed_by
     ) VALUES ($1, $2, $3, 'available', NULL, NULL, 'execution', NULL, $4, $5)`,
    [tenantId, provider, broker, at, observedBy],
  );
}

/**
 * The cooldown gate: while a recorded outage for exactly this (provider,
 * broker) pair is still cooling down, the data-moving paths fail fast
 * without touching the broker, the checkpoints or any domain state (the
 * llm module's routing-cooldown precedent). Refresh is deliberately NOT
 * gated — it is the healing path.
 */
async function assertNotCoolingDown(
  tenantId: string,
  provider: string,
  broker: string,
  at: Date,
): Promise<void> {
  const current = await currentHealthEvent(tenantId, provider, broker);
  if (current === null) return;
  const resolved = resolveHealth(
    {
      state: current.state as ProviderHealth,
      category: current.category,
      reason: current.reason,
      expiresAt: current.expires_at,
      observedAt: current.observed_at,
    } satisfies HealthEventLike,
    at,
  );
  if (resolved === 'available') return;
  const until = current.expires_at === null ? null : toIso(current.expires_at);
  throw new ConnectionBrokerError(
    'provider_outage',
    `provider '${provider}' via broker '${broker}' is ${resolved}${
      current.category === null ? '' : ` (${current.category})`
    }${
      until === null
        ? ' until an operator intervenes or a refresh recovers it'
        : ` until ${until} (cooldown)`
    } — checkpoints and domain state are untouched; retry later`,
  );
}

// ---------------------------------------------------------------------------
// Bound-connector synchronization (the W036/W037 gateway integration)
// ---------------------------------------------------------------------------

/**
 * Re-registers the bound gateway connectors through their public contracts
 * with the broker-issued (opaque) credential reference — the re-
 * authorization path of each gateway, and the SAME calls whichever broker
 * backs the connection (broker replacement does not change these domain
 * contracts). The binding re-points to the returned connector id: a grant
 * for a different provider account materializes the connector for THAT
 * account through the gateway's own upsert.
 */
async function syncBoundConnectors(
  ctx: TenantContext,
  connection: BrokerConnection,
  grant: BrokerConnectionGrant,
): Promise<BrokerConnection> {
  const db = getDb();
  let bindSourceId = connection.bindSourceId;
  let bindDestinationId = connection.bindDestinationId;

  if (connection.bindSourceId !== null) {
    try {
      const registration = await registerSource(ctx, {
        provider: connection.provider as SourceProvider,
        providerAccountId: grant.providerAccountId,
        displayName: null,
        authKind: 'oauth',
        credentialRef: grant.credentialRef,
        oauthScopes: grant.scopes,
        oauthExpiresAt: grant.expiresAt,
      });
      bindSourceId = registration.source.id;
    } catch (error) {
      if (error instanceof SourcesError) {
        // Every rejection here contradicts a pre-validated canonical grant —
        // stay loud rather than wrong (the house discipline for sibling-
        // contract rejections).
        throw new Error(
          `the sources contract rejected the broker grant of connection '${connection.id}' (internal invariant violation): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  if (connection.bindDestinationId !== null) {
    try {
      const registration = await registerDestination(ctx, {
        provider: connection.provider as DestinationProvider,
        providerAccountId: grant.providerAccountId,
        displayName: null,
        authKind: 'oauth',
        credentialRef: grant.credentialRef,
        oauthScopes: grant.scopes,
        oauthExpiresAt: grant.expiresAt,
      });
      bindDestinationId = registration.destination.id;
    } catch (error) {
      if (error instanceof DestinationsError) {
        throw new Error(
          `the destinations contract rejected the broker grant of connection '${connection.id}' (internal invariant violation): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  if (bindSourceId === connection.bindSourceId && bindDestinationId === connection.bindDestinationId) {
    return connection;
  }
  const updated = await db.query<ConnectionRow>(
    `UPDATE broker_connections SET bind_source_id = $3, bind_destination_id = $4, updated_at = $5
       WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [ctx.tenantId, connection.id, bindSourceId, bindDestinationId, now()],
  );
  const row = updated.rows[0];
  return row === undefined ? connection : mapConnection(row);
}

/** Wraps one broker interaction failure: localize + rethrow canonically. */
function brokerFailure(
  connection: { id: string; provider: string; broker: string },
  operation: string,
  error: unknown,
): ConnectionBrokerError {
  if (error instanceof BrokerAdapterError) {
    return new ConnectionBrokerError(
      'broker_failure',
      `the ${connection.broker} broker failed to ${operation} for connection '${connection.id}' (provider '${connection.provider}'): ${error.message} — the failure is localized to this (provider, broker) pair and recorded as health evidence`,
      error.failure,
    );
  }
  return new ConnectionBrokerError(
    'broker_failure',
    `the ${connection.broker} broker failed to ${operation} for connection '${connection.id}' (provider '${connection.provider}'): ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

// ---------------------------------------------------------------------------
// initiateConnection — the OAuth hand-off (pending + authorization URL)
// ---------------------------------------------------------------------------

export async function initiateConnection(
  ctx: TenantContext,
  input: InitiateConnectionInput,
): Promise<InitiateConnectionResult> {
  assertBrokerTenantContext(ctx);
  const valid = validateInitiateConnectionInput(input);

  // Bindings are validated through the owning gateways' contracts BEFORE
  // any broker interaction (provider match enforced — a connection
  // authorizes a connector of its own provider). A BOUND connector also
  // demands at least one requested scope: the gateways' oauth discipline
  // requires oauth-authorized connectors to carry granted scopes, and the
  // broker's grant cannot grant what was never requested.
  if ((valid.bindSourceId !== null || valid.bindDestinationId !== null) && valid.scopes.length === 0) {
    throw new ConnectionBrokerError(
      'invalid_input',
      'a connection that binds a source or destination connector must request at least one OAuth scope (the gateways’ oauth-authorized connectors carry granted scopes)',
    );
  }
  if (valid.bindSourceId !== null) {
    try {
      const source = await getSource(ctx, valid.bindSourceId);
      if (source.provider !== valid.provider) {
        throw new ConnectionBrokerError(
          'invalid_input',
          `bindSourceId '${valid.bindSourceId}' serves provider '${source.provider}', not '${valid.provider}'`,
        );
      }
    } catch (error) {
      if (error instanceof SourcesError) {
        throw new ConnectionBrokerError(
          'invalid_input',
          `bindSourceId '${valid.bindSourceId}' does not exist in this tenant: ${error.message}`,
        );
      }
      throw error;
    }
  }
  if (valid.bindDestinationId !== null) {
    try {
      const destination = await getDestination(ctx, valid.bindDestinationId);
      if (destination.provider !== valid.provider) {
        throw new ConnectionBrokerError(
          'invalid_input',
          `bindDestinationId '${valid.bindDestinationId}' serves provider '${destination.provider}', not '${valid.provider}'`,
        );
      }
    } catch (error) {
      if (error instanceof DestinationsError) {
        throw new ConnectionBrokerError(
          'invalid_input',
          `bindDestinationId '${valid.bindDestinationId}' does not exist in this tenant: ${error.message}`,
        );
      }
      throw error;
    }
  }
  if (valid.inventorySystemId !== null) {
    try {
      await getSystem(ctx, { systemId: valid.inventorySystemId });
    } catch (error) {
      if (error instanceof IntegrationError) {
        throw new ConnectionBrokerError(
          'invalid_input',
          `inventorySystemId '${valid.inventorySystemId}' does not exist in this tenant: ${error.message}`,
        );
      }
      throw error;
    }
  }

  const broker = getActiveBroker();
  if (broker === null) {
    throw new ConnectionBrokerError(
      'broker_unavailable',
      'no broker adapter is wired (wire one via wireConnectionBrokers)',
    );
  }

  const db = getDb();
  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM broker_connections
       WHERE tenant_id = $1 AND provider = $2 AND connection_key = $3`,
    [ctx.tenantId, valid.provider, valid.connectionKey],
  );
  const existingRow = existing.rows[0];

  // Re-initiating a pending/failed/revoked connection re-issues the
  // authorization hand-off on the SAME row identity (the re-authorization
  // path); a connected connection must be revoked first.
  if (existingRow !== undefined && existingRow.status === 'connected') {
    throw new ConnectionBrokerError(
      'connection_conflict',
      `connection key '${valid.connectionKey}' for provider '${valid.provider}' is already connected — revoke it before re-authorizing`,
    );
  }

  const connectionId = existingRow?.id ?? newId();

  let session;
  try {
    session = validateBrokerAuthorizationSession(
      await broker.beginAuthorization({
        provider: valid.provider,
        tenantId: ctx.tenantId,
        connectionId,
        connectionKey: valid.connectionKey,
        scopes: valid.scopes,
        redirectTo: valid.redirectTo,
      }),
    );
  } catch (error) {
    if (error instanceof BrokerAdapterError) {
      await observeFailure(ctx.tenantId, valid.provider, broker.key, error.failure, now(), ctx.principalId);
      throw brokerFailure({ id: connectionId, provider: valid.provider, broker: broker.key }, 'begin the authorization', error);
    }
    throw error;
  }

  const at = now();
  if (existingRow !== undefined) {
    const updated = await db.query<ConnectionRow>(
      `UPDATE broker_connections SET
         status = 'pending', broker = $3, display_name = $4, requested_scopes = $5::jsonb,
         authorization_state = $6, authorization_expires_at = $7,
         broker_connection_id = NULL, provider_account_id = NULL, credential_ref = NULL,
         oauth_scopes = '[]'::jsonb, oauth_expires_at = NULL, last_refreshed_at = NULL,
         inventory_system_id = $8, bind_source_id = $9, bind_destination_id = $10,
         revoked_by = NULL, revoked_at = NULL, revocation_note = NULL, updated_at = $11
       WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'failed', 'revoked')
       RETURNING *`,
      [
        ctx.tenantId,
        connectionId,
        broker.key,
        valid.displayName,
        JSON.stringify(valid.scopes),
        session.state,
        new Date(session.expiresAt),
        valid.inventorySystemId,
        valid.bindSourceId,
        valid.bindDestinationId,
        at,
      ],
    );
    if (updated.rows[0] === undefined) {
      throw new ConnectionBrokerError(
        'connection_conflict',
        `connection key '${valid.connectionKey}' for provider '${valid.provider}' changed state concurrently — retry the initiation`,
      );
    }
    await recordEvent(ctx, connectionId, 'connect_initiated', broker.key, `re-issued authorization hand-off`);
    return { connection: mapConnection(updated.rows[0]!), authorization: session };
  }

  try {
    const inserted = await db.query<ConnectionRow>(
      `INSERT INTO broker_connections (
         id, tenant_id, provider, connection_key, display_name, broker, status,
         requested_scopes, authorization_state, authorization_expires_at,
         inventory_system_id, bind_source_id, bind_destination_id, created_by,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $14)
       RETURNING *`,
      [
        connectionId,
        ctx.tenantId,
        valid.provider,
        valid.connectionKey,
        valid.displayName,
        broker.key,
        JSON.stringify(valid.scopes),
        session.state,
        new Date(session.expiresAt),
        valid.inventorySystemId,
        valid.bindSourceId,
        valid.bindDestinationId,
        ctx.principalId,
        at,
      ],
    );
    await recordEvent(ctx, connectionId, 'connect_initiated', broker.key, null);
    return { connection: mapConnection(inserted.rows[0]!), authorization: session };
  } catch (error) {
    if (isDuplicateKeyOn(error, 'broker_connections')) {
      throw new ConnectionBrokerError(
        'connection_conflict',
        `connection key '${valid.connectionKey}' for provider '${valid.provider}' was created concurrently; retry the initiation`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// completeConnection — the OAuth grant lands
// ---------------------------------------------------------------------------

export async function completeConnection(
  ctx: TenantContext,
  input: CompleteConnectionInput,
): Promise<CompleteConnectionResult> {
  assertBrokerTenantContext(ctx);
  const valid = validateCompleteConnectionInput(input);
  const row = await loadConnectionRow(ctx, valid.connectionId);
  if (row.status !== 'pending') {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `connection '${row.id}' is '${row.status}', not 'pending' — only a pending authorization can be completed`,
    );
  }
  if (row.authorization_state !== valid.state) {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `the echoed state token does not match the open authorization of connection '${row.id}'`,
    );
  }
  if (row.authorization_expires_at !== null && Date.parse(toIso(row.authorization_expires_at)) <= now().getTime()) {
    await markFailed(ctx, row, 'the authorization hand-off expired before completion');
    throw new ConnectionBrokerError(
      'connection_authorization_expired',
      `the authorization hand-off of connection '${row.id}' expired at ${toIso(row.authorization_expires_at)} — re-initiate to re-authorize`,
    );
  }

  const broker = requireBrokerByKey(row.broker);
  let grant;
  try {
    grant = validateBrokerConnectionGrant(
      await broker.completeAuthorization({
        provider: row.provider as BrokerProvider,
        connectionId: row.id,
        state: valid.state,
      }),
    );
  } catch (error) {
    if (error instanceof BrokerAdapterError) {
      await observeFailure(ctx.tenantId, row.provider, row.broker, error.failure, now(), ctx.principalId);
      await markFailed(ctx, row, error.failure.detail);
      throw brokerFailure(
        { id: row.id, provider: row.provider, broker: row.broker },
        'complete the authorization',
        error,
      );
    }
    throw error;
  }

  const at = now();
  let updated;
  try {
    updated = await getDb().query<ConnectionRow>(
      `UPDATE broker_connections SET
         status = 'connected', broker_connection_id = $3, provider_account_id = $4,
         credential_ref = $5, oauth_scopes = $6::jsonb, oauth_expires_at = $7,
         last_refreshed_at = $8, authorization_state = NULL, authorization_expires_at = NULL,
         updated_at = $8
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
       RETURNING *`,
      [
        ctx.tenantId,
        row.id,
        grant.brokerConnectionId,
        grant.providerAccountId,
        grant.credentialRef,
        JSON.stringify(grant.scopes),
        grant.expiresAt === null ? null : new Date(grant.expiresAt),
        at,
      ],
    );
  } catch (error) {
    if (isDuplicateKeyOn(error, 'broker_connections')) {
      // The unique (tenant, provider, provider_account_id) guard: another
      // connection already holds this provider account. The condition is
      // permanent for this grant — park the connection 'failed'.
      await markFailed(
        ctx,
        row,
        `another connection already holds the '${row.provider}' account '${grant.providerAccountId}'`,
      );
      throw new ConnectionBrokerError(
        'connection_conflict',
        `another connection already holds the '${row.provider}' account '${grant.providerAccountId}' in this tenant`,
      );
    }
    throw error;
  }
  if (updated.rows[0] === undefined) {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `connection '${row.id}' was completed concurrently — exactly one completion wins`,
    );
  }

  const connection = await syncBoundConnectors(ctx, mapConnection(updated.rows[0]!), grant);
  await recordEvent(
    ctx,
    row.id,
    'connected',
    row.broker,
    `grant expires ${grant.expiresAt ?? 'never'} with ${grant.scopes.length} scope(s)`,
  );
  return { connection };
}

async function markFailed(
  ctx: TenantContext,
  row: ConnectionRow,
  detail: string,
): Promise<void> {
  await getDb().query(
    `UPDATE broker_connections SET status = 'failed', updated_at = $3,
         authorization_state = NULL, authorization_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [ctx.tenantId, row.id, now()],
  );
  await recordEvent(ctx, row.id, 'connect_failed', row.broker, detail);
}

// ---------------------------------------------------------------------------
// refreshConnection — token rotation through the broker
// ---------------------------------------------------------------------------

export async function refreshConnection(
  ctx: TenantContext,
  input: RefreshConnectionInput,
): Promise<RefreshConnectionResult> {
  assertBrokerTenantContext(ctx);
  const valid = validateRefreshConnectionInput(input);
  const row = await loadConnectionRow(ctx, valid.connectionId);
  if (row.status !== 'connected') {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `connection '${row.id}' is '${row.status}', not 'connected' — only a connected grant can be refreshed`,
    );
  }

  const broker = requireBrokerByKey(row.broker);
  // Refresh is deliberately NOT gated by the outage cooldown: it is the
  // healing path (a valid refresh token survives an access-token lapse),
  // and a successful refresh records the recovery.
  let grant;
  try {
    grant = validateBrokerConnectionGrant(
      await broker.refreshGrant({
        provider: row.provider as BrokerProvider,
        connectionId: row.id,
        brokerConnectionId: row.broker_connection_id!,
        credentialRef: row.credential_ref!,
      }),
    );
  } catch (error) {
    if (error instanceof BrokerAdapterError) {
      await observeFailure(ctx.tenantId, row.provider, row.broker, error.failure, now(), ctx.principalId);
      throw brokerFailure(
        { id: row.id, provider: row.provider, broker: row.broker },
        'refresh the grant',
        error,
      );
    }
    throw error;
  }

  const at = now();
  const updated = await getDb().query<ConnectionRow>(
    `UPDATE broker_connections SET
       credential_ref = $3, oauth_scopes = $4::jsonb, oauth_expires_at = $5,
       last_refreshed_at = $6, updated_at = $6
     WHERE tenant_id = $1 AND id = $2 AND status = 'connected'
     RETURNING *`,
    [
      ctx.tenantId,
      row.id,
      grant.credentialRef,
      JSON.stringify(grant.scopes),
      grant.expiresAt === null ? null : new Date(grant.expiresAt),
      at,
    ],
  );
  if (updated.rows[0] === undefined) {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `connection '${row.id}' changed state concurrently — the refresh landed on nothing`,
    );
  }

  const connection = await syncBoundConnectors(ctx, mapConnection(updated.rows[0]!), grant);
  await observeRecoveryIfNeeded(ctx.tenantId, row.provider, row.broker, at, ctx.principalId);
  await recordEvent(
    ctx,
    row.id,
    'refreshed',
    row.broker,
    `grant now expires ${grant.expiresAt ?? 'never'}`,
  );
  return { connection };
}

// ---------------------------------------------------------------------------
// revokeConnection — the grant dies everywhere
// ---------------------------------------------------------------------------

export async function revokeConnection(
  ctx: TenantContext,
  input: RevokeConnectionInput,
): Promise<RevokeConnectionResult> {
  assertBrokerTenantContext(ctx);
  const valid = validateRevokeConnectionInput(input);
  const row = await loadConnectionRow(ctx, valid.connectionId);
  if (row.status === 'revoked') {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `connection '${row.id}' is already revoked`,
    );
  }

  // Broker-side revocation FIRST: only once the credential material is
  // destroyed at the broker does the domain park the connection. A failed
  // broker revocation leaves everything untouched (retry later) — an
  // honest 'revoked' row must mean the grant is really gone.
  if (row.status === 'connected') {
    const broker = requireBrokerByKey(row.broker);
    try {
      await broker.revokeConnection({
        provider: row.provider as BrokerProvider,
        connectionId: row.id,
        brokerConnectionId: row.broker_connection_id!,
      });
    } catch (error) {
      if (error instanceof BrokerAdapterError) {
        await observeFailure(ctx.tenantId, row.provider, row.broker, error.failure, now(), ctx.principalId);
        throw brokerFailure(
          { id: row.id, provider: row.provider, broker: row.broker },
          'revoke the connection',
          error,
        );
      }
      throw error;
    }
  }

  const at = now();
  const updated = await getDb().query<ConnectionRow>(
    `UPDATE broker_connections SET
       status = 'revoked', revoked_by = $3, revoked_at = $4, revocation_note = $5, updated_at = $4
     WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'failed', 'connected')
     RETURNING *`,
    [ctx.tenantId, row.id, ctx.principalId, at, valid.note],
  );
  if (updated.rows[0] === undefined) {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `connection '${row.id}' changed state concurrently — exactly one revocation wins`,
    );
  }
  const connection = mapConnection(updated.rows[0]!);

  // The bound gateway connectors are DISABLED (safe-by-default): the
  // authorization that fed them is gone. Re-enabling is the gateways' own
  // lifecycle decision after a fresh authorization exists.
  if (row.bind_source_id !== null) {
    try {
      await setSourceStatus(ctx, { sourceId: connection.bindSourceId!, status: 'disabled' });
    } catch (error) {
      if (error instanceof SourcesError) {
        throw new Error(
          `the sources contract refused to disable the connector bound to connection '${row.id}' (internal invariant violation): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  if (row.bind_destination_id !== null) {
    try {
      await setDestinationStatus(ctx, {
        destinationId: connection.bindDestinationId!,
        status: 'disabled',
      });
    } catch (error) {
      if (error instanceof DestinationsError) {
        throw new Error(
          `the destinations contract refused to disable the connector bound to connection '${row.id}' (internal invariant violation): ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  await recordEvent(ctx, row.id, 'revoked', row.broker, valid.note);
  return { connection };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getConnection(
  ctx: TenantContext,
  query: { connectionId: string },
): Promise<BrokerConnection> {
  assertBrokerTenantContext(ctx);
  const valid = validateGetConnectionQuery(query);
  return loadConnection(ctx, valid.connectionId);
}

export async function listConnections(
  ctx: TenantContext,
  query: ListConnectionsQuery,
): Promise<BrokerConnection[]> {
  assertBrokerTenantContext(ctx);
  const valid = validateListConnectionsQuery(query);

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
  if (valid.broker !== null) {
    params.push(valid.broker);
    conditions.push(`broker = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<ConnectionRow>(
    `SELECT * FROM broker_connections WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapConnection(row));
}

export async function listConnectionEvents(
  ctx: TenantContext,
  query: ListConnectionEventsQuery,
): Promise<ConnectionEventEntry[]> {
  assertBrokerTenantContext(ctx);
  const valid = validateListConnectionEventsQuery(query);
  await loadConnection(ctx, valid.connectionId);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM broker_connection_events
       WHERE tenant_id = $1 AND connection_id = $2
       ORDER BY recorded_at DESC, id DESC LIMIT $3`,
    [ctx.tenantId, valid.connectionId, valid.limit],
  );
  return rows.rows.map((row) => mapEvent(row));
}

// ---------------------------------------------------------------------------
// Checkpoints (live state + append-only history)
// ---------------------------------------------------------------------------

async function loadCheckpointRow(
  ctx: TenantContext,
  connectionId: string,
  flow: BrokerFlow,
): Promise<CheckpointRow | null> {
  const result = await getDb().query<CheckpointRow>(
    `SELECT * FROM broker_checkpoints WHERE tenant_id = $1 AND connection_id = $2 AND flow = $3`,
    [ctx.tenantId, connectionId, flow],
  );
  return result.rows[0] ?? null;
}

/**
 * Moves one flow's current cursor and records the movement in the
 * append-only history (poll-advance, webhook-advance or replay-rewind
 * origins). Null cursor = the beginning.
 */
async function advanceCheckpoint(
  ctx: TenantContext,
  connectionId: string,
  flow: BrokerFlow,
  cursor: string | null,
  origin: CheckpointOrigin,
): Promise<BrokerCheckpoint> {
  const db = getDb();
  const at = now();
  const checkpoint = await db.transaction(async (tx) => {
    const upserted = await tx.query<CheckpointRow>(
      `INSERT INTO broker_checkpoints (tenant_id, connection_id, flow, cursor, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, connection_id, flow) DO UPDATE SET cursor = $4, updated_at = $5
       RETURNING *`,
      [ctx.tenantId, connectionId, flow, cursor, at],
    );
    await tx.query(
      `INSERT INTO broker_checkpoint_history (
         tenant_id, connection_id, flow, cursor, origin, recorded_by, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.tenantId, connectionId, flow, cursor, origin, ctx.principalId, at],
    );
    return upserted.rows[0]!;
  });
  return mapCheckpoint(checkpoint);
}

export async function getConnectionCheckpoint(
  ctx: TenantContext,
  query: { connectionId: string; flow: BrokerFlow },
): Promise<BrokerCheckpoint | null> {
  assertBrokerTenantContext(ctx);
  const valid = validateGetCheckpointQuery(query);
  // The connection check enforces tenancy before any cursor state is revealed.
  await loadConnection(ctx, valid.connectionId);
  const row = await loadCheckpointRow(ctx, valid.connectionId, valid.flow);
  return row === null ? null : mapCheckpoint(row);
}

export async function listCheckpointHistory(
  ctx: TenantContext,
  query: ListCheckpointHistoryQuery,
): Promise<BrokerCheckpointEntry[]> {
  assertBrokerTenantContext(ctx);
  const valid = validateListCheckpointHistoryQuery(query);
  await loadConnection(ctx, valid.connectionId);
  const conditions: string[] = ['tenant_id = $1', 'connection_id = $2'];
  const params: unknown[] = [ctx.tenantId, valid.connectionId];
  if (valid.flow !== null) {
    params.push(valid.flow);
    conditions.push(`flow = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<CheckpointHistoryRow>(
    `SELECT * FROM broker_checkpoint_history WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapCheckpointEntry(row));
}

export async function replayConnectionCheckpoint(
  ctx: TenantContext,
  input: ReplayCheckpointInput,
): Promise<ReplayCheckpointResult> {
  assertBrokerTenantContext(ctx);
  const valid = validateReplayCheckpointInput(input);
  // Replay is checkpoint surgery, deliberately status-agnostic: a revoked
  // or failed connection may be rewound while parked. Tenancy is enforced
  // by the connection load; the replay target must belong to the same
  // tenant's connection (uniform checkpoint_not_found otherwise).
  const connection = await loadConnection(ctx, valid.connectionId);

  if (valid.fromStart) {
    const checkpoint = await advanceCheckpoint(ctx, connection.id, valid.flow, null, 'replay');
    return { connection, rewoundTo: null, checkpoint };
  }

  const target = await getDb().query<CheckpointHistoryRow>(
    `SELECT * FROM broker_checkpoint_history
       WHERE tenant_id = $1 AND connection_id = $2 AND flow = $3 AND id = $4`,
    [ctx.tenantId, connection.id, valid.flow, valid.checkpointId],
  );
  const entry = target.rows[0];
  if (entry === undefined) {
    throw new ConnectionBrokerError(
      'checkpoint_not_found',
      `checkpoint '${valid.checkpointId}' does not exist for this connection's '${valid.flow}' flow in this tenant`,
    );
  }
  const checkpoint = await advanceCheckpoint(ctx, connection.id, valid.flow, entry.cursor, 'replay');
  return { connection, rewoundTo: mapCheckpointEntry(entry), checkpoint };
}

// ---------------------------------------------------------------------------
// The delivery ledger (dedupe authority — one claim per provider record)
// ---------------------------------------------------------------------------

async function claimRecords(
  ctx: TenantContext,
  connectionId: string,
  records: BrokerRecord[],
  via: 'sync' | 'webhook',
): Promise<{ ingested: number; duplicates: number }> {
  if (records.length === 0) return { ingested: 0, duplicates: 0 };
  const db = getDb();
  const at = now();
  const params: unknown[] = [ctx.tenantId, connectionId, at, via];
  const tuples = records.map((record, index) => `($1, $2, $${5 + index}, $4, $3)`);
  for (const record of records) params.push(record.providerRecordId);
  const claimed = await db.query<{ provider_record_id: string }>(
    `INSERT INTO broker_records (
       tenant_id, connection_id, provider_record_id, ingested_via, claimed_at
     ) VALUES ${tuples.join(', ')}
     ON CONFLICT (tenant_id, connection_id, provider_record_id) DO NOTHING
     RETURNING provider_record_id`,
    params,
  );
  const ingested = claimed.rows.length;
  return { ingested, duplicates: records.length - ingested };
}

// ---------------------------------------------------------------------------
// runConnectionSync — the checkpointed sync pull
// ---------------------------------------------------------------------------

export async function runConnectionSync(
  ctx: TenantContext,
  input: RunSyncInput,
): Promise<SyncResult> {
  assertBrokerTenantContext(ctx);
  const valid = validateRunSyncInput(input);
  const row = await loadConnectionRow(ctx, valid.connectionId);
  if (row.status !== 'connected') {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `connection '${row.id}' is '${row.status}', not 'connected' — only a connected connection can sync`,
    );
  }
  const broker = requireBrokerByKey(row.broker);
  const at = now();
  // The cooldown gate: never hammer a provider that is still cooling down.
  await assertNotCoolingDown(ctx.tenantId, row.provider, row.broker, at);

  const checkpointRow = await loadCheckpointRow(ctx, row.id, 'sync');
  const cursor = checkpointRow?.cursor ?? null;

  let result: BrokerSyncResult;
  try {
    result = validateBrokerSyncResult(
      await broker.pullSyncRecords({
        provider: row.provider as BrokerProvider,
        tenantId: ctx.tenantId,
        connectionId: row.id,
        brokerConnectionId: row.broker_connection_id!,
        credentialRef: row.credential_ref!,
        cursor,
        maxRecords: valid.maxRecords,
      }),
    );
  } catch (error) {
    if (error instanceof BrokerAdapterError) {
      await observeFailure(ctx.tenantId, row.provider, row.broker, error.failure, at, ctx.principalId);
      throw brokerFailure(
        { id: row.id, provider: row.provider, broker: row.broker },
        'pull the sync window',
        error,
      );
    }
    throw error;
  }

  // Claim FIRST, checkpoint SECOND: a crash between the two re-pulls the
  // same window on the next sync and the ledger dedupes (at-least-once
  // delivery, exactly-once claim per record).
  const claim = await claimRecords(ctx, row.id, result.records, 'sync');

  let checkpoint: BrokerCheckpoint | null =
    checkpointRow === null ? null : mapCheckpoint(checkpointRow);
  if (syncCursorAdvance(cursor, result.nextCursor)) {
    checkpoint = await advanceCheckpoint(ctx, row.id, 'sync', result.nextCursor, 'sync');
  }

  await observeRecoveryIfNeeded(ctx.tenantId, row.provider, row.broker, now(), ctx.principalId);
  return {
    connection: mapConnection(row),
    fetched: result.records.length,
    ingested: claim.ingested,
    duplicates: claim.duplicates,
    checkpoint,
    hasMore: result.hasMore,
  };
}

// ---------------------------------------------------------------------------
// receiveBrokerWebhook — the checkpointed webhook path
// ---------------------------------------------------------------------------

export async function receiveBrokerWebhook(
  ctx: TenantContext,
  input: ReceiveWebhookInput,
): Promise<WebhookResult> {
  assertBrokerTenantContext(ctx);
  const valid = validateReceiveWebhookInput(input);
  const broker =
    valid.broker === null ? getActiveBroker() : brokerByKey(valid.broker);
  if (broker === null) {
    throw new ConnectionBrokerError(
      valid.broker === null ? 'broker_unavailable' : 'unsupported_broker',
      valid.broker === null
        ? 'no broker adapter is wired (wire one via wireConnectionBrokers)'
        : `no '${valid.broker}' broker adapter is wired`,
    );
  }

  // The broker-native envelope is parsed by the broker's PRIVATE adapter
  // and never advances past this line. Parse failures are payload-shaped
  // errors (not outages): no health event, just an honest refusal.
  let parsed: BrokerWebhookParseResult;
  try {
    parsed = validateBrokerWebhookParseResult(broker.parseWebhook(valid.payload));
  } catch (error) {
    if (error instanceof BrokerAdapterError) {
      throw new ConnectionBrokerError(
        'invalid_webhook_payload',
        `the ${broker.key} webhook envelope could not be parsed: ${error.message}`,
        error.failure,
      );
    }
    throw error;
  }

  // The envelope's broker connection resolves onto THIS tenant's
  // connection — a foreign tenant's connection is indistinguishable from
  // an unknown one (ADR-0001, no existence leak).
  const row = await loadConnectionRowByBrokerId(ctx, broker.key, parsed.brokerConnectionId);
  if (row.status !== 'connected') {
    throw new ConnectionBrokerError(
      'connection_invalid_state',
      `connection '${row.id}' is '${row.status}', not 'connected' — webhook deliveries need a live grant`,
    );
  }

  // Webhook processing performs no provider interaction (the records are
  // already delivered), so the outage cooldown does not gate it; the
  // ledger and the watermark keep the exactly-once claim discipline.
  const claim = await claimRecords(ctx, row.id, parsed.records, 'webhook');

  const checkpointRow = await loadCheckpointRow(ctx, row.id, 'webhook');
  let checkpoint: BrokerCheckpoint | null =
    checkpointRow === null ? null : mapCheckpoint(checkpointRow);
  if (webhookCursorAdvance(checkpointRow?.cursor ?? null, parsed.occurredAt)) {
    checkpoint = await advanceCheckpoint(ctx, row.id, 'webhook', parsed.occurredAt, 'webhook');
  }

  return {
    connection: mapConnection(row),
    fetched: parsed.records.length,
    ingested: claim.ingested,
    duplicates: claim.duplicates,
    checkpoint,
  };
}

// ---------------------------------------------------------------------------
// Provider health reads + operator override
// ---------------------------------------------------------------------------

export async function getProviderHealth(
  ctx: TenantContext,
  query: { provider: BrokerProvider; broker?: string },
): Promise<ProviderHealthStatus | null> {
  assertBrokerTenantContext(ctx);
  const valid = validateGetProviderHealthQuery(query);
  const at = now();
  if (valid.broker !== null) {
    const row = await currentHealthEvent(ctx.tenantId, valid.provider, valid.broker);
    return row === null ? null : mapHealth(row, at);
  }
  // No broker pinned: the most recently observed pair for the provider
  // decides (its broker rides along in the result).
  const rows = await getDb().query<HealthEventRow>(
    `SELECT * FROM broker_provider_health_events
       WHERE tenant_id = $1 AND provider = $2
       ORDER BY seq DESC LIMIT 1`,
    [ctx.tenantId, valid.provider],
  );
  const row = rows.rows[0];
  return row === undefined ? null : mapHealth(row, at);
}

export async function listProviderHealth(
  ctx: TenantContext,
  query: ListProviderHealthQuery,
): Promise<ProviderHealthStatus[]> {
  assertBrokerTenantContext(ctx);
  const valid = validateListProviderHealthQuery(query);
  const at = now();
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<HealthEventRow>(
    `SELECT DISTINCT ON (provider, broker) * FROM broker_provider_health_events
       WHERE ${conditions.join(' AND ')}
       ORDER BY provider, broker, seq DESC LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapHealth(row, at));
}

export async function setProviderHealth(
  ctx: TenantContext,
  input: SetProviderHealthInput,
): Promise<ProviderHealthStatus> {
  assertBrokerTenantContext(ctx);
  if (!ctx.authority.includes(BROKER_AUTHORITY_ADMINISTER)) {
    throw new ConnectionBrokerError(
      'invalid_context',
      `setProviderHealth requires the '${BROKER_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateSetProviderHealthInput(input);
  const at = now();
  await getDb().query(
    `INSERT INTO broker_provider_health_events (
       tenant_id, provider, broker, state, category, reason, source,
       expires_at, observed_at, observed_by
     ) VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7, $8, $9)`,
    [
      ctx.tenantId,
      valid.provider,
      valid.broker,
      valid.health,
      valid.category,
      valid.reason,
      valid.expiresAt === null ? null : new Date(valid.expiresAt),
      at,
      ctx.principalId,
    ],
  );
  return {
    provider: valid.provider,
    broker: valid.broker,
    health: valid.health,
    category: valid.category,
    reason: valid.reason,
    expiresAt: valid.expiresAt,
    observedAt: at.toISOString(),
    observedBy: ctx.principalId,
  };
}

// ---------------------------------------------------------------------------
// verifyBrokerHotSwap — GOVERNANCE provider-swap evidence
// ---------------------------------------------------------------------------

interface SwapTarget {
  readonly broker: string;
  readonly connectionId: string;
  readonly completed: boolean;
  readonly resultDigest: string | null;
}

export async function verifyBrokerHotSwap(
  ctx: TenantContext,
  input: VerifyBrokerHotSwapInput,
): Promise<VerifyBrokerHotSwapResult> {
  assertBrokerTenantContext(ctx);
  const valid = validateVerifyBrokerHotSwapInput(input);
  const rowA = await loadConnectionRow(ctx, valid.connectionIdA);
  const rowB = await loadConnectionRow(ctx, valid.connectionIdB);
  for (const row of [rowA, rowB]) {
    if (row.status !== 'connected') {
      throw new ConnectionBrokerError(
        'connection_invalid_state',
        `connection '${row.id}' is '${row.status}', not 'connected' — a swap target must be live`,
      );
    }
  }
  if (rowA.provider !== rowB.provider) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `the two swap targets must serve the same provider ('${rowA.provider}' vs '${rowB.provider}')`,
    );
  }
  if (rowA.broker === rowB.broker) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `the two swap targets must be backed by different brokers (both are '${rowA.broker}')`,
    );
  }

  const at = now();
  const canonicalRequest = {
    capability: HOT_SWAP_CAPABILITY,
    provider: rowA.provider,
    cursor: null,
    maxRecords: HOT_SWAP_MAX_RECORDS,
  };
  const requestDigest = canonicalRequestDigest(canonicalRequest);

  const runTarget = async (row: ConnectionRow): Promise<SwapTarget> => {
    const broker = requireBrokerByKey(row.broker);
    try {
      const result = validateBrokerSyncResult(
        await broker.pullSyncRecords({
          provider: row.provider as BrokerProvider,
          tenantId: ctx.tenantId,
          connectionId: row.id,
          brokerConnectionId: row.broker_connection_id!,
          credentialRef: row.credential_ref!,
          cursor: null,
          maxRecords: HOT_SWAP_MAX_RECORDS,
        }),
      );
      await observeRecoveryIfNeeded(ctx.tenantId, row.provider, row.broker, at, ctx.principalId);
      return {
        broker: row.broker,
        connectionId: row.id,
        completed: true,
        resultDigest: canonicalRequestDigest({
          records: result.records.map((record) => ({
            providerRecordId: record.providerRecordId,
            kind: record.kind,
            payload: record.payload,
            occurredAt: record.occurredAt,
          })),
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        }),
      };
    } catch (error) {
      if (error instanceof BrokerAdapterError) {
        await observeFailure(ctx.tenantId, row.provider, row.broker, error.failure, at, ctx.principalId);
        return { broker: row.broker, connectionId: row.id, completed: false, resultDigest: null };
      }
      throw error;
    }
  };

  const targetA = await runTarget(rowA);
  const targetB = await runTarget(rowB);

  const outcome =
    !targetA.completed || !targetB.completed
      ? 'failed'
      : targetA.resultDigest === targetB.resultDigest
        ? 'equivalent'
        : 'completed-divergent';

  const verificationId = newId();
  await getDb().query(
    `INSERT INTO broker_hot_swap_verifications (
       id, tenant_id, capability, request_digest, provider,
       broker_a, connection_a, result_a, broker_b, connection_b, result_b,
       outcome, note, requested_by, verified_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      verificationId,
      ctx.tenantId,
      HOT_SWAP_CAPABILITY,
      requestDigest,
      rowA.provider,
      targetA.broker,
      targetA.connectionId,
      targetA.resultDigest ?? 'failed',
      targetB.broker,
      targetB.connectionId,
      targetB.resultDigest ?? 'failed',
      outcome,
      valid.note,
      ctx.principalId,
      at,
    ],
  );

  const verification: BrokerHotSwapVerification = {
    id: verificationId,
    tenantId: ctx.tenantId,
    capability: HOT_SWAP_CAPABILITY,
    requestDigest,
    provider: rowA.provider as BrokerProvider,
    brokerA: targetA.broker,
    connectionAId: targetA.connectionId,
    resultA: targetA.resultDigest ?? 'failed',
    brokerB: targetB.broker,
    connectionBId: targetB.connectionId,
    resultB: targetB.resultDigest ?? 'failed',
    outcome,
    note: valid.note,
    requestedBy: ctx.principalId,
    verifiedAt: at.toISOString(),
  };

  // The canonical, gateway-agnostic evidence record (W089 SDK format).
  const evidence: HotSwapEvidenceRecord = buildHotSwapEvidence({
    gateway: 'connection-broker',
    capability: HOT_SWAP_CAPABILITY,
    providerA: {
      provider: targetA.broker,
      target: rowA.provider,
      resultKind: targetA.completed ? 'completed' : 'failed',
    },
    providerB: {
      provider: targetB.broker,
      target: rowB.provider,
      resultKind: targetB.completed ? 'completed' : 'failed',
    },
    outcome,
    evidenceId: verificationId,
    executedAt: at.toISOString(),
    requestDigest,
    note:
      valid.note ??
      `W082 two-broker proof: the same canonical connection-sync request through '${targetA.broker}' and '${targetB.broker}'`,
  });

  return { verification, evidence };
}

export async function listHotSwapVerifications(
  ctx: TenantContext,
  query: ListHotSwapVerificationsQuery,
): Promise<BrokerHotSwapVerification[]> {
  assertBrokerTenantContext(ctx);
  const valid = validateListHotSwapVerificationsQuery(query);
  const rows = await getDb().query<HotSwapRow>(
    `SELECT * FROM broker_hot_swap_verifications
       WHERE tenant_id = $1 ORDER BY verified_at DESC, id DESC LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  return rows.rows.map((row) => mapHotSwap(row));
}

// ---------------------------------------------------------------------------
// The sources-gateway composition bridge (broker-backed source transport)
// ---------------------------------------------------------------------------

/**
 * A sources-gateway `SourceTransport` whose fetches route through the
 * broker connection bound to the polled source (W036's own polling path —
 * records become observations through the sources module's contract; no
 * provider shape or credential value crosses this bridge).
 *
 * The bridge is deliberately STATELESS for this module: the source's own
 * checkpoint (passed in `request.cursor`) is the broker pull cursor, and
 * the returned `nextCursor` is whatever the broker handed back — the
 * sources module advances ITS checkpoint exactly per its own
 * ingest-then-checkpoint discipline. Outages observed here are localized
 * and recorded exactly like every other broker interaction.
 */
export function createBrokerSourceTransport(): SourceTransport {
  return {
    async fetch(request: SourceFetchRequest): Promise<SourceFetchResult> {
      const row = await loadConnectionByBoundSource(request.tenantId, request.sourceId);
      if (row.status !== 'connected') {
        throw new ConnectionBrokerError(
          'connection_invalid_state',
          `the broker connection bound to source '${request.sourceId}' is '${row.status}', not 'connected'`,
        );
      }
      const broker = requireBrokerByKey(row.broker);
      const at = now();
      await assertNotCoolingDown(request.tenantId, row.provider, row.broker, at);

      let result: BrokerSyncResult;
      try {
        result = validateBrokerSyncResult(
          await broker.pullSyncRecords({
            provider: row.provider as BrokerProvider,
            tenantId: request.tenantId,
            connectionId: row.id,
            brokerConnectionId: row.broker_connection_id!,
            credentialRef: row.credential_ref!,
            cursor: request.cursor,
            maxRecords: request.maxRecords,
          }),
        );
      } catch (error) {
        if (error instanceof BrokerAdapterError) {
          await observeFailure(
            request.tenantId,
            row.provider,
            row.broker,
            error.failure,
            at,
            SOURCE_TRANSPORT_OBSERVER,
          );
        }
        throw error;
      }
      await observeRecoveryIfNeeded(
        request.tenantId,
        row.provider,
        row.broker,
        now(),
        SOURCE_TRANSPORT_OBSERVER,
      );
      return {
        records: result.records.map((record) => ({
          providerRecordId: record.providerRecordId,
          kind: record.kind,
          payload: record.payload,
          occurredAt: record.occurredAt,
        })),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The sources-gateway composition bridge (broker-backed source transport)
// ---------------------------------------------------------------------------
