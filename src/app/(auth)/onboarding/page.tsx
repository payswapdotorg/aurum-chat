// Auth surfaces (W058) — the onboarding page (authenticated).
//
// The company/workspace creation and selection surface: create a company,
// join one by invitation, or switch between the companies the principal
// has activated. Once an active company exists, the invite flow (issue,
// list, withdraw) lives here too — and the primary CTA is the one the
// acceptance names: reach usable Aurum chat.
//
// The page itself is a server component; every write goes through the
// /api/auth/* adapters over the auth contract (module contracts only,
// lock 31/32).

import { redirect } from 'next/navigation';
import { pageScope } from '@/app/lib/page-session';
import { listInvitations, listReachableTenants } from '@/modules/auth/contract';
import type { InvitationRecord } from '@/modules/auth/contract';
import {
  CreateCompanyForm,
  GoToChatButton,
  InviteColleagueForm,
  InvitationsList,
  JoinByInviteForm,
  PickerTenant,
  SignOutButton,
  TenantPicker,
} from '../components/onboarding-forms';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const scope = await pageScope();
  if (scope.phase === 'unauthenticated') {
    redirect('/signin?next=%2Fonboarding');
  }

  const activeTenant =
    scope.phase === 'ready' ? scope.resolved.tenant : null;
  const activeWorkspace =
    scope.phase === 'ready' ? scope.resolved.workspace : null;

  // The companies this principal has activated (live-verified by the
  // contract) — the switching surface. A broken read degrades to the
  // create/join surface.
  const reachable = await listReachableTenants(scope.token).catch(() => []);

  // The invitation roster is owner/admin-only; plain members just don't
  // see the section (the API enforces the same rule).
  let invitations: InvitationRecord[] = [];
  let canInviteAdmin = false;
  if (scope.phase === 'ready' && (activeTenant?.role === 'owner' || activeTenant?.role === 'admin')) {
    canInviteAdmin = activeTenant.role === 'owner';
    try {
      invitations = await listInvitations(scope.context);
    } catch {
      invitations = [];
    }
  }

  const pickerTenants: PickerTenant[] = reachable.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    role: tenant.role,
    active: activeTenant?.id === tenant.id,
  }));

  return (
    <>
      <header className="aurum-auth-brand">
        <span className="aurum-auth-mark" aria-hidden="true">
          A
        </span>
        <div>
          <h1>Welcome, {scope.principal.displayName}</h1>
          <p>
            {activeTenant === null
              ? 'Set up your company to start working with Aurum'
              : `Working in ${activeTenant.name}`}
          </p>
        </div>
      </header>

      {activeTenant === null ? (
        <>
          {pickerTenants.length > 0 ? (
            <TenantPicker tenants={pickerTenants} />
          ) : null}
          <CreateCompanyForm />
          <JoinByInviteForm />
        </>
      ) : (
        <>
          <section className="aurum-auth-card" aria-labelledby="aurum-active-company-title">
            <h2 id="aurum-active-company-title">{activeTenant.name} is ready</h2>
            <p className="aurum-auth-sub">
              You are {activeTenant.role === 'owner' ? 'an owner' : activeTenant.role} of this
              company{activeWorkspace === null ? '' : `, working in the ${activeWorkspace.name} workspace`}.
              Aurum chat is your primary surface — management surfaces are one
              drill-down away.
            </p>
            <div className="aurum-auth-actions">
              <GoToChatButton label="Go to Aurum chat" />
              <SignOutButton />
            </div>
          </section>

          {scope.phase === 'ready' && (activeTenant.role === 'owner' || activeTenant.role === 'admin') ? (
            <>
              <InviteColleagueForm canInviteAdmin={canInviteAdmin} />
              <section className="aurum-auth-card" aria-labelledby="aurum-invite-roster-title">
                <h2 id="aurum-invite-roster-title">Invitations</h2>
                <p className="aurum-auth-sub">
                  Pending links work until they expire (7 days) or are
                  withdrawn; accepted and withdrawn ones stay as a record.
                </p>
                <InvitationsList
                  invitations={invitations.map((invitation) => ({
                    id: invitation.id,
                    email: invitation.email,
                    tenantRole: invitation.tenantRole,
                    status: invitation.status,
                    createdAt: invitation.createdAt,
                    expiresAt: invitation.expiresAt,
                  }))}
                />
              </section>
            </>
          ) : null}

          {pickerTenants.length > 1 ? <TenantPicker tenants={pickerTenants} /> : null}
          <JoinByInviteForm />
        </>
      )}
    </>
  );
}
