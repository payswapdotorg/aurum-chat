'use client';

// Auth surfaces (W058) — the one client fetch helper the auth forms share:
// POST JSON, surface a friendly error message, never throw for expected
// failures. Success handlers perform a FULL navigation
// (window.location.assign) so the new session cookie reaches the server
// components of the destination on the first render.

export interface JsonOutcome {
  ok: boolean;
  status: number;
  /** Parsed JSON body when present. */
  data: Record<string, unknown> | null;
  /** Human-ready error message (module messages, or a status fallback). */
  message: string | null;
}

export async function postJson(url: string, body: unknown): Promise<JsonOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, data: null, message: 'Aurum is unreachable — check your connection and try again.' };
  }
  const data = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    const message =
      data !== null && typeof data['message'] === 'string'
        ? data['message']
        : `The request failed (HTTP ${response.status}).`;
    return { ok: false, status: response.status, data, message };
  }
  return { ok: true, status: response.status, data, message: null };
}

/** Navigate fully (the session cookie must reach the next server render). */
export function navigateTo(target: string): void {
  window.location.assign(target);
}
