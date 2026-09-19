// Product shell (W057) — the shell's tiny custom-event vocabulary.
//
// Overlay components (notification panel, command search) are owned by the
// shell, but commands and other surfaces need to open them from outside
// their React trees. A window CustomEvent is the same pattern the ShareNet
// reference shell uses for its connection-state indicator, and it keeps the
// coupling to a pair of well-known event names instead of a global store.

export const OPEN_NOTIFICATIONS_EVENT = 'aurum:open-notifications';
export const SHELL_REFRESH_EVENT = 'aurum:shell-refresh';

/** Ask the shell to open the notification entry (idempotent, safe offline). */
export function dispatchOpenNotifications(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATIONS_EVENT));
}

/** Ask the shell chrome to refetch its state (after a scope change). */
export function dispatchShellRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SHELL_REFRESH_EVENT));
}
