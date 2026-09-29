// Platform admin API (W116) — the request handling for /api/platform/**.
//
// The same thin-adapter discipline the (auth) group follows: route.ts
// files translate HTTP only; all logic lives here and is testable
// without booting Next.js. Authentication is the SESSION COOKIE,
// authorization is the principal's platform-admin flag (resolved through
// the auth contract) — never a query parameter, never a header seam.
//
// Outcomes:
//   * anonymous/expired sessions are uniformly 401 (no leak about which
//     part failed);
//   * a signed-in principal without the platform-admin flag is 403
//     forbidden — the same code for every non-admin, tenant role is
//     irrelevant (platform administration is never a tenant fact);
//   * module errors map to honest HTTP-ish codes (the (auth) group's
//     mapAuthApiError — the shared auth error vocabulary).

import { sessionTokenFromCookieHeader } from '@/app/lib/session';
import { mapAuthApiError } from '@/app/(auth)/lib/api';
import type { AuthApiResult } from '@/app/(auth)/lib/api';
import {
  acceptWaitlistRequest,
  declineWaitlistRequest,
  listWaitlistRequests,
} from '@/modules/auth/contract';

function ok(body: Record<string, unknown>): AuthApiResult {
  return { status: 200, body };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    return '';
  }
  return value;
}

/** GET /api/platform/waitlist — the review queue (every request, newest pending first). */
export async function handleWaitlistListGet(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token === null) {
    return { status: 401, body: { error: 'unauthenticated', message: 'no session for this request' } };
  }
  try {
    const requests = await listWaitlistRequests({ token });
    return ok({ requests });
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/**
 * POST /api/platform/waitlist/accept — a pending request becomes an
 * account (the principal row is created from the captured material; the
 * request flips to accepted with the deciding admin's id). JSON POST
 * through the session cookie — the same CSRF-resistant shape every auth
 * write uses (a cross-site form cannot post application/json).
 */
export async function handleWaitlistAcceptPost(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token === null) {
    return { status: 401, body: { error: 'unauthenticated', message: 'no session for this request' } };
  }
  const body = await readJson(request);
  try {
    const waitlistRequest = await acceptWaitlistRequest({
      token,
      requestId: requireString(body, 'requestId'),
    });
    return ok({ request: waitlistRequest });
  } catch (error) {
    return mapAuthApiError(error);
  }
}

/** POST /api/platform/waitlist/decline — flip a pending request to declined (+ optional note). */
export async function handleWaitlistDeclinePost(request: Request): Promise<AuthApiResult> {
  const token = sessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token === null) {
    return { status: 401, body: { error: 'unauthenticated', message: 'no session for this request' } };
  }
  const body = await readJson(request);
  try {
    const note =
      typeof body['note'] === 'string' && body['note'] !== '' ? (body['note'] as string) : null;
    const waitlistRequest = await declineWaitlistRequest({
      token,
      requestId: requireString(body, 'requestId'),
      note,
    });
    return ok({ request: waitlistRequest });
  } catch (error) {
    return mapAuthApiError(error);
  }
}
