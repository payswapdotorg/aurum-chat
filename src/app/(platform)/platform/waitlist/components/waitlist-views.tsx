// Platform surfaces (W116) — the waitlist desk's presentational views.
//
// Pure components (no hooks, no client APIs) so the DOM suite can
// server-render exactly the markup the browser receives. The READ is the
// W114 messenger conversation-list read: every request is a contact row
// — colored initial tile, name, email, date — with a status pill (dot +
// label, never color alone) and, while pending, the compact gold/ink
// Accept and Decline actions as ONE native POST form (the work item's
// "POST form actions" rule: no bare GET mutations, no client JavaScript
// required, and the SameSite=Lax session cookie never rides a cross-site
// form post).

import type { ReactNode } from 'react';
import type { WaitlistRequest } from '@/modules/auth/contract';
import {
  formatWaitlistInstant,
  waitlistTileInitial,
  waitlistTileTone,
} from '../../../lib/format';

/** The status pill: a colored dot always paired with its label. */
export function WaitlistStatusPill({ status }: { status: WaitlistRequest['status'] }): ReactNode {
  const tone = status === 'pending' ? 'pending' : status === 'accepted' ? 'positive' : 'risk';
  return (
    <span className="platform-pill" data-tone={tone}>
      <span className="platform-pill-dot" aria-hidden="true" />
      {status === 'pending' ? 'Waiting' : status === 'accepted' ? 'Accepted' : 'Declined'}
      <span className="platform-sr-only">{` (status: ${status})`}</span>
    </span>
  );
}

/** One pending request: the contact row plus the decision form. */
export function WaitlistPendingRow({ request }: { request: WaitlistRequest }): ReactNode {
  return (
    <li className="platform-row">
      <span className="platform-tile" data-tone={waitlistTileTone(request.displayName)} aria-hidden="true">
        {waitlistTileInitial(request.displayName)}
      </span>
      <div className="platform-row-main">
        <span className="platform-row-name">{request.displayName}</span>
        <span className="platform-row-email">{request.email}</span>
        <span className="platform-row-meta">
          requested {formatWaitlistInstant(request.requestedAt)}
        </span>
        <form className="platform-decide" method="post" action="/api/platform/waitlist/decide">
          <input type="hidden" name="requestId" value={request.id} />
          <label className="platform-sr-only" htmlFor={`note-${request.id}`}>
            Optional note for the decision on {request.displayName}&apos;s request
          </label>
          <input
            className="platform-decide-note"
            id={`note-${request.id}`}
            name="note"
            type="text"
            maxLength={280}
            placeholder="Note (optional — shown to a declined requester)"
            autoComplete="off"
          />
          <button className="platform-btn" type="submit" name="decision" value="accept" data-variant="gold">
            Accept
          </button>
          <button className="platform-btn" type="submit" name="decision" value="decline" data-variant="ink">
            Decline
          </button>
        </form>
      </div>
      <WaitlistStatusPill status={request.status} />
    </li>
  );
}

/** One decided request: the settled, read-only audit row. */
export function WaitlistSettledRow({ request }: { request: WaitlistRequest }): ReactNode {
  return (
    <li className="platform-row">
      <span className="platform-tile" data-tone={waitlistTileTone(request.displayName)} aria-hidden="true">
        {waitlistTileInitial(request.displayName)}
      </span>
      <div className="platform-row-main">
        <span className="platform-row-name">{request.displayName}</span>
        <span className="platform-row-email">{request.email}</span>
        <span className="platform-row-meta">
          requested {formatWaitlistInstant(request.requestedAt)}
          {request.decidedAt === null
            ? ''
            : ` · decided ${formatWaitlistInstant(request.decidedAt)}`}
          {request.decidedBy === null
            ? ''
            : ` · by an admin`}
        </span>
        {request.note === null ? null : (
          <span className="platform-row-note">{request.note}</span>
        )}
      </div>
      <WaitlistStatusPill status={request.status} />
    </li>
  );
}

/** The messenger's honest empty state. */
export function WaitlistEmpty(): ReactNode {
  return (
    <div className="platform-empty">
      <strong>No requests waiting</strong>
      <span>
        When someone signs up without an invitation, their request lands
        here for your review.
      </span>
    </div>
  );
}

/**
 * The whole roster: the waiting list first (contact rows with actions),
 * then the settled history (append-only audit), then the empty state
 * when there is nothing at all.
 */
export function WaitlistList({ requests }: { requests: WaitlistRequest[] }): ReactNode {
  const pending = requests.filter((request) => request.status === 'pending');
  const settled = requests.filter((request) => request.status !== 'pending');
  return (
    <>
      <section className="platform-section" aria-labelledby="waitlist-pending-title">
        <h3 className="platform-section-title" id="waitlist-pending-title">
          Waiting for review
        </h3>
        <p className="platform-section-blurb">
          Accept creates the account — the person signs in with the
          password they provided at sign-up. Decline records your note and
          shows it on their next sign-in attempt.
        </p>
        {pending.length === 0 ? (
          <WaitlistEmpty />
        ) : (
          <ul className="platform-rows">
            {pending.map((request) => (
              <WaitlistPendingRow key={request.id} request={request} />
            ))}
          </ul>
        )}
      </section>
      {settled.length === 0 ? null : (
        <section className="platform-section" aria-labelledby="waitlist-settled-title">
          <h3 className="platform-section-title" id="waitlist-settled-title">
            Decided
          </h3>
          <p className="platform-section-blurb">
            The audit trail — decisions are final and permanently recorded.
          </p>
          <ul className="platform-rows">
            {settled.map((request) => (
              <WaitlistSettledRow key={request.id} request={request} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
