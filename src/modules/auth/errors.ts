// Typed errors of the auth module. Consumers catch `AuthError` and branch
// on `code`; messages are for humans/logs, never for control flow.
//
// Credential doctrine: sign-in failures are uniformly `invalid_credentials`
// (a wrong password, an unknown email — indistinguishable on purpose, no
// account-existence leak). Session failures are uniformly
// `unauthenticated` (a missing, revoked, expired or otherwise unusable
// session token) — the surface never learns WHY a token failed.
//
// Isolation doctrine (ADR-0001, the organizations/identity house style): a
// company that does not verify (missing, foreign, or non-member) is one
// uniform `company_not_available`; an invite code that does not resolve to
// a live, deliverable invitation is one uniform `invite_not_found`.

export type AuthErrorCode =
  /** Malformed operation input (email, password, name, uuid, code shapes). */
  | 'invalid_input'
  /** Sign-in failed — wrong email or wrong password (uniform). */
  | 'invalid_credentials'
  /** The email is already registered. */
  | 'email_taken'
  /** No usable session for this token (missing, revoked or expired). */
  | 'unauthenticated'
  /** The session exists but carries no active company yet (onboarding). */
  | 'no_active_company'
  /** The requested company does not verify for this principal (missing, foreign or non-member). */
  | 'company_not_available'
  /** The requested workspace does not verify inside the active company. */
  | 'workspace_not_available'
  /** The caller's role does not allow the operation. */
  | 'forbidden'
  /** The invite code does not resolve to a live invitation. */
  | 'invite_not_found'
  /** The invite is live but bound to a different email than the session's. */
  | 'invite_email_mismatch'
  /** The invite was already accepted (terminal state). */
  | 'invite_already_accepted'
  /** The principal is already a member of the invite's company. */
  | 'already_a_member';

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
