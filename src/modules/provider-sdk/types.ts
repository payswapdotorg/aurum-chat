// The canonical, provider-agnostic vocabulary of the provider-sdk module
// (W089). Everything here is GATEWAY-NEUTRAL by construction: no provider
// SDKs, no wire formats, no provider-minted objects (the module imports no
// provider SDK at all — IMPLEMENTATION-STACK §6). Gateway modules translate
// their provider-specific reality INTO these types at the adapter boundary;
// nothing in this module ever decides WHICH provider to use (provider
// selection stays in the owning gateway's routing/policy — handoff §4.6 and
// the W089 acceptance "provider selection stays outside domain logic").

// ---------------------------------------------------------------------------
// 1. Adapter lifecycle (W089 engineering mandate: registration → health/
//    capability discovery → configuration → verification → active →
//    degraded → retired)
// ---------------------------------------------------------------------------

/**
 * The canonical lifecycle states every provider adapter instance moves
 * through, regardless of gateway (llm, agents, channels, sources,
 * destinations, and future meeting/realtime/telephony gateways).
 *
 *   registered → discovered → configured → verified → active ⇄ degraded → retired
 *
 * `retired` is terminal: a retired adapter is removed from consideration and
 * a replacement must enter the lifecycle at `registered`. Health is a
 * SEPARATE axis (see ProviderHealthStatus): an `active` adapter's health
 * moves healthy ⇄ degraded/unavailable without leaving the `active`
 * lifecycle state; the `degraded` lifecycle state is for providers that are
 * installed but currently not trusted to serve, pending recovery.
 */
export type ProviderLifecycleState =
  | 'registered'
  | 'discovered'
  | 'configured'
  | 'verified'
  | 'active'
  | 'degraded'
  | 'retired';

/** The canonical lifecycle events (the verbs that drive the states). */
export type ProviderLifecycleEvent =
  | 'discover' // registered → discovered (health/capability discovery)
  | 'configure' // discovered → configured
  | 'verify' // configured → verified (conformance + credential verification)
  | 'activate' // verified → active
  | 'degrade' // active → degraded
  | 'recover' // degraded → active
  | 'retire'; // any non-retired state → retired

/** One append-only lifecycle history entry. */
export interface ProviderLifecycleTransition {
  /** State before the transition (null only for the birth entry). */
  readonly from: ProviderLifecycleState | null;
  readonly to: ProviderLifecycleState;
  readonly event: ProviderLifecycleEvent | 'register';
  /** ISO 8601 timestamp — caller-supplied (or the infra clock default). */
  readonly at: string;
  /** Free-form operator/machine reason (may be null). */
  readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// 2. Canonical failure taxonomy (§9 failure isolation: a provider-specific
//    failure becomes canonical capability/error state)
// ---------------------------------------------------------------------------

/**
 * The canonical error categories a provider interaction can normalize to.
 * Provider-native error shapes (HTTP status codes, SDK error classes, wire
// error payloads) NEVER cross the adapter boundary as themselves — the
 * adapter maps them onto this vocabulary.
 */
export type CanonicalErrorCategory =
  | 'auth_failure' // credentials rejected/expired
  | 'permission_denied' // scope/entitlement missing
  | 'quota_exhausted' // budget/period quota spent
  | 'rate_limited' // throttled — retry later
  | 'provider_unavailable' // outage / 5xx / connection refused
  | 'timeout' // request timed out
  | 'malformed_response' // provider response could not be normalized
  | 'unsupported_capability' // provider cannot serve this capability
  | 'invalid_request' // the canonical request itself is invalid
  | 'canceled' // the interaction was canceled
  | 'unknown_failure'; // could not be classified

/** How a failure heals. */
export type CanonicalFailureRecovery =
  | 'automatic' // cooldown + retry heals it; no human action needed
  | 'operator' // a human must intervene (rotate credentials, raise budget…)
  | 'none'; // nothing to heal (caller error / unsupported capability / canceled)

/** What one failure does to the provider's health while routing. */
export type CanonicalHealthImpact =
  | 'degrade' // still routable with caution
  | 'unavailable' // stop routing to this provider
  | 'none'; // caller/capability-scoped — provider health unchanged

/**
 * The canonical, normalized form of one provider failure. This is what
 * provider-specific exceptions become at the adapter boundary — the value
 * the owning gateway records as capability/error state (§9 failure
 * isolation: a provider outage must not become a domain failure; it becomes
 * THIS, and the gateway routes around it).
 */
export interface CanonicalProviderFailure {
  readonly category: CanonicalErrorCategory;
  /** Is an automatic retry sensible for this category? */
  readonly retryable: boolean;
  /** How this failure heals (see CanonicalFailureRecovery). */
  readonly recovery: CanonicalFailureRecovery;
  /** What this failure does to provider health (see CanonicalHealthImpact). */
  readonly healthImpact: CanonicalHealthImpact;
  /** The canonical gateway key the failing provider serves (e.g. 'llm'). */
  readonly gateway: string;
  /** The canonical provider key (e.g. 'openai'). */
  readonly provider: string;
  /** Safe, bounded human-readable detail (never a credential value). */
  readonly detail: string;
  /** Retry hint in milliseconds when the provider conveyed one; else null. */
  readonly retryAfterMs: number | null;
}

/** The full semantic row of one error category (single source of truth). */
export interface CanonicalFailureSemantics {
  readonly category: CanonicalErrorCategory;
  readonly retryable: boolean;
  readonly recovery: CanonicalFailureRecovery;
  readonly healthImpact: CanonicalHealthImpact;
}

// ---------------------------------------------------------------------------
// 3. Health & capability reporting
// ---------------------------------------------------------------------------

/**
 * The routing-facing health of a provider instance (a separate axis from the
 * lifecycle state — see ProviderLifecycleState).
 */
export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable';

/** What a provider currently serves, in the owning gateway's canonical capability vocabulary. */
export interface ProviderCapabilitySet {
  readonly sdk: 'provider-capability-set';
  readonly gateway: string;
  readonly provider: string;
  /** Canonical capability keys (e.g. 'text-generation', 'embedding' for the llm gateway). */
  readonly capabilities: readonly string[];
}

// ---------------------------------------------------------------------------
// 4. The adapter definition (the template every conforming provider fills in)
// ---------------------------------------------------------------------------

/**
 * The version of the provider-sdk adapter contract this definition targets.
 * Adapters declare it; the conformance kit checks it so a stale adapter
 * cannot silently pass review.
 */
export const PROVIDER_ADAPTER_SDK_VERSION = '1.0.0';

/** A provider-specific error classifier: provider-native error → canonical category, or null to fall through to the SDK heuristics. */
export type ProviderErrorClassifier = (error: unknown) => CanonicalErrorCategory | null;

/**
 * The provider-agnostic adapter definition every conforming provider
 * adapter implements ALONGSIDE its gateway-native duties (e.g. the llm
 * module's LlmAdapter translation methods). The definition carries only
 * canonical values: descriptor keys, capability declaration and error
 * normalization. It deliberately has NO execution method — the owning
 * gateway keeps its own canonical operation contracts (invokeLlm,
 * submitAgentExecution, …) and its own routing; the SDK never selects
 * providers.
 */
export interface ProviderAdapterDefinition {
  /** Structural discriminant. */
  readonly sdk: 'provider-adapter-definition';
  /** The SDK contract version this adapter targets (PROVIDER_ADAPTER_SDK_VERSION). */
  readonly sdkVersion: string;
  /** Canonical gateway key (e.g. 'llm', 'agents', 'channels'). */
  readonly gateway: string;
  /** Canonical provider key (e.g. 'openai') — opaque outside the gateway. */
  readonly provider: string;
  /** The capabilities this provider adapter declares it can serve. */
  describeCapabilities(): ProviderCapabilitySet;
  /** Normalize any error (provider-native or unknown) into the canonical failure taxonomy. */
  mapError(error: unknown): CanonicalProviderFailure;
}

/** Input for createProviderAdapterDefinition. */
export interface ProviderAdapterDefinitionInput {
  readonly gateway: string;
  readonly provider: string;
  readonly capabilities: readonly string[];
  /** Optional provider-specific classifier consulted before the SDK heuristics. */
  readonly classifyError?: ProviderErrorClassifier | null;
}

// ---------------------------------------------------------------------------
// 5. Hot-swap evidence (GOVERNANCE "Provider swap evidence"; builds on the
//    llm module's hot-swap verification precedent)
// ---------------------------------------------------------------------------

export type HotSwapOutcome =
  | 'equivalent' // both targets completed with identical normalized output
  | 'completed-divergent' // both completed, outputs differ — the swap still proved
  | 'failed'; // at least one target failed

/** One side of a hot-swap: which provider served and whether it completed. */
export interface HotSwapTargetDescriptor {
  /** Canonical provider key (e.g. 'openai'). */
  readonly provider: string;
  /** Opaque in-provider target refinement (e.g. a model id); may be null. */
  readonly target: string | null;
  readonly resultKind: 'completed' | 'failed';
}

/**
 * The canonical, gateway-agnostic hot-swap evidence record: proof that one
 * provider can replace another for a capability WITHOUT domain changes.
 *
 * Format (versioned via `evidenceVersion`):
 *   - `requestDigest` — SHA-256 hex of the canonical request both targets
 *     executed (the gateway computes it over ITS canonical request; the SDK
 *     can compute one over any JSON value via stable serialization);
 *   - `providerA`/`providerB` — the two (different) targets and whether
 *     each completed;
 *   - `outcome` — deterministic STRUCTURAL comparison only ('equivalent' /
 *     'completed-divergent' / 'failed'); semantic judgment stays with the
 *     caller (the llm module's precedent);
 *   - `evidenceId` — the gateway-native verification record id (opaque);
 *   - `executedAt` — ISO 8601.
 */
export interface HotSwapEvidenceRecord {
  readonly sdk: 'provider-hot-swap-evidence';
  readonly evidenceVersion: 1;
  readonly gateway: string;
  readonly capability: string;
  readonly requestDigest: string;
  readonly providerA: HotSwapTargetDescriptor;
  readonly providerB: HotSwapTargetDescriptor;
  readonly outcome: HotSwapOutcome;
  /** Always the deterministic structural comparison (never a semantic claim). */
  readonly comparison: 'deterministic-structural';
  readonly evidenceId: string;
  readonly executedAt: string;
  readonly note: string | null;
}

/** Input for buildHotSwapEvidence. Provide `requestDigest` (preferred, gateway-computed) or `canonicalRequest` (SDK digests it). */
export interface HotSwapEvidenceInput {
  readonly gateway: string;
  readonly capability: string;
  readonly providerA: HotSwapTargetDescriptor;
  readonly providerB: HotSwapTargetDescriptor;
  readonly outcome: HotSwapOutcome;
  readonly evidenceId: string;
  readonly executedAt: string;
  readonly note?: string | null;
  readonly requestDigest?: string | null;
  readonly canonicalRequest?: unknown;
}
