// Typed errors of the identity module. Consumers catch `IdentityError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`identity_not_found`) — existence of an identity in another tenant
// must not leak (ADR-0001).

export type IdentityErrorCode =
  | 'invalid_context'
  | 'forbidden'
  | 'invalid_identity_input'
  | 'invalid_subject'
  | 'identity_not_found'
  | 'identity_already_verified'
  | 'identity_revoked'
  | 'identity_not_verified'
  | 'identity_not_linked'
  | 'identity_already_linked'
  | 'invalid_challenge_ttl'
  | 'challenge_not_active'
  | 'challenge_expired'
  | 'challenge_code_mismatch'
  | 'challenge_attempts_exhausted';

export class IdentityError extends Error {
  constructor(
    public readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}
