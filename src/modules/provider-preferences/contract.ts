// ============================================================================
// provider-preferences — the ONLY public surface of the
// provider-preferences module (IMPLEMENTATION-STACK §2; cross-module
// imports of anything else are architecture violations detected by
// scripts/check-architecture.ts).
//
// W091 — User-Friendly Provider Choice UX:
// "Present provider selection as outcomes such as cost, privacy,
//  quality, speed or organizational policy. Persist preferences and
//  reveal technical details only in advanced settings."
// Acceptance: "ordinary user never needs provider jargon; preference
// can be changed at any time; system explains why a provider was
// selected; technical override remains available to authorized
// advanced users."
//
//   THE PREFERENCE DOMAIN (persisted outcomes, both levels):
//   setTenantPreference — claim-gated ('provider-preferences:
//      administer'): the company-wide outcome priority and the
//      organizational-policy posture. Changeable any time; audited.
//   getTenantPreference / setPersonalPreference (any member; the
//      principal comes from the context, never the payload) /
//      getPersonalPreference / clearPersonalPreference — the personal
//      level, changeable any time, audited.
//   getResolvedPreference — the deterministic fold for the calling
//      principal (policy-first → personal → tenant → the documented
//      balanced default) with its plain-language source attribution.
//
//   THE "WHY" LEDGER (selection explanations — append-only):
//   resolveProviderChoice — the composed POLICY-INPUT resolution the
//      owning gateway routes around: the active technical override, the
//      W090 budget routing (READ-ONLY consult — provider costs route
//      through the billing gateway, never around it), the resolved
//      outcome profile and the deterministic ranker; records the honest
//      user-language explanation, including 'only one option was
//      available', 'no option was available' and 'a spending limit
//      excluded others'. Idempotent by dedupe key (first write wins).
//   recordSelectionExplanation — the standalone recorder for gateways
//      that choose on their own: the explanation is BUILT here from
//      structured fields (jargon-free by construction).
//   listSelectionExplanations — the ORDINARY feed: no technical
//      identity crosses (the view projection strips the provider and
//      account references).
//   getSelectionExplanation — claim-gated: the FULL record (the chosen
//      provider, account reference, gateway) for the advanced surface.
//
//   THE TECHNICAL OVERRIDE (advanced, authorization-gated, reversible):
//   setTechnicalOverride / clearTechnicalOverride /
//   getTechnicalOverride / listTechnicalOverrides — pin a provider for
//      a (gateway, capability) scope with a REQUIRED reason; a cleared
//      override can be set again; every change appends to the audit
//      feed. The override is routing POLICY INPUT — it never bypasses
//      the W009 authority gate for consequential actions.
//
//   THE AUDIT FEED:
//   listProviderPreferenceEvents — the append-only change history
//      (user-language details; the storage layer refuses UPDATE/DELETE
//      on both audit tables).
//
// JARGON DISCIPLINE (the acceptance's first clause): the ordinary
// surface speaks outcomes and plain language ONLY. The user-language
// explanation strings are assembled by policy.ts from structured
// decision fields — there is no code path that interpolates a provider
// key into an explanation — and the ordinary reads return the view
// projection without technical identity. Providers appear only as the
// OPAQUE keys of the claim-gated advanced surface.
//
// ROUTING POSTURE (the work order's scope): this module FEEDS policy
// inputs (the resolved profile, the recorded explanations, the
// override state); it never changes provider implementations, never
// invokes a provider, and never privileges one (lock 30 — the ranker
// applies the TENANT's priority over caller-normalized signals).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's preferences,
// overrides, explanations and audit events are indistinguishable from
// missing ones — no existence leak.
//
// Dependency posture (WORK-ITEM-CATALOG W091 ← W066, W080, W089, W090;
// all verified present at the reviewed base): this module imports ONLY
// one other module's contract — provider-billing (W090: the read-only
// budget-routing consult inside resolveProviderChoice). The W089 SDK's
// open-vocabulary discipline (shape-checked gateway/provider keys, no
// hard-coded provider list) is applied directly; the W066 BYOA surface
// and the W080 workflow discipline are composed by the owning gateways,
// not re-implemented here.
// ============================================================================

export {
  // The preference domain (tenant level + personal level)
  clearPersonalPreference,
  getPersonalPreference,
  getResolvedPreference,
  getTenantPreference,
  setPersonalPreference,
  setTenantPreference,
  // The "why" ledger (selection explanations)
  listSelectionExplanations,
  recordSelectionExplanation,
  resolveProviderChoice,
  getSelectionExplanation,
  // The technical override (advanced, gated, reversible)
  clearTechnicalOverride,
  getTechnicalOverride,
  listTechnicalOverrides,
  setTechnicalOverride,
  // The audit feed
  listProviderPreferenceEvents,
} from './service';

export { ProviderPreferencesError } from './errors';
export type { ProviderPreferencesErrorCode } from './errors';

// Module-owned constants.
export { PROVIDER_PREFERENCES_AUTHORITY_ADMINISTER } from './service';

// The pure deterministic policy core (unit-tested without a database;
// exported for downstream surfaces exactly like the capability-grants
// reason helpers and the deep-actions reconciliation surface).
export {
  DEFAULT_OUTCOME_PRIORITY,
  buildSelectionExplanation,
  outcomePhrase,
  preferenceSourcePhrase,
  rankProviderCandidates,
  resolvePreferenceProfile,
  selectionDecisionLabel,
  toOrdinaryExplanationView,
} from './policy';
export type {
  CandidateRanking,
  RankedCandidate,
  SelectionExplanationInput,
} from './policy';

// Validation vocabularies + guards (the house pattern).
export {
  DEFAULT_LIST_LIMIT,
  MAX_ACCOUNT_REF_LENGTH,
  MAX_CANDIDATES,
  MAX_DEDUPE_KEY_LENGTH,
  MAX_EXPLANATION_LENGTH,
  MAX_LIST_LIMIT,
  MAX_PROJECTED_COST_MINOR,
  MAX_REASON_LENGTH,
  PREFERENCE_SOURCES,
  PROVIDER_PREFERENCE_EVENT_TYPES,
  PROVIDER_PREFERENCE_OUTCOMES,
  SELECTION_DECISIONS,
  TECHNICAL_OVERRIDE_STATUSES,
  assertProviderPreferencesTenantContext,
  isPreferenceSource,
  isProviderPreferenceEventType,
  isProviderPreferenceOutcome,
  isSelectionDecision,
  isTechnicalOverrideStatus,
  isUuid,
  overrideScopeKey,
} from './validation';
export type {
  ValidatedClearOverrideInput,
  ValidatedGetExplanationQuery,
  ValidatedGetOverrideQuery,
  ValidatedListEventsQuery,
  ValidatedListExplanationsQuery,
  ValidatedListOverridesQuery,
  ValidatedRecordExplanationInput,
  ValidatedResolveChoiceInput,
  ValidatedSetOverrideInput,
  ValidatedSetPersonalPreferenceInput,
  ValidatedSetTenantPreferenceInput,
} from './validation';

export type {
  ClearTechnicalOverrideInput,
  GetSelectionExplanationQuery,
  GetTechnicalOverrideQuery,
  ListProviderPreferenceEventsQuery,
  ListSelectionExplanationsQuery,
  ListTechnicalOverridesQuery,
  PersonalPreference,
  PreferenceSource,
  ProviderCandidate,
  ProviderPreferenceEvent,
  ProviderPreferenceEventType,
  ProviderPreferenceOutcome,
  RecordSelectionExplanationInput,
  RecordSelectionExplanationResult,
  ResolvedPreferenceProfile,
  ResolveProviderChoiceInput,
  ResolveProviderChoiceResult,
  SelectionDecision,
  SelectionExplanationRecord,
  SelectionExplanationView,
  SetPersonalPreferenceInput,
  SetTechnicalOverrideInput,
  SetTechnicalOverrideResult,
  SetTenantPreferenceInput,
  TenantPreference,
  TechnicalOverride,
  TechnicalOverrideStatus,
} from './types';
