// Platform surfaces (W116) — the waitlist desk's unit + DOM suite: the
// pure page-access resolution (who renders, who is redirected where —
// without leaking the desk's existence) and the server-rendered roster
// markup (contact rows, status pills, the POST decision forms, the empty
// state), through React's renderToReadableStream exactly as the browser
// receives it. No database here — the handler journeys live in
// platform-waitlist-integration.test.ts.

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import type { SessionResolution } from '@/app/lib/session';
import type { WaitlistRequest } from '@/modules/auth/contract';
import { resolvePlatformPageAccess } from '../lib/page-context';
import { WaitlistList } from '../platform/waitlist/components/waitlist-views';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function anonymousSession(): SessionResolution {
  return { status: 'anonymous', platformAdmin: false };
}

function adminSession(status: 'no-company' | 'authenticated' = 'authenticated'): SessionResolution {
  if (status === 'no-company') {
    return {
      status: 'no-company',
      sessionId: 'session-id',
      principal: { id: 'principal-id', email: 'operator@example.test', displayName: 'Operator' },
      platformAdmin: true,
      companies: [],
    };
  }
  return {
    status: 'authenticated',
    sessionId: 'session-id',
    principal: { id: 'principal-id', email: 'operator@example.test', displayName: 'Operator' },
    platformAdmin: true,
    context: { tenantId: '0f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', principalId: 'principal-id', authority: [] },
    role: 'owner',
    workspaceId: null,
    companies: [],
  };
}

function regularSession(status: 'no-company' | 'authenticated' = 'authenticated'): SessionResolution {
  const admin = adminSession(status);
  return { ...admin, platformAdmin: false };
}

function request(overrides: Partial<WaitlistRequest>): WaitlistRequest {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'dana.whitfield@example.test',
    displayName: 'Dana Whitfield',
    status: 'pending',
    requestedAt: '2026-10-08T09:12:00.000Z',
    decidedAt: null,
    decidedBy: null,
    note: null,
    ...overrides,
  };
}

async function renderHtml(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node);
  return await new Response(stream).text();
}

// ---------------------------------------------------------------------------
// The page gate (pure)
// ---------------------------------------------------------------------------

describe('platform page access (W116)', () => {
  it('renders only for a platform admin — with or without a company', () => {
    expect(resolvePlatformPageAccess(adminSession('authenticated'))).toMatchObject({ ok: true });
    expect(resolvePlatformPageAccess(adminSession('no-company'))).toMatchObject({ ok: true });
  });

  it('redirects the anonymous visitor to sign-in', () => {
    expect(resolvePlatformPageAccess(anonymousSession())).toEqual({
      ok: false,
      redirectTo: '/signin',
    });
  });

  it('redirects a regular user to their natural surface — no existence leak', () => {
    const authenticated = resolvePlatformPageAccess(regularSession('authenticated'));
    expect(authenticated).toEqual({ ok: false, redirectTo: '/chat' });
    const onboarding = resolvePlatformPageAccess(regularSession('no-company'));
    expect(onboarding).toEqual({ ok: false, redirectTo: '/onboarding' });
  });
});

// ---------------------------------------------------------------------------
// The roster markup (DOM)
// ---------------------------------------------------------------------------

describe('the waitlist roster markup (W116)', () => {
  it('renders every pending request as a contact row with the decision form', async () => {
    const html = await renderHtml(
      createElement(WaitlistList, {
        requests: [
          request({}),
          request({
            id: '22222222-2222-4222-8222-222222222222',
            email: 'eli.employee@example.test',
            displayName: 'Eli Employee',
          }),
        ],
      }),
    );
    // Contact rows: the colored initial tiles, the names, the emails, the date.
    expect(html).toContain('class="platform-tile"');
    expect(html).toContain('Dana Whitfield');
    expect(html).toContain('dana.whitfield@example.test');
    expect(html).toContain('Eli Employee');
    expect(html).toContain('requested');
    expect(html).toContain('Oct 8, 2026 · 09:12 UTC');
    // The status pill pairs its label, never color alone.
    expect(html).toContain('Waiting');
    // The decision forms: POST form actions, the hidden request id, the
    // note input, and the two submit buttons carrying the decision.
    expect((html.match(/method="post"/g) ?? []).length).toBe(2);
    expect(html).toContain('action="/api/platform/waitlist/decide"');
    expect(html).toContain('name="requestId"');
    expect(html).toContain('name="note"');
    expect((html.match(/value="accept"/g) ?? []).length).toBe(2);
    expect((html.match(/value="decline"/g) ?? []).length).toBe(2);
    // Both submit buttons carry the decision field (the clicked one wins).
    expect((html.match(/name="decision"/g) ?? []).length).toBe(4);
    expect(html).toContain('Accept');
    expect(html).toContain('Decline');
  });

  it('renders the settled history read-only with the audit trail and note', async () => {
    const html = await renderHtml(
      createElement(WaitlistList, {
        requests: [
          request({
            status: 'declined',
            decidedAt: '2026-10-09T10:00:00.000Z',
            decidedBy: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
            note: 'This round is internal only',
          }),
          request({
            id: '33333333-3333-4333-8333-333333333333',
            email: 'ok.person@example.test',
            displayName: 'Ok Person',
            status: 'accepted',
            decidedAt: '2026-10-09T11:00:00.000Z',
            decidedBy: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
          }),
        ],
      }),
    );
    expect(html).toContain('Decided');
    expect(html).toContain('Accepted');
    expect(html).toContain('Declined');
    expect(html).toContain('Oct 9, 2026');
    expect(html).toContain('by principal');
    expect(html).toContain('1a2b3c4d');
    expect(html).toContain('This round is internal only');
    // Settled rows carry no decision form — history is read-only.
    expect(html).not.toContain('method="post"');
  });

  it('renders the honest empty state when nothing waits', async () => {
    const html = await renderHtml(createElement(WaitlistList, { requests: [] }));
    expect(html).toContain('No requests waiting');
    expect(html).toContain('their request lands');
    expect(html).not.toContain('method="post"');
  });
});
