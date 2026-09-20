// Errors of the auth module (W058 — Authentication, Sessions & Tenant
// Onboarding).
//
// Code map (stable strings the app layer maps to HTTP outcomes):
//   invalid_input            — malformed arguments (400)
//   invalid_credentials      — sign-in failed; deliberately the SAME error
//                              for an unknown email and a wrong password
//                              (no account enumeration)
//   email_taken             — sign-up email already registered (409)
//   unauthorized            — no session / revoked session token (401)
//   session_expired         — the session's lifetime is over (401)
//   principal_disabled      — the account is disabled; sessions die with it (401)
//   tenant_unavailable      — the named company does not exist or the
//                              principal is not (or no longer) a member —
//                              the ADR-0001 no-existence-leak doctrine
//                              (organizations makes the two cases
//                              indistinguishable on purpose)
//   workspace_unavailable   — the workspace does not exist in the active
//                              company or is not visible to the principal
//   no_active_tenant        — the session has no active company selection
//   forbidden               — the acting principal's role does not allow
//                              the operation (403)
//   slug_taken              — company slug already in use (409)
//   invitation_not_found    — unknown/expired/revoked/accepted invitation
//                              token (uniform, no probing)
//   invitation_not_pending  — the invitation exists but can no longer be
//                              accepted (accepted or revoked)
//   invitation_expired      — the invitation's lifetime is over
//   invitation_email_mismatch — the signed-in account's email differs from
//                              the invited address (invite tokens are not
//                              transferable)
//   grant_failed            — the organizations contract refused the
//                              membership grant at acceptance time (e.g.
//                              the inviter lost the authority to grant it)

export type AuthErrorCode =
  | 'invalid_input'
  | 'invalid_credentials'
  | 'email_taken'
  | 'unauthorized'
  | 'session_expired'
  | 'principal_disabled'
  | 'tenant_unavailable'
  | 'workspace_unavailable'
  | 'no_active_tenant'
  | 'forbidden'
  | 'slug_taken'
  | 'invitation_not_found'
  | 'invitation_not_pending'
  | 'invitation_expired'
  | 'invitation_email_mismatch'
  | 'grant_failed';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}
