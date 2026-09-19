'use client';

// Product shell (W057) — the tenant/workspace switcher.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Global": "persistent tenant/workspace
// switcher". Data comes from the organizations contract through the shell
// state (company + workspaces); switching rewrites the URL's scope
// parameters (`switchScopeTarget` — a company change drops the workspace
// selection) and asks the chrome to refetch. The company-change affordance
// is the documented development seam made visible: until the
// authentication experience owns company selection, the switcher accepts an
// explicit tenant id, exactly the way the shell resolves scope.
//
// Keyboard behavior: the trigger is aria-haspopup + aria-expanded; inside
// the menu ArrowUp/Down move focus (roving), Home/End jump, Escape closes
// and returns focus to the trigger, and every item is a real button.

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useShellState } from './shell-state-context';
import { switchScopeTarget } from '../lib/context';
import { nextFocusIndex } from '../lib/focus';
import type { FocusMove } from '../lib/focus';
import { ShellGlyph } from './icons';

const TENANT_INPUT_HINT =
  'Development seam: company selection happens by explicit tenant id until the sign-in experience lands.';

function switchTarget(change: { tenant?: string; workspace?: string | null }): string {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  return switchScopeTarget(search, change);
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
  const [tenantInput, setTenantInput] = useState('');
  const [tenantError, setTenantError] = useState<string | null>(null);
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
    setTenantError(null);
    if (returnFocus) triggerRef.current?.focus();
  };

  const applyChange = (change: { tenant?: string; workspace?: string | null }) => {
    const target = switchTarget(change);
    // Preserve the pathname; only the scope query changes.
    const path =
      typeof window === 'undefined' ? '/chat' : window.location.pathname;
    router.push(`${path}${target}`);
    close(true);
    // Client-side navigation does not update window.location synchronously,
    // so the chrome refetches with the NEW scope explicitly (the generic
    // shell-refresh event would re-read the not-yet-updated URL and race
    // this fetch — the explicit scope is authoritative here).
    refresh(target === '' ? '?' : target);
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
    const selectedSlug =
      status.view.workspace ??
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

  const workspaces =
    status.phase === 'ready' && status.view.company.ok
      ? status.view.company.workspaces
      : [];
  const selectedSlug =
    status.phase === 'ready' ? status.view.workspace : null;

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
                  onClick={() => {
                    if ((selectedSlug ?? 'default') === workspace.slug) {
                      close(true);
                      return;
                    }
                    applyChange({ workspace: workspace.slug });
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

          <form
            className="aurum-switcher-form"
            onSubmit={(event) => {
              event.preventDefault();
              const candidate = tenantInput.trim();
              if (
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                  candidate,
                )
              ) {
                setTenantError('A company id is a uuid (for example from your onboarding).');
                return;
              }
              setTenantInput('');
              applyChange({ tenant: candidate.toLowerCase() });
            }}
          >
            <label
              htmlFor={`${menuId}-tenant`}
              style={{ fontSize: 11, color: 'var(--faint-ink)', display: 'block', marginBottom: 4 }}
            >
              Switch company by tenant id
            </label>
            <input
              id={`${menuId}-tenant`}
              className="aurum-switcher-input"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="00000000-0000-4000-8000-000000000000"
              value={tenantInput}
              onChange={(event) => {
                setTenantInput(event.target.value);
                setTenantError(null);
              }}
            />
            {tenantError === null ? null : (
              <p className="aurum-switcher-note" role="alert" style={{ color: 'var(--risk-text)' }}>
                {tenantError}
              </p>
            )}
            <div className="aurum-switcher-actions">
              <button type="submit" className="aurum-btn" style={{ minHeight: 34 }}>
                Switch
              </button>
            </div>
            <p className="aurum-switcher-note">{TENANT_INPUT_HINT}</p>
          </form>
        </div>
      ) : null}
    </div>
  );
}
