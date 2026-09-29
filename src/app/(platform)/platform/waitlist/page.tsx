// Platform admin surface (W116) — /platform/waitlist.
//
// The access-request review queue, visible ONLY to platform admins: the
// page resolves the session and bounces everyone else away with the
// shell's ordinary redirect targets (anonymous → /signin, signed-in →
// /chat) — never an "access denied" page, so a non-admin learns nothing
// about the area beyond an ordinary bounce. Reads like a conversation
// list: request rows as contact rows (colored initial tiles, name +
// email + date), status pills, compact gold/ink accept/decline actions
// (the client component posts them — JSON + session cookie, the same
// CSRF-resistant shape every auth write uses). The honest empty bubble
// carries the no-requests state.

import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { listWaitlistRequests } from '@/modules/auth/contract';
import type { WaitlistRequest } from '@/modules/auth/contract';
import { currentSessionToken, resolveSession } from '@/app/lib/session';
import { waitlistPageAccess } from '../../lib/waitlist-views';
import {
  WAITLIST_EMPTY_MESSAGE,
  WAITLIST_PAGE_COPY,
  waitlistDecidedLabel,
  waitlistHue,
  waitlistInitial,
  waitlistRequestedLabel,
  waitlistStatusLabel,
  waitlistStatusTone,
} from '../../lib/waitlist-views';
import { WaitlistDecision } from '../../components/waitlist-decision';

export const dynamic = 'force-dynamic';

export default async function WaitlistPage(): Promise<ReactNode> {
  const session = await resolveSession();
  const access = waitlistPageAccess(session);
  if (access.decision === 'redirect') redirect(access.target);

  // The gate already proved the platform-admin flag on the session's
  // principal; the token-scoped contract read re-verifies it server-side.
  const token = await currentSessionToken();
  let requests: WaitlistRequest[] = [];
  if (token !== null) {
    try {
      requests = await listWaitlistRequests({ token });
    } catch {
      // The flag stopped verifying between resolve and read (revoked
      // mid-flight) — the honest state is the empty queue, not a crash.
      requests = [];
    }
  }

  const pending = requests.filter((request) => request.status === 'pending');
  const settled = requests.filter((request) => request.status !== 'pending');

  return (
    <div>
      <div className="aurum-platform-title-block">
        <h2 className="aurum-platform-page-title">{WAITLIST_PAGE_COPY.title}</h2>
        <p className="aurum-platform-page-blurb">{WAITLIST_PAGE_COPY.blurb}</p>
      </div>

      {requests.length === 0 ? (
        <p className="aurum-waitlist-empty" role="status">
          {WAITLIST_EMPTY_MESSAGE}
        </p>
      ) : (
        <div className="aurum-waitlist-panel">
          <ul className="aurum-waitlist-list" aria-label="Access requests">
            {[...pending, ...settled].map((request) => (
              <li key={request.id} className="aurum-waitlist-row">
                <span
                  className="aurum-waitlist-tile"
                  data-hue={waitlistHue(request.email)}
                  aria-hidden="true"
                >
                  {waitlistInitial(request.displayName)}
                </span>
                <div className="aurum-waitlist-main">
                  <span className="aurum-waitlist-name">{request.displayName}</span>
                  <span className="aurum-waitlist-email">{request.email}</span>
                  <span className="aurum-waitlist-meta">
                    {waitlistRequestedLabel(request.requestedAt)}
                    {waitlistDecidedLabel(request) === null
                      ? ''
                      : ` · ${waitlistDecidedLabel(request)}`}
                  </span>
                  {request.note === null ? null : (
                    <p className="aurum-waitlist-note">Note: {request.note}</p>
                  )}
                </div>
                <div className="aurum-waitlist-side">
                  <span className="aurum-waitlist-pill" data-tone={waitlistStatusTone(request.status)}>
                    {waitlistStatusLabel(request.status)}
                  </span>
                  {request.status === 'pending' ? (
                    <WaitlistDecision requestId={request.id} />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
