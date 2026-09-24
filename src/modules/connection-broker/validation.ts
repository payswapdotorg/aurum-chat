// Pure validation/normalization logic of the connection-broker module (no
// database, no clock, no network). Everything a caller, an adapter or a
// broker may put into the connection path crosses these guards first; the
// SQL CHECK constraints in migrations/001 mirror the load-bearing rules as
// defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `createdAt`, credential VALUES or a broker connection id into
// a connection record — identity, tenancy and commit times are minted by
// the system, and secrets never enter domain tables at all
// (IMPLEMENTATION-STACK §8; the W082 credential-isolation acceptance).
//
// BROKER OUTPUT is re-validated here too (defense in depth, the sources
// module's discipline): a buggy or hostile broker adapter cannot smuggle
// provider shapes, unbounded values or credential-looking material past
// the boundary.

import type { TenantContext } from '@/infra/tenant';
import { isCanonicalErrorCategory, type CanonicalErrorCategory } from '@/modules/provider-sdk/contract';
import { SOURCE_PROVIDERS } from '@/modules/sources/contract';
import { DESTINATION_PROVIDERS } from '@/modules/destinations/contract';
import { ConnectionBrokerError } from './errors';
import type {
  BrokerConnectionGrant,
  BrokerFlow,
  BrokerProvider,
  BrokerRecord,
  BrokerSyncResult,
  BrokerWebhookParseResult,
  CheckpointOrigin,
  CompleteConnectionInput,
  ConnectionEventType,
  ConnectionStatus,
  GetCheckpointQuery,
  GetConnectionQuery,
  GetProviderHealthQuery,
  HealthEventSource,
  InitiateConnectionInput,
  ListCheckpointHistoryQuery,
  ListConnectionEventsQuery,
  ListConnectionsQuery,
  ListHotSwapVerificationsQuery,
  ListProviderHealthQuery,
  ProviderHealth,
  ReceiveWebhookInput,
  ReplayCheckpointInput,
  RefreshConnectionInput,
  RevokeConnectionInput,
  RunSyncInput,
  SetProviderHealthInput,
  VerifyBrokerHotSwapInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (derived where a sibling gateway owns the source of truth)
// ---------------------------------------------------------------------------

/**
 * The canonical brokered-provider vocabulary: the UNION of the sources
 * gateway's inbound providers and the destinations gateway's outbound
 * providers, derived from their public contracts (no drift possible).
 * Mirrored by the provider CHECK in migrations/001 — keep in sync.
 */
export const BROKER_PROVIDERS: readonly BrokerProvider[] = Array.from(
  new Set([...SOURCE_PROVIDERS, ...DESTINATION_PROVIDERS]),
);

export const CONNECTION_STATUSES = ['pending', 'connected', 'revoked', 'failed'] as const;
export const BROKER_FLOWS = ['sync', 'webhook'] as const;
export const CHECKPOINT_ORIGINS = ['sync', 'webhook', 'replay'] as const;
export const PROVIDER_HEALTHS = ['available', 'degraded', 'unavailable'] as const;
export const HEALTH_EVENT_SOURCES = ['execution', 'manual'] as const;
export const CONNECTION_EVENT_TYPES = [
  'connect_initiated',
  'connected',
  'connect_failed',
  'refreshed',
  'revoked',
] as const;
export const HOT_SWAP_OUTCOMES = ['equivalent', 'completed-divergent', 'failed'] as const;

// ---------------------------------------------------------------------------
// Limits (mirrored by migrations/001 CHECKs where load-bearing)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_MAX_RECORDS = 50;
export const MAX_MAX_RECORDS = 200;
/** Hard cap on one broker delivery batch, whatever the caller asked for. */
export const MAX_BATCH_RECORDS = 200;
export const MAX_PAYLOAD_BYTES = 1_048_576; // mirrors the sources module's cap
export const MAX_CONNECTION_KEY_LENGTH = 128;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_CREDENTIAL_REF_LENGTH = 255;
export const MAX_OAUTH_SCOPES = 32;
export const MAX_SCOPE_LENGTH = 255;
export const MAX_CURSOR_LENGTH = 1024;
export const MAX_PROVIDER_RECORD_ID_LENGTH = 255;
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_BROKER_CONNECTION_ID_LENGTH = 255;
export const MAX_BROKER_KEY_LENGTH = 64;
export const MAX_STATE_TOKEN_LENGTH = 255;
export const MAX_REDIRECT_TO_LENGTH = 1024;
export const MAX_AUTHORIZATION_URL_LENGTH = 2048;
export const MAX_KIND_LENGTH = 128;
export const MAX_DETAIL_LENGTH = 500;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_REASON_LENGTH = 500;

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Canonical classification — the SAME pattern the observations module
// enforces on observation kinds (so a broker record can flow onward).
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Strict ISO 8601 with an explicit offset — broker event times are
// unambiguous (timestamptz; IMPLEMENTATION-STACK §8).
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// Caller-chosen connection key: lowercase canonical slug (nango-style).
const CONNECTION_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
// Broker adapter key: short canonical slug (open vocabulary).
const BROKER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Opaque printable tokens (state tokens, broker ids).
const PRINTABLE_TOKEN_PATTERN = /^\P{C}[\P{C}\s]*$/u;
// Credential references the broker issues: a scheme + opaque path.
const CREDENTIAL_REF_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}:\P{C}[\P{C}\s]{0,189}$/u;

const INITIATE_INPUT_KEYS = [
  'provider',
  'connectionKey',
  'displayName',
  'scopes',
  'redirectTo',
  'inventorySystemId',
  'bindSourceId',
  'bindDestinationId',
] as const;
const COMPLETE_INPUT_KEYS = ['connectionId', 'state'] as const;
const REFRESH_INPUT_KEYS = ['connectionId'] as const;
const REVOKE_INPUT_KEYS = ['connectionId', 'note'] as const;
const RUN_SYNC_INPUT_KEYS = ['connectionId', 'maxRecords'] as const;
const RECEIVE_WEBHOOK_INPUT_KEYS = ['broker', 'payload'] as const;
const GET_CHECKPOINT_QUERY_KEYS = ['connectionId', 'flow'] as const;
const LIST_CHECKPOINT_HISTORY_QUERY_KEYS = ['connectionId', 'flow', 'limit'] as const;
const REPLAY_INPUT_KEYS = ['connectionId', 'flow', 'checkpointId', 'fromStart'] as const;
const GET_CONNECTION_QUERY_KEYS = ['connectionId'] as const;
const LIST_CONNECTIONS_QUERY_KEYS = ['provider', 'status', 'broker', 'limit'] as const;
const LIST_CONNECTION_EVENTS_QUERY_KEYS = ['connectionId', 'limit'] as const;
const GET_PROVIDER_HEALTH_QUERY_KEYS = ['provider', 'broker'] as const;
const LIST_PROVIDER_HEALTH_QUERY_KEYS = ['provider', 'limit'] as const;
const SET_PROVIDER_HEALTH_INPUT_KEYS = [
  'provider',
  'broker',
  'health',
  'category',
  'reason',
  'expiresAt',
] as const;
const VERIFY_HOT_SWAP_INPUT_KEYS = ['connectionIdA', 'connectionIdB', 'note'] as const;
const LIST_HOT_SWAP_QUERY_KEYS = ['limit'] as const;

// ---------------------------------------------------------------------------
// Input key sets (for broker-output re-validation)
// ---------------------------------------------------------------------------

const GRANT_KEYS = ['brokerConnectionId', 'providerAccountId', 'credentialRef', 'scopes', 'expiresAt'] as const;
const SESSION_KEYS = ['authorizationUrl', 'state', 'expiresAt'] as const;
const SYNC_RESULT_KEYS = ['records', 'nextCursor', 'hasMore'] as const;
const WEBHOOK_PARSE_KEYS = ['brokerConnectionId', 'deliveryId', 'occurredAt', 'records'] as const;
const RECORD_KEYS = ['providerRecordId', 'kind', 'payload', 'occurredAt'] as const;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isBrokerProvider(value: unknown): value is BrokerProvider {
  return (
    typeof value === 'string' &&
    (BROKER_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return (
    typeof value === 'string' &&
    (CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isBrokerFlow(value: unknown): value is BrokerFlow {
  return (
    typeof value === 'string' && (BROKER_FLOWS as readonly string[]).includes(value)
  );
}

export function isCheckpointOrigin(value: unknown): value is CheckpointOrigin {
  return (
    typeof value === 'string' &&
    (CHECKPOINT_ORIGINS as readonly string[]).includes(value)
  );
}

export function isProviderHealth(value: unknown): value is ProviderHealth {
  return (
    typeof value === 'string' &&
    (PROVIDER_HEALTHS as readonly string[]).includes(value)
  );
}

export function isHealthEventSource(value: unknown): value is HealthEventSource {
  return (
    typeof value === 'string' &&
    (HEALTH_EVENT_SOURCES as readonly string[]).includes(value)
  );
}

export function isConnectionEventType(value: unknown): value is ConnectionEventType {
  return (
    typeof value === 'string' &&
    (CONNECTION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** A plausible broker adapter key (open vocabulary; canonical slug shape). */
export function isBrokerKeyShape(value: unknown): value is string {
  return typeof value === 'string' && BROKER_KEY_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertBrokerTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ConnectionBrokerError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ConnectionBrokerError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new ConnectionBrokerError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Shared primitive helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new ConnectionBrokerError(
        'invalid_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

/** Deep JSON check: only plain JSON values survive (house pattern). */
function checkJsonValue(
  value: unknown,
  where: string,
  depth: number,
): void {
  if (depth > 16) {
    throw new ConnectionBrokerError('invalid_input', `${where} nests deeper than 16 levels`);
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (const entry of value) checkJsonValue(entry, `${where}[]`, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      checkJsonValue(entry, `${where}.${key}`, depth + 1);
    }
    return;
  }
  throw new ConnectionBrokerError(
    'invalid_input',
    `${where} must be a plain JSON value (no functions, dates or class instances)`,
  );
}

function requirePlainObject(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ConnectionBrokerError('invalid_input', `${where} must be an object`);
  }
  return value;
}

function optionalDisplayString(
  value: unknown,
  where: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ConnectionBrokerError('invalid_input', `${where} must be a string or null`);
  }
  const text = value.trim();
  if (text === '') {
    throw new ConnectionBrokerError('invalid_input', `${where} must be a non-empty string or null`);
  }
  if (text.length > maxLength) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `${where} must be at most ${maxLength} characters (got ${text.length})`,
    );
  }
  return text;
}

function validateScopeList(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConnectionBrokerError('invalid_input', `${where} must be an array of scopes`);
  }
  if (value.length > MAX_OAUTH_SCOPES) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `${where} supports at most ${MAX_OAUTH_SCOPES} scopes (got ${value.length})`,
    );
  }
  const scopes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConnectionBrokerError('invalid_input', `${where} entries must be non-empty strings`);
    }
    const scope = entry.trim();
    if (scope.length > MAX_SCOPE_LENGTH) {
      throw new ConnectionBrokerError(
        'invalid_input',
        `${where} entries must be at most ${MAX_SCOPE_LENGTH} characters`,
      );
    }
    if (scopes.includes(scope)) {
      throw new ConnectionBrokerError('invalid_input', `${where} entries must be unique ('${scope}' repeats)`);
    }
    scopes.push(scope);
  }
  return scopes;
}

function validateLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConnectionBrokerError('invalid_input', 'limit must be an integer');
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `limit must be between 1 and ${MAX_LIST_LIMIT} (got ${value})`,
    );
  }
  return value;
}

function validateIsoInstant(value: unknown, where: string): string {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `${where} must be a strict ISO 8601 timestamp with explicit offset`,
    );
  }
  return value;
}

function validateOptionalIsoInstant(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  return validateIsoInstant(value, where);
}

function validateUuid(value: unknown, where: string): string {
  if (!isUuid(value)) {
    throw new ConnectionBrokerError('invalid_input', `${where} must be a uuid`);
  }
  return value;
}

/**
 * Connection ids are loader-guarded: a malformed id is validated only as a
 * non-empty string here and surfaces as `connection_not_found` from the
 * loader (indistinguishable from a missing record — no existence leak,
 * ADR-0001; the sources module's loader discipline).
 */
function requireConnectionId(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConnectionBrokerError('invalid_input', `${where} must be a non-empty string`);
  }
  return value;
}

function validateOptionalUuid(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  return validateUuid(value, where);
}

// ---------------------------------------------------------------------------
// Connection lifecycle inputs
// ---------------------------------------------------------------------------

export interface ValidatedInitiateInput {
  readonly provider: BrokerProvider;
  readonly connectionKey: string;
  readonly displayName: string | null;
  readonly scopes: string[];
  readonly redirectTo: string | null;
  readonly inventorySystemId: string | null;
  readonly bindSourceId: string | null;
  readonly bindDestinationId: string | null;
}

export function validateInitiateConnectionInput(input: InitiateConnectionInput): ValidatedInitiateInput {
  const value = requirePlainObject(input, 'initiateConnection input');
  rejectUnknownKeys(value, INITIATE_INPUT_KEYS, 'initiateConnection input');
  if (!isBrokerProvider(value.provider)) {
    throw new ConnectionBrokerError(
      'unsupported_provider',
      `provider must be one of ${BROKER_PROVIDERS.join(', ')} (got '${String(value.provider)}')`,
    );
  }
  if (typeof value.connectionKey !== 'string' || !CONNECTION_KEY_PATTERN.test(value.connectionKey)) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `connectionKey must match ${CONNECTION_KEY_PATTERN} (1..${MAX_CONNECTION_KEY_LENGTH} lowercase canonical characters)`,
    );
  }
  const redirectTo =
    value.redirectTo === undefined || value.redirectTo === null
      ? null
      : (() => {
          if (typeof value.redirectTo !== 'string') {
            throw new ConnectionBrokerError('invalid_input', 'redirectTo must be a string or null');
          }
          if (value.redirectTo.length > MAX_REDIRECT_TO_LENGTH) {
            throw new ConnectionBrokerError(
              'invalid_input',
              `redirectTo must be at most ${MAX_REDIRECT_TO_LENGTH} characters`,
            );
          }
          return value.redirectTo;
        })();
  return {
    provider: value.provider,
    connectionKey: value.connectionKey,
    displayName: optionalDisplayString(value.displayName, 'displayName', MAX_DISPLAY_NAME_LENGTH),
    scopes: validateScopeList(value.scopes, 'scopes'),
    redirectTo,
    inventorySystemId: validateOptionalUuid(value.inventorySystemId, 'inventorySystemId'),
    bindSourceId: validateOptionalUuid(value.bindSourceId, 'bindSourceId'),
    bindDestinationId: validateOptionalUuid(value.bindDestinationId, 'bindDestinationId'),
  };
}

export interface ValidatedCompleteInput {
  readonly connectionId: string;
  readonly state: string;
}

export function validateCompleteConnectionInput(input: CompleteConnectionInput): ValidatedCompleteInput {
  const value = requirePlainObject(input, 'completeConnection input');
  rejectUnknownKeys(value, COMPLETE_INPUT_KEYS, 'completeConnection input');
  const connectionId = requireConnectionId(value.connectionId, 'connectionId');
  if (typeof value.state !== 'string' || value.state.trim() === '' || value.state.length > MAX_STATE_TOKEN_LENGTH) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `state must be a non-empty string of at most ${MAX_STATE_TOKEN_LENGTH} characters`,
    );
  }
  return { connectionId, state: value.state };
}

export interface ValidatedConnectionIdInput {
  readonly connectionId: string;
}

export function validateRefreshConnectionInput(input: RefreshConnectionInput): ValidatedConnectionIdInput {
  const value = requirePlainObject(input, 'refreshConnection input');
  rejectUnknownKeys(value, REFRESH_INPUT_KEYS, 'refreshConnection input');
  return { connectionId: requireConnectionId(value.connectionId, 'connectionId') };
}

export interface ValidatedRevokeInput {
  readonly connectionId: string;
  readonly note: string | null;
}

export function validateRevokeConnectionInput(input: RevokeConnectionInput): ValidatedRevokeInput {
  const value = requirePlainObject(input, 'revokeConnection input');
  rejectUnknownKeys(value, REVOKE_INPUT_KEYS, 'revokeConnection input');
  return {
    connectionId: requireConnectionId(value.connectionId, 'connectionId'),
    note: optionalDisplayString(value.note, 'note', MAX_NOTE_LENGTH),
  };
}

// ---------------------------------------------------------------------------
// Sync / webhook inputs
// ---------------------------------------------------------------------------

export interface ValidatedRunSyncInput {
  readonly connectionId: string;
  readonly maxRecords: number;
}

export function validateRunSyncInput(input: RunSyncInput): ValidatedRunSyncInput {
  const value = requirePlainObject(input, 'runConnectionSync input');
  rejectUnknownKeys(value, RUN_SYNC_INPUT_KEYS, 'runConnectionSync input');
  let maxRecords = DEFAULT_MAX_RECORDS;
  if (value.maxRecords !== undefined && value.maxRecords !== null) {
    if (
      typeof value.maxRecords !== 'number' ||
      !Number.isInteger(value.maxRecords) ||
      value.maxRecords < 1 ||
      value.maxRecords > MAX_MAX_RECORDS
    ) {
      throw new ConnectionBrokerError(
        'invalid_input',
        `maxRecords must be an integer between 1 and ${MAX_MAX_RECORDS}`,
      );
    }
    maxRecords = value.maxRecords;
  }
  return { connectionId: requireConnectionId(value.connectionId, 'connectionId'), maxRecords };
}

export interface ValidatedReceiveWebhookInput {
  readonly broker: string | null;
  readonly payload: unknown;
}

export function validateReceiveWebhookInput(input: ReceiveWebhookInput): ValidatedReceiveWebhookInput {
  const value = requirePlainObject(input, 'receiveBrokerWebhook input');
  rejectUnknownKeys(value, RECEIVE_WEBHOOK_INPUT_KEYS, 'receiveBrokerWebhook input');
  let broker: string | null = null;
  if (value.broker !== undefined && value.broker !== null) {
    if (!isBrokerKeyShape(value.broker)) {
      throw new ConnectionBrokerError(
        'unsupported_broker',
        `broker must be a canonical broker key (got '${String(value.broker)}')`,
      );
    }
    broker = value.broker;
  }
  checkJsonValue(value.payload, 'payload', 0);
  return { broker, payload: value.payload };
}

// ---------------------------------------------------------------------------
// Checkpoint queries
// ---------------------------------------------------------------------------

export interface ValidatedGetCheckpointQuery {
  readonly connectionId: string;
  readonly flow: BrokerFlow;
}

export function validateGetCheckpointQuery(query: GetCheckpointQuery): ValidatedGetCheckpointQuery {
  const value = requirePlainObject(query, 'getConnectionCheckpoint query');
  rejectUnknownKeys(value, GET_CHECKPOINT_QUERY_KEYS, 'getConnectionCheckpoint query');
  if (!isBrokerFlow(value.flow)) {
    throw new ConnectionBrokerError('invalid_query', `flow must be one of ${BROKER_FLOWS.join(', ')}`);
  }
  return { connectionId: requireConnectionId(value.connectionId, 'connectionId'), flow: value.flow };
}

export interface ValidatedListCheckpointHistoryQuery {
  readonly connectionId: string;
  readonly flow: BrokerFlow | null;
  readonly limit: number;
}

export function validateListCheckpointHistoryQuery(
  query: ListCheckpointHistoryQuery,
): ValidatedListCheckpointHistoryQuery {
  const value = requirePlainObject(query, 'listCheckpointHistory query');
  rejectUnknownKeys(value, LIST_CHECKPOINT_HISTORY_QUERY_KEYS, 'listCheckpointHistory query');
  let flow: BrokerFlow | null = null;
  if (value.flow !== undefined && value.flow !== null) {
    if (!isBrokerFlow(value.flow)) {
      throw new ConnectionBrokerError('invalid_query', `flow must be one of ${BROKER_FLOWS.join(', ')}`);
    }
    flow = value.flow;
  }
  return {
    connectionId: requireConnectionId(value.connectionId, 'connectionId'),
    flow,
    limit: validateLimit(value.limit),
  };
}

export interface ValidatedReplayInput {
  readonly connectionId: string;
  readonly flow: BrokerFlow;
  readonly checkpointId: string | null;
  readonly fromStart: boolean;
}

export function validateReplayCheckpointInput(input: ReplayCheckpointInput): ValidatedReplayInput {
  const value = requirePlainObject(input, 'replayConnectionCheckpoint input');
  rejectUnknownKeys(value, REPLAY_INPUT_KEYS, 'replayConnectionCheckpoint input');
  if (!isBrokerFlow(value.flow)) {
    throw new ConnectionBrokerError('invalid_input', `flow must be one of ${BROKER_FLOWS.join(', ')}`);
  }
  const checkpointId = validateOptionalUuid(value.checkpointId, 'checkpointId');
  const fromStart = value.fromStart === true;
  if (checkpointId === null && !fromStart) {
    throw new ConnectionBrokerError(
      'invalid_input',
      'exactly one replay target is required: checkpointId or fromStart',
    );
  }
  if (checkpointId !== null && fromStart) {
    throw new ConnectionBrokerError(
      'invalid_input',
      'only one replay target is allowed: checkpointId or fromStart, not both',
    );
  }
  return { connectionId: requireConnectionId(value.connectionId, 'connectionId'), flow: value.flow, checkpointId, fromStart };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function validateGetConnectionQuery(query: GetConnectionQuery): { connectionId: string } {
  const value = requirePlainObject(query, 'getConnection query');
  rejectUnknownKeys(value, GET_CONNECTION_QUERY_KEYS, 'getConnection query');
  return { connectionId: requireConnectionId(value.connectionId, 'connectionId') };
}

export interface ValidatedListConnectionsQuery {
  readonly provider: BrokerProvider | null;
  readonly status: ConnectionStatus | null;
  readonly broker: string | null;
  readonly limit: number;
}

export function validateListConnectionsQuery(query: ListConnectionsQuery): ValidatedListConnectionsQuery {
  const value = requirePlainObject(query, 'listConnections query');
  rejectUnknownKeys(value, LIST_CONNECTIONS_QUERY_KEYS, 'listConnections query');
  let provider: BrokerProvider | null = null;
  if (value.provider !== undefined && value.provider !== null) {
    if (!isBrokerProvider(value.provider)) {
      throw new ConnectionBrokerError(
        'unsupported_provider',
        `provider must be one of ${BROKER_PROVIDERS.join(', ')}`,
      );
    }
    provider = value.provider;
  }
  let status: ConnectionStatus | null = null;
  if (value.status !== undefined && value.status !== null) {
    if (!isConnectionStatus(value.status)) {
      throw new ConnectionBrokerError(
        'invalid_query',
        `status must be one of ${CONNECTION_STATUSES.join(', ')}`,
      );
    }
    status = value.status;
  }
  let broker: string | null = null;
  if (value.broker !== undefined && value.broker !== null) {
    if (!isBrokerKeyShape(value.broker)) {
      throw new ConnectionBrokerError('invalid_query', 'broker must be a canonical broker key');
    }
    broker = value.broker;
  }
  return { provider, status, broker, limit: validateLimit(value.limit) };
}

export function validateListConnectionEventsQuery(
  query: ListConnectionEventsQuery,
): { connectionId: string; limit: number } {
  const value = requirePlainObject(query, 'listConnectionEvents query');
  rejectUnknownKeys(value, LIST_CONNECTION_EVENTS_QUERY_KEYS, 'listConnectionEvents query');
  return {
    connectionId: requireConnectionId(value.connectionId, 'connectionId'),
    limit: validateLimit(value.limit),
  };
}

// ---------------------------------------------------------------------------
// Provider-health queries and overrides
// ---------------------------------------------------------------------------

export interface ValidatedGetProviderHealthQuery {
  readonly provider: BrokerProvider;
  readonly broker: string | null;
}

export function validateGetProviderHealthQuery(query: GetProviderHealthQuery): ValidatedGetProviderHealthQuery {
  const value = requirePlainObject(query, 'getProviderHealth query');
  rejectUnknownKeys(value, GET_PROVIDER_HEALTH_QUERY_KEYS, 'getProviderHealth query');
  if (!isBrokerProvider(value.provider)) {
    throw new ConnectionBrokerError(
      'unsupported_provider',
      `provider must be one of ${BROKER_PROVIDERS.join(', ')}`,
    );
  }
  let broker: string | null = null;
  if (value.broker !== undefined && value.broker !== null) {
    if (!isBrokerKeyShape(value.broker)) {
      throw new ConnectionBrokerError('invalid_query', 'broker must be a canonical broker key');
    }
    broker = value.broker;
  }
  return { provider: value.provider, broker };
}

export interface ValidatedListProviderHealthQuery {
  readonly provider: BrokerProvider | null;
  readonly limit: number;
}

export function validateListProviderHealthQuery(query: ListProviderHealthQuery): ValidatedListProviderHealthQuery {
  const value = requirePlainObject(query, 'listProviderHealth query');
  rejectUnknownKeys(value, LIST_PROVIDER_HEALTH_QUERY_KEYS, 'listProviderHealth query');
  let provider: BrokerProvider | null = null;
  if (value.provider !== undefined && value.provider !== null) {
    if (!isBrokerProvider(value.provider)) {
      throw new ConnectionBrokerError(
        'unsupported_provider',
        `provider must be one of ${BROKER_PROVIDERS.join(', ')}`,
      );
    }
    provider = value.provider;
  }
  return { provider, limit: validateLimit(value.limit) };
}

export interface ValidatedSetProviderHealthInput {
  readonly provider: BrokerProvider;
  readonly broker: string;
  readonly health: ProviderHealth;
  readonly category: CanonicalErrorCategory | null;
  readonly reason: string | null;
  readonly expiresAt: string | null;
}

export function validateSetProviderHealthInput(input: SetProviderHealthInput): ValidatedSetProviderHealthInput {
  const value = requirePlainObject(input, 'setProviderHealth input');
  rejectUnknownKeys(value, SET_PROVIDER_HEALTH_INPUT_KEYS, 'setProviderHealth input');
  if (!isBrokerProvider(value.provider)) {
    throw new ConnectionBrokerError(
      'unsupported_provider',
      `provider must be one of ${BROKER_PROVIDERS.join(', ')}`,
    );
  }
  if (!isBrokerKeyShape(value.broker)) {
    throw new ConnectionBrokerError('invalid_input', 'broker must be a canonical broker key');
  }
  if (!isProviderHealth(value.health)) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `health must be one of ${PROVIDER_HEALTHS.join(', ')}`,
    );
  }
  let category: CanonicalErrorCategory | null = null;
  if (value.category !== undefined && value.category !== null) {
    if (!isCanonicalErrorCategory(value.category)) {
      throw new ConnectionBrokerError(
        'invalid_input',
        'category must be a canonical error category (W089 taxonomy)',
      );
    }
    category = value.category;
  }
  if (value.health !== 'available' && category === null) {
    throw new ConnectionBrokerError(
      'invalid_input',
      `category is required when health is '${value.health}' (the canonical failure being recorded)`,
    );
  }
  if (value.health === 'available' && category !== null) {
    throw new ConnectionBrokerError(
      'invalid_input',
      "category must be null when health is 'available' (recovery carries no failure)",
    );
  }
  const reason = optionalDisplayString(value.reason, 'reason', MAX_REASON_LENGTH);
  const expiresAt = validateOptionalIsoInstant(value.expiresAt, 'expiresAt');
  if (value.health === 'available' && expiresAt !== null) {
    throw new ConnectionBrokerError(
      'invalid_input',
      "expiresAt must be null when health is 'available' (available states never expire)",
    );
  }
  return { provider: value.provider, broker: value.broker, health: value.health, category, reason, expiresAt };
}

// ---------------------------------------------------------------------------
// Hot-swap verification inputs
// ---------------------------------------------------------------------------

export interface ValidatedVerifyHotSwapInput {
  readonly connectionIdA: string;
  readonly connectionIdB: string;
  readonly note: string | null;
}

export function validateVerifyBrokerHotSwapInput(input: VerifyBrokerHotSwapInput): ValidatedVerifyHotSwapInput {
  const value = requirePlainObject(input, 'verifyBrokerHotSwap input');
  rejectUnknownKeys(value, VERIFY_HOT_SWAP_INPUT_KEYS, 'verifyBrokerHotSwap input');
  const connectionIdA = requireConnectionId(value.connectionIdA, 'connectionIdA');
  const connectionIdB = requireConnectionId(value.connectionIdB, 'connectionIdB');
  if (connectionIdA === connectionIdB) {
    throw new ConnectionBrokerError(
      'invalid_input',
      'connectionIdA and connectionIdB must be two different connections',
    );
  }
  return {
    connectionIdA,
    connectionIdB,
    note: optionalDisplayString(value.note, 'note', MAX_NOTE_LENGTH),
  };
}

export function validateListHotSwapVerificationsQuery(query: ListHotSwapVerificationsQuery): { limit: number } {
  const value = requirePlainObject(query, 'listHotSwapVerifications query');
  rejectUnknownKeys(value, LIST_HOT_SWAP_QUERY_KEYS, 'listHotSwapVerifications query');
  return { limit: validateLimit(value.limit) };
}

// ---------------------------------------------------------------------------
// Cursor movement semantics (pure; the sources module's discipline)
// ---------------------------------------------------------------------------

/**
 * Whether a sync pull moves the checkpoint: a null next cursor NEVER moves
 * it (an exhausted window keeps the last position — the next pull re-fetches
 * the same window and the ledger dedupes), and an unchanged cursor adds no
 * history entry.
 */
export function syncCursorAdvance(current: string | null, next: string | null): boolean {
  return next !== null && next !== current;
}

/**
 * Whether a webhook delivery moves the webhook-flow checkpoint: the
 * watermark only moves FORWARD in time (a late redelivery of an older
 * envelope never rewinds it).
 */
export function webhookCursorAdvance(current: string | null, occurredAt: string): boolean {
  if (current === null) return true;
  return Date.parse(occurredAt) > Date.parse(current);
}

// ---------------------------------------------------------------------------
// Broker-output re-validation (defense in depth — a buggy or hostile
// adapter cannot smuggle provider shapes or credential values onward)
// ---------------------------------------------------------------------------

function validateBrokerRecord(value: unknown, where: string): BrokerRecord {
  const record = requirePlainObject(value, where);
  rejectUnknownKeys(record, RECORD_KEYS, where);
  if (typeof record.providerRecordId !== 'string' || record.providerRecordId.trim() === '') {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `${where}.providerRecordId must be a non-empty string`,
    );
  }
  if (record.providerRecordId.length > MAX_PROVIDER_RECORD_ID_LENGTH) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `${where}.providerRecordId must be at most ${MAX_PROVIDER_RECORD_ID_LENGTH} characters`,
    );
  }
  if (typeof record.kind !== 'string' || !KIND_PATTERN.test(record.kind)) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `${where}.kind must match ${KIND_PATTERN} (1..${MAX_KIND_LENGTH} canonical characters)`,
    );
  }
  const occurredAt = validateIsoInstant(record.occurredAt, `${where}.occurredAt`);
  checkJsonValue(record.payload, `${where}.payload`, 0);
  if (JSON.stringify(record.payload ?? null).length > MAX_PAYLOAD_BYTES) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `${where}.payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  return {
    providerRecordId: record.providerRecordId,
    kind: record.kind,
    payload: record.payload ?? null,
    occurredAt,
  };
}

function validateOpaqueToken(
  value: unknown,
  where: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim() === '' || !PRINTABLE_TOKEN_PATTERN.test(value)) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `${where} must be a non-empty printable string`,
    );
  }
  if (value.length > maxLength) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `${where} must be at most ${maxLength} characters`,
    );
  }
  return value;
}

/** Re-validates one broker authorization session (`invalid_broker_result`). */
export function validateBrokerAuthorizationSession(value: unknown): {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
} {
  const session = requirePlainObject(value, 'the broker authorization session');
  rejectUnknownKeys(session, SESSION_KEYS, 'the broker authorization session');
  if (
    typeof session.authorizationUrl !== 'string' ||
    session.authorizationUrl.length > MAX_AUTHORIZATION_URL_LENGTH ||
    !/^https?:\/\//.test(session.authorizationUrl)
  ) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `the broker session's authorizationUrl must be an http(s) URL of at most ${MAX_AUTHORIZATION_URL_LENGTH} characters`,
    );
  }
  return {
    authorizationUrl: session.authorizationUrl,
    state: validateOpaqueToken(session.state, 'the broker session state', MAX_STATE_TOKEN_LENGTH),
    expiresAt: validateIsoInstant(session.expiresAt, 'the broker session expiresAt'),
  };
}

/** Re-validates one broker connection grant (`invalid_broker_result`). */
export function validateBrokerConnectionGrant(value: unknown): BrokerConnectionGrant {
  const grant = requirePlainObject(value, 'the broker connection grant');
  rejectUnknownKeys(grant, GRANT_KEYS, 'the broker connection grant');
  return {
    brokerConnectionId: validateOpaqueToken(
      grant.brokerConnectionId,
      'the grant brokerConnectionId',
      MAX_BROKER_CONNECTION_ID_LENGTH,
    ),
    providerAccountId: validateOpaqueToken(
      grant.providerAccountId,
      'the grant providerAccountId',
      MAX_PROVIDER_ACCOUNT_ID_LENGTH,
    ),
    credentialRef: (() => {
      if (typeof grant.credentialRef !== 'string' || !CREDENTIAL_REF_PATTERN.test(grant.credentialRef)) {
        throw new ConnectionBrokerError(
          'invalid_broker_result',
          'the grant credentialRef must be an opaque scheme-qualified reference (never a credential value)',
        );
      }
      return grant.credentialRef;
    })(),
    scopes: validateScopeList(grant.scopes, 'the grant scopes'),
    expiresAt: validateOptionalIsoInstant(grant.expiresAt, 'the grant expiresAt'),
  };
}

/** Re-validates one broker sync result (`invalid_broker_result`). */
export function validateBrokerSyncResult(value: unknown): BrokerSyncResult {
  const result = requirePlainObject(value, 'the broker sync result');
  rejectUnknownKeys(result, SYNC_RESULT_KEYS, 'the broker sync result');
  if (!Array.isArray(result.records)) {
    throw new ConnectionBrokerError('invalid_broker_result', 'the broker sync result records must be an array');
  }
  if (result.records.length > MAX_BATCH_RECORDS) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `the broker sync result supports at most ${MAX_BATCH_RECORDS} records per window (got ${result.records.length})`,
    );
  }
  const seen = new Set<string>();
  const records = result.records.map((entry, index) => {
    const record = validateBrokerRecord(entry, `the sync result records[${index}]`);
    if (seen.has(record.providerRecordId)) {
      throw new ConnectionBrokerError(
        'invalid_broker_result',
        `the sync result carries a duplicate providerRecordId '${record.providerRecordId}'`,
      );
    }
    seen.add(record.providerRecordId);
    return record;
  });
  let nextCursor: string | null = null;
  if (result.nextCursor !== undefined && result.nextCursor !== null) {
    if (
      typeof result.nextCursor !== 'string' ||
      result.nextCursor.length > MAX_CURSOR_LENGTH ||
      result.nextCursor.trim() === ''
    ) {
      throw new ConnectionBrokerError(
        'invalid_broker_result',
        `the sync result nextCursor must be a non-empty string of at most ${MAX_CURSOR_LENGTH} characters`,
      );
    }
    nextCursor = result.nextCursor;
  }
  if (typeof result.hasMore !== 'boolean') {
    throw new ConnectionBrokerError('invalid_broker_result', 'the sync result hasMore must be a boolean');
  }
  return { records, nextCursor, hasMore: result.hasMore };
}

/** Re-validates one broker webhook parse result (`invalid_broker_result`). */
export function validateBrokerWebhookParseResult(value: unknown): BrokerWebhookParseResult {
  const parsed = requirePlainObject(value, 'the broker webhook parse result');
  rejectUnknownKeys(parsed, WEBHOOK_PARSE_KEYS, 'the broker webhook parse result');
  if (!Array.isArray(parsed.records)) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      'the broker webhook parse result records must be an array',
    );
  }
  if (parsed.records.length > MAX_BATCH_RECORDS) {
    throw new ConnectionBrokerError(
      'invalid_broker_result',
      `the broker webhook envelope supports at most ${MAX_BATCH_RECORDS} records (got ${parsed.records.length})`,
    );
  }
  const seen = new Set<string>();
  const records = parsed.records.map((entry, index) => {
    const record = validateBrokerRecord(entry, `the webhook records[${index}]`);
    if (seen.has(record.providerRecordId)) {
      throw new ConnectionBrokerError(
        'invalid_broker_result',
        `the webhook envelope carries a duplicate providerRecordId '${record.providerRecordId}'`,
      );
    }
    seen.add(record.providerRecordId);
    return record;
  });
  return {
    brokerConnectionId: validateOpaqueToken(
      parsed.brokerConnectionId,
      'the webhook brokerConnectionId',
      MAX_BROKER_CONNECTION_ID_LENGTH,
    ),
    deliveryId:
      parsed.deliveryId === undefined || parsed.deliveryId === null
        ? null
        : validateOpaqueToken(parsed.deliveryId, 'the webhook deliveryId', MAX_PROVIDER_RECORD_ID_LENGTH),
    occurredAt: validateIsoInstant(parsed.occurredAt, 'the webhook occurredAt'),
    records,
  };
}
