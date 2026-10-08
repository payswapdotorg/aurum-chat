// ============================================================================
// provider-fabric — TL-frozen shared type vocabulary (W124b)
//
// FROZEN CONTRACT SURFACE enabling W132 (Provider Fabric and User-Selectable
// Models) and W133 (Aurum Agent Body + Model Binding) to proceed in parallel.
// Derived from spec/MASTER-ROADMAP-2026-10-04.md W132/W133 definitions and
// the frozen W034 LLM Gateway architecture (src/modules/llm/).
//
// Ownership law:
//   * W132 owns src/modules/provider-fabric/** (implementation, migrations,
//     tests, operational contract) and may extend these types ADDITIVELY.
//   * W133 (and every other module) imports these types ONLY through
//     '@/modules/provider-fabric/contract'.
//   * Semantic changes require TL integration approval.
//
// Architecture laws baked in:
//   * No provider is architecturally privileged (lock 30). A custom provider
//     is a DEFINITION over an existing wire protocol — it never introduces a
//     new protocol dialect outside the adapter set.
//   * Credentials live in the existing credential-ref mechanism, never in
//     provider definitions or catalog entries.
//   * The LLM Gateway (W034) remains the owner of provider/model execution
//     and routing; the fabric supplies definitions/catalogs/bindings to it.
//   * LLM output is never authoritative (lock 10).
// ============================================================================

// ----------------------------------------------------------------------------
// Wire protocols — the adapter dialects the platform can already speak.
// A custom provider REUSES one of these; it never invents a protocol.
// ----------------------------------------------------------------------------

export type WireProtocolKind =
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'google-compatible'
  | 'mistral-compatible'
  | 'cohere-compatible';

// ----------------------------------------------------------------------------
// ProviderDefinition — a provider the tenant can connect. Either a KNOWN
// registry provider (W034 code-owned vocabulary) or a CUSTOM definition
// over an existing wire protocol (custom base URL, tenant label).
// ----------------------------------------------------------------------------

export type ProviderDefinitionKind = 'known' | 'custom';

export interface ProviderDefinition {
  readonly definitionId: string; // system-minted
  readonly tenantId: string;
  readonly kind: ProviderDefinitionKind;
  /** For 'known': the W034 LlmProvider vocabulary value. For 'custom': tenant-chosen slug. */
  readonly provider: string;
  readonly label: string;
  /** REQUIRED for 'custom'; null for 'known' (the adapter's canonical endpoint). */
  readonly baseUrl: string | null;
  /** REQUIRED for 'custom': which existing wire protocol this definition speaks. */
  readonly wireProtocol: WireProtocolKind | null;
  readonly status: 'active' | 'disabled';
  readonly createdAt: string; // ISO
  readonly updatedAt: string; // ISO
}

// ----------------------------------------------------------------------------
// ModelCatalogEntry — one model available through a provider definition.
// Entries arrive via DISCOVERY (provider model-list endpoint) or MANUAL
// registration (when discovery is unavailable). Both are first-class.
// ----------------------------------------------------------------------------

export type ModelCatalogOrigin = 'discovered' | 'manual';

export interface ModelCatalogEntry {
  readonly entryId: string; // system-minted
  readonly tenantId: string;
  readonly definitionId: string; // the ProviderDefinition it belongs to
  /** Opaque model id the provider's API accepts (lock 16 discipline). */
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: readonly ('text-generation' | 'embedding')[];
  readonly origin: ModelCatalogOrigin;
  /** Populated when known (discovery or manual entry); null = unknown. */
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  /** Integer minor units per 1,000,000 tokens (USD); null = unknown. */
  readonly priceInputMinorPerMillion: number | null;
  readonly priceOutputMinorPerMillion: number | null;
  readonly discoveredAt: string | null; // ISO, discovery origin only
  readonly registeredAt: string; // ISO
  readonly status: 'available' | 'unavailable';
}

// ----------------------------------------------------------------------------
// ModelDiscovery — the state of model discovery for a provider definition.
// ----------------------------------------------------------------------------

export interface ModelDiscoveryState {
  readonly definitionId: string;
  readonly tenantId: string;
  /** 'supported' | 'unsupported' — some providers have no list-models API. */
  readonly capability: 'supported' | 'unsupported';
  readonly lastAttemptAt: string | null; // ISO
  readonly lastOutcome: 'succeeded' | 'failed' | 'never-attempted';
  readonly lastError: string | null; // sanitized, no credentials
  readonly discoveredCount: number;
}

// ----------------------------------------------------------------------------
// ModelBinding — the tenant's explicit selection of a model for a purpose.
// Bindings are the ONLY way a surface acquires a model; they are auditable
// and swappable without touching the body that consumes them.
// ----------------------------------------------------------------------------

export type ModelBindingPurpose =
  | 'cognition'
  | 'conversation'
  | 'analysis'
  | 'background'; // mirrors W034 LlmScope

export interface ModelBinding {
  readonly bindingId: string; // system-minted
  readonly tenantId: string;
  readonly purpose: ModelBindingPurpose;
  readonly definitionId: string; // provider definition
  readonly modelId: string; // opaque model id within that definition
  readonly status: 'active' | 'superseded';
  /** Account used to execute (credentialRef resolved by the llm gateway). */
  readonly accountId: string;
  readonly createdBy: string;
  readonly createdAt: string; // ISO
  readonly supersededAt: string | null; // ISO — set when replaced by a newer binding
}

// ----------------------------------------------------------------------------
// ProviderHealth — availability states surfaced to users.
// ----------------------------------------------------------------------------

export interface ProviderHealthState {
  readonly definitionId: string;
  readonly tenantId: string;
  readonly state: 'available' | 'unavailable' | 'unknown';
  readonly lastVerifiedAt: string | null; // ISO
  readonly basis: 'verification' | 'execution' | 'manual' | 'none';
  /** Sanitized note (no credentials, no raw provider error dumps). */
  readonly note: string | null;
}

// ============================================================================
// W132 operational extension (ADDITIVE — every frozen export above stays
// byte-identical; this block adds the operational vocabulary the service
// layer, the contract surface and the tests speak).
// ============================================================================

// ----------------------------------------------------------------------------
// Code-owned wire-protocol knowledge (module-internal reference data).
//
// For a 'known' definition (W034 LlmProvider vocabulary) the wire protocol
// is DERIVED, never stored: it is the dialect the W034 adapter set speaks
// for that provider (deepseek/groq speak the OpenAI-compatible dialect
// through the openai-compatible adapter — see llm/adapters/index.ts).
// ----------------------------------------------------------------------------

/** The wire protocol a W034 known provider speaks (mirrors the W034 adapter set). */
export type KnownProviderWireProtocol = WireProtocolKind;

// ----------------------------------------------------------------------------
// Definition management inputs/results
// ----------------------------------------------------------------------------

/** Connect a KNOWN provider (W034 LlmProvider vocabulary) for the tenant. */
export interface ConnectKnownProviderInput {
  /** Must be a W034 registry provider (the closed known-provider vocabulary). */
  readonly provider: string;
  /** Optional tenant-chosen label; defaults to the provider slug. */
  readonly label?: string;
}

/**
 * Register a CUSTOM provider: a definition over an EXISTING wire protocol
 * with a custom base URL. A custom provider never invents a protocol
 * dialect — wireProtocol must be one the platform already speaks.
 */
export interface RegisterCustomProviderInput {
  /** Tenant-chosen slug; must not collide with the W034 vocabulary. */
  readonly provider: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly wireProtocol: WireProtocolKind;
}

export interface UpdateProviderDefinitionInput {
  readonly definitionId: string;
  /** Label and status are the only mutable fields — a definition's identity (kind, provider, endpoint, protocol) is immutable. */
  readonly label?: string;
  readonly status?: 'active' | 'disabled';
}

export interface ListProviderDefinitionsQuery {
  readonly kind?: ProviderDefinitionKind;
  readonly status?: 'active' | 'disabled';
  readonly provider?: string;
  /** 1..500, default 50. */
  readonly limit?: number;
}

export interface DefinitionRefQuery {
  readonly definitionId: string;
}

// ----------------------------------------------------------------------------
// Catalog management
// ----------------------------------------------------------------------------

/**
 * Manually register a model on a definition (the discovery fallback — a
 * first-class catalog entry with origin 'manual').
 */
export interface RegisterModelManuallyInput {
  readonly definitionId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities?: readonly ('text-generation' | 'embedding')[];
  readonly contextWindowTokens?: number | null;
  readonly maxOutputTokens?: number | null;
  readonly priceInputMinorPerMillion?: number | null;
  readonly priceOutputMinorPerMillion?: number | null;
}

export interface ListModelCatalogQuery {
  /** Optional filter; when absent the WHOLE tenant catalog lists (one canonical registry). */
  readonly definitionId?: string;
  readonly origin?: ModelCatalogOrigin;
  readonly status?: 'available' | 'unavailable';
  readonly capability?: 'text-generation' | 'embedding';
  /** 1..500, default 50. */
  readonly limit?: number;
}

export interface ModelEntryRefQuery {
  readonly entryId: string;
}

// ----------------------------------------------------------------------------
// Discovery — the transport seam (mirrors the llm gateway's setLlmTransport
// infra-seam pattern: deterministic doubles in tests, real transports wired
// at process start, NEVER real network under test).
// ----------------------------------------------------------------------------

/**
 * One model a discovery transport reports. Everything except `modelId` may
 * be unknown (`null`) — many list-models endpoints return bare ids; the
 * fabric fills display names from the id and enriches capabilities/windows
 * from the W034 registry for known providers, never by guessing.
 */
export interface FabricDiscoveredModelSample {
  readonly modelId: string;
  readonly displayName: string | null;
  readonly capabilities: readonly ('text-generation' | 'embedding')[] | null;
  readonly contextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly priceInputMinorPerMillion: number | null;
  readonly priceOutputMinorPerMillion: number | null;
}

/** The provider-neutral request handed to the discovery transport. */
export interface FabricDiscoveryRequest {
  readonly definitionId: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly wireProtocol: WireProtocolKind;
  /** null for 'known' definitions — the protocol's canonical endpoint. */
  readonly baseUrl: string | null;
}

/**
 * Provider-neutral outcome of one discovery probe:
 *  * `succeeded`   — the provider listed its models;
 *  * `unsupported` — the provider exposes no list-models API (a legitimate
 *                    provider property, recorded in the discovery state —
 *                    the manual registration fallback exists for this);
 *  * `failed`      — the probe failed (transport error); `detail` is
 *                    sanitized before it is ever persisted.
 */
export interface FabricDiscoveryReceipt {
  readonly status: 'succeeded' | 'unsupported' | 'failed';
  readonly models: readonly FabricDiscoveredModelSample[];
  /** Sanitized human detail; null when the transport has nothing to say. */
  readonly detail: string | null;
}

/** The discovery port real transports implement (wired via setFabricDiscoveryTransport). */
export interface FabricDiscoveryTransport {
  listModels(request: FabricDiscoveryRequest): Promise<FabricDiscoveryReceipt>;
}

export type ModelDiscoveryOutcome = 'succeeded' | 'unsupported' | 'failed';

export interface RunModelDiscoveryInput {
  readonly definitionId: string;
}

/** The result of one discovery run: the outcome, the recorded state, and the (refreshed) entries when succeeded. */
export interface ModelDiscoveryResult {
  readonly outcome: ModelDiscoveryOutcome;
  readonly state: ModelDiscoveryState;
  /** The definition's catalog entries after the refresh (empty unless succeeded). */
  readonly entries: readonly ModelCatalogEntry[];
}

// ----------------------------------------------------------------------------
// Bindings
// ----------------------------------------------------------------------------

export interface AttachModelBindingInput {
  readonly purpose: ModelBindingPurpose;
  readonly definitionId: string;
  readonly modelId: string;
  /** OPAQUE reference to the W034 BYOA account that executes this binding. */
  readonly accountId: string;
}

export interface AttachModelBindingResult {
  readonly binding: ModelBinding;
  /** The binding this one superseded (null when this is the purpose's first binding). */
  readonly superseded: ModelBinding | null;
}

export interface ActiveBindingQuery {
  readonly purpose: ModelBindingPurpose;
}

export interface ListModelBindingsQuery {
  readonly purpose?: ModelBindingPurpose;
  readonly status?: 'active' | 'superseded';
  /** 1..500, default 50. */
  readonly limit?: number;
}

export interface BindingSwapEvidenceQuery {
  readonly purpose: ModelBindingPurpose;
}

/** One distinct (definition, model) path a purpose has been bound through, in first-attachment order. */
export interface ModelBindingProviderPath {
  readonly definitionId: string;
  readonly provider: string;
  readonly label: string;
  readonly kind: ProviderDefinitionKind;
  readonly modelId: string;
}

/**
 * The fabric-level provider-swap evidence: which model currently serves a
 * purpose, the full append-only binding history, and the distinct
 * provider/model paths that purpose has been served through. (Execution
 * through both paths is proven by the W034 hot-swap verification at the
 * composition boundary — the fabric never invokes models.)
 */
export interface ModelBindingSwapEvidence {
  readonly purpose: ModelBindingPurpose;
  readonly current: ModelBinding | null;
  /** Chronological (seq ascending) — the audit trail. */
  readonly history: readonly ModelBinding[];
  readonly providerPaths: readonly ModelBindingProviderPath[];
}

// ----------------------------------------------------------------------------
// Health
// ----------------------------------------------------------------------------

export interface RecordProviderHealthInput {
  readonly definitionId: string;
  /** Callers may only ASSERT a definite state — 'unknown' is the honest default the fabric mints itself. */
  readonly state: 'available' | 'unavailable';
  /**
   * 'manual' (a person says so) or 'execution' (observed through gateway
   * executions by the composition layer). 'verification' is reserved for
   * the fabric's own verifyProviderDefinition probe; 'none' is the
   * initial state minted at connect.
   */
  readonly basis: 'manual' | 'execution';
  /** Sanitized note (credential-shaped content is rejected, never stored). */
  readonly note?: string | null;
}

export interface ListProviderHealthStatesQuery {
  readonly state?: 'available' | 'unavailable' | 'unknown';
  /** 1..500, default 50. */
  readonly limit?: number;
}
