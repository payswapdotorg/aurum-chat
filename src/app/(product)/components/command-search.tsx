'use client';

// Product shell (W057) — the Cmd/Ctrl+K command search.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Global": "Cmd/Ctrl+K command search".
// The registry comes from the pure `buildShellCommands` (areas, management
// surfaces, chat starters, actions) — one list, shared with the rail. The
// dialog implements the combobox/listbox pattern: the input carries
// aria-activedescendant, ArrowUp/Down/Home/End move the selection (pure
// `nextCommandIndex`), Enter runs the command, Escape closes, and focus
// returns to the opener. Navigation targets preserve the current scope.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useProductShell } from './product-shell-provider';
import { ShellGlyph } from './icons';
import {
  buildShellCommands,
  commandHref,
  filterShellCommands,
  nextCommandIndex,
} from '../lib/command-registry';
import type { ShellCommand } from '../lib/command-registry';
import { scopeFromSearch } from '../lib/context';
import { dispatchOpenNotifications } from '../lib/shell-events';

export function CommandSearch(): ReactNode {
  const router = useRouter();
  const { commandSearchOpen, closeCommandSearch } = useProductShell();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const listId = useId();

  const commands = useMemo(() => buildShellCommands(), []);
  const results = useMemo(
    () => filterShellCommands(commands, query),
    [commands, query],
  );

  // Reset on every open; remember the opener for focus return.
  useEffect(() => {
    if (!commandSearchOpen) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setSelected(0);
    // Focus after paint so the input exists in the DOM.
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, [commandSearchOpen]);

  const runCommand = (command: ShellCommand) => {
    closeCommandSearch();
    if (command.target.kind === 'open-notifications') {
      dispatchOpenNotifications();
      return;
    }
    const scope =
      typeof window === 'undefined' ? '' : scopeFromSearch(window.location.search);
    router.push(commandHref(command, scope));
  };

  if (!commandSearchOpen) return null;

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((current) => nextCommandIndex(current, results.length, 'next'));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => nextCommandIndex(current, results.length, 'prev'));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSelected(nextCommandIndex(null, results.length, 'first'));
    } else if (event.key === 'End') {
      event.preventDefault();
      setSelected(nextCommandIndex(null, results.length, 'last'));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const index = selected === null ? 0 : selected;
      const entry = results[index];
      if (entry !== undefined) runCommand(entry.command);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeCommandSearch();
    }
  };

  let lastGroup = '';

  return (
    <div
      className="aurum-cmdk"
      role="dialog"
      aria-modal="true"
      aria-label="Command search"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeCommandSearch();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeCommandSearch();
      }}
    >
      <div className="aurum-cmdk-panel">
        <div className="aurum-cmdk-inputrow">
          <ShellGlyph name="search" size={18} />
          <input
            ref={inputRef}
            className="aurum-cmdk-input"
            type="text"
            role="combobox"
            aria-label="Search commands"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              selected === null || results[selected] === undefined
                ? undefined
                : `${listId}-item-${results[selected]!.command.id}`
            }
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search areas, management surfaces, questions…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="aurum-kbd">esc</span>
        </div>
        {results.length === 0 ? (
          <div className="aurum-cmdk-empty">
            Nothing matches “{query}”. Try a product area, a management
            surface, or a question for Aurum.
          </div>
        ) : (
          <ul className="aurum-cmdk-list" id={listId} role="listbox" aria-label="Commands">
            {results.map((entry, index) => {
              const command = entry.command;
              const showGroup = command.group !== lastGroup;
              lastGroup = command.group;
              const isSelected = index === selected;
              return (
                <li key={command.id} role="none">
                  {showGroup ? (
                    <p className="aurum-cmdk-group" aria-hidden="true">
                      {command.group}
                    </p>
                  ) : null}
                  <div
                    id={`${listId}-item-${command.id}`}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                    className="aurum-cmdk-item"
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => runCommand(command)}
                  >
                    <ShellGlyph name={command.icon} size={17} />
                    <span className="aurum-cmdk-text">
                      <span className="aurum-cmdk-title">{command.title}</span>
                      <span className="aurum-cmdk-sub">{command.subtitle}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="aurum-cmdk-foot">
          <span>
            <span className="aurum-kbd">↑</span> <span className="aurum-kbd">↓</span>{' '}
            move
          </span>
          <span>
            <span className="aurum-kbd">↵</span> open
          </span>
          <span>
            <span className="aurum-kbd">esc</span> close
          </span>
        </div>
      </div>
    </div>
  );
}
