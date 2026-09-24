// Pure validation/normalization logic of the integration-intelligence
// module (no database, no clock, no network). Everything a caller may put
// into this module's operations crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys (the sources module's pattern): a
// caller can never smuggle `id`, `tenantId`, `createdAt`, scores or
// explanations into records — identity, tenancy, ranking and explanation
// content are minted by the system from validated discovery evidence.

import type { TenantContext } from '@/infra/tenant';
import { IntegrationError } from './errors';
import type {
  ConnectSystemInput,
  DecideBatchInput,
  DiscoveryGrantStatus,
  GetDiscoveryGrantQuery,
  GetRecommendationBatchQuery,
  GetRecommendationQuery,
  GetSystemQuery,
  GrantDiscoverySourceInput,
  ListDiscoveryGrantsQuery,
  ListRecommendationBatchesQuery,
  ListRecommendationsQuery,
  ListSystemsQuery,
  ListVerificationRunsQuery,
  RecommendationBatchStatus,
  RecommendationStatus,
  RevokeDiscoverySourceInput,
  RunDiscoveryInput,
  SubmitBatchInput,
  SystemConnectionStatus,
  SystemHealth,
  VerifySystemInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const DISCOVERY_GRANT_STATUSES = ['active', 'revoked'] as const;
export const SYSTEM_HEALTHS = ['unknown', 'healthy', 'degraded', 'unreachable'] as const;
export const SYSTEM_CONNECTION_STATUSES = ['discovered', 'connected', 'disconnected'] as const;
export const RECOMMENDATION_STATUSES = [
  'proposed',
  'pending_approval',
  'approved',
  'rejected',
  'connected',
] as const;
export const RECOMMENDATION_BATCH_STATUSES = [
  'pending_request',
  'pending_approval',
  'approved',
  'rejected',
] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_DISCOVERY_MAX_RECORDS = 100;
export const MAX_DISCOVERY_MAX_RECORDS = 200;
export const MIN_BATCH_RECOMMENDATIONS = 1;
export const MAX_BATCH_RECOMMENDATIONS = 100;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_JUSTIFICATION_LENGTH = 2000;
export const MAX_EVIDENCE_OBSERVATIONS = 10;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isDiscoveryGrantStatus(value: unknown): value is DiscoveryGrantStatus {
  return (
    typeof value === 'string' && (DISCOVERY_GRANT_STATUSES as readonly string[]).includes(value)
  );
}

export function isSystemHealth(value: unknown): value is SystemHealth {
  return typeof value === 'string' && (SYSTEM_HEALTHS as readonly string[]).includes(value);
}

export function isSystemConnectionStatus(value: unknown): value is SystemConnectionStatus {
  return (
    typeof value === 'string' &&
    (SYSTEM_CONNECTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isRecommendationStatus(value: unknown): value is RecommendationStatus {
  return (
    typeof value === 'string' && (RECOMMENDATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isRecommendationBatchStatus(value: unknown): value is RecommendationBatchStatus {
  return (
    typeof value === 'string' &&
    (RECOMMENDATION_BATCH_STATUSES as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertIntegrationTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new IntegrationError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new IntegrationError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new IntegrationError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

// ---------------------------------------------------------------------------
// Primitive helpers (house pattern)
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
      throw new IntegrationError(
        'invalid_integration_input',
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new IntegrationError('invalid_integration_input', `'${field}' must be a uuid`);
  }
  return value;
}

function optionalNote(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IntegrationError(
      'invalid_integration_input',
      `'${field}' must be a non-empty string or null`,
    );
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw new IntegrationError(
      'invalid_integration_input',
      `'${field}' must be at most ${MAX_NOTE_LENGTH} characters`,
    );
  }
  return value;
}

function optionalLimit(value: unknown, field: string): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new IntegrationError('invalid_integration_input', `'${field}' must be an integer`);
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw new IntegrationError(
      'invalid_integration_input',
      `'${field}' must be between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const GRANT_INPUT_KEYS = ['sourceId', 'note'] as const;
const REVOKE_INPUT_KEYS = ['grantId'] as const;
const GET_GRANT_QUERY_KEYS = ['grantId'] as const;
const LIST_GRANTS_QUERY_KEYS = ['status', 'limit'] as const;

export interface ValidatedGrantInput {
  sourceId: string;
  note: string | null;
}

export function validateGrantDiscoverySourceInput(input: GrantDiscoverySourceInput): ValidatedGrantInput {
  if (!isPlainObject(input)) {
    throw new IntegrationError('invalid_integration_input', 'grant input must be an object');
  }
  rejectUnknownKeys(input, GRANT_INPUT_KEYS, 'grant input');
  return {
    sourceId: requireUuid(input.sourceId, 'sourceId'),
    note: optionalNote(input.note, 'note'),
  };
}

export interface ValidatedRevokeInput {
  grantId: string;
}

export function validateRevokeDiscoverySourceInput(input: RevokeDiscoverySourceInput): ValidatedRevokeInput {
  if (!isPlainObject(input)) {
    throw new IntegrationError('invalid_integration_input', 'revoke input must be an object');
  }
  rejectUnknownKeys(input, REVOKE_INPUT_KEYS, 'revoke input');
  return {
    grantId: requireUuid(input.grantId, 'grantId'),
  };
}

export function validateGetDiscoveryGrantQuery(query: GetDiscoveryGrantQuery): { grantId: string } {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'grant query must be an object');
  }
  rejectUnknownKeys(query, GET_GRANT_QUERY_KEYS, 'grant query');
  return { grantId: requireUuid(query.grantId, 'grantId') };
}

export interface ValidatedListGrantsQuery {
  status: DiscoveryGrantStatus | null;
  limit: number;
}

export function validateListDiscoveryGrantsQuery(query: ListDiscoveryGrantsQuery): ValidatedListGrantsQuery {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'grants list query must be an object');
  }
  rejectUnknownKeys(query, LIST_GRANTS_QUERY_KEYS, 'grants list query');
  let status: DiscoveryGrantStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isDiscoveryGrantStatus(query.status)) {
      throw new IntegrationError(
        'invalid_integration_input',
        `'status' must be one of ${DISCOVERY_GRANT_STATUSES.join('|')}`,
      );
    }
    status = query.status;
  }
  return { status, limit: optionalLimit(query.limit, 'limit') };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const RUN_DISCOVERY_INPUT_KEYS = ['sourceId', 'maxRecords'] as const;

export interface ValidatedRunDiscoveryInput {
  sourceId: string | null;
  maxRecords: number;
}

export function validateRunDiscoveryInput(input: RunDiscoveryInput): ValidatedRunDiscoveryInput {
  if (!isPlainObject(input)) {
    throw new IntegrationError('invalid_integration_input', 'discovery input must be an object');
  }
  rejectUnknownKeys(input, RUN_DISCOVERY_INPUT_KEYS, 'discovery input');
  let sourceId: string | null = null;
  if (input.sourceId !== undefined && input.sourceId !== null) {
    sourceId = requireUuid(input.sourceId, 'sourceId');
  }
  let maxRecords = DEFAULT_DISCOVERY_MAX_RECORDS;
  if (input.maxRecords !== undefined && input.maxRecords !== null) {
    if (
      typeof input.maxRecords !== 'number' ||
      !Number.isInteger(input.maxRecords) ||
      input.maxRecords < 1 ||
      input.maxRecords > MAX_DISCOVERY_MAX_RECORDS
    ) {
      throw new IntegrationError(
        'invalid_integration_input',
        `'maxRecords' must be an integer between 1 and ${MAX_DISCOVERY_MAX_RECORDS}`,
      );
    }
    maxRecords = input.maxRecords;
  }
  return { sourceId, maxRecords };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const GET_SYSTEM_QUERY_KEYS = ['systemId'] as const;
const LIST_SYSTEMS_QUERY_KEYS = [
  'connectionStatus',
  'health',
  'capabilityClass',
  'dataCategory',
  'search',
  'limit',
] as const;

export function validateGetSystemQuery(query: GetSystemQuery): { systemId: string } {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'system query must be an object');
  }
  rejectUnknownKeys(query, GET_SYSTEM_QUERY_KEYS, 'system query');
  return { systemId: requireUuid(query.systemId, 'systemId') };
}

export interface ValidatedListSystemsQuery {
  connectionStatus: SystemConnectionStatus | null;
  health: SystemHealth | null;
  capabilityClass: string | null;
  dataCategory: string | null;
  search: string | null;
  limit: number;
}

export function validateListSystemsQuery(query: ListSystemsQuery): ValidatedListSystemsQuery {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'systems list query must be an object');
  }
  rejectUnknownKeys(query, LIST_SYSTEMS_QUERY_KEYS, 'systems list query');
  let connectionStatus: SystemConnectionStatus | null = null;
  if (query.connectionStatus !== undefined && query.connectionStatus !== null) {
    if (!isSystemConnectionStatus(query.connectionStatus)) {
      throw new IntegrationError(
        'invalid_integration_input',
        `'connectionStatus' must be one of ${SYSTEM_CONNECTION_STATUSES.join('|')}`,
      );
    }
    connectionStatus = query.connectionStatus;
  }
  let health: SystemHealth | null = null;
  if (query.health !== undefined && query.health !== null) {
    if (!isSystemHealth(query.health)) {
      throw new IntegrationError(
        'invalid_integration_input',
        `'health' must be one of ${SYSTEM_HEALTHS.join('|')}`,
      );
    }
    health = query.health;
  }
  let capabilityClass: string | null = null;
  if (query.capabilityClass !== undefined && query.capabilityClass !== null) {
    if (typeof query.capabilityClass !== 'string' || query.capabilityClass.trim().length === 0) {
      throw new IntegrationError(
        'invalid_integration_input',
        "'capabilityClass' must be a non-empty string",
      );
    }
    capabilityClass = query.capabilityClass.trim();
  }
  let dataCategory: string | null = null;
  if (query.dataCategory !== undefined && query.dataCategory !== null) {
    if (typeof query.dataCategory !== 'string' || query.dataCategory.trim().length === 0) {
      throw new IntegrationError(
        'invalid_integration_input',
        "'dataCategory' must be a non-empty string",
      );
    }
    dataCategory = query.dataCategory.trim();
  }
  let search: string | null = null;
  if (query.search !== undefined && query.search !== null) {
    if (typeof query.search !== 'string' || query.search.trim().length === 0) {
      throw new IntegrationError('invalid_integration_input', "'search' must be a non-empty string");
    }
    search = query.search.trim();
  }
  return { connectionStatus, health, capabilityClass, dataCategory, search, limit: optionalLimit(query.limit, 'limit') };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

const GET_RECOMMENDATION_QUERY_KEYS = ['recommendationId'] as const;
const LIST_RECOMMENDATIONS_QUERY_KEYS = ['status', 'systemId', 'batchId', 'limit'] as const;

export function validateGetRecommendationQuery(query: GetRecommendationQuery): { recommendationId: string } {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'recommendation query must be an object');
  }
  rejectUnknownKeys(query, GET_RECOMMENDATION_QUERY_KEYS, 'recommendation query');
  return { recommendationId: requireUuid(query.recommendationId, 'recommendationId') };
}

export interface ValidatedListRecommendationsQuery {
  status: RecommendationStatus | null;
  systemId: string | null;
  batchId: string | null;
  limit: number;
}

export function validateListRecommendationsQuery(query: ListRecommendationsQuery): ValidatedListRecommendationsQuery {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'recommendations list query must be an object');
  }
  rejectUnknownKeys(query, LIST_RECOMMENDATIONS_QUERY_KEYS, 'recommendations list query');
  let status: RecommendationStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isRecommendationStatus(query.status)) {
      throw new IntegrationError(
        'invalid_integration_input',
        `'status' must be one of ${RECOMMENDATION_STATUSES.join('|')}`,
      );
    }
    status = query.status;
  }
  let systemId: string | null = null;
  if (query.systemId !== undefined && query.systemId !== null) {
    systemId = requireUuid(query.systemId, 'systemId');
  }
  let batchId: string | null = null;
  if (query.batchId !== undefined && query.batchId !== null) {
    batchId = requireUuid(query.batchId, 'batchId');
  }
  return { status, systemId, batchId, limit: optionalLimit(query.limit, 'limit') };
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

const SUBMIT_BATCH_INPUT_KEYS = ['recommendationIds', 'justification'] as const;
const DECIDE_BATCH_INPUT_KEYS = ['batchId', 'decision', 'note'] as const;
const GET_BATCH_QUERY_KEYS = ['batchId'] as const;
const LIST_BATCHES_QUERY_KEYS = ['status', 'limit'] as const;

export interface ValidatedSubmitBatchInput {
  recommendationIds: string[];
  justification: string | null;
}

export function validateSubmitBatchInput(input: SubmitBatchInput): ValidatedSubmitBatchInput {
  if (!isPlainObject(input)) {
    throw new IntegrationError('invalid_integration_input', 'batch input must be an object');
  }
  rejectUnknownKeys(input, SUBMIT_BATCH_INPUT_KEYS, 'batch input');
  const raw = input.recommendationIds;
  if (
    !Array.isArray(raw) ||
    raw.length < MIN_BATCH_RECOMMENDATIONS ||
    raw.length > MAX_BATCH_RECOMMENDATIONS
  ) {
    throw new IntegrationError(
      'invalid_integration_input',
      `'recommendationIds' must be an array of ${MIN_BATCH_RECOMMENDATIONS}..${MAX_BATCH_RECOMMENDATIONS} uuids`,
    );
  }
  const recommendationIds: string[] = [];
  for (const entry of raw) {
    const id = requireUuid(entry, 'recommendationIds[]');
    if (recommendationIds.includes(id)) {
      throw new IntegrationError(
        'invalid_integration_input',
        `'recommendationIds' contains duplicate '${id}'`,
      );
    }
    recommendationIds.push(id);
  }
  let justification: string | null = null;
  if (input.justification !== undefined && input.justification !== null) {
    if (
      typeof input.justification !== 'string' ||
      input.justification.trim().length === 0 ||
      input.justification.length > MAX_JUSTIFICATION_LENGTH
    ) {
      throw new IntegrationError(
        'invalid_integration_input',
        `'justification' must be a non-empty string of at most ${MAX_JUSTIFICATION_LENGTH} characters`,
      );
    }
    justification = input.justification.trim();
  }
  return { recommendationIds, justification };
}

export interface ValidatedDecideBatchInput {
  batchId: string;
  decision: 'approve' | 'reject';
  note: string | null;
}

export function validateDecideBatchInput(input: DecideBatchInput): ValidatedDecideBatchInput {
  if (!isPlainObject(input)) {
    throw new IntegrationError('invalid_integration_input', 'decision input must be an object');
  }
  rejectUnknownKeys(input, DECIDE_BATCH_INPUT_KEYS, 'decision input');
  if (input.decision !== 'approve' && input.decision !== 'reject') {
    throw new IntegrationError('invalid_integration_input', "'decision' must be 'approve' or 'reject'");
  }
  return {
    batchId: requireUuid(input.batchId, 'batchId'),
    decision: input.decision,
    note: optionalNote(input.note, 'note'),
  };
}

export function validateGetRecommendationBatchQuery(query: GetRecommendationBatchQuery): { batchId: string } {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'batch query must be an object');
  }
  rejectUnknownKeys(query, GET_BATCH_QUERY_KEYS, 'batch query');
  return { batchId: requireUuid(query.batchId, 'batchId') };
}

export interface ValidatedListBatchesQuery {
  status: RecommendationBatchStatus | null;
  limit: number;
}

export function validateListRecommendationBatchesQuery(query: ListRecommendationBatchesQuery): ValidatedListBatchesQuery {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'batches list query must be an object');
  }
  rejectUnknownKeys(query, LIST_BATCHES_QUERY_KEYS, 'batches list query');
  let status: RecommendationBatchStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isRecommendationBatchStatus(query.status)) {
      throw new IntegrationError(
        'invalid_integration_input',
        `'status' must be one of ${RECOMMENDATION_BATCH_STATUSES.join('|')}`,
      );
    }
    status = query.status;
  }
  return { status, limit: optionalLimit(query.limit, 'limit') };
}

// ---------------------------------------------------------------------------
// Connection + verification
// ---------------------------------------------------------------------------

const CONNECT_INPUT_KEYS = ['recommendationId'] as const;
const VERIFY_INPUT_KEYS = ['systemId'] as const;
const LIST_VERIFICATIONS_QUERY_KEYS = ['systemId', 'recommendationId', 'limit'] as const;

export function validateConnectSystemInput(input: ConnectSystemInput): { recommendationId: string } {
  if (!isPlainObject(input)) {
    throw new IntegrationError('invalid_integration_input', 'connect input must be an object');
  }
  rejectUnknownKeys(input, CONNECT_INPUT_KEYS, 'connect input');
  return { recommendationId: requireUuid(input.recommendationId, 'recommendationId') };
}

export function validateVerifySystemInput(input: VerifySystemInput): { systemId: string } {
  if (!isPlainObject(input)) {
    throw new IntegrationError('invalid_integration_input', 'verify input must be an object');
  }
  rejectUnknownKeys(input, VERIFY_INPUT_KEYS, 'verify input');
  return { systemId: requireUuid(input.systemId, 'systemId') };
}

export interface ValidatedListVerificationRunsQuery {
  systemId: string | null;
  recommendationId: string | null;
  limit: number;
}

export function validateListVerificationRunsQuery(query: ListVerificationRunsQuery): ValidatedListVerificationRunsQuery {
  if (!isPlainObject(query)) {
    throw new IntegrationError('invalid_integration_input', 'verifications list query must be an object');
  }
  rejectUnknownKeys(query, LIST_VERIFICATIONS_QUERY_KEYS, 'verifications list query');
  let systemId: string | null = null;
  if (query.systemId !== undefined && query.systemId !== null) {
    systemId = requireUuid(query.systemId, 'systemId');
  }
  let recommendationId: string | null = null;
  if (query.recommendationId !== undefined && query.recommendationId !== null) {
    recommendationId = requireUuid(query.recommendationId, 'recommendationId');
  }
  return { systemId, recommendationId, limit: optionalLimit(query.limit, 'limit') };
}
