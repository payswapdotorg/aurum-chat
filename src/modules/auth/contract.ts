// ============================================================================
// auth — the ONLY public surface of the auth module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W058 — Authentication, Sessions & Tenant Onboarding:
// "Implement auth/session domain and product entry flow; sign-in/sign-out/
//  session renewal; company/workspace creation and selection;
//  membership/invite flows; authenticated routing. Remove the query/header
//  tenant seam from normal user navigation. Preserve explicit
//  TenantContext internally."
//
// Ownership
//   * ACCOUNTS    — email+password principals (the same opaque principal
//                   ids organizations.tenant_members carries; the auth
//                   module is where those principals finally come from).
//   * SESSIONS    — opaque bearer tokens. The active company/workspace is
//                   per-session NAVIGATION state; membership is verified
//                   LIVE through the organizations contract before any
//                   TenantContext is produced (tenant switching can never
//                   cross scope, and a revoked membership degrades a
//                   session to "no active company" — never to data).
//   * INVITATIONS — tenant-scoped membership offers; the grant itself
//                   runs through organizations.addTenantMember with the
//                   INVITER's context, so the organizations contract
//                   re-checks the inviter's CURRENT authority at
//                   acceptance time.
//
// Composition (MODULE-DEPENDENCY-MAP: auth composes organizations — the
// declared W058 dependency on W001): every organizations interaction goes
// through `@/modules/organizations/contract` only. The `organizations:
// provision` platform claim is minted at exactly one seam — createCompany,
// for a session-authenticated principal.
//
// Authority (interim until W009's matrix): session contexts derive their
// authority claims from the VERIFIED tenant role (see authority.ts) — a
// member can no longer self-assign 'actions:approve' through a URL
// parameter; claims are earned by membership.
//
// Security invariants
//   * raw tokens (session and invitation) appear in exactly ONE return
//     value at mint time; tables hold sha-256 hashes only;
//   * sign-in failures are uniform (no account enumeration);
//   * invitation tokens reveal only their own invitation (possession
//     doctrine) and are not transferable between accounts;
//   * disabled accounts kill their sessions.
// ============================================================================

export {
  acceptInvitation,
  createCompany,
  createInvitation,
  inspectInvitation,
  listInvitations,
  listReachableTenants,
  renewSession,
  resolveSession,
  revokeInvitation,
  selectWorkspace,
  signIn,
  signOut,
  signOutEverywhere,
  signUp,
  switchTenant,
} from './service';

export { INVITATION_TTL_MS, SESSION_RENEWAL_WINDOW_MS, SESSION_TTL_MS } from './service';
export { SESSION_TTL_SECONDS } from './service';

export { AuthError } from './errors';
export type { AuthErrorCode } from './errors';

export { SESSION_AUTHORITY_BY_ROLE, sessionAuthorityForRole } from './authority';

export type {
  AcceptInvitationInput,
  AcceptInvitationResult,
  ActiveTenant,
  ActiveWorkspace,
  AuthPrincipal,
  CreateCompanyInput,
  CreatedInvitation,
  CreateInvitationInput,
  InspectedInvitation,
  InvitationRecord,
  InvitationStatus,
  ReachableTenant,
  ResolvedSession,
  RevokeInvitationInput,
  SelectWorkspaceInput,
  SessionResolution,
  SessionSnapshot,
  SignInInput,
  SignInResult,
  SignUpInput,
  SwitchTenantInput,
} from './types';
