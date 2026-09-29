// ============================================================================
// auth — the ONLY public surface of the auth module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W058 — Authentication, Sessions & Tenant Onboarding (spec/work-items/
// WORK-ITEM-CATALOG.md): "Implement auth/session domain and product entry
// flow; sign-in/sign-out/session renewal; company/workspace creation and
// selection; membership/invite flows; authenticated routing. Remove the
// query/header tenant seam from normal user navigation. Preserve explicit
// TenantContext internally."
//
// Ownership
//   * auth_users     — principals: the platform table whose ids ARE the
//                      TenantContext.principalId values ("the auth module
//                      owns principals", organizations contract);
//   * auth_sessions  — signed-in browser state (token digest + the ACTIVE
//                      company/workspace selection, re-verified through
//                      the organizations contract on every authentication);
//   * auth_user_companies — the principal's company directory (the
//                      switcher's always-re-verified candidate list);
//   * auth_invites   — tenant-scoped invitations (ADR-0001: every row
//                      carries tenant_id);
//   * auth_waitlist  — W116 platform access requests (a pending request
//                      is NOT a user; a platform admin accepts or declines
//                      before any principal exists).
//
// W116 — the PUBLIC signup is waitlist-gated: `signUp` records a request
// (or keeps today's immediate access when a live invitation bound to the
// same email vouches for it); `registerUser` stays the internal
// activation primitive behind the admin-granted doors and the demo
// harness. Platform admins are designated by the persisted
// `is_platform_admin` flag, granted either by the
// AURUM_PLATFORM_ADMIN_EMAILS env bootstrap (on sign-in; fails closed
// when unset) or by the claim-gated `setPlatformAdmin` (the seed path).
//
// Tenancy (ADR-0001)
//   * The organizations module remains the SOLE membership authority —
//     every membership check and grant goes through its contract; this
//     module never reads tenant_members directly.
//   * A session's company selection is validated per authentication and
//     silently de-selected when membership stops verifying: tenant
//     switching can never cross scope.
//   * Credentials are never stored raw: passwords as scrypt verifiers,
//     session tokens and invite codes as SHA-256 digests only.
//
// Authority
//   * The interim role→claim mapping (claims.ts) derives a session's
//     TenantContext.authority from its VERIFIED tenant role — no more
//     self-asserted authority parameters. W009 folds it into the authority
//     matrix.
//   * Self-service company creation is this module's one explicit platform
//     operation (PlatformContext + organizations:provision, scoped to the
//     single provisionTenant call — never ambient, never session-wide).
//
// Dependencies: organizations (W001 — tenants, workspaces, memberships)
// via contract only. identity (W002) is a verified repo dependency of the
// work item and stays untouched by this module.
// ============================================================================

export {
  authenticateSession,
  changePassword,
  createCompanyForSession,
  createInvite,
  decideWaitlistRequest,
  getInviteByCode,
  listInvites,
  listUserCompanies,
  listWaitlist,
  redeemInvite,
  registerUser,
  requestAccountAccess,
  revokeInvite,
  selectCompany,
  selectWorkspace,
  setPlatformAdmin,
  signIn,
  signOut,
  signOutEverywhere,
  signUp,
} from './service';

export { claimsForRole, MANAGEMENT_CLAIMS } from './claims';

export {
  AUTH_AUTHORITY_PLATFORM_ADMIN,
  PLATFORM_ADMIN_EMAILS_ENV,
  platformAdminEmails,
} from './platform-admins';

export { AuthError } from './errors';
export type { AuthErrorCode } from './errors';

export {
  INVITE_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from './policy';

export {
  hashPassword,
  verifyPassword,
} from './passwords';

export {
  hashToken,
  mintInviteCode,
  mintToken,
} from './tokens';

export type {
  ActiveCompany,
  AuthInvite,
  AuthenticatedSession,
  AuthPrincipal,
  ChangePasswordInput,
  CreateCompanyInput,
  CreateInviteInput,
  DecideWaitlistInput,
  GetInviteByCodeInput,
  InvitePreview,
  IssuedInvite,
  IssuedSession,
  ListInvitesInput,
  ListUserCompaniesInput,
  ListWaitlistInput,
  RedeemInviteInput,
  RegisterUserInput,
  RequestAccountAccessInput,
  RevokeInviteInput,
  SelectCompanyInput,
  SelectWorkspaceInput,
  SignInInput,
  SignOutEverywhereInput,
  SignOutInput,
  SignUpInput,
  SignUpOutcome,
  UserCompany,
  WaitlistRequest,
} from './types';
