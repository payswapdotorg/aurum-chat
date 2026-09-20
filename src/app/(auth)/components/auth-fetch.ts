'use client';

// Auth surfaces (W058) — the tiny shared fetch helper of the client forms.
// Every request carries the session cookie implicitly (same-origin fetch);
// no scope parameters ever appear in a URL.

export interface AuthFetchOutcome {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export async function postAuthJson(path: string, body: Record<string, unknown>): Promise<AuthFetchOutcome> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, status: response.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: { message: 'the request could not be sent' } };
  }
}

/** The redirect target after a successful sign-in/registration. */
export function afterAuthTarget(body: Record<string, unknown>, next: string | null): string {
  const session = body['session'] as { company?: unknown } | undefined;
  const hasCompany =
    session !== undefined && session !== null && typeof session === 'object' && session.company !== null;
  if (next !== null && next.startsWith('/') && !next.startsWith('//')) return next;
  return hasCompany ? '/chat' : '/onboarding';
}
