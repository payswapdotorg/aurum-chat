// Pure validation/normalization logic of the provider-fabric module
// (W132). No database, no transport, no clock — everything a caller may
// put into a provider definition, a catalog entry, a discovery run, a
// model binding or a health record crosses these guards first; the SQL
// CHECK constraints in migrations/001 mirror the load-bearing rules as
// defense in depth.
//
// TWO ORDERING LAWS carry the prior-execution failure lessons:
//
//   ALLOWED-KEYS-FIRST (lesson 1): every validator rejects unknown INPUT
//   KEYS *before* it scans any VALUE for credential payloads. The
//   allowed-key sets are closed, so legitimate field names
//   (`contextWindowTokens`, `maxOutputTokens`, `price*`) are never
//   conflated with credential payloads — an unknown `apiKey` key fails as
//   an unknown field, and only the values of *allowed* free-text fields
//   are ever credential-scanned.
//
//   SAMPLE-INPUT STRIPPING (lesson 2): the model-sample validator
//   (`validateModelSample`) accepts ONLY the sample's own keys. Reference
//   and system-minted keys (`definitionId`, `entryId`, `origin`,
//   `discoveredAt`, `status`, `tenantId`) are stripped from the wrapper
//   BEFORE the sample validator runs — the manual-registration path
//   validates the sample in isolation and attaches the definition
//   reference afterwards, so no wrapper can ever smuggle a system key
//   through the sample gate.
//
// CREDENTIAL-SUBSTRING LAW (lesson 3): `containsCredentialLikeToken` is
// UNANCHORED — it catches credential-like tokens embedded ANYWHERE in a
// string (URL userinfo/hosts such as `https://sk-…@api.example.com`,
// query strings, prose notes), not only bare anchored patterns, while the
// prefix-boundary and key-name constraints keep legitimate prose
// (`task-2026…`, `context window 128000 tokens`) clean.

import type { TenantContext } from '@/infra/tenant';
import { isLlmProvider, LLM_PROVIDERS } from '@/modules/llm/contract';
import { ProviderFabricError } from './errors';
import type {
  ActiveBindingQuery,
  AttachModelBindingInput,
  BindingSwapEvidenceQuery,
  ConnectKnownProviderInput,
  ListModelBindingsQuery,
  ListModelCatalogQuery,
  ListProviderDefinitionsQuery,
  ListProviderHealthStatesQuery,
  ModelBindingPurpose,
  ProviderDefinitionKind,
  RecordProviderHealthInput,
  RegisterCustomProviderInput,
  RegisterModelManuallyInput,
  UpdateProviderDefinitionInput,
  WireProtocolKind,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (mirrored by migrations/001 where SQL can express them)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_LABEL_LENGTH = 100;
export const MAX_PROVIDER_SLUG_LENGTH = 64;
export const MAX_BASE_URL_LENGTH = 2048;
export const MAX_MODEL_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 255;
export const MAX_NOTE_LENGTH = 500;
export const MAX_ERROR_LENGTH = 500;
export const MAX_TOKENS = 2_000_000_000;

/** Tenant-chosen custom provider slug: a lowercase URL-safe slug. */
export const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Opaque provider-minted strings — printable (control characters excluded).
const PRINTABLE_ID_PATTERN = /^[^\p{Cc}]{1,255}$/u;

// ---------------------------------------------------------------------------
// Vocabularies (the frozen type unions, as runtime guards)
// ---------------------------------------------------------------------------

export const WIRE_PROTOCOLS = [
  'openai-compatible',
  'anthropic-compatible',
  'google-compatible',
  'mistral-compatible',
  'cohere-compatible',
] as const;

export const MODEL_BINDING_PURPOSES = ['cognition', 'conversation', 'analysis', 'background'] as const;

export const MODEL_CATALOG_CAPABILITIES = ['text-generation', 'embedding'] as const;

export type ModelCatalogCapability = (typeof MODEL_CATALOG_CAPABILITIES)[number];

/**
 * The wire protocol each W034 known provider speaks — the fabric's
 * code-owned copy of the adapter-set truth (deepseek/groq speak the
 * OpenAI-compatible dialect; see llm/adapters/index.ts). A custom
 * provider NEVER gets an entry here: it reuses one of these dialects.
 */
export const PROVIDER_WIRE_PROTOCOLS: Readonly<Record<string, WireProtocolKind>> = {
  openai: 'openai-compatible',
  anthropic: 'anthropic-compatible',
  google: 'google-compatible',
  mistral: 'mistral-compatible',
  cohere: 'cohere-compatible',
  deepseek: 'openai-compatible',
  groq: 'openai-compatible',
};

/** The wire protocol for a W034 known provider (null when the slug is not in the vocabulary). */
export function knownProviderWireProtocol(provider: string): WireProtocolKind | null {
  return PROVIDER_WIRE_PROTOCOLS[provider] ?? null;
}

export function isWireProtocolKind(value: unknown): value is WireProtocolKind {
  return typeof value === 'string' && (WIRE_PROTOCOLS as readonly string[]).includes(value);
}

export function isModelBindingPurpose(value: unknown): value is ModelBindingPurpose {
  return (
    typeof value === 'string' && (MODEL_BINDING_PURPOSES as readonly string[]).includes(value)
  );
}

export function isModelCatalogCapability(value: unknown): value is ModelCatalogCapability {
  return (
    typeof value === 'string' &&
    (MODEL_CATALOG_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isProviderDefinitionKind(value: unknown): value is ProviderDefinitionKind {
  return typeof value === 'string' && (['known', 'custom'] as const).includes(value as never);
}

// ---------------------------------------------------------------------------
// Credential-substring detection (UNANCHORED — lesson 3)
// ---------------------------------------------------------------------------

/**
 * Well-known credential token shapes, matched UNANCHORED so a token
 * embedded in a URL host/userinfo/query or in prose is caught exactly
 * like a bare one. The `sk-` family carries a left boundary so ordinary
 * hyphenated prose (`task-20261004120000`) never trips it.
 */
const CREDENTIAL_TOKEN_PATTERNS: readonly RegExp[] = [
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{12,}/i, // OpenAI/Anthropic-style keys (sk-, sk-ant-, sk-proj-…)
  /bearer\s+[a-z0-9._~+/=-]{16,}/i, // Bearer tokens
  /ghp_[a-z0-9]{20,}/i, // GitHub personal access tokens
  /github_pat_[a-z0-9_]{20,}/i, // GitHub fine-grained tokens
  /akia[0-9a-z]{16}/i, // AWS access key ids
  /xox[abprs]-[a-z0-9-]{10,}/i, // Slack tokens
  /aiza[0-9a-z_-]{30,}/i, // Google API keys
  /(?:api[-_]?key|apikey|secret|password|credential)\s*[:=]\s*["']?[a-z0-9+/_-]{12,}/i, // credential assignments in prose/forms
];

/** True when `text` contains a credential-like token ANYWHERE inside it. */
export function containsCredentialLikeToken(text: string): boolean {
  for (const pattern of CREDENTIAL_TOKEN_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Sanitizes a USER-SUPPLIED note: trims, caps the length, and REJECTS
 * credential-shaped content with the typed `credential_payload_rejected`
 * (credentials live only in the credential-ref mechanism — a note is
 * never the place for them; rejecting is louder and safer than redacting).
 */
export function sanitizeUserNote(value: unknown, field = 'note'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw inputError(`${field} must be a string when present`);
  }
  const text = value.trim();
  if (text === '') return null;
  if (text.length > MAX_NOTE_LENGTH) {
    throw inputError(`${field} must be at most ${MAX_NOTE_LENGTH} characters (got ${text.length})`);
  }
  if (containsCredentialLikeToken(text)) {
    throw credentialError(
      `${field} contains credential-shaped content — credentials live only in the credential-ref mechanism, never in ${field}`,
    );
  }
  return text;
}

/**
 * Sanitizes TRANSPORT-DERIVED detail before it is persisted: a null/empty
 * detail becomes `fallback`; an over-long detail is truncated; and a
 * detail containing credential-like material is replaced wholesale with a
 * fixed withheld phrase (the transport is infrastructure — a raw provider
 * error dump must never land in the discovery state or health notes).
 */
export function sanitizeTransportDetail(detail: string | null, fallback: string): string {
  if (detail === null) return fallback;
  const text = detail.trim();
  if (text === '') return fallback;
  if (containsCredentialLikeToken(text)) {
    return 'provider error detail withheld (sanitized)';
  }
  if (text.length > MAX_ERROR_LENGTH) {
    return `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Small helpers (the llm module's proven shapes)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function inputError(message: string): ProviderFabricError {
  return new ProviderFabricError('invalid_input', message);
}

function queryError(message: string): ProviderFabricError {
  return new ProviderFabricError('invalid_query', message);
}

function credentialError(message: string): ProviderFabricError {
  return new ProviderFabricError('credential_payload_rejected', message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function requirePrintable(value: unknown, field: string, maxLength: number): string {
  const text = requireString(value, field);
  if (text.length > maxLength) {
    throw inputError(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  if (!PRINTABLE_ID_PATTERN.test(text)) {
    throw inputError(
      `${field} must be 1..${maxLength} printable characters without control characters`,
    );
  }
  return text;
}

function boundedLabel(value: unknown, field: string): string {
  return requirePrintable(value, field, MAX_LABEL_LENGTH);
}

function requireBoundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw inputError(`${field} must be an integer (got ${String(value)})`);
  }
  if (value < min || value > max) {
    throw inputError(`${field} must be between ${min} and ${max} (got ${String(value)})`);
  }
  return value;
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw queryError(`limit must be an integer (got ${String(value)})`);
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw queryError(`limit must be between 1 and ${MAX_LIST_LIMIT} (got ${String(value)})`);
  }
  return value;
}

/** Rejects unknown keys — ALWAYS the first check of every validator (lesson 1). */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw inputError(
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// TenantContext
// ---------------------------------------------------------------------------

export function assertProviderFabricTenantContext(context: {
  tenantId: string;
  principalId: string;
  authority: string[];
}): void {
  if (
    typeof context.tenantId !== 'string' ||
    context.tenantId === '' ||
    typeof context.principalId !== 'string' ||
    context.principalId === '' ||
    !Array.isArray(context.authority)
  ) {
    throw new ProviderFabricError(
      'invalid_context',
      'the provider fabric requires an explicit tenant context (tenantId, principalId, authority)',
    );
  }
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const CONNECT_KNOWN_KEYS = ['provider', 'label'] as const;
const REGISTER_CUSTOM_KEYS = ['provider', 'label', 'baseUrl', 'wireProtocol'] as const;
const UPDATE_DEFINITION_KEYS = ['definitionId', 'label', 'status'] as const;
const LIST_DEFINITIONS_KEYS = ['kind', 'status', 'provider', 'limit'] as const;

export interface ValidatedConnectKnownProviderInput {
  provider: string;
  label: string;
}

export function validateConnectKnownProviderInput(
  input: ConnectKnownProviderInput,
): ValidatedConnectKnownProviderInput {
  if (!isPlainObject(input)) throw inputError('the known-provider connect input must be an object');
  // Lesson 1: keys first — an unknown `apiKey` key fails HERE, never in the
  // credential-value scan below.
  rejectUnknownKeys(input, CONNECT_KNOWN_KEYS, 'the known-provider connect input');

  if (typeof input.provider !== 'string' || !isLlmProvider(input.provider)) {
    throw new ProviderFabricError(
      'unsupported_provider',
      `provider must be one of the W034 registry providers (${LLM_PROVIDERS.join(', ')}) (got '${String(input.provider)}')`,
    );
  }
  let label: string = input.provider;
  if (input.label !== undefined && input.label !== null) {
    label = boundedLabel(input.label, 'label');
  }
  if (containsCredentialLikeToken(label)) {
    throw credentialError('label contains credential-shaped content');
  }
  return { provider: input.provider, label };
}

export interface ValidatedRegisterCustomProviderInput {
  provider: string;
  label: string;
  baseUrl: string;
  wireProtocol: WireProtocolKind;
}

export function validateRegisterCustomProviderInput(
  input: RegisterCustomProviderInput,
): ValidatedRegisterCustomProviderInput {
  if (!isPlainObject(input)) throw inputError('the custom-provider input must be an object');
  rejectUnknownKeys(input, REGISTER_CUSTOM_KEYS, 'the custom-provider input');

  const provider = requireString(input.provider, 'provider');
  if (!PROVIDER_SLUG_PATTERN.test(provider)) {
    throw inputError(
      `provider must be a lowercase slug matching ${PROVIDER_SLUG_PATTERN.source} (got '${provider}')`,
    );
  }
  if (isLlmProvider(provider)) {
    throw new ProviderFabricError(
      'provider_slug_reserved',
      `the custom provider slug '${provider}' is reserved by the W034 known-provider vocabulary — choose a different slug`,
    );
  }
  const label = boundedLabel(input.label, 'label');
  if (containsCredentialLikeToken(label)) {
    throw credentialError('label contains credential-shaped content');
  }

  const baseUrl = validateBaseUrl(input.baseUrl);

  if (!isWireProtocolKind(input.wireProtocol)) {
    throw new ProviderFabricError(
      'unsupported_wire_protocol',
      `wireProtocol must be one of the existing wire protocols (${WIRE_PROTOCOLS.join(', ')}) — a custom provider never invents a protocol dialect (got '${String(input.wireProtocol)}')`,
    );
  }
  return { provider, label, baseUrl, wireProtocol: input.wireProtocol };
}

/**
 * A custom provider base URL: http(s), no userinfo, no embedded
 * credential-like token anywhere (UNANCHORED scan — lesson 3).
 */
function validateBaseUrl(value: unknown): string {
  const raw = requireString(value, 'baseUrl');
  if (raw.length > MAX_BASE_URL_LENGTH) {
    throw inputError(`baseUrl must be at most ${MAX_BASE_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw inputError(`baseUrl must be a valid http(s) URL (got '${raw}')`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw inputError(`baseUrl must use http or https (got '${parsed.protocol}')`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw credentialError(
      'baseUrl must not carry embedded credentials (userinfo) — credentials live only in the credential-ref mechanism',
    );
  }
  if (containsCredentialLikeToken(raw)) {
    throw credentialError(
      'baseUrl contains credential-shaped content — credentials live only in the credential-ref mechanism',
    );
  }
  return raw;
}

export interface ValidatedUpdateProviderDefinitionInput {
  definitionId: string;
  label: string | null;
  status: 'active' | 'disabled' | null;
}

export function validateUpdateProviderDefinitionInput(
  input: UpdateProviderDefinitionInput,
): ValidatedUpdateProviderDefinitionInput {
  if (!isPlainObject(input)) throw inputError('the definition update input must be an object');
  rejectUnknownKeys(input, UPDATE_DEFINITION_KEYS, 'the definition update input');

  const definitionId = requireString(input.definitionId, 'definitionId');
  let label: string | null = null;
  if (input.label !== undefined && input.label !== null) {
    label = boundedLabel(input.label, 'label');
    if (containsCredentialLikeToken(label)) {
      throw credentialError('label contains credential-shaped content');
    }
  }
  let status: 'active' | 'disabled' | null = null;
  if (input.status !== undefined && input.status !== null) {
    if (input.status !== 'active' && input.status !== 'disabled') {
      throw inputError(`status must be 'active' or 'disabled' (got '${String(input.status)}')`);
    }
    status = input.status;
  }
  if (label === null && status === null) {
    throw inputError('the definition update must carry at least one of label, status');
  }
  return { definitionId, label, status };
}

export interface ValidatedListDefinitionsQuery {
  kind: ProviderDefinitionKind | null;
  status: 'active' | 'disabled' | null;
  provider: string | null;
  limit: number;
}

export function validateListProviderDefinitionsQuery(
  query: ListProviderDefinitionsQuery,
): ValidatedListDefinitionsQuery {
  if (!isPlainObject(query)) throw queryError('the definition list query must be an object');
  rejectUnknownKeys(query, LIST_DEFINITIONS_KEYS, 'the definition list query');

  let kind: ProviderDefinitionKind | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (!isProviderDefinitionKind(query.kind)) {
      throw queryError(`kind must be 'known' or 'custom' (got '${String(query.kind)}')`);
    }
    kind = query.kind;
  }
  let status: 'active' | 'disabled' | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (query.status !== 'active' && query.status !== 'disabled') {
      throw queryError(`status must be 'active' or 'disabled' (got '${String(query.status)}')`);
    }
    status = query.status;
  }
  let provider: string | null = null;
  if (query.provider !== undefined && query.provider !== null) {
    provider = requirePrintable(query.provider, 'provider', MAX_PROVIDER_SLUG_LENGTH);
  }
  return { kind, status, provider, limit: requireLimit(query.limit) };
}

// ---------------------------------------------------------------------------
// Catalog — the SAMPLE validator (lesson 2) and the manual input
// ---------------------------------------------------------------------------

/**
 * The model sample's OWN keys — and nothing else. Reference and
 * system-minted keys (definitionId, entryId, origin, discoveredAt,
 * status, tenantId) are NEVER in this set: the sample validator is pure
 * model payload, and any wrapper must strip such keys before calling it.
 */
export const MODEL_SAMPLE_KEYS = [
  'modelId',
  'displayName',
  'capabilities',
  'contextWindowTokens',
  'maxOutputTokens',
  'priceInputMinorPerMillion',
  'priceOutputMinorPerMillion',
] as const;

export interface ValidatedModelSample {
  modelId: string;
  displayName: string | null;
  capabilities: ModelCatalogCapability[];
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  priceInputMinorPerMillion: number | null;
  priceOutputMinorPerMillion: number | null;
}

/**
 * Validates a bare model sample. `provider_malformed_response` (not
 * `invalid_input`) when the sample comes from a transport receipt — the
 * caller decides which: `fromTransport` marks samples produced by
 * infrastructure, where a bad shape is an internal invariant violation.
 */
export function validateModelSample(
  sample: unknown,
  fromTransport: boolean,
): ValidatedModelSample {
  const bad = (message: string): ProviderFabricError =>
    fromTransport
      ? new ProviderFabricError('provider_malformed_response', message)
      : inputError(message);
  if (!isPlainObject(sample)) {
    throw bad('a model sample must be an object');
  }
  // Lesson 2: the sample gate — reference/system keys are unknown HERE.
  rejectUnknownKeys(sample, MODEL_SAMPLE_KEYS, 'the model sample');

  let modelId: string;
  try {
    modelId = requirePrintable(sample.modelId, 'modelId', MAX_MODEL_ID_LENGTH);
  } catch (error) {
    throw bad((error as ProviderFabricError).message);
  }
  if (containsCredentialLikeToken(modelId)) {
    throw credentialError('modelId contains credential-shaped content');
  }

  let displayName: string | null = null;
  if (sample.displayName !== undefined && sample.displayName !== null) {
    if (typeof sample.displayName !== 'string') {
      throw bad('displayName must be a string when present');
    }
    const text = sample.displayName.trim();
    if (text !== '') {
      if (text.length > MAX_DISPLAY_NAME_LENGTH) {
        throw bad(`displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`);
      }
      if (containsCredentialLikeToken(text)) {
        throw credentialError('displayName contains credential-shaped content');
      }
      displayName = text;
    }
  }

  let capabilities: ModelCatalogCapability[] = [];
  if (sample.capabilities !== undefined && sample.capabilities !== null) {
    if (!Array.isArray(sample.capabilities)) {
      throw bad('capabilities must be an array when present');
    }
    const seen = new Set<ModelCatalogCapability>();
    for (const capability of sample.capabilities) {
      if (!isModelCatalogCapability(capability)) {
        throw bad(
          `capabilities entries must be one of ${MODEL_CATALOG_CAPABILITIES.join(', ')} (got '${String(capability)}')`,
        );
      }
      if (!seen.has(capability)) seen.add(capability);
    }
    capabilities = [...seen];
  }

  const numeric = (value: unknown, field: string, min: number): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > MAX_TOKENS) {
      throw bad(`${field} must be an integer between ${min} and ${MAX_TOKENS}`);
    }
    return value;
  };

  return {
    modelId,
    displayName,
    capabilities,
    contextWindowTokens: numeric(sample.contextWindowTokens, 'contextWindowTokens', 1),
    maxOutputTokens: numeric(sample.maxOutputTokens, 'maxOutputTokens', 0),
    priceInputMinorPerMillion: numeric(sample.priceInputMinorPerMillion, 'priceInputMinorPerMillion', 0),
    priceOutputMinorPerMillion: numeric(sample.priceOutputMinorPerMillion, 'priceOutputMinorPerMillion', 0),
  };
}

const REGISTER_MODEL_KEYS = ['definitionId', ...MODEL_SAMPLE_KEYS] as const;

export interface ValidatedRegisterModelInput {
  definitionId: string;
  sample: ValidatedModelSample;
}

export function validateRegisterModelInput(
  input: RegisterModelManuallyInput,
): ValidatedRegisterModelInput {
  if (!isPlainObject(input)) {
    throw inputError('the manual model registration input must be an object');
  }
  rejectUnknownKeys(input, REGISTER_MODEL_KEYS, 'the manual model registration input');

  const definitionId = requireString(input.definitionId, 'definitionId');

  // Lesson 2: strip the reference key before the sample validator runs —
  // the sample gate sees ONLY the sample's own keys.
  const sampleWrapper: Record<string, unknown> = {};
  for (const key of MODEL_SAMPLE_KEYS) {
    if (input[key] !== undefined) sampleWrapper[key] = input[key];
  }
  const sample = validateModelSample(sampleWrapper, false);

  if (sample.displayName === null) {
    throw inputError('displayName is required for manual registration');
  }
  return { definitionId, sample: { ...sample, displayName: sample.displayName } };
}

const LIST_CATALOG_KEYS = ['definitionId', 'origin', 'status', 'capability', 'limit'] as const;

export interface ValidatedListCatalogQuery {
  definitionId: string | null;
  origin: 'discovered' | 'manual' | null;
  status: 'available' | 'unavailable' | null;
  capability: ModelCatalogCapability | null;
  limit: number;
}

export function validateListModelCatalogQuery(
  query: ListModelCatalogQuery,
): ValidatedListCatalogQuery {
  if (!isPlainObject(query)) throw queryError('the catalog list query must be an object');
  rejectUnknownKeys(query, LIST_CATALOG_KEYS, 'the catalog list query');

  let definitionId: string | null = null;
  if (query.definitionId !== undefined && query.definitionId !== null) {
    definitionId = requireString(query.definitionId, 'definitionId');
    if (!UUID_PATTERN.test(definitionId)) {
      throw queryError(`definitionId must be a uuid when filtering the catalog (got '${definitionId}')`);
    }
  }
  let origin: 'discovered' | 'manual' | null = null;
  if (query.origin !== undefined && query.origin !== null) {
    if (query.origin !== 'discovered' && query.origin !== 'manual') {
      throw queryError(`origin must be 'discovered' or 'manual' (got '${String(query.origin)}')`);
    }
    origin = query.origin;
  }
  let status: 'available' | 'unavailable' | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (query.status !== 'available' && query.status !== 'unavailable') {
      throw queryError(`status must be 'available' or 'unavailable' (got '${String(query.status)}')`);
    }
    status = query.status;
  }
  let capability: ModelCatalogCapability | null = null;
  if (query.capability !== undefined && query.capability !== null) {
    if (!isModelCatalogCapability(query.capability)) {
      throw queryError(
        `capability must be one of ${MODEL_CATALOG_CAPABILITIES.join(', ')} (got '${String(query.capability)}')`,
      );
    }
    capability = query.capability;
  }
  return { definitionId, origin, status, capability, limit: requireLimit(query.limit) };
}

// ---------------------------------------------------------------------------
// Discovery inputs and receipts
// ---------------------------------------------------------------------------

const DEFINITION_REF_KEYS = ['definitionId'] as const;

/** Any single-definition reference query (get/verify/health/discovery share the shape). */
export function validateDefinitionRefQuery(input: unknown): { definitionId: string } {
  if (!isPlainObject(input)) throw queryError('the definition reference query must be an object');
  rejectUnknownKeys(input, DEFINITION_REF_KEYS, 'the definition reference query');
  return { definitionId: requireString(input.definitionId, 'definitionId') };
}

export function validateRunModelDiscoveryInput(input: unknown): { definitionId: string } {
  if (!isPlainObject(input)) throw inputError('the discovery input must be an object');
  rejectUnknownKeys(input, DEFINITION_REF_KEYS, 'the discovery input');
  return { definitionId: requireString(input.definitionId, 'definitionId') };
}

export interface ValidatedDiscoveryReceipt {
  status: 'succeeded' | 'unsupported' | 'failed';
  models: ValidatedModelSample[];
  detail: string | null;
}

/**
 * Normalizes and validates a transport receipt: status vocabulary, models
 * (each sample through the SAMPLE gate — transport data is infrastructure
 * output, so malformed shapes are `provider_malformed_response`), and the
 * detail (shape only here; sanitization happens at persist time).
 */
export function validateDiscoveryReceipt(receipt: unknown): ValidatedDiscoveryReceipt {
  if (!isPlainObject(receipt)) {
    throw new ProviderFabricError('provider_malformed_response', 'a discovery receipt must be an object');
  }
  rejectUnknownKeys(
    receipt,
    ['status', 'models', 'detail'],
    'the discovery receipt',
  );
  if (
    receipt.status !== 'succeeded' &&
    receipt.status !== 'unsupported' &&
    receipt.status !== 'failed'
  ) {
    throw new ProviderFabricError(
      'provider_malformed_response',
      `the discovery receipt status must be 'succeeded', 'unsupported' or 'failed' (got '${String(receipt.status)}')`,
    );
  }
  let models: ValidatedModelSample[] = [];
  if (receipt.models !== undefined && receipt.models !== null) {
    if (!Array.isArray(receipt.models)) {
      throw new ProviderFabricError('provider_malformed_response', 'the discovery receipt models must be an array');
    }
    models = receipt.models.map((sample) => validateModelSample(sample, true));
  }
  if (receipt.status === 'succeeded') {
    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model.modelId)) {
        throw new ProviderFabricError(
          'provider_malformed_response',
          `the discovery receipt lists model '${model.modelId}' twice`,
        );
      }
      seen.add(model.modelId);
    }
  } else {
    models = [];
  }
  let detail: string | null = null;
  if (receipt.detail !== undefined && receipt.detail !== null) {
    if (typeof receipt.detail !== 'string') {
      throw new ProviderFabricError('provider_malformed_response', 'the discovery receipt detail must be a string when present');
    }
    detail = receipt.detail.trim() === '' ? null : receipt.detail.trim();
  }
  return { status: receipt.status, models, detail };
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

const ATTACH_BINDING_KEYS = ['purpose', 'definitionId', 'modelId', 'accountId'] as const;
const LIST_BINDINGS_KEYS = ['purpose', 'status', 'limit'] as const;
const SWAP_EVIDENCE_KEYS = ['purpose'] as const;
const ACTIVE_BINDING_KEYS = ['purpose'] as const;

export interface ValidatedAttachModelBindingInput {
  purpose: ModelBindingPurpose;
  definitionId: string;
  modelId: string;
  accountId: string;
}

export function validateAttachModelBindingInput(
  input: AttachModelBindingInput,
): ValidatedAttachModelBindingInput {
  if (!isPlainObject(input)) throw inputError('the binding input must be an object');
  rejectUnknownKeys(input, ATTACH_BINDING_KEYS, 'the binding input');

  if (!isModelBindingPurpose(input.purpose)) {
    throw inputError(
      `purpose must be one of ${MODEL_BINDING_PURPOSES.join(', ')} (got '${String(input.purpose)}')`,
    );
  }
  const definitionId = requireString(input.definitionId, 'definitionId');
  const modelId = requirePrintable(input.modelId, 'modelId', MAX_MODEL_ID_LENGTH);
  if (containsCredentialLikeToken(modelId)) {
    throw credentialError('modelId contains credential-shaped content');
  }
  const accountId = requireString(input.accountId, 'accountId');
  if (!UUID_PATTERN.test(accountId)) {
    throw inputError(`accountId must be a uuid (got '${accountId}')`);
  }
  return { purpose: input.purpose, definitionId, modelId, accountId };
}

export interface ValidatedPurposeQuery {
  purpose: ModelBindingPurpose;
}

export function validateActiveBindingQuery(query: ActiveBindingQuery): ValidatedPurposeQuery {
  if (!isPlainObject(query)) throw queryError('the active-binding query must be an object');
  rejectUnknownKeys(query, ACTIVE_BINDING_KEYS, 'the active-binding query');
  if (!isModelBindingPurpose(query.purpose)) {
    throw queryError(
      `purpose must be one of ${MODEL_BINDING_PURPOSES.join(', ')} (got '${String(query.purpose)}')`,
    );
  }
  return { purpose: query.purpose };
}

export function validateBindingSwapEvidenceQuery(query: BindingSwapEvidenceQuery): ValidatedPurposeQuery {
  if (!isPlainObject(query)) throw queryError('the swap-evidence query must be an object');
  rejectUnknownKeys(query, SWAP_EVIDENCE_KEYS, 'the swap-evidence query');
  if (!isModelBindingPurpose(query.purpose)) {
    throw queryError(
      `purpose must be one of ${MODEL_BINDING_PURPOSES.join(', ')} (got '${String(query.purpose)}')`,
    );
  }
  return { purpose: query.purpose };
}

export interface ValidatedListBindingsQuery {
  purpose: ModelBindingPurpose | null;
  status: 'active' | 'superseded' | null;
  limit: number;
}

export function validateListModelBindingsQuery(
  query: ListModelBindingsQuery,
): ValidatedListBindingsQuery {
  if (!isPlainObject(query)) throw queryError('the binding list query must be an object');
  rejectUnknownKeys(query, LIST_BINDINGS_KEYS, 'the binding list query');

  let purpose: ModelBindingPurpose | null = null;
  if (query.purpose !== undefined && query.purpose !== null) {
    if (!isModelBindingPurpose(query.purpose)) {
      throw queryError(
        `purpose must be one of ${MODEL_BINDING_PURPOSES.join(', ')} (got '${String(query.purpose)}')`,
      );
    }
    purpose = query.purpose;
  }
  let status: 'active' | 'superseded' | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (query.status !== 'active' && query.status !== 'superseded') {
      throw queryError(`status must be 'active' or 'superseded' (got '${String(query.status)}')`);
    }
    status = query.status;
  }
  return { purpose, status, limit: requireLimit(query.limit) };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const RECORD_HEALTH_KEYS = ['definitionId', 'state', 'basis', 'note'] as const;
const LIST_HEALTH_KEYS = ['state', 'limit'] as const;

export interface ValidatedRecordHealthInput {
  definitionId: string;
  state: 'available' | 'unavailable';
  basis: 'manual' | 'execution';
  note: string | null;
}

export function validateRecordProviderHealthInput(
  input: RecordProviderHealthInput,
): ValidatedRecordHealthInput {
  if (!isPlainObject(input)) throw inputError('the health record input must be an object');
  rejectUnknownKeys(input, RECORD_HEALTH_KEYS, 'the health record input');

  const definitionId = requireString(input.definitionId, 'definitionId');
  if (input.state !== 'available' && input.state !== 'unavailable') {
    throw inputError(
      `state must be 'available' or 'unavailable' — 'unknown' is the honest default the fabric mints itself, never a caller assertion (got '${String(input.state)}')`,
    );
  }
  if (input.basis !== 'manual' && input.basis !== 'execution') {
    throw inputError(
      `basis must be 'manual' or 'execution' — 'verification' is reserved for the fabric's own verifyProviderDefinition probe and 'none' for the initial state (got '${String(input.basis)}')`,
    );
  }
  const note = sanitizeUserNote(input.note, 'note');
  return { definitionId, state: input.state, basis: input.basis, note };
}

export interface ValidatedListHealthQuery {
  state: 'available' | 'unavailable' | 'unknown' | null;
  limit: number;
}

export function validateListProviderHealthStatesQuery(
  query: ListProviderHealthStatesQuery,
): ValidatedListHealthQuery {
  if (!isPlainObject(query)) throw queryError('the health list query must be an object');
  rejectUnknownKeys(query, LIST_HEALTH_KEYS, 'the health list query');

  let state: 'available' | 'unavailable' | 'unknown' | null = null;
  if (query.state !== undefined && query.state !== null) {
    if (
      query.state !== 'available' &&
      query.state !== 'unavailable' &&
      query.state !== 'unknown'
    ) {
      throw queryError(
        `state must be 'available', 'unavailable' or 'unknown' (got '${String(query.state)}')`,
      );
    }
    state = query.state;
  }
  return { state, limit: requireLimit(query.limit) };
}

// ---------------------------------------------------------------------------
// Reference resolution helpers (lesson 5: the uniform not-found)
// ---------------------------------------------------------------------------

/**
 * Resolves a definition reference SHAPE (not existence): the id must be a
 * non-empty string. Whether it names a definition THE CALLER CAN SEE is
 * the service layer's question — malformed and unknown ids both surface
 * the uniform typed `definition_not_found` there, never a generic query
 * error.
 */
export function requireDefinitionRef(value: unknown, field = 'definitionId'): string {
  return requireString(value, field);
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
