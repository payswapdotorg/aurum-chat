// Platform API (W116) — POST /api/platform/waitlist/decide.
//
// The waitlist decision endpoint the admin surface's native forms post
// to. All logic lives here (the tower/product thin-adapter discipline):
// the handler is a plain function over a Request, testable without
// booting Next.js.
//
// MUTATION SEMANTICS (the work item's rule: "never bare GET mutations"):
// this is a POST form action. The browser posts
// application/x-www-form-urlencoded with SameSite=Lax cookies — a
// cross-site form cannot ride the session cookie (Lax only sends it on
// top-level GET navigations), which is the CSRF-equivalent guarantee the
// JSON+fetch surfaces get from their content type.
//
// Every outcome is a REDIRECT (the form navigates): admins return to the
// desk with a quiet notice flag; anyone else is routed exactly like the
// page gate routes them — anonymous → /signin, a signed-in non-admin →
// their natural surface, never a body that acknowledges the platform
// area exists.

import { resolveSessionRequest, sessionTokenFromRequest } from '@/app/lib/session';
import { decideWaitlistRequest, listWaitlist } from '@/modules/auth/contract';
import { AuthError } from '@/modules/auth/contract';

/** The waitlist desk the decisions return to. */
export const WAITLIST_PAGE_PATH = '/platform/waitlist';

/** One decide outcome: where the browser lands next (always a redirect). */
export interface WaitlistDecideResult {
  /** Relative redirect target (the route frames it against the request). */
  location: string;
}

/** One roster read outcome (the admin's JSON list endpoint). */
export interface WaitlistListResult {
  status: number;
  body: Record<string, unknown>;
}

function naturalSurface(status: 'no-company' | 'authenticated'): string {
  return status === 'authenticated' ? '/chat' : '/onboarding';
}

/**
 * GET /api/platform/waitlist — the admin's roster as JSON (the operator's
 * programmatic view of the same list the desk renders). Anonymous → the
 * uniform 401; a signed-in non-admin → the uniform 403 (the quiet the
 * service floor keeps); the roster itself is read-only.
 */
export async function handleWaitlistListGet(request: Request): Promise<WaitlistListResult> {
  const token = sessionTokenFromRequest(request);
  if (token === null) {
    return { status: 401, body: { error: 'unauthenticated', message: 'no session for this request' } };
  }
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return { status: 401, body: { error: 'unauthenticated', message: 'no session for this request' } };
  }
  if (!resolution.platformAdmin) {
    return { status: 403, body: { error: 'forbidden', message: 'this operation requires the platform admin role' } };
  }
  const requests = await listWaitlist({ token });
  return { status: 200, body: { requests } };
}

/**
 * POST /api/platform/waitlist/decide — accept or decline one pending
 * request (optional one-line note). Form fields: requestId, decision
 * ('accept' | 'decline' — the clicked submit button's value), note.
 */
export async function handleWaitlistDecidePost(request: Request): Promise<WaitlistDecideResult> {
  const token = sessionTokenFromRequest(request);
  if (token === null) {
    return { location: '/signin' };
  }
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return { location: '/signin' };
  }
  if (!resolution.platformAdmin) {
    // Quiet, exactly like the page gate — no leak, no mutation.
    return { location: naturalSurface(resolution.status) };
  }
  let fields: FormData;
  try {
    fields = await request.formData();
  } catch {
    return { location: `${WAITLIST_PAGE_PATH}?error=invalid` };
  }
  const requestId = fields.get('requestId');
  const decision = fields.get('decision');
  const note = fields.get('note');
  if (typeof requestId !== 'string' || (decision !== 'accept' && decision !== 'decline')) {
    return { location: `${WAITLIST_PAGE_PATH}?error=invalid` };
  }
  try {
    await decideWaitlistRequest({
      token,
      requestId,
      decision,
      note: typeof note === 'string' && note !== '' ? note : null,
    });
    return { location: `${WAITLIST_PAGE_PATH}?done=${decision === 'accept' ? 'accepted' : 'declined'}` };
  } catch (error) {
    if (error instanceof AuthError && error.code === 'waitlist_not_found') {
      return { location: `${WAITLIST_PAGE_PATH}?error=not_found` };
    }
    if (error instanceof AuthError && error.code === 'invalid_input') {
      return { location: `${WAITLIST_PAGE_PATH}?error=invalid` };
    }
    return { location: `${WAITLIST_PAGE_PATH}?error=failed` };
  }
}
