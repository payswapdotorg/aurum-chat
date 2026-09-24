// Public domain types of the connection-broker module (W082 — Universal
// Connection Broker).
//
// W082 owns the universal CONNECTION layer: "Integrate OAuth, tokens, syncs
// and webhooks through provider-neutral adapters. Support a pluggable
// managed connection broker with Nango as the first candidate and
// equivalent alternatives." Acceptance: connect/revoke/refresh; webhook/
// sync checkpoints; provider outages are localized; credential values never
// enter domain state; broker replacement does not change domain contracts.
//
// Everything here is provider-neutral AND broker-neutral BY CONSTRUCTION
// (lock 16 + the W089 provider-isolation discipline):
//   * upstream PROVIDERS appear only as the canonical `BrokerProvider` key
//     (the union of the sources and destinations gateways' provider
//     vocabularies — this module's connections serve either side);
//   * managed BROKERS appear only as the canonical `broker` string key on
//     persisted state (pluggable adapter identity, deliberately NOT a
//     closed SQL enum — "equivalent alternatives" is the acceptance);
//   * the only broker/provider-minted values that cross this surface are
//     OPAQUE strings (broker connection ids, provider account ids, cursors,
//     state tokens, delivery ids).
//
// CREDENTIAL ISOLATION (GOVERNANCE mandatory invariant; IMPLEMENTATION-
// STACK §8; the W082 acceptance "credential values never enter domain
// state"): OAuth token values, refresh tokens, API keys and broker secret
// keys NEVER cross the broker port or this contract. The managed broker
// holds the credential material; the domain tracks only the OPAQUE
// `credentialRef` plus NON-SECRET authorization state (granted scopes,
// grant expiry). Broker instance secrets (e.g. a Nango secret key) are
// wiring-time adapter configuration and never reach a domain table, a log
// line or a contract result.
//
// CHECKPOINTS mirror the sources module's deliberate model (W036
// precedent), one per flow: the current `broker_checkpoints` row is the
// live resume point, `broker_checkpoint_history` is the append-only audit
// and the legal rewind target set, and the `broker_records` ledger is the
// dedupe authority — one row per (tenant, connection, provider record id),
// ever — so sync re-pulls, webhook redeliveries and checkpoint replays are
// all suppressed against it (at-least-once delivery, exactly-once
// processing per record).

import type { DestinationProvider } from '@/modules/destinations/contract';
import type { SourceProvider } from '@/modules/sources/contract';
import type {
  CanonicalErrorCategory,
  HotSwapEvidenceRecord,
  ProviderAdapterDefinition,
} from '@/modules/provider-sdk/contract';

// ---------------------------------------------------------------------------
// Providers, brokers, statuses, flows
// ---------------------------------------------------------------------------

/**
 * The canonical upstream-provider vocabulary this module brokers
 * connections for: the union of the sources gateway's inbound providers
 * (W036) and the destinations gateway's outbound providers (W037) — a
 * broker connection may bind a connector on either side. Derived from the
 * two gateways' public vocabularies (no drift possible); mirrored by the
 * provider CHECK in migrations/001.
 */
export type BrokerProvider = SourceProvider | DestinationProvider;

/**
 * The managed-broker vocabulary of FIRST-PARTY adapters shipped in this
 * module's `adapters/` folder. The persisted `broker` column is an OPEN
 * vocabulary (shape-checked only): wiring a third-party equivalent broker
 * adapter is exactly the pluggability the work item demands, so new broker
 * keys require no migration — only a conforming adapter (W089 SDK).
 */
export type FirstPartyBrokerKey = 'nango' | 'embedded';

/** Lifecycle of one broker connection (forward-only; see migrations/001). */
export type ConnectionStatus = 'pending' | 'connected' | 'revoked' | 'failed';

/** The two checkpointed flows a connected connection carries. */
export type BrokerFlow = 'sync' | 'webhook';

/** What recorded one checkpoint history entry. */
export type CheckpointOrigin = 'sync' | 'webhook' | 'replay';

/** Routing-facing health of one (provider, broker) pair (llm precedent). */
export type ProviderHealth = 'available' | 'degraded' | 'unavailable';

/** Whether a health event was observed by execution or forced by an operator. */
export type HealthEventSource = 'execution' | 'manual';

// ---------------------------------------------------------------------------
// Broker connections (the universal connection record)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped universal connection: one OAuth authorization a tenant
 * holds against an upstream provider, managed end-to-end by ONE broker
 * adapter (the `broker` key). The connection carries the connect/revoke/
 * refresh lifecycle, the opaque broker-side identity and the checkpointed
 * sync/webhook flows.
 *
 * `credentialRef` is an OPAQUE reference into the backing broker's
 * credential store — never a credential value. `brokerConnectionId` and
 * `providerAccountId` are opaque broker/provider-minted strings.
 * `oauthScopes`/`oauthExpiresAt` are non-secret authorization state.
 *
 * Bindings (all opaque soft references, validated through the owning
 * module's public contract at initiation):
 *   * `bindSourceId`      — the sources-gateway connector (W036) this
 *                           connection authorizes; re-registered through
 *                           the sources contract on connect and refresh,
 *                           disabled on revoke;
 *   * `bindDestinationId` — the destinations-gateway connector (W037)
 *                           this connection authorizes (same discipline);
 *   * `inventorySystemId` — the Tool & System Inventory entry (W081) this
 *                           connection realizes (provenance only).
 */
export interface BrokerConnection {
  id: string;
  tenantId: string;
  provider: BrokerProvider;
  /** Caller-chosen canonical connection key (unique per tenant+provider). */
  connectionKey: string;
  displayName: string | null;
  /** The broker adapter backing this connection (pluggable identity). */
  broker: string;
  /** Opaque broker-side connection id (null while pending). */
  brokerConnectionId: string | null;
  /** Opaque provider-side account id (null while pending). */
  providerAccountId: string | null;
  /** Opaque broker credential-store reference (null while pending). */
  credentialRef: string | null;
  /** The scopes the initiation requested (broker/provider may grant less). */
  requestedScopes: string[];
  /** The scopes the broker reported as actually granted. */
  oauthScopes: string[];
  /** When the OAuth grant lapses (null = non-expiring). */
  oauthExpiresAt: string | null;
  status: ConnectionStatus;
  /** Opaque one-time broker authorization state (pending connections only). */
  authorizationState: string | null;
  /** When the pending authorization hand-off lapses (pending only). */
  authorizationExpiresAt: string | null;
  inventorySystemId: string | null;
  bindSourceId: string | null;
  bindDestinationId: string | null;
  /** ISO 8601 — last successful grant refresh (connected only). */
  lastRefreshedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revocationNote: string | null;
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on lifecycle/authorization changes only. */
  updatedAt: string;
}

export interface InitiateConnectionInput {
  provider: BrokerProvider;
  /** Canonical connection key (unique per tenant+provider). */
  connectionKey: string;
  displayName?: string | null;
  /** OAuth scopes to request (empty = the provider's default grant). */
  scopes?: string[];
  /** Post-authorization redirect target handed to the broker (opaque). */
  redirectTo?: string | null;
  /** Tool & System Inventory entry this connection realizes (W081; optional). */
  inventorySystemId?: string | null;
  /** Existing sources-gateway connector this connection authorizes (W036). */
  bindSourceId?: string | null;
  /** Existing destinations-gateway connector this connection authorizes (W037). */
  bindDestinationId?: string | null;
}

/** The authorization hand-off a pending connection hands the tenant's user. */
export interface AuthorizationHandoff {
  /** Where the tenant's user completes the OAuth grant (broker-minted). */
  authorizationUrl: string;
  /** Opaque one-time state token the callback must echo. */
  state: string;
  /** ISO 8601 — when the hand-off lapses. */
  expiresAt: string;
}

export interface InitiateConnectionResult {
  connection: BrokerConnection;
  authorization: AuthorizationHandoff;
}

export interface CompleteConnectionInput {
  connectionId: string;
  /** The state token the broker's callback echoed back. */
  state: string;
}

export interface CompleteConnectionResult {
  connection: BrokerConnection;
}

export interface RefreshConnectionInput {
  connectionId: string;
}

export interface RefreshConnectionResult {
  connection: BrokerConnection;
}

export interface RevokeConnectionInput {
  connectionId: string;
  /** Operator note recorded with the revocation trail. */
  note?: string | null;
}

export interface RevokeConnectionResult {
  connection: BrokerConnection;
}

export interface GetConnectionQuery {
  connectionId: string;
}

export interface ListConnectionsQuery {
  provider?: BrokerProvider;
  status?: ConnectionStatus;
  broker?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** One append-only lifecycle/audit event of a connection. */
export interface ConnectionEventEntry {
  id: string;
  connectionId: string;
  event: ConnectionEventType;
  broker: string;
  detail: string | null;
  recordedBy: string;
  /** ISO 8601 — service clock. */
  recordedAt: string;
}

export type ConnectionEventType =
  | 'connect_initiated'
  | 'connected'
  | 'connect_failed'
  | 'refreshed'
  | 'revoked';

export interface ListConnectionEventsQuery {
  connectionId: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Sync and webhook flows (checkpointed, deduped)
// ---------------------------------------------------------------------------

export interface RunSyncInput {
  connectionId: string;
  /** 1..200, default 50. */
  maxRecords?: number;
}

/**
 * Result of `runConnectionSync` — the checkpointed sync pull. Record
 * PAYLOADS deliberately do not cross this contract: the managed broker
 * holds the synced data (its normalized store), while this module records
 * the delivery ledger claims, advances the checkpoint and reports the
 * counts (the sources-gateway composition bridge turns pulls into
 * observations through W036's own contract when a source is bound).
 */
export interface SyncResult {
  connection: BrokerConnection;
  /** Records the broker returned for this window. */
  fetched: number;
  /** Records newly claimed on the delivery ledger. */
  ingested: number;
  /** Records suppressed by the ledger (already claimed). */
  duplicates: number;
  /** Current sync checkpoint after the pull (null when none was ever recorded). */
  checkpoint: BrokerCheckpoint | null;
  /** Whether the broker reports more data past this window. */
  hasMore: boolean;
}

/** Input of `receiveBrokerWebhook` — the broker-native webhook edge. */
export interface ReceiveWebhookInput {
  /**
   * The broker key whose adapter parses the envelope (default: the active
   * broker). `payload` is the raw broker-native JSON envelope exactly as
   * the broker delivered it; it is parsed by that broker's PRIVATE adapter
   * and never crosses back out.
   */
  broker?: string;
  payload: unknown;
}

export interface WebhookResult {
  connection: BrokerConnection;
  /** Records the broker's webhook delivered. */
  fetched: number;
  /** Records newly claimed on the delivery ledger. */
  ingested: number;
  /** Records suppressed by the ledger (already claimed). */
  duplicates: number;
  /** Current webhook-flow checkpoint after the delivery. */
  checkpoint: BrokerCheckpoint | null;
}

// ---------------------------------------------------------------------------
// Checkpoints (live state + append-only history)
// ---------------------------------------------------------------------------

/**
 * The current checkpoint of one flow of a connection: the OPAQUE cursor
 * the next sync resumes from, or — for the webhook flow — the opaque
 * watermark of the last processed delivery. Null cursor = the beginning.
 */
export interface BrokerCheckpoint {
  connectionId: string;
  flow: BrokerFlow;
  cursor: string | null;
  /** ISO 8601 — when the cursor last moved. */
  updatedAt: string;
}

/** One append-only checkpoint history entry — a legal replay target. */
export interface BrokerCheckpointEntry {
  id: string;
  connectionId: string;
  flow: BrokerFlow;
  cursor: string | null;
  origin: CheckpointOrigin;
  recordedBy: string;
  /** ISO 8601 — service clock. */
  recordedAt: string;
}

export interface GetCheckpointQuery {
  connectionId: string;
  flow: BrokerFlow;
}

export interface ListCheckpointHistoryQuery {
  connectionId: string;
  flow?: BrokerFlow;
  /** 1..500, default 50. */
  limit?: number;
}

export interface ReplayCheckpointInput {
  connectionId: string;
  flow: BrokerFlow;
  /** Rewind to this recorded history entry. */
  checkpointId?: string | null;
  /** Or rewind to the beginning of the flow. */
  fromStart?: boolean;
}

export interface ReplayCheckpointResult {
  connection: BrokerConnection;
  /** The history entry the checkpoint was rewound to (null for fromStart). */
  rewoundTo: BrokerCheckpointEntry | null;
  checkpoint: BrokerCheckpoint;
}

// ---------------------------------------------------------------------------
// Provider health (outage localization — observed, append-only)
// ---------------------------------------------------------------------------

/** Current resolved health of one (provider, broker) pair. */
export interface ProviderHealthStatus {
  provider: BrokerProvider;
  broker: string;
  health: ProviderHealth;
  /** The canonical category of the last observed failure (null when available). */
  category: CanonicalErrorCategory | null;
  reason: string | null;
  /** ISO 8601 cooldown horizon while unhealthy (null = indefinite). */
  expiresAt: string | null;
  /** ISO 8601 — when the current state was observed. */
  observedAt: string;
  observedBy: string;
}

export interface GetProviderHealthQuery {
  provider: BrokerProvider;
  broker?: string;
}

export interface ListProviderHealthQuery {
  provider?: BrokerProvider;
  /** 1..500, default 50. */
  limit?: number;
}

export interface SetProviderHealthInput {
  provider: BrokerProvider;
  broker: string;
  health: ProviderHealth;
  /** Canonical failure category (required for non-available states). */
  category?: CanonicalErrorCategory | null;
  reason?: string | null;
  /** Cooldown horizon for unhealthy states (null = indefinite). */
  expiresAt?: string | null;
}

// ---------------------------------------------------------------------------
// Broker hot-swap verification (GOVERNANCE provider-swap evidence)
// ---------------------------------------------------------------------------

/**
 * One recorded broker hot-swap verification: the SAME canonical sync
 * request executed through two connections backed by DIFFERENT brokers,
 * with no domain-contract change (the W082 acceptance "broker replacement
 * does not change domain contracts"; the llm module's W034/W048 precedent
 * reshaped onto the connection gateway).
 *
 * `requestDigest` proves both brokers executed a byte-identical canonical
 * request; `outcome` is the deterministic STRUCTURAL comparison of the two
 * normalized results — semantic judgment stays with the caller.
 */
export interface BrokerHotSwapVerification {
  id: string;
  tenantId: string;
  /** The canonical capability the swap exercised ('connection-sync'). */
  capability: string;
  /** SHA-256 hex digest of the canonical request both brokers executed. */
  requestDigest: string;
  /** The upstream provider both connections serve. */
  provider: BrokerProvider;
  brokerA: string;
  connectionAId: string;
  /** Structural summary of target A's normalized result. */
  resultA: string;
  brokerB: string;
  connectionBId: string;
  /** Structural summary of target B's normalized result. */
  resultB: string;
  outcome: 'equivalent' | 'completed-divergent' | 'failed';
  note: string | null;
  requestedBy: string;
  /** ISO 8601 — service clock. */
  verifiedAt: string;
}

export interface VerifyBrokerHotSwapInput {
  /** The connection served by broker A (must be connected). */
  connectionIdA: string;
  /** The connection served by broker B (must be connected, different broker). */
  connectionIdB: string;
  note?: string | null;
}

export interface VerifyBrokerHotSwapResult {
  verification: BrokerHotSwapVerification;
  /**
   * The canonical, gateway-agnostic evidence record (W089 SDK format) —
   * the same swap expressed in the ecosystem-wide provider-swap shape.
   */
  evidence: HotSwapEvidenceRecord;
}

export interface ListHotSwapVerificationsQuery {
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Broker wiring (infrastructure, not domain state)
// ---------------------------------------------------------------------------

/** Read-only introspection of one wired broker adapter. */
export interface WiredBrokerInfo {
  /** The broker adapter's canonical key. */
  key: string;
  /** The canonical capabilities the adapter declares (W089 SDK). */
  capabilities: string[];
}

// ---------------------------------------------------------------------------
// The broker port (provider-neutral AND broker-neutral; implementations
// live inside this module's adapters/ folder — IMPLEMENTATION-STACK §6)
// ---------------------------------------------------------------------------

/**
 * One canonical record the broker's sync/webhook path delivers: the
 * provider-neutral unit of broker-side data movement (the exact shape of
 * the sources module's `CanonicalSourceRecord`, so the composition bridge
 * `createBrokerSourceTransport` can hand records to W036 unchanged).
 * `providerRecordId` is the provider's stable record/event id — the dedupe
 * key on the delivery ledger. Payloads are plain JSON and NEVER persisted
 * by this module (they stay in the broker's normalized store).
 */
export interface BrokerRecord {
  providerRecordId: string;
  kind: string;
  payload: unknown;
  occurredAt: string;
}

/** The authorization hand-off a broker's `beginAuthorization` returns. */
export interface BrokerAuthorizationSession {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}

/** The grant a broker issues on authorization completion / refresh. */
export interface BrokerConnectionGrant {
  /** Opaque broker-side connection id. */
  brokerConnectionId: string;
  /** Opaque provider-side account id. */
  providerAccountId: string;
  /** OPAQUE broker credential-store reference — never a credential value. */
  credentialRef: string;
  /** The scopes the broker reports as granted. */
  scopes: string[];
  /** When the OAuth grant lapses (null = non-expiring). */
  expiresAt: string | null;
}

/** The provider-neutral outcome of one broker sync pull. */
export interface BrokerSyncResult {
  records: BrokerRecord[];
  /** Null = the broker has no further data (an exhausted window). */
  nextCursor: string | null;
  hasMore: boolean;
}

/** What a broker's webhook adapter produces from one broker-native envelope. */
export interface BrokerWebhookParseResult {
  /** The broker-side connection the envelope belongs to (opaque). */
  brokerConnectionId: string;
  /** The broker's own delivery id, when it carries one (opaque). */
  deliveryId: string | null;
  /** When the broker delivered the envelope (strict ISO 8601). */
  occurredAt: string;
  records: BrokerRecord[];
}

// --- broker operation requests (provider-neutral) ---------------------------

export interface BrokerAuthorizationRequest {
  provider: BrokerProvider;
  tenantId: string;
  /** The DOMAIN connection id (opaque to the broker). */
  connectionId: string;
  /** The caller-chosen canonical connection key. */
  connectionKey: string;
  /** Requested OAuth scopes (empty = the provider's default grant). */
  scopes: string[];
  /** Post-authorization redirect target (opaque; may be null). */
  redirectTo: string | null;
}

export interface BrokerAuthorizationCallback {
  provider: BrokerProvider;
  connectionId: string;
  /** The state token the broker's callback echoed back. */
  state: string;
}

export interface BrokerRefreshRequest {
  provider: BrokerProvider;
  connectionId: string;
  /** The broker-side connection id issued at completion. */
  brokerConnectionId: string;
  /** The opaque credential-store reference the broker issued. */
  credentialRef: string;
}

export interface BrokerRevokeRequest {
  provider: BrokerProvider;
  connectionId: string;
  brokerConnectionId: string;
}

export interface BrokerSyncRequest {
  provider: BrokerProvider;
  tenantId: string;
  connectionId: string;
  brokerConnectionId: string;
  credentialRef: string;
  /** Resume point; null = pull from the beginning. */
  cursor: string | null;
  maxRecords: number;
}

// --- the http client port (broker adapters stay network-agnostic) -----------

/**
 * One broker HTTP request (dialect-neutral; the adapter owns the dialect).
 * `path` is BROKER-RELATIVE (e.g. `/connection/<id>`): the injected client
 * resolves it against the broker instance's base URL — client and adapter
 * are constructed together at wiring time, so the adapter never needs to
 * know the transport's URL-joining rules.
 */
export interface BrokerHttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One broker HTTP response (status + parsed JSON body). */
export interface BrokerHttpResponse {
  status: number;
  body: unknown;
}

/**
 * The network port broker adapters are constructed with. Real clients
 * translate requests onto `fetch` (infrastructure wiring); tests substitute
 * a scripted client. Network errors are thrown as plain Errors — the
 * adapters normalize them through the W089 taxonomy.
 */
export interface BrokerHttpClient {
  request(request: BrokerHttpRequest): Promise<BrokerHttpResponse>;
}

// --- the port itself ----------------------------------------------------------

/**
 * The managed-broker port: ONE provider-neutral surface every broker
 * adapter implements — Nango is the first candidate, the embedded broker
 * is the shipped equivalent alternative, and any conforming third-party
 * adapter may replace them (the W082 acceptance "broker replacement does
 * not change domain contracts": everything above this line is
 * broker-agnostic BY CONSTRUCTION).
 *
 * Alongside its gateway-native duties, every implementation carries a W089
 * `ProviderAdapterDefinition` (canonical lifecycle/error/capability
 * contract; the conformance kit proves it). Implementations live inside
 * `src/modules/connection-broker/adapters/` and are wired at process start
 * via `wireConnectionBrokers`; nothing is wired by default — operations
 * then fail explicitly with `broker_unavailable`.
 *
 * Adapters THROW on broker/provider failures (a `BrokerAdapterError`
 * carrying the canonical normalized failure); they never return fake
 * successes.
 */
export interface ConnectionBroker {
  /** The canonical broker key (persisted on connections; open vocabulary). */
  readonly key: string;
  /** The W089 SDK adapter definition (lifecycle, capabilities, errors). */
  readonly definition: ProviderAdapterDefinition;
  /** Start one OAuth authorization: build the broker-side hand-off. */
  beginAuthorization(request: BrokerAuthorizationRequest): Promise<BrokerAuthorizationSession>;
  /** Complete one authorization: exchange the echoed state for the grant. */
  completeAuthorization(callback: BrokerAuthorizationCallback): Promise<BrokerConnectionGrant>;
  /** Refresh one connection's OAuth grant (token rotation is broker-internal). */
  refreshGrant(request: BrokerRefreshRequest): Promise<BrokerConnectionGrant>;
  /** Revoke one connection broker-side (credential material is destroyed there). */
  revokeConnection(request: BrokerRevokeRequest): Promise<void>;
  /** Pull one window of changed records since the cursor. */
  pullSyncRecords(request: BrokerSyncRequest): Promise<BrokerSyncResult>;
  /** Parse one broker-native webhook envelope (the raw envelope never leaves the adapter). */
  parseWebhook(payload: unknown): BrokerWebhookParseResult;
}
