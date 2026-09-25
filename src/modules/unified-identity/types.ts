// Public domain types of the unified-identity module (W095 — Unified
// Cross-Channel, Meeting and Telephony Identity Verification).
//
// W095 owns the CROSS-MODALITY extension of identity proof: one person
// remains one organizational identity across messaging, meetings, SMS,
// voice, realtime and Edge Connector paths. The identity module (W002)
// stays the identity AUTHORITY for channel accounts (its
// verified-linking workflow, challenge codes and admin attestations are
// untouched and un-bypassed); this module adds:
//
//   * a modality-scoped identity REGISTRY for the communication paths the
//     identity module's provider vocabulary does not cover — meeting
//     participants (W085), realtime session participants (W086) and Edge
//     Connector path identities (W088's vocabulary lands with that item;
//     edge provider keys are free-form neutral keys until then);
//   * the AMBIGUITY GUARD (the W095 acceptance rule): an observation
//     whose matching evidence points at more than one organizational
//     person is recorded as an open ambiguity and REMAINS unverified —
//     it is never auto-merged onto a subject;
//   * the UNIFIED RESOLUTION + PROFILE surface: resolve any
//     (modality, provider, account) to the one organizational person it
//     belongs to, and show a person's verified reach grouped by
//     communication modality.
//
// Subjects are opaque uuid references to people.persons.id (the house
// pattern — no cross-module foreign key; the people module owns person
// records and this module validates every subject through its contract).

import type { ChannelProvider, ExternalIdentity } from '@/modules/identity/contract';
import type { Employee, Person } from '@/modules/people/contract';

// ---------------------------------------------------------------------------
// Modalities
// ---------------------------------------------------------------------------

/**
 * The communication modalities W095 unifies (WORK-ITEM-CATALOG W095:
 * "messaging, meetings, SMS, voice and Edge Connector paths"; realtime
 * voice/telephony sessions are W086's path and carry their own modality).
 *
 * - `messaging` — channel providers except sms/voice (identity-backed);
 * - `sms`       — cellular SMS reachability (identity provider 'sms');
 * - `voice`     — cellular voice reachability (identity provider 'voice');
 * - `meeting`   — meeting participants (W085 provider vocabulary);
 * - `realtime`  — realtime session participants (W086 provider vocabulary,
 *                 including SIP/telephony dial-outs);
 * - `edge`      — Aurum Edge Connector paths (W088; free-form neutral
 *                 provider keys until that module's vocabulary lands).
 */
export type UnifiedModality =
  | 'messaging'
  | 'sms'
  | 'voice'
  | 'meeting'
  | 'realtime'
  | 'edge';

/**
 * Modalities backed by the identity module's channel-provider registry:
 * resolution for these delegates to the people/identity contracts and this
 * module never persists a shadow row for them (no second identity
 * authority — POST-S002 addendum "Communications kernel").
 */
export type IdentityBackedModality = 'messaging' | 'sms' | 'voice';

/**
 * Modalities whose identities live in THIS module's registry (the paths
 * beyond the identity module's provider vocabulary).
 */
export type RegistryModality = 'meeting' | 'realtime' | 'edge';

// ---------------------------------------------------------------------------
// Unified identities (registry rows)
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a modality-scoped identity in this module's registry.
 * Unlike the identity module there is no `pending` state: this module
 * issues no challenges (the identity module remains the only challenge
 * authority), so an observation is either unverified, verified (linked)
 * or revoked.
 */
export type UnifiedStatus = 'unverified' | 'verified' | 'revoked';

/**
 * How a registry identity was verified:
 * - `cross_modality_match` — unique verified-evidence match (an email or
 *   E.164 phone facet matching EXACTLY ONE verified, subject-linked
 *   identity of one organizational person);
 * - `admin_attestation`    — explicit, evidence-carrying admin act.
 */
export type UnifiedVerificationMethod = 'cross_modality_match' | 'admin_attestation';

/** One modality-scoped identity owned by this module's registry. */
export interface UnifiedIdentity {
  id: string;
  tenantId: string;
  modality: RegistryModality;
  /** Neutral provider key (the owning module's canonical vocabulary). */
  provider: string;
  /** Canonical, adapter-normalized account/participant id (opaque). */
  providerAccountId: string;
  displayName: string | null;
  /**
   * Captured contact facet used as MATCHING EVIDENCE (as delivered,
   * trimmed — probes also try the lowercased form, the meetings module's
   * bridge discipline). Never proof on its own; only a UNIQUE match
   * against verified identities links.
   */
  email: string | null;
  /** Captured contact facet used as MATCHING EVIDENCE (E.164). */
  phone: string | null;
  /** Opaque reference to people.persons.id — null while unresolved. */
  subjectId: string | null;
  status: UnifiedStatus;
  verificationMethod: UnifiedVerificationMethod | null;
  verificationEvidence: string | null;
  /** ISO 8601. */
  verifiedAt: string | null;
  /** Principal that performed or confirmed the verification. */
  verifiedBy: string | null;
  /** ISO 8601. */
  revokedAt: string | null;
  revokedReason: string | null;
  /** ISO 8601. */
  linkedAt: string | null;
  /** ISO 8601 — first observation. */
  firstSeenAt: string;
  /** ISO 8601 — latest observation. */
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Matching (the ambiguity guard)
// ---------------------------------------------------------------------------

/** A person a facet probe found through a VERIFIED, subject-linked identity. */
export interface MatchCandidate {
  personId: string;
  /** The identity provider whose verified account produced the candidate. */
  matchedVia: 'email' | 'sms' | 'voice';
  /** Provider key of the matching identity ('email' | 'sms' | 'voice'). */
  provider: string;
  /** Account id of the matching identity. */
  providerAccountId: string;
}

/** What the ambiguity-guarded matcher decided for one observation. */
export type UnifiedMatchOutcome =
  | { outcome: 'unmatched' }
  | { outcome: 'linked'; personId: string; candidates: MatchCandidate[] }
  | { outcome: 'already_linked'; personId: string; candidates: MatchCandidate[] }
  | {
      outcome: 'ambiguous';
      candidates: MatchCandidate[];
      /** The open ambiguity ledger row that records the conflict. */
      ambiguityId: string;
    }
  | {
      /** The row keeps its existing verified link; evidence disagreed. */
      outcome: 'link_retained';
      personId: string;
      candidates: MatchCandidate[];
      ambiguityId: string;
    };

// ---------------------------------------------------------------------------
// Ambiguity ledger
// ---------------------------------------------------------------------------

export type UnifiedAmbiguityKind =
  | 'conflicting_subject_matches'
  | 'linked_subject_conflict';

export type UnifiedAmbiguityStatus = 'open' | 'resolved';

/**
 * How an open ambiguity was closed:
 * - `admin_linked`     — an administrator linked the identity (linkUnifiedSubject);
 * - `revoked`          — the verified link was withdrawn (revokeUnifiedLink);
 * - `evidence_resolved` — later unique verified-evidence superseded the conflict;
 * - `dismissed`        — reviewed, closed without action.
 */
export type UnifiedAmbiguityResolutionAction =
  | 'admin_linked'
  | 'revoked'
  | 'evidence_resolved'
  | 'dismissed';

/**
 * One recorded ambiguity (the W095 acceptance evidence): an observation
 * whose evidence matched more than one organizational person
 * (`conflicting_subject_matches`), or a verified row whose newer evidence
 * points away from its linked subject (`linked_subject_conflict`). The
 * identity in question stays unverified / keeps its link until a human
 * decides — never auto-merged, never silently re-linked.
 */
export interface UnifiedAmbiguity {
  id: string;
  tenantId: string;
  unifiedIdentityId: string;
  kind: UnifiedAmbiguityKind;
  /** The evidence candidates that could not be reconciled. */
  candidates: MatchCandidate[];
  detail: string;
  status: UnifiedAmbiguityStatus;
  resolvedAction: UnifiedAmbiguityResolutionAction | null;
  resolvedBy: string | null;
  /** ISO 8601. */
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface ObserveModalityIdentityInput {
  modality: RegistryModality;
  provider: string;
  providerAccountId: string;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface ObserveModalityIdentityResult {
  identity: UnifiedIdentity;
  /** false when a registry row for this (modality, provider, account) existed. */
  created: boolean;
  /** What the ambiguity-guarded matcher decided on this observation. */
  match: UnifiedMatchOutcome;
}

export interface LinkUnifiedSubjectInput {
  unifiedIdentityId: string;
  /** uuid of the subject record (people.persons.id). */
  personId: string;
  /** Human-readable evidence backing the attestation (required). */
  evidence: string;
}

export interface RevokeUnifiedLinkInput {
  unifiedIdentityId: string;
  reason: string;
}

export interface ResolveUnifiedAmbiguityInput {
  ambiguityId: string;
  /** 'dismissed' closes the ambiguity without linking (reviewed, no action). */
  action: 'dismissed';
  note?: string | null;
}

export interface ResolveUnifiedIdentityInput {
  modality: UnifiedModality;
  provider: string;
  providerAccountId: string;
}

/** A registry identity view (see UnifiedIdentityView for the shared shape). */
export interface UnifiedRegistryView {
  origin: 'unified_registry';
  identity: UnifiedIdentity;
}

/** An identity-module identity viewed through the unified surface. */
export interface UnifiedIdentityModuleView {
  origin: 'identity_module';
  identity: ExternalIdentity;
}

/**
 * Normalized view of one modality identity, whichever registry owns it —
 * the unified surface never leaks which module stores the row.
 */
export type UnifiedIdentityView = UnifiedRegistryView | UnifiedIdentityModuleView;

/**
 * Outcome of resolving one (modality, provider, account):
 *
 * - `unknown_identity` — no such identity in this tenant;
 * - `unverified`       — known but not a verified, linked identity
 *   (unverified / revoked / unlinked) — it must NOT be treated as an
 *   employee (lock 15); the precise status rides on the view;
 * - `resolved`         — resolves to exactly one person, with their
 *   employment record when one exists.
 */
export type UnifiedResolution =
  | { status: 'unknown_identity' }
  | { status: 'unverified'; view: UnifiedIdentityView }
  | { status: 'resolved'; view: UnifiedIdentityView; person: Person; employee: Employee | null };

/** One modality's verified reach in a subject profile. */
export interface UnifiedModalityReach {
  modality: UnifiedModality;
  /** Verified, subject-linked identities of this modality. */
  identities: UnifiedIdentityView[];
}

/**
 * The cross-modality proof surface (the W095 acceptance): one
 * organizational person, their employment record, and every communication
 * modality they are verifiably reachable on.
 */
export interface UnifiedSubjectProfile {
  person: Person;
  employee: Employee | null;
  /** Modalities in canonical vocabulary order; empty modalities omitted. */
  modalities: UnifiedModalityReach[];
  /** Distinct modalities with at least one verified, linked identity. */
  verifiedModalityCount: number;
}

export interface ListUnifiedIdentitiesQuery {
  modality?: RegistryModality;
  status?: UnifiedStatus;
  subjectId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

export interface ListUnifiedAmbiguitiesQuery {
  status?: UnifiedAmbiguityStatus;
  unifiedIdentityId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

export interface ListUnifiedIdentityEventsQuery {
  unifiedIdentityId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Append-only evidence trail of consequential unification decisions. */
export interface UnifiedIdentityEvent {
  id: string;
  tenantId: string;
  unifiedIdentityId: string;
  kind:
    | 'observed'
    | 'linked'
    | 'admin_linked'
    | 'revoked'
    | 'ambiguity_opened'
    | 'ambiguity_resolved';
  detail: string;
  /** ISO 8601. */
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Pull-based unification jobs (meetings / realtime participant registries)
// ---------------------------------------------------------------------------

export interface UnifyMeetingIdentitiesInput {
  /** 1..500 meeting participants considered per pass, default 50. */
  limit?: number;
}

export interface UnifyRealtimeIdentitiesInput {
  /** Restrict the pass to one realtime session's participants. */
  sessionId?: string;
  /** 1..500 realtime participants considered per pass, default 50. */
  limit?: number;
}

/** Summary of one unification pass over a participant registry. */
export interface UnifiedUnifySummary {
  /** Participants the pass considered. */
  considered: number;
  /** Registry rows created (first sight). */
  created: number;
  /** Rows auto-linked by a unique verified-evidence match. */
  linked: number;
  /** Rows whose evidence was ambiguous (open ambiguity recorded). */
  ambiguous: number;
  /** Verified rows whose newer evidence disagreed (link retained). */
  linkRetained: number;
  /** Participants skipped (Aurum's own realtime participant, unknown session). */
  skipped: number;
}

/** Re-exported so consumers of this contract need no sibling imports. */
export type { ChannelProvider, ExternalIdentity, Employee, Person };
