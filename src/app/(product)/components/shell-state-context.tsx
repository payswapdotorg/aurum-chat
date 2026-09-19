'use client';

// Product shell (W057) — the chrome's data provider.
//
// The ShareNet reference shell client-fetches its connection state on mount
// (with a skeleton in the sidebar while it loads); the product shell does
// the same for its chrome state: one GET /api/product/shell carrying the
// current scope query, refreshed on demand (after a scope switch, when the
// notification entry opens). While it loads, the switcher and the bell
// render their quiet skeletons — the shell's loading pattern doing real
// work, not a decoration.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { ShellStateView } from '../lib/shell-state';
import { SHELL_REFRESH_EVENT } from '../lib/shell-events';

export type ShellStateStatus =
  | { phase: 'loading' }
  | { phase: 'ready'; view: ShellStateView }
  | { phase: 'error'; message: string };

export interface ShellStateApi {
  status: ShellStateStatus;
  /**
   * Refetch the chrome state. Pass the NEW '?…' scope when called right
   * after a client-side navigation (see fetchShellState); omitted, the
   * current URL scope is used.
   */
  refresh: (searchOverride?: string) => void;
}

const ShellStateContext = createContext<ShellStateApi | null>(null);

/**
 * Fetch the shell state. `searchOverride` (a raw '?…' string) lets a caller
 * that has just navigated pass the NEW scope explicitly — client-side
 * navigation does not update window.location synchronously, so reading it
 * immediately after router.push would race with the URL change.
 */
async function fetchShellState(searchOverride?: string): Promise<ShellStateView> {
  const scope =
    searchOverride !== undefined
      ? searchOverride
      : typeof window === 'undefined'
        ? ''
        : window.location.search;
  const url =
    scope === '' ? '/api/product/shell' : `/api/product/shell${scope}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    const message =
      body !== null && typeof body.message === 'string'
        ? body.message
        : `shell state unavailable (HTTP ${response.status})`;
    throw new Error(message);
  }
  const envelope = (await response.json()) as { view: ShellStateView };
  return envelope.view;
}

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ShellStateStatus>({ phase: 'loading' });
  const generation = useRef(0);

  const refresh = useCallback((searchOverride?: string) => {
    const current = generation.current + 1;
    generation.current = current;
    setStatus((previous) =>
      previous.phase === 'ready' ? previous : { phase: 'loading' },
    );
    void fetchShellState(searchOverride)
      .then((view) => {
        if (generation.current !== current) return;
        setStatus({ phase: 'ready', view });
      })
      .catch((error: unknown) => {
        if (generation.current !== current) return;
        const message =
          error instanceof Error ? error.message : 'shell state unavailable';
        setStatus({ phase: 'error', message });
      });
  }, []);

  useEffect(() => {
    refresh();
    const onShellRefresh = () => refresh();
    window.addEventListener(SHELL_REFRESH_EVENT, onShellRefresh);
    return () => {
      window.removeEventListener(SHELL_REFRESH_EVENT, onShellRefresh);
    };
  }, [refresh]);

  const api = useMemo<ShellStateApi>(
    () => ({ status, refresh }),
    [status, refresh],
  );

  return (
    <ShellStateContext.Provider value={api}>
      {children}
    </ShellStateContext.Provider>
  );
}

/** The chrome state (tenant, workspaces, notifications). Throws outside the provider. */
export function useShellState(): ShellStateApi {
  const value = useContext(ShellStateContext);
  if (value === null) {
    throw new Error('useShellState must be used inside ShellStateProvider');
  }
  return value;
}
