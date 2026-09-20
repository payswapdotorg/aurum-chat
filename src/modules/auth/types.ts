// Domain types of the auth module (W058 — Authentication, Sessions &
// Tenant Onboarding).
//
// The auth module OWNS principals (the `auth_users` rows — their ids are
// the opaque `principalId` every TenantContext carries), sessions (the
// signed-in browser state, with the active company/workspace selection),
// the principal's company directory (the switcher's always-re-verified
// candidate list) and tenant invitations.
//
// Persistence shape (snake_case rows) is private to the service; contract
// consumers only ever see the camelCase entities below.

import type { TenantRole } from '@/modules/organizations/contract';

/** The authenticated principal as the surfaces see it (no credential material). */
export interface AuthPrincipal {
  /** The principal id TenantContext.principalId carries. */
  id: string;
  email: string;
  displayName: string;
}

/** The session's active company selection, with the verified role and derived claims. */
export interface ActiveCompany {
  tenantId: string;
  /** Active workspace id inside the tenant, or null when the tenant default applies. */
  workspaceId: string | null;
  /** The principal's verified tenant role at authentication time. */
  role: TenantRole;
  /** Authority claims derived from the verified role (interim mapping, see claims.ts). */
  authority: string[];
}

/** What `authenticateSession` returns for one live session token. */
export interface AuthenticatedSession {
  sessionId: string;
  principalId: string;
  principal: AuthPrincipal;
  /** Login time of the session. */
  createdAt: string;
  /** Idle-sliding expiry (never past the absolute cap). */
  expiresAt: string;
  /** When the session last verified activity (null before the first touch). */
  lastSeenAt: string | null;
  /** The active company selection, or null when onboarding has not selected one. */
  company: ActiveCompany | null;
}

/** One verified company of the principal's directory (the switcher's data). */
export interface UserCompany {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  /** How the company entered the directory. */
  addedVia: 'created' | 'invite' | 'switch';
  addedAt: string;
  lastSelectedAt: string;
}

/** An invitation as the issuer's roster sees it (never the code). */
export interface AuthInvite {
  id: string;
  tenantId: string;
  workspaceId: string | null;
  email: string;
  role: 'member' | 'admin';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
}

/** The public face of an invitation the code-holder may read (no roster detail). */
export interface InvitePreview {
  /** The company the invitation belongs to (resolved through the issuer's context). */
  tenantName: string | null;
  /** The inviting company readable only while the issuer still verifies. */
  email: string;
  role: 'member' | 'admin';
  /** The workspace name when the invite is workspace-scoped. */
  workspaceName: string | null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface RegisterUserInput {
  displayName: string;
  email: string;
  password: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface AuthenticateSessionInput {
  token: string;
}

export interface SignOutInput {
  token: string;
}

export interface SelectCompanyInput {
  token: string;
  tenantId: string;
}

export interface SelectWorkspaceInput {
  token: string;
  /** null clears the selection (the tenant default applies). */
  workspaceId: string | null;
}

export interface CreateCompanyInput {
  token: string;
  /** Company display name (1–200 chars). */
  name: string;
  /** Defaults to a slug derived from the name. */
  slug?: string;
  /** Name of the default workspace created with the company. */
  defaultWorkspaceName?: string;
}

export interface ListUserCompaniesInput {
  token: string;
}

export interface CreateInviteInput {
  email: string;
  /** Tenant role granted on redemption ('member' default; 'owner' is provisioning-only). */
  role?: 'member' | 'admin';
  /** Optional workspace whose membership the redemption also grants. */
  workspaceId?: string | null;
}

export interface ListInvitesInput {
  includeSettled?: boolean;
}

export interface RevokeInviteInput {
  inviteId: string;
}

export interface RedeemInviteInput {
  token: string;
  code: string;
}

export interface GetInviteByCodeInput {
  code: string;
}

/** A session together with its one-time secret (sign-in/registration result). */
export interface IssuedSession {
  session: AuthenticatedSession;
  /** The raw session token — shown exactly once; only its hash is stored. */
  token: string;
}

/** An invitation together with its one-time secret (creation result). */
export interface IssuedInvite {
  invite: AuthInvite;
  /** The raw invite code — shown exactly once; only its hash is stored. */
  code: string;
}
