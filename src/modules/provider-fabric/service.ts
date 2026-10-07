// Implementation of the provider-fabric module's public operations (see
// contract.ts) — W132 "Provider Fabric and User-Selectable Models".
//
// Conventions (IMPLEMENTATION-STACK §3/§8, the llm module's shapes): all
// SQL goes through the db port with `$n` placeholders; ids are uuids
// minted by PostgreSQL (`gen_random_uuid()`); timestamps come from the
// injectable clock and are never caller-supplied; every statement is
// scoped by the explicit TenantContext (ADR-0001) — cross-tenant access
// is indistinguishable from a missing record.
//
// W132 acceptance — known-provider connect · custom provider over an
// existing wire protocol · model discovery with manual fallback · model
// switching · single canonical registry · two-provider swap evidence ·
// credentials isolated — is carried by these deliberate properties, all
// tested:
//   1. KNOWN providers connect by the W034 LlmProvider vocabulary (the
//      llm module's code-owned registry — the ONLY known-provider
//      vocabulary; the fabric never invents one). CUSTOM providers are
//      definitions over an EXISTING WireProtocolKind with a custom base
//      URL — a custom provider never introduces a protocol dialect
//      (lock 30).
//   2. ONE canonical registry: every model a tenant can bind must be a
//      model_catalog_entries row of one of the tenant's definitions;
//      bindings reference (definition, modelId) pairs that resolve in
//      that catalog, so there is exactly one place a tenant's model
//      space exists.
//   3. DISCOVERY runs through the pluggable transport seam
//      (setFabricDiscoveryTransport — the setLlmTransport pattern): no
//      transport is wired by default and discovery then fails explicitly
//      with `provider_unavailable`; tests substitute deterministic
//      doubles and NEVER touch real network. Discovery failures are
//      RECORDED (the discovery state), never faked as success; manual
//      registration is the first-class fallback.
//   4. MODEL SWITCHING is binding supersession: attachModelBinding
//      appends the new binding and supersedes the previous active one
//      inside ONE transaction (the partial unique index enforces
//      one-active-per-purpose at the storage level). Bindings are
//      append-only audit evidence — the two-provider swap history
//      survives forever.
//   5. CREDENTIALS: no fabric input, table or note ever carries a
//      credential VALUE. The only credential linkage is the opaque
//      accountId reference to the W034 BYOA account (whose credentialRef
//      the llm gateway resolves at execution time). Credential-shaped
//      content in inputs is rejected with the typed
//      `credential_payload_rejected`; transport-derived detail is
//      sanitized before persistence.
//   6. The LLM Gateway (W034) remains the ONLY owner of provider/model
//      execution and routing: the fabric supplies definitions, catalogs
//      and bindings; it NEVER invokes a model and never re-routes
//      invokeLlm. Health observed through gateway executions is recorded
//      here only as evidence (basis 'execution') by the composition
//      layer.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { findLlmModel, isLlmProvider } from '@/modules/llm/contract';
import { ProviderFabricError } from './errors';
import {
  assertProviderFabricTenantContext,
  isUuid,
  knownProviderWireProtocol,
  sanitizeTransportDetail,
  validateActiveBindingQuery,
  validateAttachModelBindingInput,
  validateBindingSwapEvidenceQuery,
  validateConnectKnownProviderInput,
  validateDefinitionRefQuery,
  validateDiscoveryReceipt,
  validateListModelBindingsQuery,
  validateListModelCatalogQuery,
  validateListProviderDefinitionsQuery,
  validateListProviderHealthStatesQuery,
  validateModelSample,
  validateRecordProviderHealthInput,
  validateRegisterCustomProviderInput,
  validateRegisterModelInput,
  validateRunModelDiscoveryInput,
  validateUpdateProviderDefinitionInput,
  type ValidatedModelSample,
} from './validation';
import type {
  AttachModelBindingInput,
  AttachModelBindingResult,
  ConnectKnownProviderInput,
  FabricDiscoveryRequest,
  FabricDiscoveryTransport,
  ListModelBindingsQuery,
  ListModelCatalogQuery,
  ListProviderDefinitionsQuery,
  ListProviderHealthStatesQuery,
  ModelBinding,
  ModelBindingProviderPath,
  ModelBindingPurpose,
  ModelBindingSwapEvidence,
  ModelCatalogEntry,
  ModelDiscoveryResult,
  ModelDiscoveryState,
  ProviderDefinition,
  ProviderDefinitionKind,
  ProviderHealthState,
  RecordProviderHealthInput,
  RegisterCustomProviderInput,
  RegisterModelManuallyInput,
  UpdateProviderDefinitionInput,
  WireProtocolKind,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface DefinitionRow extends DbRow {
  id: string;
  tenant_id: string;
  kind: string;
  provider: string;
  label: string;
  base_url: string | null;
  wire_protocol: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CatalogEntryRow extends DbRow {
  id: string;
  tenant_id: string;
  definition_id: string;
  model_id: string;
  display_name: string;
  capabilities: string[];
  origin: string;
  context_window_tokens: number | null;
  max_output_tokens: number | null;
  price_input_minor_per_million: number | null;
  price_output_minor_per_million: number | null;
  discovered_at: Date | string | null;
  registered_at: Date | string;
  status: string;
}

interface DiscoveryStateRow extends DbRow {
  tenant_id: string;
  definition_id: string;
  capability: string;
  last_attempt_at: Date | string | null;
  last_outcome: string;
  last_error: string | null;
  discovered_count: number;
}

interface BindingRow extends DbRow {
  id: string;
  seq: number;
  tenant_id: string;
  purpose: string;
  definition_id: string;
  model_id: string;
  status: string;
  account_id: string;
  created_by: string;
  created_at: Date | string;
  superseded_at: Date | string | null;
}

interface HealthEventRow extends DbRow {
  id: string;
  seq: number;
  tenant_id: string;
  definition_id: string;
  state: string;
  basis: string;
  verified_at: Date | string | null;
  note: string | null;
  observed_by: string;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapDefinition(row: DefinitionRow): ProviderDefinition {
  return {
    definitionId: row.id,
    tenantId: row.tenant_id,
    kind: row.kind as ProviderDefinitionKind, // CHECK-constrained by migration 001
    provider: row.provider,
    label: row.label,
    baseUrl: row.base_url,
    wireProtocol: (row.wire_protocol as WireProtocolKind | null), // CHECK-constrained by migration 001
    status: row.status as ProviderDefinition['status'],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapCatalogEntry(row: CatalogEntryRow): ModelCatalogEntry {
  return {
    entryId: row.id,
    tenantId: row.tenant_id,
    definitionId: row.definition_id,
    modelId: row.model_id,
    displayName: row.display_name,
    capabilities: row.capabilities as ModelCatalogEntry['capabilities'],
    origin: row.origin as ModelCatalogEntry['origin'],
    contextWindowTokens: row.context_window_tokens,
    maxOutputTokens: row.max_output_tokens,
    priceInputMinorPerMillion: row.price_input_minor_per_million,
    priceOutputMinorPerMillion: row.price_output_minor_per_million,
    discoveredAt: row.discovered_at === null ? null : toIso(row.discovered_at),
    registeredAt: toIso(row.registered_at),
    status: row.status as ModelCatalogEntry['status'],
  };
}

function mapDiscoveryState(row: DiscoveryStateRow): ModelDiscoveryState {
  return {
    definitionId: row.definition_id,
    tenantId: row.tenant_id,
    capability: row.capability as ModelDiscoveryState['capability'],
    lastAttemptAt: row.last_attempt_at === null ? null : toIso(row.last_attempt_at),
    lastOutcome: row.last_outcome as ModelDiscoveryState['lastOutcome'],
    lastError: row.last_error,
    discoveredCount: row.discovered_count,
  };
}

function mapBinding(row: BindingRow): ModelBinding {
  return {
    bindingId: row.id,
    tenantId: row.tenant_id,
    purpose: row.purpose as ModelBindingPurpose,
    definitionId: row.definition_id,
    modelId: row.model_id,
    status: row.status as ModelBinding['status'],
    accountId: row.account_id,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    supersededAt: row.superseded_at === null ? null : toIso(row.superseded_at),
  };
}

function mapHealthEvent(row: HealthEventRow): ProviderHealthState {
  return {
    definitionId: row.definition_id,
    tenantId: row.tenant_id,
    state: row.state as ProviderHealthState['state'],
    lastVerifiedAt: row.verified_at === null ? null : toIso(row.verified_at),
    basis: row.basis as ProviderHealthState['basis'],
    note: row.note,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** PostgreSQL unique-violation (23505) on a named constraint, from either db backend. */
function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (candidate.code === '23505') return candidate.constraint === constraint;
  return (
    typeof candidate.message === 'string' &&
    /duplicate key value/i.test(candidate.message) &&
    candidate.message.includes(constraint)
  );
}

/**
 * Loads a definition the CALLER CAN SEE, or throws the uniform typed
 * `definition_not_found` — for a MALFORMED id exactly as for an unknown or
 * foreign-tenant one (the prior-execution lesson: a malformed reference
 * must surface the uniform not-found, never a generic query error).
 */
async function loadDefinition(
  db: Queryable,
  ctx: TenantContext,
  definitionId: string,
  forUpdate = false,
): Promise<DefinitionRow> {
  if (!isUuid(definitionId)) {
    throw new ProviderFabricError(
      'definition_not_found',
      `provider definition '${definitionId}' does not exist in this tenant`,
    );
  }
  const result = await db.query<DefinitionRow>(
    `SELECT * FROM provider_definitions
       WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, definitionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ProviderFabricError(
      'definition_not_found',
      `provider definition '${definitionId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function readDiscoveryState(
  db: Queryable,
  ctx: TenantContext,
  definitionId: string,
): Promise<ModelDiscoveryState> {
  const result = await db.query<DiscoveryStateRow>(
    `SELECT * FROM model_discovery_states WHERE tenant_id = $1 AND definition_id = $2`,
    [ctx.tenantId, definitionId],
  );
  const row = result.rows[0];
  if (row !== undefined) return mapDiscoveryState(row);
  // Defense in depth: connect mints the state row; a missing row reads as
  // the honest never-attempted default, never a fabricated success.
  return {
    definitionId,
    tenantId: ctx.tenantId,
    capability: 'supported',
    lastAttemptAt: null,
    lastOutcome: 'never-attempted',
    lastError: null,
    discoveredCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Discovery transport seam (mirrors the llm gateway's setLlmTransport)
// ---------------------------------------------------------------------------

let fabricDiscoveryTransport: FabricDiscoveryTransport | null = null;

/**
 * Infrastructure wiring for the discovery port. Real transports (provider
 * HTTP) live outside the tests' world and are wired once at process
 * start; tests substitute deterministic doubles. `null` restores the
 * default "no provider available" state.
 */
export function setFabricDiscoveryTransport(transport: FabricDiscoveryTransport | null): void {
  fabricDiscoveryTransport = transport;
}

/** The currently wired discovery transport (null when none — discovery then fails `provider_unavailable`). */
export function getFabricDiscoveryTransport(): FabricDiscoveryTransport | null {
  return fabricDiscoveryTransport;
}

function requireDiscoveryTransport(): FabricDiscoveryTransport {
  if (fabricDiscoveryTransport === null) {
    throw new ProviderFabricError(
      'provider_unavailable',
      'no provider-fabric discovery transport is wired — wire one via setFabricDiscoveryTransport (as provider availability permits)',
    );
  }
  return fabricDiscoveryTransport;
}

/** Builds the provider-neutral discovery request for a definition (known providers carry the derived wire protocol). */
function buildDiscoveryRequest(ctx: TenantContext, definition: DefinitionRow): FabricDiscoveryRequest {
  if (definition.kind === 'custom') {
    return {
      definitionId: definition.id,
      tenantId: ctx.tenantId,
      provider: definition.provider,
      wireProtocol: definition.wire_protocol as WireProtocolKind, // CHECK-constrained for 'custom'
      baseUrl: definition.base_url,
    };
  }
  const wireProtocol = knownProviderWireProtocol(definition.provider);
  if (wireProtocol === null) {
    // Unreachable barring a registry drift between the llm module's
    // vocabulary and this definition (validated at connect); stay loud.
    throw new Error(
      `known provider '${definition.provider}' has no wire protocol mapping (internal invariant violation)`,
    );
  }
  return {
    definitionId: definition.id,
    tenantId: ctx.tenantId,
    provider: definition.provider,
    wireProtocol,
    baseUrl: null,
  };
}

// ---------------------------------------------------------------------------
// Definitions — connect known / register custom / read / update
// ---------------------------------------------------------------------------

/** Connects a KNOWN provider (W034 LlmProvider vocabulary) for the tenant. */
export async function connectKnownProvider(
  ctx: TenantContext,
  input: ConnectKnownProviderInput,
): Promise<ProviderDefinition> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateConnectKnownProviderInput(input);
  return insertDefinition(ctx, {
    kind: 'known',
    provider: valid.provider,
    label: valid.label,
    baseUrl: null,
    wireProtocol: null,
  });
}

/** Registers a CUSTOM provider: a definition over an EXISTING wire protocol with a custom base URL. */
export async function registerCustomProvider(
  ctx: TenantContext,
  input: RegisterCustomProviderInput,
): Promise<ProviderDefinition> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateRegisterCustomProviderInput(input);
  return insertDefinition(ctx, {
    kind: 'custom',
    provider: valid.provider,
    label: valid.label,
    baseUrl: valid.baseUrl,
    wireProtocol: valid.wireProtocol,
  });
}

async function insertDefinition(
  ctx: TenantContext,
  values: {
    kind: ProviderDefinitionKind;
    provider: string;
    label: string;
    baseUrl: string | null;
    wireProtocol: WireProtocolKind | null;
  },
): Promise<ProviderDefinition> {
  const at = now();
  try {
    return await getDb().transaction(async (tx) => {
      const inserted = await tx.query<DefinitionRow>(
        `INSERT INTO provider_definitions (
           tenant_id, kind, provider, label, base_url, wire_protocol,
           status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
         RETURNING *`,
        [
          ctx.tenantId,
          values.kind,
          values.provider,
          values.label,
          values.baseUrl,
          values.wireProtocol,
          at,
        ],
      );
      const row = inserted.rows[0]!;
      // The honest initial per-definition state, minted atomically with
      // the definition: discovery never attempted; health never verified.
      await tx.query(
        `INSERT INTO model_discovery_states (tenant_id, definition_id)
           VALUES ($1, $2)`,
        [ctx.tenantId, row.id],
      );
      await tx.query(
        `INSERT INTO provider_health_states (
           tenant_id, definition_id, state, basis, verified_at, note, observed_by, created_at
         ) VALUES ($1, $2, 'unknown', 'none', NULL, NULL, $3, $4)`,
        [ctx.tenantId, row.id, ctx.principalId, at],
      );
      return mapDefinition(row);
    });
  } catch (error) {
    if (isUniqueViolationOn(error, 'provider_definitions_slug_unique')) {
      throw new ProviderFabricError(
        'provider_slug_taken',
        `a provider definition for '${values.provider}' already exists in this tenant — the registry carries one definition per provider slug`,
      );
    }
    throw error;
  }
}

export async function getProviderDefinition(
  ctx: TenantContext,
  query: { definitionId: string },
): Promise<ProviderDefinition> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateDefinitionRefQuery(query);
  const row = await loadDefinition(getDb(), ctx, valid.definitionId);
  return mapDefinition(row);
}

export async function listProviderDefinitions(
  ctx: TenantContext,
  query: ListProviderDefinitionsQuery,
): Promise<ProviderDefinition[]> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateListProviderDefinitionsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.kind !== null) {
    params.push(valid.kind);
    conditions.push(`kind = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  params.push(valid.limit);
  const result = await getDb().query<DefinitionRow>(
    `SELECT * FROM provider_definitions
       WHERE ${conditions.join(' AND ')}
       ORDER BY provider ASC
       LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapDefinition);
}

export async function updateProviderDefinition(
  ctx: TenantContext,
  input: UpdateProviderDefinitionInput,
): Promise<ProviderDefinition> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateUpdateProviderDefinitionInput(input);
  return getDb().transaction(async (tx) => {
    const existing = await loadDefinition(tx, ctx, valid.definitionId, true);
    const updated = await tx.query<DefinitionRow>(
      `UPDATE provider_definitions
         SET label = $1, status = $2, updated_at = $3
         WHERE tenant_id = $4 AND id = $5
         RETURNING *`,
      [
        valid.label ?? existing.label,
        valid.status ?? existing.status,
        now(),
        ctx.tenantId,
        existing.id,
      ],
    );
    return mapDefinition(updated.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// Catalog — manual registration (the discovery fallback) and reads
// ---------------------------------------------------------------------------

export async function registerModelManually(
  ctx: TenantContext,
  input: RegisterModelManuallyInput,
): Promise<ModelCatalogEntry> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateRegisterModelInput(input);
  const db = getDb();
  const definition = await loadDefinition(db, ctx, valid.definitionId);
  if (definition.status !== 'active') {
    throw new ProviderFabricError(
      'definition_disabled',
      `provider definition '${valid.definitionId}' is disabled — enable it before registering models`,
    );
  }
  const at = now();
  try {
    const inserted = await db.query<CatalogEntryRow>(
      `INSERT INTO model_catalog_entries (
         tenant_id, definition_id, model_id, display_name, capabilities,
         origin, context_window_tokens, max_output_tokens,
         price_input_minor_per_million, price_output_minor_per_million,
         discovered_at, registered_at, status
       ) VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9, NULL, $10, 'available')
       RETURNING *`,
      [
        ctx.tenantId,
        definition.id,
        valid.sample.modelId,
        valid.sample.displayName,
        valid.sample.capabilities,
        valid.sample.contextWindowTokens,
        valid.sample.maxOutputTokens,
        valid.sample.priceInputMinorPerMillion,
        valid.sample.priceOutputMinorPerMillion,
        at,
      ],
    );
    return mapCatalogEntry(inserted.rows[0]!);
  } catch (error) {
    if (isUniqueViolationOn(error, 'model_catalog_entries_unique')) {
      throw new ProviderFabricError(
        'duplicate_model_entry',
        `model '${valid.sample.modelId}' is already registered on this provider definition`,
      );
    }
    throw error;
  }
}

export async function listModelCatalog(
  ctx: TenantContext,
  query: ListModelCatalogQuery,
): Promise<ModelCatalogEntry[]> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateListModelCatalogQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.definitionId !== null) {
    params.push(valid.definitionId);
    conditions.push(`definition_id = $${params.length}`);
  }
  if (valid.origin !== null) {
    params.push(valid.origin);
    conditions.push(`origin = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.capability !== null) {
    params.push(valid.capability);
    conditions.push(`capabilities @> ARRAY[$${params.length}]::text[]`);
  }
  params.push(valid.limit);
  const result = await getDb().query<CatalogEntryRow>(
    `SELECT * FROM model_catalog_entries
       WHERE ${conditions.join(' AND ')}
       ORDER BY definition_id ASC, model_id ASC
       LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapCatalogEntry);
}

export async function getModelCatalogEntry(
  ctx: TenantContext,
  query: { entryId: string },
): Promise<ModelCatalogEntry> {
  assertProviderFabricTenantContext(ctx);
  if (
    typeof query !== 'object' ||
    query === null ||
    typeof query.entryId !== 'string' ||
    query.entryId.trim() === ''
  ) {
    throw new ProviderFabricError(
      'invalid_query',
      'the catalog entry query must carry a non-empty entryId',
    );
  }
  const entryId = query.entryId.trim();
  // Uniform not-found for malformed, unknown and foreign ids alike — the
  // uuid check runs BEFORE the query (a malformed uuid would otherwise
  // surface as a raw driver error, never a typed one).
  if (!isUuid(entryId)) {
    throw new ProviderFabricError(
      'entry_not_found',
      `catalog entry '${entryId}' does not exist in this tenant`,
    );
  }
  const result = await getDb().query<CatalogEntryRow>(
    `SELECT * FROM model_catalog_entries WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, entryId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ProviderFabricError(
      'entry_not_found',
      `catalog entry '${entryId}' does not exist in this tenant`,
    );
  }
  return mapCatalogEntry(row);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Enriches a discovered sample with the W034 registry's code-owned
 * reference data when the definition is a KNOWN provider and the registry
 * carries the model — capabilities, windows and list prices the registry
 * knows are HONEST enrichment (never a guess); everything the sample left
 * null for a custom provider stays null (honest unknown).
 */
function enrichDiscoveredSample(
  definition: DefinitionRow,
  sample: ValidatedModelSample,
): {
  modelId: string;
  displayName: string;
  capabilities: string[];
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  priceInputMinorPerMillion: number | null;
  priceOutputMinorPerMillion: number | null;
} {
  let capabilities = sample.capabilities;
  let contextWindowTokens = sample.contextWindowTokens;
  let maxOutputTokens = sample.maxOutputTokens;
  let priceInput = sample.priceInputMinorPerMillion;
  let priceOutput = sample.priceOutputMinorPerMillion;
  if (definition.kind === 'known' && isLlmProvider(definition.provider)) {
    const descriptor = findLlmModel(definition.provider, sample.modelId);
    if (descriptor !== null) {
      if (capabilities.length === 0) capabilities = [...descriptor.capabilities];
      contextWindowTokens ??= descriptor.contextWindowTokens;
      maxOutputTokens ??= descriptor.maxOutputTokens;
      priceInput ??= descriptor.priceInputMinorPerMillion;
      priceOutput ??= descriptor.priceOutputMinorPerMillion;
    }
  }
  return {
    modelId: sample.modelId,
    displayName: sample.displayName ?? sample.modelId,
    capabilities,
    contextWindowTokens,
    maxOutputTokens,
    priceInputMinorPerMillion: priceInput,
    priceOutputMinorPerMillion: priceOutput,
  };
}

export async function runModelDiscovery(
  ctx: TenantContext,
  input: { definitionId: string },
): Promise<ModelDiscoveryResult> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateRunModelDiscoveryInput(input);
  const db = getDb();
  const definition = await loadDefinition(db, ctx, valid.definitionId);
  if (definition.status !== 'active') {
    throw new ProviderFabricError(
      'definition_disabled',
      `provider definition '${valid.definitionId}' is disabled — enable it before discovering models`,
    );
  }
  const transport = requireDiscoveryTransport();
  // The probe runs OUTSIDE any transaction (a real transport is network
  // I/O); only the catalog/state writes below are atomic.
  const receipt = validateDiscoveryReceipt(
    await transport.listModels(buildDiscoveryRequest(ctx, definition)),
  );
  const at = now();

  if (receipt.status === 'succeeded') {
    const prepared = receipt.models.map((sample) => enrichDiscoveredSample(definition, sample));
    await db.transaction(async (tx) => {
      for (const model of prepared) {
        await tx.query(
          `INSERT INTO model_catalog_entries (
             tenant_id, definition_id, model_id, display_name, capabilities,
             origin, context_window_tokens, max_output_tokens,
             price_input_minor_per_million, price_output_minor_per_million,
             discovered_at, registered_at, status
           ) VALUES ($1, $2, $3, $4, $5, 'discovered', $6, $7, $8, $9, $10, $10, 'available')
           ON CONFLICT (tenant_id, definition_id, model_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             capabilities = EXCLUDED.capabilities,
             context_window_tokens = COALESCE(EXCLUDED.context_window_tokens, model_catalog_entries.context_window_tokens),
             max_output_tokens = COALESCE(EXCLUDED.max_output_tokens, model_catalog_entries.max_output_tokens),
             price_input_minor_per_million = COALESCE(EXCLUDED.price_input_minor_per_million, model_catalog_entries.price_input_minor_per_million),
             price_output_minor_per_million = COALESCE(EXCLUDED.price_output_minor_per_million, model_catalog_entries.price_output_minor_per_million),
             discovered_at = EXCLUDED.discovered_at,
             status = 'available'
           WHERE model_catalog_entries.origin = 'discovered'`,
          [
            ctx.tenantId,
            definition.id,
            model.modelId,
            model.displayName,
            model.capabilities,
            model.contextWindowTokens,
            model.maxOutputTokens,
            model.priceInputMinorPerMillion,
            model.priceOutputMinorPerMillion,
            at,
          ],
        );
      }
      // Models the provider no longer lists become honestly 'unavailable'
      // (never deleted — the catalog is current state, the history stays
      // inspectable). Manually registered entries are sticky: the tenant
      // put them there deliberately, discovery never touches them.
      await tx.query(
        `UPDATE model_catalog_entries
           SET status = 'unavailable'
           WHERE tenant_id = $1 AND definition_id = $2 AND origin = 'discovered'
             AND NOT (model_id = ANY($3::text[]))`,
        [ctx.tenantId, definition.id, prepared.map((model) => model.modelId)],
      );
      await tx.query(
        `INSERT INTO model_discovery_states (
           tenant_id, definition_id, capability, last_attempt_at, last_outcome, last_error, discovered_count
         ) VALUES ($1, $2, 'supported', $3, 'succeeded', NULL, $4)
         ON CONFLICT (tenant_id, definition_id) DO UPDATE SET
           capability = EXCLUDED.capability,
           last_attempt_at = EXCLUDED.last_attempt_at,
           last_outcome = EXCLUDED.last_outcome,
           last_error = EXCLUDED.last_error,
           discovered_count = EXCLUDED.discovered_count`,
        [ctx.tenantId, definition.id, at, prepared.length],
      );
    });
    const state = await readDiscoveryState(db, ctx, definition.id);
    const entries = await listModelCatalog(ctx, { definitionId: definition.id, limit: 500 });
    return { outcome: 'succeeded', state, entries };
  }

  // 'unsupported' (a legitimate provider property — the manual fallback
  // exists for this) or 'failed' (transport error): recorded, never faked.
  // `discovered_count` keeps its last-known value (a failed attempt is not
  // zero models — it is no new information).
  const lastError =
    receipt.status === 'unsupported'
      ? `model listing is not supported by this provider${receipt.detail === null ? '' : ` (${sanitizeTransportDetail(receipt.detail, 'no detail')})`}`
      : sanitizeTransportDetail(receipt.detail, 'the model discovery attempt failed');
  await db.query(
    `INSERT INTO model_discovery_states (
       tenant_id, definition_id, capability, last_attempt_at, last_outcome, last_error, discovered_count
     ) VALUES ($1, $2, $3, $4, 'failed', $5, 0)
     ON CONFLICT (tenant_id, definition_id) DO UPDATE SET
       capability = EXCLUDED.capability,
       last_attempt_at = EXCLUDED.last_attempt_at,
       last_outcome = EXCLUDED.last_outcome,
       last_error = EXCLUDED.last_error`,
    [
      ctx.tenantId,
      definition.id,
      receipt.status === 'unsupported' ? 'unsupported' : 'supported',
      at,
      lastError,
    ],
  );
  const state = await readDiscoveryState(db, ctx, definition.id);
  return { outcome: receipt.status, state, entries: [] };
}

// ---------------------------------------------------------------------------
// Bindings — attach/supersede (the swap path), reads, swap evidence
// ---------------------------------------------------------------------------

/**
 * Attaches a model binding for a purpose — THE SWAP PATH: appends the new
 * binding and supersedes the purpose's previous active binding inside ONE
 * transaction. The partial unique index (one active binding per purpose
 * per tenant) is the storage-level backstop.
 */
export async function attachModelBinding(
  ctx: TenantContext,
  input: AttachModelBindingInput,
): Promise<AttachModelBindingResult> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateAttachModelBindingInput(input);
  const at = now();
  try {
    return await getDb().transaction(async (tx) => {
      const definition = await loadDefinition(tx, ctx, valid.definitionId, true);
      if (definition.status !== 'active') {
        throw new ProviderFabricError(
          'definition_disabled',
          `provider definition '${valid.definitionId}' is disabled — enable it before binding models`,
        );
      }
      // ONE canonical registry: a bindable model must be a catalog entry
      // of the tenant's definition, and it must be available.
      const entry = await tx.query<CatalogEntryRow>(
        `SELECT * FROM model_catalog_entries
           WHERE tenant_id = $1 AND definition_id = $2 AND model_id = $3`,
        [ctx.tenantId, definition.id, valid.modelId],
      );
      const entryRow = entry.rows[0];
      if (entryRow === undefined) {
        throw new ProviderFabricError(
          'model_not_in_catalog',
          `model '${valid.modelId}' is not in the tenant's catalog for this provider definition — register or discover it first (one canonical registry)`,
        );
      }
      if (entryRow.status !== 'available') {
        throw new ProviderFabricError(
          'model_unavailable',
          `model '${valid.modelId}' is currently unavailable in the catalog`,
        );
      }

      // Supersede the current active binding (one-way, under its row lock).
      const current = await tx.query<BindingRow>(
        `SELECT * FROM model_bindings
           WHERE tenant_id = $1 AND purpose = $2 AND status = 'active'
           FOR UPDATE`,
        [ctx.tenantId, valid.purpose],
      );
      let superseded: ModelBinding | null = null;
      const currentRow = current.rows[0];
      if (currentRow !== undefined) {
        const updated = await tx.query<BindingRow>(
          `UPDATE model_bindings
             SET status = 'superseded', superseded_at = $1
             WHERE tenant_id = $2 AND id = $3
             RETURNING *`,
          [at, ctx.tenantId, currentRow.id],
        );
        superseded = mapBinding(updated.rows[0]!);
      }

      const inserted = await tx.query<BindingRow>(
        `INSERT INTO model_bindings (
           tenant_id, purpose, definition_id, model_id, status,
           account_id, created_by, created_at
         ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)
         RETURNING *`,
        [ctx.tenantId, valid.purpose, definition.id, valid.modelId, valid.accountId, ctx.principalId, at],
      );
      return { binding: mapBinding(inserted.rows[0]!), superseded };
    });
  } catch (error) {
    if (isUniqueViolationOn(error, 'model_bindings_one_active_per_purpose')) {
      throw new ProviderFabricError(
        'binding_conflict',
        `another active binding for purpose '${valid.purpose}' was attached concurrently — retry the attach`,
      );
    }
    throw error;
  }
}

export async function getActiveModelBinding(
  ctx: TenantContext,
  query: { purpose: ModelBindingPurpose },
): Promise<ModelBinding | null> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateActiveBindingQuery(query);
  const result = await getDb().query<BindingRow>(
    `SELECT * FROM model_bindings
       WHERE tenant_id = $1 AND purpose = $2 AND status = 'active'
       ORDER BY seq DESC
       LIMIT 1`,
    [ctx.tenantId, valid.purpose],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapBinding(row);
}

export async function listModelBindings(
  ctx: TenantContext,
  query: ListModelBindingsQuery,
): Promise<ModelBinding[]> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateListModelBindingsQuery(query);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.purpose !== null) {
    params.push(valid.purpose);
    conditions.push(`purpose = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const result = await getDb().query<BindingRow>(
    `SELECT * FROM model_bindings
       WHERE ${conditions.join(' AND ')}
       ORDER BY seq DESC
       LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapBinding);
}

/**
 * The fabric-level two-provider swap evidence for a purpose: the current
 * binding, the full append-only history (chronological), and the distinct
 * provider/model paths the purpose has been served through. Execution
 * equivalence through both paths is the W034 hot-swap verification's job
 * at the composition boundary — the fabric never invokes models.
 */
export async function getBindingSwapEvidence(
  ctx: TenantContext,
  query: { purpose: ModelBindingPurpose },
): Promise<ModelBindingSwapEvidence> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateBindingSwapEvidenceQuery(query);
  const history = await listModelBindings(ctx, { purpose: valid.purpose, limit: 500 });
  const chronological = [...history].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const current = chronological.find((binding) => binding.status === 'active') ?? null;

  // Distinct (definition, model) paths in first-attachment order. The
  // definitions always resolve (they are never deleted); a definition
  // disabled after the fact still appears — history is history.
  const definitionIds = [...new Set(chronological.map((binding) => binding.definitionId))];
  const definitions = new Map<string, ProviderDefinition>();
  for (const definitionId of definitionIds) {
    const row = await loadDefinition(getDb(), ctx, definitionId);
    definitions.set(definitionId, mapDefinition(row));
  }
  const seenPaths = new Set<string>();
  const providerPaths: ModelBindingProviderPath[] = [];
  for (const binding of chronological) {
    const key = `${binding.definitionId}::${binding.modelId}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    const definition = definitions.get(binding.definitionId)!;
    providerPaths.push({
      definitionId: binding.definitionId,
      provider: definition.provider,
      label: definition.label,
      kind: definition.kind,
      modelId: binding.modelId,
    });
  }
  return { purpose: valid.purpose, current, history: chronological, providerPaths };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

async function latestHealthEvent(
  db: Queryable,
  ctx: TenantContext,
  definitionId: string,
): Promise<ProviderHealthState> {
  const result = await db.query<HealthEventRow>(
    `SELECT * FROM provider_health_states
       WHERE tenant_id = $1 AND definition_id = $2
       ORDER BY seq DESC
       LIMIT 1`,
    [ctx.tenantId, definitionId],
  );
  const row = result.rows[0];
  if (row !== undefined) return mapHealthEvent(row);
  // Defense in depth: connect mints the initial 'unknown'/'none' event;
  // a missing event reads as the honest unverified default.
  return {
    definitionId,
    tenantId: ctx.tenantId,
    state: 'unknown',
    lastVerifiedAt: null,
    basis: 'none',
    note: null,
  };
}

async function insertHealthEvent(
  ctx: TenantContext,
  values: {
    definitionId: string;
    state: ProviderHealthState['state'];
    basis: ProviderHealthState['basis'];
    verifiedAt: Date | null;
    note: string | null;
  },
): Promise<ProviderHealthState> {
  const at = now();
  await getDb().query(
    `INSERT INTO provider_health_states (
       tenant_id, definition_id, state, basis, verified_at, note, observed_by, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.tenantId, values.definitionId, values.state, values.basis, values.verifiedAt, values.note, ctx.principalId, at],
  );
  return latestHealthEvent(getDb(), ctx, values.definitionId);
}

/**
 * Verifies a provider definition through the discovery transport probe
 * and records the result with basis 'verification'. An `unsupported`
 * listing response still proves the provider is REACHABLE (the endpoint
 * answered) — that is an availability proof, never a failure.
 */
export async function verifyProviderDefinition(
  ctx: TenantContext,
  input: { definitionId: string },
): Promise<ProviderHealthState> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateDefinitionRefQuery(input);
  const db = getDb();
  const definition = await loadDefinition(db, ctx, valid.definitionId);
  if (definition.status !== 'active') {
    throw new ProviderFabricError(
      'definition_disabled',
      `provider definition '${valid.definitionId}' is disabled — enable it before verifying`,
    );
  }
  const transport = requireDiscoveryTransport();
  const receipt = validateDiscoveryReceipt(
    await transport.listModels(buildDiscoveryRequest(ctx, definition)),
  );
  let state: ProviderHealthState['state'];
  let note: string;
  if (receipt.status === 'succeeded') {
    state = 'available';
    note = `verification probe succeeded (${receipt.models.length} models listed)`;
  } else if (receipt.status === 'unsupported') {
    state = 'available';
    note = 'verification probe reached the provider (model listing unsupported)';
  } else {
    state = 'unavailable';
    note = sanitizeTransportDetail(receipt.detail, 'verification probe failed');
  }
  return insertHealthEvent(ctx, {
    definitionId: definition.id,
    state,
    basis: 'verification',
    verifiedAt: now(),
    note,
  });
}

/**
 * Records a health observation with a CALLER basis ('manual' — a person
 * says so; 'execution' — the composition layer observed a gateway
 * execution outcome). 'verification' is reserved for the fabric's own
 * probe and 'none' for the initial state. Works on disabled definitions
 * too: health is observational evidence, never configuration.
 */
export async function recordProviderHealth(
  ctx: TenantContext,
  input: RecordProviderHealthInput,
): Promise<ProviderHealthState> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateRecordProviderHealthInput(input);
  const definition = await loadDefinition(getDb(), ctx, valid.definitionId);
  return insertHealthEvent(ctx, {
    definitionId: definition.id,
    state: valid.state,
    basis: valid.basis,
    verifiedAt: now(),
    note: valid.note,
  });
}

export async function getProviderHealthState(
  ctx: TenantContext,
  query: { definitionId: string },
): Promise<ProviderHealthState> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateDefinitionRefQuery(query);
  const definition = await loadDefinition(getDb(), ctx, valid.definitionId);
  return latestHealthEvent(getDb(), ctx, definition.id);
}

export async function listProviderHealthStates(
  ctx: TenantContext,
  query: ListProviderHealthStatesQuery,
): Promise<ProviderHealthState[]> {
  assertProviderFabricTenantContext(ctx);
  const valid = validateListProviderHealthStatesQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let stateFilter = '';
  if (valid.state !== null) {
    params.push(valid.state);
    stateFilter = `WHERE latest.state = $${params.length}`;
  }
  params.push(valid.limit);
  const result = await getDb().query<HealthEventRow>(
    `SELECT latest.* FROM (
       SELECT DISTINCT ON (definition_id) *
         FROM provider_health_states
         WHERE tenant_id = $1
         ORDER BY definition_id, seq DESC
     ) latest
     ${stateFilter}
     ORDER BY latest.definition_id ASC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapHealthEvent);
}
