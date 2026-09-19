'use client';

// Product shell (W057) — the shell's client state provider.
//
// Two pieces of shell-wide client state:
//
//  * the CONTEXT DRAWER (open payload / closed) — surfaces hand normalized
//    payloads to `openContext` and the shell owns presentation;
//  * the COMMAND SEARCH dialog (open/closed) — the ⌘K overlay and every
//    "Search" button share this state so focus returns to the opener.
//
// Everything else (chrome data) lives in the sibling shell-state provider.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  contextDrawerReducer,
  normalizeContextPayload,
} from '../lib/context-drawer';
import type { ContextDrawerPayload } from '../lib/context-drawer';

export interface ProductShellApi {
  /** Open the context drawer with a payload (invalid input is ignored). */
  openContext: (payload: unknown) => void;
  /** Close the context drawer. */
  closeContext: () => void;
  /** Whether the context drawer is open (and its payload when it is). */
  contextDrawer: { open: boolean; payload: ContextDrawerPayload | null };
  /** Open the ⌘K command search. */
  openCommandSearch: () => void;
  /** Close the ⌘K command search. */
  closeCommandSearch: () => void;
  /** Whether the command search is open. */
  commandSearchOpen: boolean;
}

const ProductShellContext = createContext<ProductShellApi | null>(null);

export function ProductShellProvider({ children }: { children: ReactNode }) {
  const [drawer, dispatchDrawer] = useReducer(contextDrawerReducer, {
    open: false,
  });
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);

  const openContext = useCallback((payload: unknown) => {
    const normalized = normalizeContextPayload(payload);
    if (normalized === null) return;
    dispatchDrawer({ type: 'open', payload: normalized });
  }, []);

  const closeContext = useCallback(() => {
    dispatchDrawer({ type: 'close' });
  }, []);

  const openCommandSearch = useCallback(() => {
    setCommandSearchOpen(true);
  }, []);

  const closeCommandSearch = useCallback(() => {
    setCommandSearchOpen(false);
  }, []);

  const api = useMemo<ProductShellApi>(
    () => ({
      openContext,
      closeContext,
      contextDrawer: {
        open: drawer.open,
        payload: drawer.open ? drawer.payload : null,
      },
      openCommandSearch,
      closeCommandSearch,
      commandSearchOpen,
    }),
    [
      openContext,
      closeContext,
      drawer,
      openCommandSearch,
      closeCommandSearch,
      commandSearchOpen,
    ],
  );

  return (
    <ProductShellContext.Provider value={api}>
      {children}
    </ProductShellContext.Provider>
  );
}

/** The shell API (drawer + command search). Throws when used outside the provider. */
export function useProductShell(): ProductShellApi {
  const value = useContext(ProductShellContext);
  if (value === null) {
    throw new Error('useProductShell must be used inside ProductShellProvider');
  }
  return value;
}
