// Session authority derivation (W058) — the INTERIM bridge from verified
// tenant membership roles to the authority-claim vocabulary the domain
// modules already check.
//
// Why this exists: every contract call takes an explicit TenantContext
// whose `authority` the domain modules gate on (actions/identity/
// extensions/agents/marketplace). Before W058 those claims arrived
// through the development seam (?authority=...) — anyone could claim
// anything. Sessions make claims EARNEST: they derive from the caller's
// verified membership role (resolveSession proves membership through the
// organizations contract before any context is built), so a member can
// no longer self-assign 'actions:approve' by editing a URL.
//
// The mapping is deliberately minimal and documented; W009 owns the
// authority matrix and may replace it wholesale.
//
//   owner / admin  — actions:approve (keep the human approval gate usable),
//                    identity:attest + identity:link (the connections hub's
//                    verification workflow),
//                    extensions:administer + agents:administer (governing
//                    the company's own extensions/agents — install,
//                    activate, suspend, rollback, builds),
//                    marketplace:submit (the open developer model —
//                    platform review is the real gate)
//   member         — marketplace:submit only (any member may develop; the
//                    platform pipeline stays claim-gated)
//   (nobody)       — marketplace:administer is a PLATFORM claim; tenant
//                    roles never derive it (platform reviewers are not a
//                    tenant concept — W068 owns that surface).
//
// NOTE (deviation-aware): 'extensions:administer' and 'agents:administer'
// are tenant-scoped administrative claims in their owning modules (the
// extensions/agents contracts check them for tenant operations like
// installing and governing company extensions). They are derived for
// tenant owners/admins so those PRODUCT flows remain usable; they are
// NOT platform claims.

import type { TenantRole } from '@/modules/organizations/contract';

export const SESSION_AUTHORITY_BY_ROLE: Record<TenantRole, readonly string[]> = {
  owner: [
    'actions:approve',
    'identity:attest',
    'identity:link',
    'extensions:administer',
    'agents:administer',
    'marketplace:submit',
  ],
  admin: [
    'actions:approve',
    'identity:attest',
    'identity:link',
    'extensions:administer',
    'agents:administer',
    'marketplace:submit',
  ],
  member: ['marketplace:submit'],
};

/** The authority claims a session context carries for a verified tenant role. */
export function sessionAuthorityForRole(role: TenantRole): string[] {
  return [...SESSION_AUTHORITY_BY_ROLE[role]];
}
