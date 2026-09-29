// Platform surfaces (W116) — /platform/waitlist, the access-request desk.
//
// Visible ONLY to platform admins (the page gate in lib/page-context
// redirects everyone else to their natural surface without acknowledging
// the desk exists). The roster reads like a conversation list — contact
// rows with colored initial tiles, status pills, compact gold/ink
// actions — and every decision is a native POST form to
// /api/platform/waitlist/decide (never a GET mutation).

import { listWaitlist } from '@/modules/auth/contract';
import { requirePlatformAdminPage } from '../../lib/page-context';
import { WaitlistList } from './components/waitlist-views';

export const dynamic = 'force-dynamic';

type PageSearchParams = Record<string, string | string[] | undefined>;

const NOTICES = {
  accepted: 'Request accepted — the account is active and the person can sign in.',
  declined: 'Request declined — your note (when given) will show on their next sign-in attempt.',
  not_found: 'That request is no longer waiting — it may already have been decided.',
  invalid: 'The decision could not be read — please use the buttons on the desk.',
  failed: 'The decision could not be recorded — please try again.',
} as const;

export default async function PlatformWaitlistPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const page = await requirePlatformAdminPage();
  const requests = await listWaitlist({ token: page.token });
  const pendingCount = requests.filter((request) => request.status === 'pending').length;

  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  const done = first(params['done']);
  const error = first(params['error']);
  const notice =
    done !== null && done in NOTICES
      ? { text: NOTICES[done as keyof typeof NOTICES], risk: false }
      : error !== null && error in NOTICES
        ? { text: NOTICES[error as keyof typeof NOTICES], risk: true }
        : null;

  return (
    <>
      <header className="platform-page-head">
        <h2>Access requests</h2>
        <p>
          Every signup without an invitation lands here as a request: the
          email, the name and the moment it arrived. Accept and the
          account becomes active — the person signs in with the password
          they provided and flows into onboarding. Invitations skip this
          queue: an invite is already company-granted trust.
        </p>
        <div className="platform-page-meta">
          <span>
            {pendingCount === 0
              ? 'Nothing waiting'
              : `${pendingCount} waiting · oldest first`}
          </span>
          <span>reviewing as {page.resolution.principal.email}</span>
        </div>
      </header>
      {notice === null ? null : (
        <p className="platform-notice" data-tone={notice.risk ? 'risk' : undefined} role="status">
          {notice.text}
        </p>
      )}
      <WaitlistList requests={requests} />
    </>
  );
}
