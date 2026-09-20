// Auth surfaces (W058) — /onboarding.
//
// The company/workspace selection surface (work item: "company/workspace
// creation and selection; membership/invite flows"). Two honest modes:
//
//   * ENTRY (a live session without an active company — a fresh
//     registration, or a membership that stopped verifying): pick an
//     existing company from the verified directory, create a company, or
//     join one with an invitation code. Every path lands in Aurum chat.
//
//   * MANAGE (a session WITH an active company — reached from the shell's
//     More area): switch company / create another, and manage this
//     company's invitations.
//
// Both modes resolve EVERYTHING from the session — no tenant query
// parameter exists anywhere in this surface.

import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { listInvites } from '@/modules/auth/contract';
import { listWorkspaces } from '@/modules/organizations/contract';
import { resolveSession } from '@/app/lib/session';
import { AuthBrand } from '../components/brand';
import { CompanyPicker } from '../components/company-picker';
import { CreateCompanyForm } from '../components/create-company-form';
import { RedeemInviteForm } from '../components/redeem-invite-form';
import { InviteManager } from '../components/invite-manager';
import { SignOutButton } from '../components/sign-out-button';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage(): Promise<ReactNode> {
  const session = await resolveSession();
  if (session.status === 'anonymous') redirect('/signin');

  const entry = session.status === 'no-company';
  const activeTenantId = entry ? null : session.context.tenantId;
  const companies = session.companies;

  // The invitation roster + workspace options exist only in manage mode
  // (they are company-scoped). Both degrade quietly for plain members.
  let invites: Awaited<ReturnType<typeof listInvites>> = [];
  let workspaces: { id: string; name: string }[] = [];
  let role = 'member';
  if (!entry) {
    role = session.role;
    try {
      invites = await listInvites(session.context, {});
      const all = await listWorkspaces(session.context);
      workspaces = all.map((workspace) => ({ id: workspace.id, name: workspace.name }));
    } catch {
      // A member's roster read is refused by the organizations contract —
      // the honest empty state below says so instead of pretending.
    }
  }

  return (
    <div className={`aurum-auth-card${entry ? '' : ' aurum-auth-wide'}`}>
      <AuthBrand tag={entry ? 'Set up your workspace' : 'Company & invitations'} />
      <h1 className="aurum-auth-title">
        {entry ? 'Welcome to Aurum' : 'Your companies'}
      </h1>
      <p className="aurum-auth-blurb">
        {entry
          ? 'Create your company workspace, or join one with an invitation code. Either way you land in a conversation with Aurum, your company’s intelligence employee.'
          : 'Switch company, create another one, or manage this company’s invitations. Every company re-verifies your membership on every request.'}
      </p>

      <section className="aurum-auth-section" aria-labelledby="onboard-select">
        <h2 id="onboard-select" className="aurum-auth-section-title">
          {entry ? 'Your companies' : 'Switch company'}
        </h2>
        <p className="aurum-auth-section-blurb">
          {companies.length > 0
            ? 'Selecting a company makes it the active scope of this session.'
            : entry
              ? 'Companies you create or join will appear here.'
              : 'No other companies yet.'}
        </p>
        <CompanyPicker companies={companies} activeTenantId={activeTenantId} />
      </section>

      <section className="aurum-auth-section" aria-labelledby="onboard-create">
        <h2 id="onboard-create" className="aurum-auth-section-title">
          Create a company
        </h2>
        <p className="aurum-auth-section-blurb">
          You become the owner — the default workspace and your memberships
          come with it.
        </p>
        <CreateCompanyForm />
      </section>

      {entry ? (
        <section className="aurum-auth-section" aria-labelledby="onboard-join">
          <h2 id="onboard-join" className="aurum-auth-section-title">
            Join with an invitation
          </h2>
          <p className="aurum-auth-section-blurb">
            Have a code from a colleague? It is bound to your email address.
          </p>
          <RedeemInviteForm />
        </section>
      ) : (
        <section className="aurum-auth-section" aria-labelledby="onboard-invites">
          <h2 id="onboard-invites" className="aurum-auth-section-title">
            Invitations
          </h2>
          <p className="aurum-auth-section-blurb">
            Invite colleagues into this company — membership is granted when
            they redeem the code with the matching email.
          </p>
          <InviteManager
            initialInvites={invites.map((invite) => ({
              id: invite.id,
              email: invite.email,
              role: invite.role,
              status: invite.status,
              workspaceId: invite.workspaceId,
              expiresAt: invite.expiresAt,
            }))}
            workspaces={workspaces}
            canInvite={role === 'owner' || role === 'admin'}
          />
        </section>
      )}

      <div className="aurum-auth-alt">
        <span>
          Signed in as <strong>{session.principal.email}</strong> ·{' '}
          {entry ? 'no active company' : `active role: ${role}`}
        </span>
        <SignOutButton label="Sign out of Aurum" />
      </div>
    </div>
  );
}
