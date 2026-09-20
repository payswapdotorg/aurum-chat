'use client';

// Product shell (W057/W058) — the chrome's data provider.
//
// The ShareNet reference shell client-fetches its connection state on
// mount (with a skeleton in the sidebar while it loads); the product
// shell does the same for its chrome state: one GET /api/product/shell
// — the SESSION COOKIE carries the scope (W058), so the URL carries
// none of it — refreshed on demand (after a company/workspace switch,
// when the notification entry opens). While it loads, the switcher and
// the bell render their quiet skeletons — the shell's loading pattern
// doing real work, not a decoration.

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
import type { AccountSection } from '../lib/api';
import { SHELL_REFRESH_EVENT } from '../lib/shell-events';

/** The envelope the chrome keeps: the view plus the account section. */
export interface ShellEnvelope {
  view: ShellStateView;
  account: AccountSection;
}

export type ShellStateStatus =
  | { phase: 'loading' }
  | { phase: 'ready'; envelope: ShellEnvelope }
  | { phase: 'error'; message: string };

export interface ShellStateApi {
  status: ShellStateStatus;
  /** Refetch the chrome state (the session cookie scopes the request). */
  refresh: () => void;
}

const ShellStateContext = createContext<ShellStateApi | null>(null);

async function fetchShellState(): Promise<ShellEnvelope> {
  const response = await fetch('/api/product/shell', { cache: 'no-store' });
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
  const body = (await response.json()) as {
    view: ShellStateView;
    account: AccountSection;
  };
  return { view: body.view, account: body.account };
}

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ShellStateStatus>({ phase: 'loading' });
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const current = generation.current + 1;
    generation.current = current;
    setStatus((previous) =>
      previous.phase === 'ready' ? previous : { phase: 'loading' },
    );
    void fetchShellState()
      .then((envelope) => {
        if (generation.current !== current) return;
        setStatus({ phase: 'ready', envelope });
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

/** The chrome state (view + account). Throws outside the provider. */
export function useShellState(): ShellStateApi {
  const value = useContext(ShellStateContext);
  if (value === null) {
    throw new Error('useShellState must be used inside ShellStateProvider');
  }
  return value;
}
