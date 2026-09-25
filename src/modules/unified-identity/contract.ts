// ============================================================================
// unified-identity — the ONLY public surface of the unified-identity
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else
// are architecture violations detected by scripts/check-architecture.ts).
//
// W095 — Unified Cross-Channel, Meeting and Telephony Identity
// Verification: "Extend identity proof so one person remains one
// organizational identity across messaging, meetings, SMS, voice and Edge
// Connector paths. Acceptance: same verified employee can be recognized
// across at least three communication modalities; ambiguous matches
// remain external/unverified instead of being auto-merged."
//
//   observeModalityIdentity — the on-sight registry edge for the
//      communication paths beyond the identity module's provider
//      vocabulary (meeting / realtime / edge). Get-or-create; facets move
//      forward; then the AMBIGUITY GUARD runs: contact facets are matched
//      against the tenant's VERIFIED, subject-linked identities and
//        · exactly one distinct person  → the identity is linked
//          (verification method `cross_modality_match`, evidence kept);
//        · more than one person         → an OPEN ambiguity is recorded
//          and the identity REMAINS unverified — never auto-merged;
//        · a verified row's newer evidence disagrees → the link is
//          RETAINED and the conflict recorded for human review.
//      Display names are never evidence. A revoked unification never
//      re-links automatically.
//   unifyMeetingIdentities / unifyRealtimeIdentities — the pull-based
//      passes over the meetings (W085) and realtime (W086) participant
//      registries, through their contracts: every captured participant
//      flows into the unified registry and through the ambiguity guard.
//   linkUnifiedSubject / revokeUnifiedLink / resolveUnifiedAmbiguity —
//      the explicit, claim-gated trust operations (identity:link /
//      identity:attest — the identity module's interim authority model,
//      reused so one class of identity administrators governs every
//      modality). Linking closes the identity's open ambiguities.
//   resolveUnifiedIdentity — the unified resolution: any (modality,
//      provider, account) → the ONE organizational person it belongs to,
//      or an honest unknown/unverified. Messaging/sms/voice delegate to
//      the people/identity contracts (the identity module stays the
//      authority — no shadow rows, no bypassed verification); meeting/
//      realtime/edge resolve against this module's registry.
//   getUnifiedSubjectProfile — the cross-modality proof surface: a
//      person's verified reach grouped by communication modality, with
//      verifiedModalityCount the W095 acceptance number.
//   getUnifiedIdentity / listUnifiedIdentities / listUnifiedAmbiguities /
//   listUnifiedIdentityEvents — tenant-scoped registry, ambiguity-ledger
//   and evidence-trail reads.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's
// unification state is reported as `unified_identity_not_found` /
// `ambiguity_not_found` (no existence leak). PeopleError (`person_not_found`)
// propagates unchanged out of subject-bearing operations, exactly as it
// does from the people and cellular contracts.
//
// Provider isolation (lock 16): providers appear only as the neutral keys
// of the owning module's contract vocabulary (identity CHANNEL_PROVIDERS,
// meetings MEETING_PROVIDERS, realtime REALTIME_PROVIDERS; edge keys are
// free-form neutral keys until W088 lands). No provider SDK object, raw
// envelope or provider schema crosses this contract.
//
// Dependency posture (WORK-ITEM-CATALOG W095 ← W002, W030, W085, W086,
// W087): this module imports ONLY module contracts — the identity
// contract (W002 — verified-evidence matching and the delegated
// messaging/sms/voice resolution), the people contract (W002 — person/
// employee records and identity resolution), the meetings contract (W085
// — the participant registry the meeting pass unifies) and the realtime
// contract (W086 — the session/participant registry the realtime pass
// unifies). The messaging path (W030) and the cellular SMS/voice paths
// (W087) ride the identity module's provider vocabulary, which those
// modules register and resolve identities through — the same rows this
// module's resolution and profile surfaces read; the challenge-delivery
// loop itself stays owned by the identity+channels pair and is exercised
// end-to-end by this module's integration tests.
// ============================================================================

export {
  // Registry edge + the ambiguity guard
  observeModalityIdentity,
  // Pull-based unification passes (meetings W085 / realtime W086)
  unifyMeetingIdentities,
  unifyRealtimeIdentities,
  // Explicit trust operations (claim-gated)
  linkUnifiedSubject,
  resolveUnifiedAmbiguity,
  revokeUnifiedLink,
  // Unified resolution + profile (the W095 proof surface)
  getUnifiedSubjectProfile,
  resolveUnifiedIdentity,
  // Registry / ledger / trail reads
  getUnifiedIdentity,
  listUnifiedAmbiguities,
  listUnifiedIdentities,
  listUnifiedIdentityEvents,
} from './service';

export { UnifiedIdentityError } from './errors';
export type { UnifiedIdentityErrorCode } from './errors';

export {
  // Vocabularies
  REGISTRY_MODALITIES,
  UNIFIED_AMBIGUITY_ACTIONS,
  UNIFIED_AMBIGUITY_KINDS,
  UNIFIED_AMBIGUITY_STATUSES,
  UNIFIED_MODALITIES,
  UNIFIED_STATUSES,
  UNIFIED_VERIFICATION_METHODS,
  // Limits
  DEFAULT_LIST_LIMIT,
  MAX_DETAIL_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_EVIDENCE_LENGTH,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_PROVIDER_LENGTH,
  MAX_REASON_LENGTH,
  MIN_LIST_LIMIT,
  // Guards + pure classification
  isRegistryModality,
  isUnifiedModality,
  isUnifiedStatus,
  isUnifiedVerificationMethod,
  modalityOfChannelProvider,
} from './validation';

// The interim authority claims this module's trust operations require —
// the identity module's exact claims (W002's interim model, reused so one
// class of identity administrators governs every modality).
export { IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK } from '@/modules/identity/contract';

// The ambiguity guard's pure decision logic (re-exported for consumers
// that reason about match outcomes without a database).
export { decideMatch, distinctPersons, relateEvidenceToSubject } from './matching';

export type {
  LinkUnifiedSubjectInput,
  ListUnifiedAmbiguitiesQuery,
  ListUnifiedIdentitiesQuery,
  ListUnifiedIdentityEventsQuery,
  MatchCandidate,
  ObserveModalityIdentityInput,
  ObserveModalityIdentityResult,
  RegistryModality,
  ResolveUnifiedAmbiguityInput,
  ResolveUnifiedIdentityInput,
  RevokeUnifiedLinkInput,
  UnifiedAmbiguity,
  UnifiedAmbiguityKind,
  UnifiedAmbiguityResolutionAction,
  UnifiedAmbiguityStatus,
  UnifiedIdentity,
  UnifiedIdentityEvent,
  UnifiedIdentityView,
  UnifiedMatchOutcome,
  UnifiedModality,
  UnifiedModalityReach,
  UnifiedRegistryView,
  UnifiedIdentityModuleView,
  UnifiedResolution,
  UnifiedStatus,
  UnifiedSubjectProfile,
  UnifiedUnifySummary,
  UnifiedVerificationMethod,
  UnifyMeetingIdentitiesInput,
  UnifyRealtimeIdentitiesInput,
} from './types';
