'use client';

// Product shell (W057/W058) — the tenant/workspace switcher.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Global": "persistent tenant/workspace
// switcher". Until W058 the switcher accepted a raw tenant id (the
// documented development seam made visible). Now the SESSION owns the
// scope: the menu lists the companies the signed-in principal has
// ACTIVATED (live-verified by the auth contract through the shell API's
// account section), switching POSTs to /api/auth/tenant/switch and the
// chrome refetches — membership is re-verified server-side on every hop,
// so switching can never cross scope. Workspaces switch the same way
// (/api/auth/workspace/select). The menu also carries the account row
// (email + sign out) and the onboarding entry (create/join a company).
//
// Keyboard behavior: the trigger is aria-haspopup + aria-expanded; inside
// the menu ArrowUp/Down move focus (roving), Home/End jump, Escape closes
// and returns focus to the trigger, and every item is a real button.

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useShellState } from './shell-state-context';
import { nextFocusIndex } from '../lib/focus';
import type { FocusMove } from '../lib/focus';
import { ShellGlyph } from './icons';

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; message: string | null }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (response.ok) return { ok: true, message: null };
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    return {
      ok: false,
      message:
        data !== null && typeof data.message === 'string'
          ? data.message
          : `the switch failed (HTTP ${response.status})`,
    };
  } catch {
    return { ok: false, message: 'Aurum is unreachable — try again.' };
  }
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

export function TenantSwitcher({
  variant,
}: {
  /** `rail` (desktop, full) or `topbar` (mobile, compact). */
  variant: 'rail' | 'topbar';
}): ReactNode {
  const { status, refresh } = useShellState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  // Click-outside closes (focus stays where the user put it).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current !== null &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setSwitchError(null);
    if (returnFocus) triggerRef.current?.focus();
  };

  const switchTenant = async (tenantId: string) => {
    if (busy !== null) return;
    setSwitchError(null);
    setBusy(`tenant:${tenantId}`);
    const outcome = await postJson('/api/auth/tenant/switch', { tenantId });
    setBusy(null);
    if (!outcome.ok) {
      setSwitchError(outcome.message);
      return;
    }
    close(true);
    refresh();
  };

  const selectWorkspace = async (workspaceId: string) => {
    if (busy !== null) return;
    setSwitchError(null);
    setBusy(`workspace:${workspaceId}`);
    const outcome = await postJson('/api/auth/workspace/select', { workspaceId });
    setBusy(null);
    if (!outcome.ok) {
      setSwitchError(outcome.message);
      return;
    }
    close(true);
    refresh();
  };

  const signOut = async () => {
    if (busy !== null) return;
    setBusy('signout');
    await postJson('/api/auth/sign-out', {});
    window.location.assign('/signin');
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const move: FocusMove | null =
      event.key === 'ArrowDown'
        ? 'next'
        : event.key === 'ArrowUp'
          ? 'prev'
          : event.key === 'Home'
            ? 'first'
            : event.key === 'End'
              ? 'last'
              : null;
    if (move !== null) {
      event.preventDefault();
      const items = Array.from(
        rootRef.current?.querySelectorAll<HTMLButtonElement>(
          '.aurum-switcher-item',
        ) ?? [],
      );
      const active = items.findIndex((item) => item === document.activeElement);
      const next = nextFocusIndex(active === -1 ? null : active, items.length, move);
      if (next !== null) items[next]?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  };

  // --- trigger content: company + workspace, with quiet states ---

  let triggerContent: ReactNode;
  if (status.phase === 'loading') {
    triggerContent = (
      <>
        <span className="aurum-switcher-glyph" aria-hidden="true">
          ·
        </span>
        <span className="aurum-switcher-name">
          <span className="aurum-skel aurum-skel-line" style={{ width: 108, margin: 0 }} aria-hidden="true" />
          <span className="aurum-sr-only">Loading company…</span>
        </span>
      </>
    );
  } else if (status.phase === 'error') {
    triggerContent = (
      <>
        <span className="aurum-switcher-glyph" aria-hidden="true">
          ?
        </span>
        <span className="aurum-switcher-name">
          <span className="aurum-switcher-company">Company unavailable</span>
          <span className="aurum-switcher-workspace">retry from the menu</span>
        </span>
      </>
    );
  } else if (!status.envelope.view.company.ok) {
    triggerContent = (
      <>
        <span className="aurum-switcher-glyph" aria-hidden="true">
          ·
        </span>
        <span className="aurum-switcher-name">
          <span className="aurum-switcher-company">No company</span>
          <span className="aurum-switcher-workspace">choose one to begin</span>
        </span>
      </>
    );
  } else {
    const { tenant, workspaces } = status.envelope.view.company;
    const selectedSlug =
      status.envelope.view.workspace ??
      workspaces.find((workspace) => workspace.slug === 'default')?.slug ??
      null;
    const selected = workspaces.find((w) => w.slug === selectedSlug) ?? null;
    triggerContent = (
      <>
        <span className="aurum-switcher-glyph" aria-hidden="true">
          {tenant.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="aurum-switcher-name">
          <span className="aurum-switcher-company">{tenant.name}</span>
          {variant === 'rail' ? (
            <span className="aurum-switcher-workspace">
              {selected === null ? 'Default workspace' : selected.name}
            </span>
          ) : null}
        </span>
      </>
    );
  }

  const ready = status.phase === 'ready' ? status.envelope : null;
  const workspaces =
    ready !== null && ready.view.company.ok ? ready.view.company.workspaces : [];
  const tenants = ready === null ? [] : ready.account.tenants;
  const activeTenantId = ready === null ? null : ready.view.tenantId;
  const activeTenant = tenants.find((tenant) => tenant.id === activeTenantId) ?? null;
  const selectedSlug = ready === null ? null : ready.view.workspace;

  return (
    <div className="aurum-switcher" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="aurum-switcher-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) {
            close(false);
          } else {
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            close(false);
          }
        }}
      >
        {triggerContent}
        <span className="aurum-switcher-caret">
          <ShellGlyph name="chevron" size={16} />
        </span>
      </button>

      {open ? (
        <div
          id={menuId}
          className="aurum-switcher-menu"
          role="dialog"
          aria-label="Company and workspace"
          onKeyDown={onMenuKeyDown}
        >
          {switchError === null ? null : (
            <p className="aurum-switcher-note" role="alert" style={{ color: 'var(--risk-text)', padding: '6px 10px' }}>
              {switchError}
            </p>
          )}

          {/* Companies — the session's verified activations. */}
          <div role="menu" aria-label="Companies">
            <p className="aurum-switcher-heading" role="presentation">
              Company
            </p>
            {tenants.length === 0 ? (
              <p className="aurum-switcher-note" style={{ padding: '2px 10px 6px' }}>
                No activated companies yet — create or join one.
              </p>
            ) : (
              tenants.map((tenant) => (
                <button
                  key={tenant.id}
                  type="button"
                  className="aurum-switcher-item"
                  role="menuitemradio"
                  aria-checked={tenant.id === activeTenantId}
                  disabled={busy !== null}
                  onClick={() => {
                    if (tenant.id === activeTenantId) {
                      close(true);
                      return;
                    }
                    void switchTenant(tenant.id);
                  }}
                >
                  <span>
                    {tenant.name}
                    <span
                      style={{
                        display: 'block',
                        fontSize: 11,
                        color: 'var(--faint-ink)',
                      }}
                    >
                      {roleLabel(tenant.role)}
                    </span>
                  </span>
                  <span className="aurum-switcher-check">
                    {tenant.id === activeTenantId ? (
                      <ShellGlyph name="check" size={16} />
                    ) : null}
                  </span>
                </button>
              ))
            )}
            <div className="aurum-switcher-actions" style={{ padding: '4px 10px 8px' }}>
              <a
                className="aurum-btn"
                data-variant="quiet"
                href="/onboarding"
                style={{ minHeight: 34, fontSize: 12.5 }}
              >
                Create or join a company
              </a>
            </div>
          </div>

          {/* Workspaces of the active company. */}
          {workspaces.length === 0 ? (
            <>
              <p className="aurum-switcher-heading" role="presentation">
                Workspace
              </p>
              <p className="aurum-switcher-note" style={{ padding: '2px 10px 6px' }}>
                No workspaces are readable with the current principal.
              </p>
            </>
          ) : (
            <div role="menu" aria-label="Workspaces">
              <p className="aurum-switcher-heading" role="presentation">
                Workspace
              </p>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className="aurum-switcher-item"
                  role="menuitemradio"
                  aria-checked={
                    (selectedSlug ?? 'default') === workspace.slug
                  }
                  disabled={busy !== null}
                  onClick={() => {
                    if ((selectedSlug ?? 'default') === workspace.slug) {
                      close(true);
                      return;
                    }
                    void selectWorkspace(workspace.id);
                  }}
                >
                  <span>{workspace.name}</span>
                  {workspace.slug === 'default' && selectedSlug === null ? (
                    <span className="aurum-tag">default</span>
                  ) : null}
                  <span className="aurum-switcher-check">
                    {(selectedSlug ?? 'default') === workspace.slug ? (
                      <ShellGlyph name="check" size={16} />
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Account row — who is signed in, and the exit. */}
          <div role="menu" aria-label="Account">
            <p className="aurum-switcher-heading" role="presentation">
              Account
            </p>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '2px 10px 8px',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--muted-ink)',
                  overflowWrap: 'anywhere',
                  minWidth: 0,
                }}
              >
                {ready === null ? '' : ready.account.principal.email}
                {activeTenant === null
                  ? ''
                  : ` · ${roleLabel(activeTenant.role)}`}
              </span>
              <button
                type="button"
                className="aurum-btn"
                data-variant="quiet"
                style={{ minHeight: 34, fontSize: 12.5 }}
                disabled={busy !== null}
                onClick={() => void signOut()}
              >
                {busy === 'signout' ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
