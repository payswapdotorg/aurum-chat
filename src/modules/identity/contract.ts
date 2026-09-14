// ============================================================================
// identity — the ONLY public surface of the identity module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// ADR-0003 — Identity Resolution. An employee may have many external channel
// identities; an ExternalIdentity resolves them into one tenant-scoped
// person/employee record with an explicit verification state.
//
// The verified-linking workflow:
//
//   1. registerExternalIdentity      — channel adapters register provider
//      accounts on sight (get-or-create; duplicates collapse onto one row).
//      New identities are `unverified` and resolve to nothing.
//   2. issueVerificationChallenge / completeVerificationChallenge
//      — out-of-band proof that the account holder controls the account
//      (code delivery happens in the channels module, W030), OR
//      attestIdentity — an explicit, evidence-carrying admin attestation.
//   3. attachVerifiedSubject         — link a *verified* identity to its
//      subject (people.persons.id, opaque here). The people module's
//      linkExternalIdentity orchestrates this for person records.
//   4. detachSubject / revokeVerification — break the association / withdraw
//      the trust. Revocation also detaches: a revoked identity resolves to
//      nothing until it is explicitly re-attested.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and is
// tenant-scoped at the SQL layer; access to another tenant's identity is
// reported as `identity_not_found` (no existence leak).
//
// Authority (interim until W009): attestation/revocation require the
// `identity:attest` claim; attach/detach require `identity:link`.
//
// Provider independence (ADR-0015): providers appear only as neutral keys
// (see CHANNEL_PROVIDERS); no provider SDK object crosses this contract.
// ============================================================================

export {
  attestIdentity,
  attachVerifiedSubject,
  completeVerificationChallenge,
  detachSubject,
  findExternalIdentityByProviderKey,
  getExternalIdentity,
  issueVerificationChallenge,
  listSubjectIdentities,
  registerExternalIdentity,
  revokeVerification,
} from './service';

export { IdentityError } from './errors';
export type { IdentityErrorCode } from './errors';

export { CHANNEL_PROVIDERS, isChannelProvider } from './providers';
export type { ChannelProvider } from './providers';

export { IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK } from './access';

export { DEFAULT_CHALLENGE_TTL_SECONDS } from './challenge';

export type {
  AttachSubjectInput,
  AttestIdentityInput,
  CompleteChallengeInput,
  DetachSubjectInput,
  ExternalIdentity,
  FindByProviderKeyInput,
  IdentityStatus,
  IssuedChallenge,
  IssueChallengeInput,
  RegisterExternalIdentityInput,
  RegisterExternalIdentityResult,
  RevokeVerificationInput,
  SubjectKind,
  VerificationMethod,
} from './types';
