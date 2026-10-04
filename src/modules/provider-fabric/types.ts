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
