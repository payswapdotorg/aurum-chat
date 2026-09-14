// Public domain types of the identity module (ADR-0003 — Identity Resolution).
//
// The identity module owns ExternalIdentity records: tenant-scoped, verified
// links between channel-provider accounts and the subject record they belong
// to. Subjects are opaque uuid references — the people module owns person
// records and orchestrates linking (dependency direction `identity → people`
// per MODULE-DEPENDENCY-MAP.md), so `subjectId` intentionally carries no
// foreign key.

import type { ChannelProvider } from './providers';

/**
 * Lifecycle of an ExternalIdentity's verification (ADR-0003: "explicit
 * verification state").
 *
 * - `unverified` — registered, ownership of the account not yet proven;
 * - `pending`    — a verification challenge has been issued and is outstanding;
 * - `verified`   — ownership proven (challenge response or admin attestation);
 * - `revoked`    — verification withdrawn; the identity resolves to nothing
 *                  until it is explicitly re-attested.
 */
export type IdentityStatus = 'unverified' | 'pending' | 'verified' | 'revoked';

/** How ownership of the provider account was proven. */
export type VerificationMethod = 'challenge_response' | 'admin_attestation';

/**
 * Kind of record an ExternalIdentity resolves to. W002 links persons only;
 * the value is carried explicitly so later work items (customers, supplier
 * contacts, …) can extend the vocabulary without reshaping the table.
 */
export type SubjectKind = 'person';

/** A tenant-scoped external channel identity (ADR-0003). */
export interface ExternalIdentity {
  id: string;
  tenantId: string;
  /** Neutral provider key (ARCHITECTURE.md §9); never a provider SDK object (lock 16). */
  provider: ChannelProvider;
  /**
   * Canonical, provider-normalized account identifier as supplied by the
   * channel adapter (e.g. E.164 phone, Slack member id, email address).
   * Normalization is the adapter's concern (ADR-0015); this module stores
   * the value exactly as given (trimmed) and keys uniqueness on it.
   */
  providerAccountId: string;
  displayName: string | null;
  /** Opaque reference to the linked subject (people.persons.id) — null while unresolved. */
  subjectId: string | null;
  subjectKind: SubjectKind | null;
  linkedAt: string | null;
  status: IdentityStatus;
  verificationMethod: VerificationMethod | null;
  /** ISO 8601. */
  verifiedAt: string | null;
  /** Principal that performed or confirmed the verification. */
  verifiedBy: string | null;
  /** Free-text evidence recorded for admin attestations. */
  verificationEvidence: string | null;
  /** ISO 8601. */
  revokedAt: string | null;
  revokedReason: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

export interface RegisterExternalIdentityInput {
  provider: ChannelProvider;
  providerAccountId: string;
  displayName?: string | null;
}

export interface RegisterExternalIdentityResult {
  identity: ExternalIdentity;
  /** false when a identity for this (provider, account) already existed. */
  created: boolean;
}

export interface FindByProviderKeyInput {
  provider: ChannelProvider;
  providerAccountId: string;
}

export interface IssueChallengeInput {
  identityId: string;
  /** Seconds until the challenge expires (default 900; allowed 30..86400). */
  ttlSeconds?: number;
}

/**
 * A freshly issued challenge. `code` is returned exactly once — delivering it
 * over the provider channel is the channels module's concern (W030). Only
 * its hash is persisted.
 */
export interface IssuedChallenge {
  identityId: string;
  challengeId: string;
  code: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface CompleteChallengeInput {
  identityId: string;
  code: string;
}

export interface AttestIdentityInput {
  identityId: string;
  /** Human-readable evidence backing the attestation (required). */
  evidence: string;
}

export interface RevokeVerificationInput {
  identityId: string;
  reason: string;
}

export interface AttachSubjectInput {
  identityId: string;
  /** uuid of the subject record (people.persons.id for W002). */
  subjectId: string;
  subjectKind?: SubjectKind;
}

export interface DetachSubjectInput {
  identityId: string;
}
