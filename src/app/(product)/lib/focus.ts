// Product shell (W057) — focus and keyboard-traversal helpers.
//
// The acceptance bar for the shell includes "accessibility keyboard
// traversal". The DOM-touching half lives in the client components (focus
// trapping, focus return); the DECISIONS live here as pure functions so
// they are unit-testable: roving-index math for arrow-key menus and
// listboxes, and the tab-wrap decision a focus trap makes on Tab/Shift+Tab.

/** Which interactive elements a trap considers focusable, in DOM order. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export type FocusMove = 'first' | 'last' | 'next' | 'prev' | 'none';

/**
 * Roving focus across `count` items (menus, listboxes): wraps at both
 * ends, `null` means "nothing selected yet" (first for 'next', last for
 * 'prev' — the way roving tabindex behaves).
 */
export function nextFocusIndex(
  current: number | null,
  count: number,
  move: FocusMove,
): number | null {
  if (count <= 0) return null;
  switch (move) {
    case 'none':
      return current;
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    case 'next':
      return current === null ? 0 : (current + 1) % count;
    case 'prev':
      return current === null ? count - 1 : (current - 1 + count) % count;
  }
}

/**
 * The focus-trap decision: given the index of the active element among
 * `count` focusables and whether Tab carried Shift, return the index focus
 * should land on (wrapping), or null when the browser's default move stays
 * inside the container.
 */
export function trapTabIndex(
  activeIndex: number | null,
  count: number,
  shiftKey: boolean,
): number | null {
  if (count <= 0) return null;
  if (activeIndex === null) return 0;
  if (!shiftKey) {
    return activeIndex === count - 1 ? 0 : null;
  }
  return activeIndex === 0 ? count - 1 : null;
}

/** Generic wrap-around step (used by pagination-like controls). */
export function wrapIndex(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
