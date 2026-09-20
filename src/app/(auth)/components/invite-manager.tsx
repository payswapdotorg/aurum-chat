'use client';

// Auth surfaces (W058) — the invitation manager (membership/invite flows).
//
// For the active company: create invitations (the CODE is returned once
// and shown once, with a copy affordance), list the roster (pending
// first, server-rendered and refreshed after every mutation), and revoke.
// Every write goes through the API adapters, which resolve the tenant
// context from the session — never from a URL.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { postAuthJson } from './auth-fetch';

export interface InviteRowView {
  id: string;
  email: string;
  role: 'member' | 'admin';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  workspaceId: string | null;
  expiresAt: string;
}

export interface WorkspaceOption {
  id: string;
  name: string;
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function InviteManager({
  initialInvites,
  workspaces,
  canInvite,
}: {
  initialInvites: InviteRowView[];
  workspaces: WorkspaceOption[];
  canInvite: boolean;
}): ReactNode {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [issuedTo, setIssuedTo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setIssuedCode(null);
    setCopied(false);
    const outcome = await postAuthJson('/api/auth/invite', {
      email,
      role,
      ...(workspaceId === '' ? {} : { workspaceId }),
    });
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string' ? outcome.body['message'] : 'the invitation could not be created';
      setError(message);
      setPending(false);
      return;
    }
    const code = typeof outcome.body['code'] === 'string' ? outcome.body['code'] : null;
    setIssuedCode(code);
    setIssuedTo(email.trim().toLowerCase());
    setEmail('');
    setPending(false);
    router.refresh();
  };

  const revoke = async (inviteId: string) => {
    const outcome = await postAuthJson('/api/auth/invite/revoke', { inviteId });
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string' ? outcome.body['message'] : 'the invitation could not be revoked';
      setError(message);
      return;
    }
    router.refresh();
  };

  const copyCode = async () => {
    if (issuedCode === null) return;
    try {
      await navigator.clipboard.writeText(inviteLink(issuedCode));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div>
      {canInvite ? (
        <form className="aurum-auth-form" onSubmit={onSubmit} noValidate>
          <div className="aurum-auth-field">
            <label className="aurum-auth-label" htmlFor="invite-email">
              Invite by email
            </label>
            <input
              id="invite-email"
              className="aurum-auth-input"
              type="email"
              name="email"
              required
              autoComplete="off"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </div>
          <div className="aurum-auth-field">
            <label className="aurum-auth-label" htmlFor="invite-role">
              Role
            </label>
            <select
              id="invite-role"
              className="aurum-auth-input"
              name="role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value === 'admin' ? 'admin' : 'member');
              }}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="aurum-auth-field">
            <label className="aurum-auth-label" htmlFor="invite-workspace">
              Workspace membership (optional)
            </label>
            <select
              id="invite-workspace"
              className="aurum-auth-input"
              name="workspace"
              value={workspaceId}
              onChange={(event) => {
                setWorkspaceId(event.target.value);
              }}
            >
              <option value="">Company-wide only</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
          {error === null ? null : (
            <p className="aurum-auth-error" role="alert">
              {error}
            </p>
          )}
          <button className="aurum-auth-btn" type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create invitation'}
          </button>
          {issuedCode !== null ? (
            <div aria-live="polite">
              <p className="aurum-auth-notice" style={{ margin: 0 }}>
                Invitation for {issuedTo} created. This code is shown once —
                send it to them now:
              </p>
              <p className="aurum-auth-code" style={{ marginTop: 8 }}>
                {inviteLink(issuedCode)}
              </p>
              <button
                type="button"
                className="aurum-auth-btn"
                data-variant="quiet"
                style={{ minHeight: 36, marginTop: 8 }}
                onClick={() => {
                  void copyCode();
                }}
              >
                {copied ? 'Copied link' : 'Copy invitation link'}
              </button>
            </div>
          ) : null}
        </form>
      ) : (
        <p className="aurum-auth-hint" style={{ margin: 0 }}>
          Invitations are issued by the company&apos;s owners and admins — your
          role is {canInvite ? '' : 'member'}.
        </p>
      )}

      {initialInvites.length > 0 ? (
        <ul className="aurum-auth-roster">
          {initialInvites.map((invite) => (
            <li key={invite.id}>
              <span className="aurum-auth-roster-main">
                <span className="aurum-auth-roster-email">{invite.email}</span>
                <span className="aurum-auth-roster-meta">
                  {invite.role} · {invite.status === 'pending' ? `expires ${formatExpiry(invite.expiresAt)}` : invite.status}
                  {invite.workspaceId === null
                    ? ' · company-wide'
                    : workspaces.find((w) => w.id === invite.workspaceId) !== undefined
                      ? ` · ${workspaces.find((w) => w.id === invite.workspaceId)!.name}`
                      : ' · workspace'}
                </span>
              </span>
              <span
                className="aurum-auth-pill"
                data-tone={invite.status === 'pending' ? 'positive' : 'neutral'}
              >
                {invite.status}
              </span>
              {invite.status === 'pending' && canInvite ? (
                <button
                  type="button"
                  className="aurum-auth-revoke"
                  onClick={() => {
                    void revoke(invite.id);
                  }}
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="aurum-auth-hint" style={{ marginTop: 12 }}>
          No open invitations for this company.
        </p>
      )}
    </div>
  );
}

/** The shareable invitation link for a code (an absolute path is fine — the host is the deployment's). */
function inviteLink(code: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/invite/${code}`;
}
