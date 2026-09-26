// ============================================================================
// provider-preferences — the ONLY public surface of the provider-preferences
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W091 — User-Friendly Provider Choice UX:
// "Present provider selection as outcomes such as cost, privacy, quality,
//  speed or organizational policy. Persist preferences and reveal technical
//  details only in advanced settings."
//
//   THE OUTCOME LAYER, NOT A NEW ROUTER:
//   the llm module's routing engine stays exactly as-is; this module adds
//   the tenant-level OUTCOME PREFERENCE PROFILE — one plain-language choice
//   (privacy-first / lowest-cost / fastest / most-reliable / balanced) that
//   maps deterministically ONTO the existing routing facts (the tenant-owned
//   account `priority` ordering, written through the llm contract's own
//   updateAiProviderAccount input — no new routing channel). Lock 30 is
//   absolute: the mapping never hard-codes a provider, and preference
//   language contains no provider jargon.
//
//   Profiles + audit:
//   getProviderPreferenceProfile — the tenant's saved choice with its
//      application state (honest defaults when nothing is saved yet) and
//      the current mapping guidance in plain language;
//   savePreferenceProfile — any member may save, unlimited times; every
//      change appends to the audit. When the saver holds the technical
//      authority claim the choice is applied immediately (takes effect
//      for the NEXT routing decision); otherwise the honest
//      requiresAdministrator state is returned.
//   applyPreferenceProfile — (claim-gated) write the mapping's priorities
//      through the llm contract; re-runnable at any time.
//   listPreferenceChangeEvents — the append-only audit (saved / applied /
//      technical-override), newest first.
//
//   The explanation surface:
//   explainRoutingDecision — "why was this provider selected?" rendered
//      from the FROZEN LlmRoutingSnapshot of the latest (or a given)
//      execution: plain-language lines, one per candidate, chosen reason
//      first; unknown machine reasons render as honest unexplained lines —
//      never invented explanations. The plain lines carry no provider/
//      model names; the technical detail rides the authorized view only.
//
//   The technical layer (advanced settings, authorized users only):
//   getTechnicalLayerView / updateProviderAccountControls — gated by the
//      SAME authority claim that administers AI provider accounts
//      ('llm:administer', re-exported below as the module's technical
//      claim). The override is a thin projection onto the EXISTING llm
//      service input (UpdateAiProviderAccountInput: priority, status,
//      scopes, capabilities, data-policy ceiling, budget) — reversible at
//      any time; cross-tenant ids are uniformly not-found (no leak).
//
// Honesty rules: cost bases cite the W090 provider-billing attribution
// first (public reads), then the llm gateway's recorded usage; privacy
// bases cite the account's data-policy ceiling; speed/reliability cite
// measured usage; anything unevidenced says so — the current order stays
// and nothing is invented. The provider-sdk technology registry is cited
// for security posture when it carries an evaluated entry for the
// provider (today it carries none for the llm providers — the surface
// states that honestly instead of inventing a posture).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's profiles, mappings,
// events and accounts are indistinguishable from missing ones — no
// existence leak.
// ============================================================================

export {
  // The outcome preference profile + audit
  applyPreferenceProfile,
  getProviderPreferenceProfile,
  listPreferenceChangeEvents,
  savePreferenceProfile,
  // The explanation surface
  explainRoutingDecision,
  // The technical layer (authorized advanced users only)
  getTechnicalLayerView,
  updateProviderAccountControls,
} from './service';

// The authority claim that gates the technical layer — the SAME claim the
// llm module enforces on account management (one claim, no new vocabulary).
export { PROVIDER_PREFERENCES_TECHNICAL_CLAIM } from './service';

export { ProviderPreferencesError } from './errors';
export type { ProviderPreferencesErrorCode } from './errors';

// Pure vocabulary / derivations (unit-testable without a database).
export {
  DEFAULT_PREFERENCE,
  PREFERENCE_OPTIONS,
  PRIORITY_STEP,
  REJECTION_REASON_PHRASES,
  allExplanationLines,
  computePreferenceOrder,
  evidenceByProvider,
  explainRoutingSnapshot,
  preferenceLineFor,
  preferenceOption,
} from './mappings';
export type { CostEvidenceSource, ProviderMeasuredEvidence } from './mappings';

// Module-owned constants.
export {
  CHANGE_EVENT_KINDS,
  DEFAULT_EVENT_LIMIT,
  MAX_BASIS_LENGTH,
  MAX_EVENT_LIMIT,
  MAX_EVENT_SUMMARY_LENGTH,
  MAX_MAPPED_ACCOUNTS,
  MAX_NOTE_LENGTH,
  PREFERENCE_KINDS,
  isPreferenceChangeEventKind,
  isProviderPreferenceKind,
  isUuid,
} from './validation';
export type {
  ValidatedSavePreferenceInput,
  ValidatedListChangeEventsQuery,
  ValidatedExplainQuery,
  ValidatedTechnicalOverrideInput,
} from './validation';

export type {
  AccountPreferenceFacts,
  ApplyPreferenceProfileResult,
  ListPreferenceChangeEventsQuery,
  PreferenceApplication,
  PreferenceAssignment,
  PreferenceChangeEvent,
  PreferenceChangeEventKind,
  PreferenceEvidence,
  PreferenceOption,
  PreferenceOrderPlan,
  PreferenceOutcomeDimension,
  ProviderPreferenceKind,
  ProviderPreferenceProfile,
  ProviderPreferenceProfileView,
  RoutingDecisionExplanation,
  RoutingExplanation,
  RoutingExplanationLine,
  SavePreferenceProfileInput,
  SavePreferenceProfileResult,
  TechnicalAccountRow,
  TechnicalLayerView,
  TechnicalOverrideInput,
  TechnicalOverrideResult,
} from './types';
