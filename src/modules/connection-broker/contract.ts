// ============================================================================
// connection-broker — the ONLY public surface of the connection-broker
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else
// are architecture violations detected by scripts/check-architecture.ts).
//
// W082 — Universal Connection Broker:
// "Integrate OAuth, tokens, syncs and webhooks through provider-neutral
//  adapters. Support a pluggable managed connection broker with Nango as
//  the first candidate and equivalent alternatives."
// Acceptance: connect/revoke/refresh; webhook/sync checkpoints; provider
// outages are localized; credential values never enter domain state;
// broker replacement does not change domain contracts.
//
//   THE CONNECTION LIFECYCLE (OAuth/token management)
//     initiateConnection — create (or RE-ISSUE, on a pending/failed/revoked
//        row) one tenant-scoped connection per (provider, connection key)
//        and hand back the broker's OAuth authorization hand-off (URL +
//        opaque state + expiry). Bindings are validated through the owning
//        gateways' contracts FIRST: bindSourceId (W036), bindDestinationId
//        (W037, provider must match) and inventorySystemId (W081 Tool &
//        System Inventory).
//     completeConnection — the broker confirmed the grant: the connection
//        becomes 'connected' with the OPAQUE credential reference, granted
//        scopes and expiry; the bound connectors are re-registered through
//        their gateway contracts (the re-authorization path — the same
//        calls whichever broker is active).
//     refreshConnection — rotate the grant through the broker (token
//        rotation is broker-internal; only non-secret state moves).
//        Deliberately NOT outage-gated: refresh is the healing path.
//     revokeConnection — destroy the grant broker-side FIRST, then park
//        the connection 'revoked' and DISABLE the bound connectors.
//
//   THE CHECKPOINTED FLOWS (syncs + webhooks)
//     runConnectionSync — pull one window of changed records through the
//        broker since the connection's sync checkpoint; claims land on the
//        append-only delivery ledger (dedupe by provider record id) and the
//        checkpoint advances only after the claim. Record payloads stay in
//        the broker's normalized store (the sources bridge below moves
//        them into Aurum evidence through W036's own path).
//     receiveBrokerWebhook — one broker-native envelope; the broker's
//        PRIVATE adapter parses it, the records claim on the same ledger,
//        and the webhook-flow watermark advances (forward-only).
//     getConnectionCheckpoint / listCheckpointHistory /
//     replayConnectionCheckpoint — the live cursor, the append-only audit
//        (the legal rewind targets) and REPLAY under dedupe.
//
//   OUTAGE LOCALIZATION + OPERATOR OVERRIDES
//     Every broker/provider failure is normalized (W089 taxonomy), thrown
//     as `broker_failure` carrying the canonical failure, and recorded as
//     append-only health evidence for exactly one (provider, broker) pair:
//     getProviderHealth / listProviderHealth read the resolved state;
//     setProviderHealth (claim 'connection-broker:administer') overrides
//     it. While a recorded outage is cooling down the sync path fails fast
//     (`provider_outage`) — checkpoints and domain state untouched.
//
//   BROKER PLUGGABILITY + SWAP EVIDENCE
//     wireConnectionBrokers — process-start wiring of the broker adapter
//     set (FIRST entry = active; nothing wired by default → explicit
//     `broker_unavailable`). The nango + embedded adapter factories below
//     are the shipped first-party pair; any conforming ConnectionBroker
//     implementation may replace them.
//     verifyBrokerHotSwap — GOVERNANCE provider-swap evidence: the SAME
//     canonical connection-sync request through two connections backed by
//     DIFFERENT brokers, recorded append-only and returned as the
//     canonical W089 HotSwapEvidenceRecord.
//     listHotSwapVerifications — the verification ledger.
//
//   THE SOURCES COMPOSITION BRIDGE
//     createBrokerSourceTransport — a sources-gateway SourceTransport
//     whose fetches route through the broker connection bound to the
//     polled source, so broker-backed sources ingest records as
//     observations through W036's own polling contract (source cursors
//     stay the sources module's truth; this bridge is stateless).
//
// PROVIDER/BROKER ISOLATION (lock 16; MODULE-DEPENDENCY-MAP provider
// boundaries): everything exported below is provider-neutral AND
// broker-neutral by construction. Providers appear only as the canonical
// `BrokerProvider` key (the union of the sources/destinations vocabularies);
// brokers appear only as opaque string keys; the only broker/provider-
// minted values on this surface are OPAQUE strings (connection ids,
// account ids, cursors, state tokens, delivery ids).
//
// CREDENTIAL ISOLATION (GOVERNANCE mandatory invariant): `credentialRef`
// is an OPAQUE reference into the backing broker's credential store; token
// values never reach a domain table, a log line or a contract result.
// Broker instance secrets (e.g. a Nango secret key) are wiring-time
// adapter configuration (see the adapter factories below).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's connections,
// checkpoints, health state or swap evidence is indistinguishable from
// missing (`connection_not_found` / `checkpoint_not_found`) — no existence
// leak.
// ============================================================================

export {
  // the connection lifecycle (OAuth/token management)
  initiateConnection,
  completeConnection,
  refreshConnection,
  revokeConnection,
  // reads
  getConnection,
  listConnections,
  listConnectionEvents,
  // the checkpointed flows (syncs + webhooks)
  runConnectionSync,
  receiveBrokerWebhook,
  getConnectionCheckpoint,
  listCheckpointHistory,
  replayConnectionCheckpoint,
  // outage localization + operator overrides
  getProviderHealth,
  listProviderHealth,
  setProviderHealth,
  // broker pluggability + swap evidence
  verifyBrokerHotSwap,
  listHotSwapVerifications,
  wireConnectionBrokers,
  getWiredBrokers,
  getActiveBroker,
  listWiredBrokers,
  // the sources composition bridge
  createBrokerSourceTransport,
} from './service';

export { ConnectionBrokerError } from './errors';
export type { ConnectionBrokerErrorCode } from './errors';

// Module-owned constants.
export {
  BROKER_AUTHORITY_ADMINISTER,
  HOT_SWAP_CAPABILITY,
} from './service';
export {
  NANGO_BROKER_KEY,
  EMBEDDED_BROKER_KEY,
  createNangoBroker,
  createEmbeddedBroker,
} from './adapters/index';
export type { NangoBrokerConfig, EmbeddedBrokerConfig } from './adapters/index';

// Validation vocabularies + guards (the house pattern).
export {
  BROKER_PROVIDERS,
  BROKER_FLOWS,
  CHECKPOINT_ORIGINS,
  CONNECTION_EVENT_TYPES,
  CONNECTION_STATUSES,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_RECORDS,
  HEALTH_EVENT_SOURCES,
  HOT_SWAP_OUTCOMES,
  MAX_BATCH_RECORDS,
  MAX_CONNECTION_KEY_LENGTH,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_CURSOR_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MAX_RECORDS,
  MAX_OAUTH_SCOPES,
  MAX_PAYLOAD_BYTES,
  MAX_SCOPE_LENGTH,
  PROVIDER_HEALTHS,
  assertBrokerTenantContext,
  isBrokerFlow,
  isBrokerKeyShape,
  isBrokerProvider,
  isCheckpointOrigin,
  isConnectionEventType,
  isConnectionStatus,
  isHealthEventSource,
  isProviderHealth,
  isUuid,
} from './validation';

// Pure health/cooldown logic (unit-tested; exported for downstream
// surfaces exactly like the integration-intelligence pure helpers).
export {
  OUTAGE_COOLDOWN_MS,
  cooldownExpiryFor,
  healthForFailure,
  isCoolingDown,
  resolveHealth,
} from './health';
export type { HealthEventLike } from './health';

export type {
  ValidatedInitiateInput,
  ValidatedCompleteInput,
  ValidatedRevokeInput,
  ValidatedRunSyncInput,
  ValidatedReceiveWebhookInput,
  ValidatedGetCheckpointQuery,
  ValidatedListCheckpointHistoryQuery,
  ValidatedReplayInput,
  ValidatedListConnectionsQuery,
  ValidatedGetProviderHealthQuery,
  ValidatedListProviderHealthQuery,
  ValidatedSetProviderHealthInput,
  ValidatedVerifyHotSwapInput,
} from './validation';

export type {
  AuthorizationHandoff,
  BrokerAuthorizationCallback,
  BrokerAuthorizationRequest,
  BrokerAuthorizationSession,
  BrokerCheckpoint,
  BrokerCheckpointEntry,
  BrokerConnection,
  BrokerConnectionGrant,
  BrokerFlow,
  BrokerHotSwapVerification,
  BrokerHttpRequest,
  BrokerHttpResponse,
  BrokerHttpClient,
  BrokerProvider,
  BrokerRecord,
  BrokerRefreshRequest,
  BrokerRevokeRequest,
  BrokerSyncRequest,
  BrokerSyncResult,
  BrokerWebhookParseResult,
  CheckpointOrigin,
  CompleteConnectionInput,
  CompleteConnectionResult,
  ConnectionBroker,
  ConnectionEventEntry,
  ConnectionEventType,
  ConnectionStatus,
  FirstPartyBrokerKey,
  GetCheckpointQuery,
  GetConnectionQuery,
  GetProviderHealthQuery,
  HealthEventSource,
  InitiateConnectionInput,
  InitiateConnectionResult,
  ListCheckpointHistoryQuery,
  ListConnectionEventsQuery,
  ListConnectionsQuery,
  ListHotSwapVerificationsQuery,
  ListProviderHealthQuery,
  ProviderHealth,
  ProviderHealthStatus,
  ReceiveWebhookInput,
  RefreshConnectionInput,
  RefreshConnectionResult,
  ReplayCheckpointInput,
  ReplayCheckpointResult,
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
