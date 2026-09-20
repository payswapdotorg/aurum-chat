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
//                      carries tenant_id).
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
  createCompanyForSession,
  createInvite,
  getInviteByCode,
  listInvites,
  listUserCompanies,
  redeemInvite,
  registerUser,
  revokeInvite,
  selectCompany,
  selectWorkspace,
  signIn,
  signOut,
} from './service';

export { claimsForRole, MANAGEMENT_CLAIMS } from './claims';

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
  CreateCompanyInput,
  CreateInviteInput,
  GetInviteByCodeInput,
  InvitePreview,
  IssuedInvite,
  IssuedSession,
  ListInvitesInput,
  ListUserCompaniesInput,
  RedeemInviteInput,
  RegisterUserInput,
  RevokeInviteInput,
  SelectCompanyInput,
  SelectWorkspaceInput,
  SignInInput,
  SignOutInput,
  UserCompany,
} from './types';
