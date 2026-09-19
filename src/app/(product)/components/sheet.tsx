'use client';

// Product shell (W057) — the shared sheet overlay.
//
// One focus-trapped, Escape-dismissible sheet drives BOTH the context
// drawer and the notification entry: a right-side panel on desktop, a
// bottom sheet on mobile (the plan's progressive-disclosure pattern —
// "detail panels/sheets"). The trap math is the pure `trapTabIndex` helper;
// this component owns the DOM: initial focus, Tab wrap, Escape, and focus
// return to the opener.

import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { FOCUSABLE_SELECTOR, trapTabIndex } from '../lib/focus';
import { ShellGlyph } from './icons';

export interface SheetProps {
  title: string;
  subtitle?: string | null;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  toneBadge?: ReactNode;
}

export function Sheet({
  title,
  subtitle,
  closeLabel,
  onClose,
  children,
  footer,
  toneBadge,
}: SheetProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel !== null) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panel).focus();
    }
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const activeIndex = focusables.findIndex(
        (element) => element === document.activeElement,
      );
      const target = trapTabIndex(
        activeIndex === -1 ? null : activeIndex,
        focusables.length,
        event.shiftKey,
      );
      if (target !== null) {
        event.preventDefault();
        focusables[target]?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  return (
    <>
      <div className="aurum-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="aurum-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="aurum-sheet-head">
          <div>
            <h2 className="aurum-sheet-title" id={titleId}>
              {title}
            </h2>
            {subtitle === null || subtitle === undefined ? null : (
              <p className="aurum-sheet-sub">{subtitle}</p>
            )}
          </div>
          {toneBadge}
          <button
            type="button"
            className="aurum-icon-btn aurum-sheet-close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <ShellGlyph name="close" size={18} />
          </button>
        </div>
        <div className="aurum-sheet-body">{children}</div>
        {footer === undefined ? null : (
          <div className="aurum-sheet-foot">{footer}</div>
        )}
      </div>
    </>
  );
}
