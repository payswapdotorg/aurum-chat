// Auth surfaces (W116) — the signup DOM suite: the waitlist confirmation
// state a person lands in after requesting access. Server-rendered
// through React's renderToReadableStream (the same technique as the
// conversation-fidelity suite), so the assertions lock the exact markup
// the browser receives — the signed-out "You're on the waitlist" view
// with its messenger-tone copy and the way back to sign-in.

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { WaitlistConfirmation } from '../components/waitlist-confirmation';

async function renderHtml(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node);
  return await new Response(stream).text();
}

describe('the waitlist confirmation state (W116)', () => {
  it('renders the signed-out confirmation with the messenger copy', async () => {
    const html = await renderHtml(createElement(WaitlistConfirmation));
    expect(html).toContain("You&#x27;re on the waitlist");
    expect(html).toContain('The Aurum team will review your request');
    expect(html).toContain('role="status"');
  });

  it('keeps the way back to sign in (no dead ends)', async () => {
    const html = await renderHtml(createElement(WaitlistConfirmation));
    expect(html).toContain('href="/signin"');
    expect(html).toContain('Back to sign in');
  });

  it('never claims an account exists — the honest pre-approval wording', async () => {
    const html = await renderHtml(createElement(WaitlistConfirmation));
    expect(html).toContain('sign in with the email and password you provided');
    expect(html).toContain('your request is kept');
    // The confirmation is a status, never an error or a session claim.
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aurum-auth-error');
  });
});
