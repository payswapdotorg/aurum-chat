// Auth surfaces (W058) — the ?next= path sanitizer.
//
// Sign-in round trips preserve the destination (?next=). Only same-app
// paths are allowed: a value that is not a clean internal path falls back
// to /chat (open-redirect guard).

export const DEFAULT_NEXT_PATH = '/chat';

export function sanitizeNextPath(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_NEXT_PATH;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return DEFAULT_NEXT_PATH;
  }
  return trimmed;
}
