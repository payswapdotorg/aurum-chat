// Platform admin surface (W116) — the waitlist page's PURE view-model.
//
// The tower/product testing doctrine: no DB, no DOM here — the page
// component renders exactly what these functions decide, so the
// messenger presentation (status pills, contact rows, empty state, the
// gating decision) is fully unit-testable without booting Next.js.

import type { WaitlistRequest } from '@/modules/auth/contract';

/** The page's decision for one session resolution (server-side gating). */
export type WaitlistPageAccess =
  | { decision: 'render' }
  | { decision: 'redirect'; target: '/signin' | '/chat' };

/**
 * Who may see /platform/waitlist: a platform admin renders; everyone
 * else is redirected AWAY with the same targets the product shell uses
 * for its gates (anonymous → /signin, signed-in → /chat) — never an
 * "access denied" page, so a non-admin learns nothing about the area's
 * existence beyond an ordinary bounce.
 */
export function waitlistPageAccess(resolution: {
  status: 'anonymous' | 'no-company' | 'authenticated';
  platformAdmin?: boolean;
}): WaitlistPageAccess {
  if (resolution.status === 'anonymous') return { decision: 'redirect', target: '/signin' };
  if (resolution.platformAdmin !== true) return { decision: 'redirect', target: '/chat' };
  return { decision: 'render' };
}

/** The status pill's visible label (color never carries meaning alone). */
export function waitlistStatusLabel(status: WaitlistRequest['status']): string {
  switch (status) {
    case 'pending':
      return 'Waiting';
    case 'accepted':
      return 'Accepted';
    case 'declined':
      return 'Declined';
  }
}

/** The status pill's tone (pairs the label — the a11y contract of the shell). */
export function waitlistStatusTone(status: WaitlistRequest['status']): 'positive' | 'neutral' | 'risk' {
  switch (status) {
    case 'pending':
      return 'neutral';
    case 'accepted':
      return 'positive';
    case 'declined':
      return 'risk';
  }
}

/** The contact tile's initial (the display name's first letter, uppercased). */
export function waitlistInitial(displayName: string): string {
  const trimmed = displayName.trim();
  return trimmed === '' ? '?' : trimmed.slice(0, 1).toUpperCase();
}

/** The stable contact-tile hue for one email (0–5, the warm family cycle). */
export function waitlistHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) % 100000;
  }
  return hash % 6;
}

/** The requested date as the contact row's one-line meta (locale-neutral). */
export function waitlistRequestedLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `Requested ${month} ${day}, ${year} · ${time} UTC`;
}

/** The settled row's audit line (decided when/by whom is admin-visible). */
export function waitlistDecidedLabel(request: WaitlistRequest): string | null {
  if (request.decidedAt === null) return null;
  const date = new Date(request.decidedAt);
  if (Number.isNaN(date.getTime())) return null;
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = date.getUTCDate();
  const verb = request.status === 'accepted' ? 'Accepted' : 'Declined';
  return `${verb} ${month} ${day}`;
}

/** The honest messenger empty bubble when nothing is waiting. */
export const WAITLIST_EMPTY_MESSAGE = 'No requests waiting.';

/** The page's own copy (single source; asserted in the view tests). */
export const WAITLIST_PAGE_COPY = {
  title: 'Access requests',
  blurb:
    'Every sign-up request lands here first. Accept to create the account — the person signs in with the password they chose. Decline with a note they will see on their next sign-in attempt.',
} as const;
