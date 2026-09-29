// Auth surfaces (W116) — the sign-up form's pure outcome decision.
//
// Client-safe (no imports): the form branches on what the API returned,
// and the branch logic + the waitlist confirmation copy live here so the
// surface tests can prove the signed-out confirmation state without a
// browser. The API's own message (WAITLIST_CONFIRMED_MESSAGE in
// lib/api.ts) rides the response body; the panel below adds the
// messenger framing around it.

/** What the sign-up form does after the API answers. */
export type SignUpOutcome =
  | { kind: 'waitlisted'; message: string; notice: string | null }
  | { kind: 'session' }
  | { kind: 'error'; message: string };

/**
 * Decide the form's next state from the API body. The waitlist path is
 * the SIGNED-OUT confirmation: no cookie was issued, so the form stays
 * on the page and renders the confirmation panel instead of routing.
 */
export function signUpOutcome(body: Record<string, unknown>): SignUpOutcome {
  if (body['result'] === 'waitlisted') {
    const message =
      typeof body['message'] === 'string' && body['message'] !== ''
        ? body['message']
        : "You're on the waitlist — the Aurum team will review your request.";
    const notice = typeof body['notice'] === 'string' ? body['notice'] : null;
    return { kind: 'waitlisted', message, notice };
  }
  return { kind: 'session' };
}

/** The confirmation panel's framing copy (messenger tone, no emojis). */
export const WAITLIST_CONFIRMATION_COPY = {
  heading: 'You are on the waitlist',
  blurb:
    'The Aurum team will review your request. When your account is accepted you can sign in with the password you chose and set up your company.',
  signInLabel: 'Back to sign in',
} as const;
