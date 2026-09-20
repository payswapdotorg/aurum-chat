'use client';

// Auth surfaces (W058) — the onboarding client forms:
//
//   * CreateCompanyForm  — name your company, become its owner, land in chat;
//   * JoinByInviteForm   — paste an invite link/token and join that company;
//   * TenantPicker       — switch between the companies you have activated;
//   * InviteColleagueForm— issue a membership invitation (the invite link
//                          is revealed exactly once, with a copy button);
//   * InvitationsList    — the roster of open/used/withdrawn invitations
//                          with revoke affordances;
//   * SignOutButton      — the account exit.
//
// All writes go through /api/auth/* (thin adapters over the auth
// contract). Success navigates fully so the session cookie (and the new
// company scope) reach the next server render.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { navigateTo, postJson } from './auth-fetch';

function friendlyRole(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

// ---------------------------------------------------------------------------

export function CreateCompanyForm(): ReactNode {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (name.trim() === '') {
      setError('Give your company a name — you can rename it later.');
      return;
    }
    setBusy(true);
    const outcome = await postJson('/api/auth/company', { name });
    if (!outcome.ok) {
      setError(outcome.message ?? 'Creating the company failed. Try again.');
      setBusy(false);
      return;
    }
    navigateTo('/chat');
  };

  return (
    <section className="aurum-auth-card" aria-labelledby="aurum-create-company-title">
      <h2 id="aurum-create-company-title">Create your company</h2>
      <p className="aurum-auth-sub">
        You become the company&apos;s first owner, with a default workspace
        and room to invite your team. Aurum starts learning your
        organization from there.
      </p>
      <form onSubmit={submit} noValidate>
        {error === null ? null : (
          <p className="aurum-auth-error" role="alert">
            {error}
          </p>
        )}
        <div className="aurum-auth-field">
          <label htmlFor="aurum-company-name">Company name</label>
          <input
            id="aurum-company-name"
            name="name"
            type="text"
            autoComplete="organization"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="aurum-auth-actions">
          <button type="submit" className="aurum-auth-btn" disabled={busy}>
            {busy ? 'Creating…' : 'Create company and open chat'}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function JoinByInviteForm(): ReactNode {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Accept a raw token or a full invite link. */
  const extractToken = (raw: string): string => {
    const trimmed = raw.trim();
    const marker = '/invite/';
    const at = trimmed.lastIndexOf(marker);
    if (at !== -1) {
      return trimmed.slice(at + marker.length).split(/[?#]/)[0] ?? '';
    }
    return trimmed;
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const token = extractToken(value);
    if (token === '') {
      setError('Paste the invitation link (or its token) you received.');
      return;
    }
    setBusy(true);
    const outcome = await postJson('/api/auth/invitations/accept', {
      invitationToken: token,
    });
    if (!outcome.ok) {
      setError(outcome.message ?? 'Joining failed. Try again.');
      setBusy(false);
      return;
    }
    navigateTo('/chat');
  };

  return (
    <section className="aurum-auth-card" aria-labelledby="aurum-join-invite-title">
      <h2 id="aurum-join-invite-title">Join with an invitation</h2>
      <p className="aurum-auth-sub">
        Invited by a colleague? The invite link works only with the email it
        was issued for — that is what makes it yours.
      </p>
      <form onSubmit={submit} noValidate>
        {error === null ? null : (
          <p className="aurum-auth-error" role="alert">
            {error}
          </p>
        )}
        <div className="aurum-auth-field">
          <label htmlFor="aurum-invite-token">Invitation link or token</label>
          <input
            id="aurum-invite-token"
            name="invite"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://…/invite/…"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <div className="aurum-auth-actions">
          <button type="submit" className="aurum-auth-btn" data-variant="quiet" disabled={busy}>
            {busy ? 'Joining…' : 'Accept invitation'}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------

export interface PickerTenant {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

export function TenantPicker({ tenants }: { tenants: PickerTenant[] }): ReactNode {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activate = async (tenantId: string) => {
    if (busyId !== null) return;
    setError(null);
    setBusyId(tenantId);
    const outcome = await postJson('/api/auth/tenant/switch', { tenantId });
    if (!outcome.ok) {
      setError(outcome.message ?? 'Switching failed. Try again.');
      setBusyId(null);
      return;
    }
    navigateTo('/chat');
  };

  return (
    <section className="aurum-auth-card" aria-labelledby="aurum-tenant-picker-title">
      <h2 id="aurum-tenant-picker-title">Your companies</h2>
      <p className="aurum-auth-sub">
        Pick the company you are working in. Switching is verified against
        your membership — you only ever see companies you belong to.
      </p>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert">
          {error}
        </p>
      )}
      <ul className="aurum-auth-list">
        {tenants.map((tenant) => (
          <li key={tenant.id}>
            <div className="aurum-auth-list-main">
              <span className="aurum-auth-list-title">{tenant.name}</span>
              <span className="aurum-auth-list-sub">
                {friendlyRole(tenant.role)} · your membership is verified live
              </span>
            </div>
            {tenant.active ? (
              <span className="aurum-auth-pill" data-tone="positive">
                Active
              </span>
            ) : (
              <button
                type="button"
                className="aurum-auth-btn"
                data-variant="quiet"
                disabled={busyId !== null}
                onClick={() => void activate(tenant.id)}
              >
                {busyId === tenant.id ? 'Switching…' : 'Switch here'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function InviteColleagueForm({ canInviteAdmin }: { canInviteAdmin: boolean }): ReactNode {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setInviteToken(null);
    setCopied(false);
    if (email.trim() === '') {
      setError('Whose email should the invitation go to?');
      return;
    }
    setBusy(true);
    const outcome = await postJson('/api/auth/invitations', {
      email,
      tenantRole: role,
    });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message ?? 'The invitation could not be created.');
      return;
    }
    const token =
      outcome.data !== null && typeof outcome.data['inviteToken'] === 'string'
        ? outcome.data['inviteToken']
        : null;
    setInviteToken(token);
    setEmail('');
    router.refresh();
  };

  const inviteLink =
    inviteToken === null
      ? ''
      : `${typeof window === 'undefined' ? '' : window.location.origin}/invite/${inviteToken}`;

  const copy = async () => {
    if (inviteToken === null) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="aurum-auth-card" aria-labelledby="aurum-invite-title">
      <h2 id="aurum-invite-title">Invite colleagues</h2>
      <p className="aurum-auth-sub">
        An invitation is a link you hand over yourself. Whoever accepts it
        with the invited email joins this company — and the grant is
        re-checked against your authority when they do.
      </p>
      <form onSubmit={submit} noValidate>
        {error === null ? null : (
          <p className="aurum-auth-error" role="alert">
            {error}
          </p>
        )}
        <div className="aurum-auth-field">
          <label htmlFor="aurum-invite-email">Their work email</label>
          <input
            id="aurum-invite-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="aurum-auth-field">
          <label htmlFor="aurum-invite-role">Company role</label>
          <select
            id="aurum-invite-role"
            name="tenantRole"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="member">Member — work in the company</option>
            {canInviteAdmin ? <option value="admin">Admin — manage members and workspaces</option> : null}
            {canInviteAdmin ? <option value="owner">Owner — full authority</option> : null}
          </select>
          {canInviteAdmin ? null : (
            <p className="aurum-auth-hint">
              Admins and owners can invite other admins/owners — ask one of
              them for those roles.
            </p>
          )}
        </div>
        <div className="aurum-auth-actions">
          <button type="submit" className="aurum-auth-btn" data-variant="accent" disabled={busy}>
            {busy ? 'Creating…' : 'Create invitation link'}
          </button>
        </div>
      </form>
      {inviteToken === null ? null : (
        <div style={{ marginTop: 14 }}>
          <p className="aurum-auth-ok" role="status">
            Invitation created — this link is shown only once. Send it to{' '}
            {email || 'your colleague'}.
          </p>
          <p className="aurum-auth-token" style={{ marginTop: 8 }}>
            {inviteLink}
          </p>
          <div className="aurum-auth-actions">
            <button type="button" className="aurum-auth-btn" data-variant="quiet" onClick={() => void copy()}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

export interface InvitationRow {
  id: string;
  email: string;
  tenantRole: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export function InvitationsList({ invitations }: { invitations: InvitationRow[] }): ReactNode {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (invitationId: string) => {
    if (busyId !== null) return;
    setError(null);
    setBusyId(invitationId);
    const outcome = await postJson('/api/auth/invitations/revoke', { invitationId });
    setBusyId(null);
    if (!outcome.ok) {
      setError(outcome.message ?? 'Withdrawing failed.');
      return;
    }
    router.refresh();
  };

  if (invitations.length === 0) {
    return (
      <p className="aurum-auth-note">
        No invitations yet — create one above and hand over the link.
      </p>
    );
  }

  const toneFor = (status: string): string => {
    if (status === 'pending') return 'warning';
    if (status === 'accepted') return 'positive';
    return '';
  };

  return (
    <>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert">
          {error}
        </p>
      )}
      <ul className="aurum-auth-list">
        {invitations.map((invitation) => (
          <li key={invitation.id}>
            <div className="aurum-auth-list-main">
              <span className="aurum-auth-list-title">{invitation.email}</span>
              <span className="aurum-auth-list-sub">
                invited as {friendlyRole(invitation.tenantRole)}
              </span>
            </div>
            <span className="aurum-auth-pill" data-tone={toneFor(invitation.status)}>
              {invitation.status}
            </span>
            {invitation.status === 'pending' ? (
              <button
                type="button"
                className="aurum-auth-btn"
                data-variant="quiet"
                disabled={busyId !== null}
                onClick={() => void revoke(invitation.id)}
              >
                {busyId === invitation.id ? 'Withdrawing…' : 'Withdraw'}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------

export function SignOutButton(): ReactNode {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="aurum-auth-btn"
      data-variant="quiet"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await postJson('/api/auth/sign-out', {});
        navigateTo('/signin');
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

// ---------------------------------------------------------------------------

export function GoToChatButton({ label }: { label: string }): ReactNode {
  return (
    <a className="aurum-auth-btn" href="/chat">
      {label}
    </a>
  );
}
