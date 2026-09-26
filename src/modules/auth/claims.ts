// Role → authority-claim derivation for authenticated sessions (W058).
//
// INTERIM, documented mapping — the same posture the organizations and
// identity modules take ("interim model — W009 folds it into the authority
// matrix"). Until the authority-matrix work item lands, a session's
// TenantContext.authority is derived from the principal's VERIFIED tenant
// role instead of being self-asserted by a URL parameter (the development
// seam this module replaces).
//
// Rules:
//   * the mapping derives ONLY from a role the organizations contract just
//     verified — a member never carries management claims;
//   * platform claims ('organizations:provision') are deliberately absent:
//     self-service company creation goes through the auth module's own
//     provisioned onboarding operation, never through ambient claims;
//   * claims ride the TenantContext exactly as before, so every domain
//     gate ('actions:approve', 'identity:link', …) applies unchanged.

import type { TenantRole } from '@/modules/organizations/contract';

/**
 * The management claim set owners and admins carry (interim, W009 folds
 * this). `marketplace:submit` is a TENANT-level capability — any company
 * may offer packages to the platform pipeline (publication remains
 * platform-governed). The platform claim `marketplace:administer`
 * (package review) is deliberately absent: platform claims never ride a
 * tenant session, exactly like `organizations:provision`.
 *
 * `llm:administer` (W066 completion of the interim set): the llm module's
 * own management claim for AI provider accounts and availability —
 * attaching external AI endpoints to a tenant is a management action (the
 * llm contract gates on exactly this string). It is TENANT-level like its
 * siblings; the list originally shipped without it, which made every
 * session unable to manage BYOA accounts.
 *
 * `provider-preferences:administer` (W091, same completion posture as
 * `llm:administer`): the provider-preferences module's management claim —
 * steering the company-wide AI outcome priority, pinning/clearing
 * technical provider overrides and reading the technical selection detail
 * are management actions (the module's contract gates on exactly this
 * string). Ordinary members keep the full preference surface (their own
 * preference and every jargon-free "why" read) WITHOUT the claim.
 */
export const MANAGEMENT_CLAIMS: readonly string[] = [
  'actions:approve',
  'actions:administer',
  'agents:administer',
  'extensions:administer',
  'identity:attest',
  'identity:link',
  'llm:administer',
  'provider-preferences:administer',
  'rewards:administer',
  'marketplace:submit',
  'api:administer',
];

/** Derive the authority claims for a verified tenant role. */
export function claimsForRole(role: TenantRole): string[] {
  if (role === 'owner' || role === 'admin') return [...MANAGEMENT_CLAIMS];
  return [];
}
