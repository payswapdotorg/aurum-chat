// Domain types of the auth module (W058 — Authentication, Sessions & Tenant
// Onboarding).
//
// The module owns three concerns:
//   * ACCOUNTS   — auth_principals: email + password sign-in identities.
//                  A principal id is the same opaque id the organizations
//                  module's membership rows already carry.
//   * SESSIONS   — auth_sessions: opaque bearer tokens with the ACTIVE
//                  company/workspace selection (navigation state only;
//                  membership is re-verified live through the
//                  organizations contract on every resolution).
//   * INVITATIONS— auth_invitations: tenant-scoped membership offers.
//
// Raw tokens (session and invitation) appear in exactly ONE return value
// at mint time; every persisted and returned record carries no secret.

import type { TenantContext } from '@/infra/tenant';
import type { TenantRole, WorkspaceRole } from '@/modules/organizations/contract';

/** A sign-in account. Never carries the password hash outside the module. */
export interface AuthPrincipal {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled';
}

/** Non-secret session facts (no token, no hash). */
export interface SessionSnapshot {
  id: string;
  createdAt: string;
  lastRenewedAt: string;
  expiresAt: string;
}

/** The verified active company of a session (null while unscoped). */
export interface ActiveTenant {
  id: string;
  name: string;
  slug: string;
  role: TenantRole;
}

/** The verified active workspace of a session (null while unscoped). */
export interface ActiveWorkspace {
  id: string;
  name: string;
  slug: string;
}

/**
 * A fully resolved session: the principal, the session facts, and — when
 * the session carries an active company — the LIVE-VERIFIED tenant,
 * workspace and the ready-made TenantContext (explicit, never ambient).
 */
export interface ResolvedSession {
  principal: AuthPrincipal;
  session: SessionSnapshot;
  tenant: ActiveTenant | null;
  workspace: ActiveWorkspace | null;
  /** Present exactly when `tenant` is: tenant id + principal + derived claims. */
  context: TenantContext | null;
}

/** What resolveSession makes of a presented token. */
export type SessionResolution =
  | { status: 'valid'; resolved: ResolvedSession }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'disabled' };

/** One company the principal has activated in Aurum (verified live). */
export interface ReachableTenant {
  id: string;
  name: string;
  slug: string;
  role: TenantRole;
  activatedAt: string;
}

/** Result of signing in or signing up: the token appears exactly once. */
export interface SignInResult {
  principal: AuthPrincipal;
  /** Opaque bearer token — hand it to the session cookie, never persist it. */
  token: string;
  /** ISO expiry of the new session. */
  expiresAt: string;
}

/** Inputs */

export interface SignUpInput {
  email: string;
  password: string;
  displayName: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface CreateCompanyInput {
  name: string;
  /** Defaults to a slug derived from the name. */
  slug?: string;
  /** Name of the default workspace created with the company. */
  defaultWorkspaceName?: string;
}

export interface SwitchTenantInput {
  tenantId: string;
}

export interface SelectWorkspaceInput {
  workspaceId: string;
}

export interface CreateInvitationInput {
  email: string;
  tenantRole: TenantRole;
  /** Optional workspace the invitee joins together with the tenant. */
  workspaceId?: string;
  /** Role in that workspace (required together with workspaceId). */
  workspaceRole?: WorkspaceRole;
}

export interface RevokeInvitationInput {
  invitationId: string;
}

export interface AcceptInvitationInput {
  /** The opaque invitation token from the invite link. */
  invitationToken: string;
}

/** Records */

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** An invitation as the inviting company sees it (no token). */
export interface InvitationRecord {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  tenantRole: TenantRole;
  workspaceId: string | null;
  workspaceRole: WorkspaceRole | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: InvitationStatus;
}

/** A freshly created invitation: the raw token appears exactly once. */
export interface CreatedInvitation extends InvitationRecord {
  token: string;
}

/**
 * What an invitation LINK reveals to its holder (the token itself is the
 * authorization to see this much — the same possession doctrine as
 * password-reset links).
 */
export type InspectedInvitation =
  | {
      status: 'pending';
      tenantName: string;
      email: string;
      tenantRole: TenantRole;
      workspaceRole: WorkspaceRole | null;
      expiresAt: string;
    }
  | { status: 'accepted' }
  | { status: 'revoked' }
  | { status: 'expired' }
  | { status: 'not_found' };

/** Result of accepting an invitation. */
export interface AcceptInvitationResult {
  tenant: ActiveTenant;
  /** Whether the optional workspace membership was also granted. */
  workspaceAdded: boolean;
  workspace: ActiveWorkspace | null;
}
