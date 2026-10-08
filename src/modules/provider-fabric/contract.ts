// ============================================================================
// provider-fabric — the ONLY public surface of the module.
// Cross-module imports must target exactly '@/modules/provider-fabric/contract'
// (scripts/check-architecture.ts rule (b); the W124b frozen stage below stays
// byte-identical — W132 only ADDS the operational surface around it).
//
// W132 — Provider Fabric and User-Selectable Models:
//
//   Definitions (one canonical registry, lock 30 — no provider privileged):
//   connectKnownProvider — connect a KNOWN provider by the W034
//      LlmProvider vocabulary (the llm module's code-owned registry —
//      the only known-provider vocabulary there is).
//   registerCustomProvider — register a CUSTOM provider: a definition
//      over an EXISTING wire protocol with a custom base URL. A custom
//      provider never invents a protocol dialect.
//   getProviderDefinition / listProviderDefinitions /
//   updateProviderDefinition — tenant-scoped reads and the two mutable
//      fields (label, status). Identity is immutable; definitions
//      disable, they never delete (binding history references them).
//
//   Catalog (single canonical registry — the acceptance's "one registry
//   drives UX/backend/runtime"):
//   registerModelManually — the discovery FALLBACK: a first-class
//      catalog entry with origin 'manual'.
//   listModelCatalog / getModelCatalogEntry — the tenant's whole model
//      space in one place (both origins, both definition kinds).
//
//   Discovery (deterministic-double seam, never real network in tests):
//   runModelDiscovery — probe the provider's model listing through the
//      wired transport; record the outcome honestly (succeeded /
//      unsupported / failed) in the per-definition discovery state;
//      refresh discovered catalog entries (manual entries are sticky);
//      models the provider no longer lists become 'unavailable'.
//   setFabricDiscoveryTransport / getFabricDiscoveryTransport —
//      infrastructure wiring for the discovery port (the setLlmTransport
//      pattern). No transport is wired by default; discovery then fails
//      explicitly with `provider_unavailable`.
//
//   Bindings (model switching = auditable supersession):
//   attachModelBinding — THE SWAP PATH: append the new binding and
//      supersede the purpose's previous active binding in ONE
//      transaction (partial unique index: one active binding per purpose
//      per tenant). Bindings are append-only audit evidence; the only
//      credential linkage is the OPAQUE accountId reference to the W034
//      BYOA account.
//   getActiveModelBinding / listModelBindings — the current selection
//      and the full audit history.
//   getBindingSwapEvidence — the fabric-level two-provider swap
//      evidence: current binding, chronological history and the distinct
//      provider/model paths a purpose has been served through.
//
//   Health (append-only observation evidence):
//   verifyProviderDefinition — the fabric's own verification probe
//      (basis 'verification'); an unsupported listing response still
//      proves reachability.
//   recordProviderHealth — caller observations (basis 'manual' or
//      'execution' — the composition layer records gateway-observed
//      outcomes here; the fabric itself never invokes models).
//   getProviderHealthState / listProviderHealthStates — the latest
//      state per definition.
//
// PROVIDER ISOLATION (locks 28/30): everything exported below is
// provider-neutral by construction. The LLM Gateway (W034) remains the
// only owner of provider/model execution and routing — this module
// SUPPLIES definitions, catalogs and bindings; it never re-routes
// invokeLlm. Credentials live only in the existing credential-ref
// mechanism: no input, output or table of this surface carries a
// credential value (credential-shaped input is rejected with the typed
// `credential_payload_rejected`).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's definitions,
// catalog, bindings or health are indistinguishable from missing ones —
// no existence leak. Malformed references surface the same uniform
// typed not-found as unknown ones.
// ============================================================================

// ---------------------------------------------------------------------------
// W124b TL-frozen stage (types only — kept byte-identical)
// ---------------------------------------------------------------------------

export type {
  WireProtocolKind,
  ProviderDefinitionKind,
  ProviderDefinition,
  ModelCatalogOrigin,
  ModelCatalogEntry,
  ModelDiscoveryState,
  ModelBindingPurpose,
  ModelBinding,
  ProviderHealthState,
} from './types';

// ---------------------------------------------------------------------------
// W132 operational surface
// ---------------------------------------------------------------------------

export {
  // Definitions
  connectKnownProvider,
  getProviderDefinition,
  listProviderDefinitions,
  registerCustomProvider,
  updateProviderDefinition,
  // Catalog
  getModelCatalogEntry,
  listModelCatalog,
  registerModelManually,
  // Discovery (transport seam + execution)
  getFabricDiscoveryTransport,
  runModelDiscovery,
  setFabricDiscoveryTransport,
  // Bindings
  attachModelBinding,
  getActiveModelBinding,
  getBindingSwapEvidence,
  listModelBindings,
  // Health
  getProviderHealthState,
  listProviderHealthStates,
  recordProviderHealth,
  verifyProviderDefinition,
} from './service';

export type {
  AttachModelBindingInput,
  AttachModelBindingResult,
  ActiveBindingQuery,
  BindingSwapEvidenceQuery,
  ConnectKnownProviderInput,
  DefinitionRefQuery,
  FabricDiscoveredModelSample,
  FabricDiscoveryReceipt,
  FabricDiscoveryRequest,
  FabricDiscoveryTransport,
  KnownProviderWireProtocol,
  ListModelBindingsQuery,
  ListModelCatalogQuery,
  ListProviderDefinitionsQuery,
  ListProviderHealthStatesQuery,
  ModelBindingProviderPath,
  ModelBindingSwapEvidence,
  ModelDiscoveryOutcome,
  ModelDiscoveryResult,
  ModelEntryRefQuery,
  RecordProviderHealthInput,
  RegisterCustomProviderInput,
  RegisterModelManuallyInput,
  RunModelDiscoveryInput,
  UpdateProviderDefinitionInput,
} from './types';

// Pure vocabulary/guards and bounds (the llm contract's discipline —
// consumers pre-check shapes without touching the service).
export {
  DEFAULT_LIST_LIMIT,
  MAX_BASE_URL_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ERROR_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MODEL_ID_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PROVIDER_SLUG_LENGTH,
  MAX_TOKENS,
  MODEL_BINDING_PURPOSES,
  MODEL_CATALOG_CAPABILITIES,
  MODEL_SAMPLE_KEYS,
  PROVIDER_SLUG_PATTERN,
  PROVIDER_WIRE_PROTOCOLS,
  WIRE_PROTOCOLS,
  containsCredentialLikeToken,
  isModelBindingPurpose,
  isModelCatalogCapability,
  isProviderDefinitionKind,
  isUuid,
  isWireProtocolKind,
  knownProviderWireProtocol,
  sanitizeTransportDetail,
  sanitizeUserNote,
  validateModelSample,
} from './validation';

export type {
  ModelCatalogCapability,
  ValidatedModelSample,
} from './validation';

export { ProviderFabricError } from './errors';
export type { ProviderFabricErrorCode } from './errors';
