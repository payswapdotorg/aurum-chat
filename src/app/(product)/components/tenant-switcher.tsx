'use client';

// Product shell (W057) — the tenant/workspace switcher (W058 re-sources
// the data and the write path).
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Global": "persistent tenant/workspace
// switcher". Data comes from the organizations contract through the shell
// state (workspaces of the active company) plus the auth contract's
// company directory (the principal's verified companies). Switching is a
// SESSION selection: POST /api/auth/session/selection re-verifies
// membership server-side before the session is touched, then the chrome
// refetches and re-navigates the current path — no query string, no
// company id typing (the development seam is gone).
//
// Keyboard behavior: the trigger is aria-haspopup + aria-expanded; inside
// the menu ArrowUp/Down move focus (roving), Home/End jump, Escape closes
// and returns focus to the trigger, and every item is a real button.

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useShellState } from './shell-state-context';
import { dispatchShellRefresh } from '../lib/shell-events';
import { nextFocusIndex } from '../lib/focus';
import type { FocusMove } from '../lib/focus';
import { postAuthJson } from '@/app/(auth)/components/auth-fetch';
import { ShellGlyph } from './icons';

interface SelectionOutcome {
  ok: boolean;
  message: string | null;
}

/** POST one session selection (company or workspace) — the only write. */
async function selectScope(body: Record<string, unknown>): Promise<SelectionOutcome> {
  const outcome = await postAuthJson('/api/auth/session/selection', body);
  if (outcome.ok) return { ok: true, message: null };
  const message =
    typeof outcome.body['message'] === 'string'
      ? outcome.body['message']
      : 'the selection could not be applied';
  return { ok: false, message };
}

export function TenantSwitcher({
  variant,
}: {
  /** `rail` (desktop, full) or `topbar` (mobile, compact). */
  variant: 'rail' | 'topbar';
}): ReactNode {
  const router = useRouter();
  const { status, refresh } = useShellState();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    setError(null);
    if (returnFocus) triggerRef.current?.focus();
  };

  /** Apply one selection: write the session, then re-render + refetch. */
  const applySelection = async (body: Record<string, unknown>, navigate: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const outcome = await selectScope(body);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    close(true);
    if (navigate) {
      // A company change re-scopes everything: land on chat (no query).
      dispatchShellRefresh();
      router.replace('/chat');
      refresh('');
      return;
    }
    // A workspace change keeps the current workflow.
    dispatchShellRefresh();
    router.refresh();
    refresh('');
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
  } else if (!status.view.company.ok) {
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
    const { tenant, workspaces } = status.view.company;
    const activeWorkspaceId = status.view.workspace;
    const selected =
      workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
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

  const workspaces =
    status.phase === 'ready' && status.view.company.ok
      ? status.view.company.workspaces
      : [];
  const companies = status.phase === 'ready' ? status.view.companies : [];
  const activeTenantId = status.phase === 'ready' ? status.view.tenantId : null;
  const activeWorkspaceId = status.phase === 'ready' ? status.view.workspace : null;

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
          {companies.length > 1 ? (
            <div role="menu" aria-label="Companies">
              <p className="aurum-switcher-heading" role="presentation">
                Company
              </p>
              {companies.map((company) => (
                <button
                  key={company.tenantId}
                  type="button"
                  className="aurum-switcher-item"
                  role="menuitemradio"
                  aria-checked={company.tenantId === activeTenantId}
                  disabled={busy}
                  onClick={() => {
                    if (company.tenantId === activeTenantId) {
                      close(true);
                      return;
                    }
                    void applySelection({ tenantId: company.tenantId }, true);
                  }}
                >
                  <span>{company.tenantName}</span>
                  <span className="aurum-switcher-check">
                    {company.tenantId === activeTenantId ? (
                      <ShellGlyph name="check" size={16} />
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

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
                  aria-checked={workspace.id === activeWorkspaceId}
                  disabled={busy}
                  onClick={() => {
                    if (workspace.id === activeWorkspaceId) {
                      close(true);
                      return;
                    }
                    void applySelection(
                      {
                        workspaceId:
                          workspace.slug === 'default' && activeWorkspaceId === null
                            ? null
                            : workspace.id,
                      },
                      false,
                    );
                  }}
                >
                  <span>{workspace.name}</span>
                  {workspace.slug === 'default' && activeWorkspaceId === null ? (
                    <span className="aurum-tag">default</span>
                  ) : null}
                  <span className="aurum-switcher-check">
                    {workspace.id === activeWorkspaceId ? (
                      <ShellGlyph name="check" size={16} />
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          )}

          <p className="aurum-switcher-note" style={{ paddingTop: 8 }}>
            Switching re-verifies your membership of the selected company
            before the session changes — scope can never cross companies.
          </p>
          {error === null ? null : (
            <p className="aurum-switcher-note" role="alert" style={{ color: 'var(--risk-text)' }}>
              {error}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
