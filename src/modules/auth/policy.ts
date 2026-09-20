// Session lifetime policy (W058) — pure, clock-parameterized so tests
// drive every boundary explicitly.
//
// Model: an idle-sliding session under an absolute cap.
//   * IDLE TTL      — how long inactivity may last before expiry;
//   * ABSOLUTE CAP  — a session never outlives login + this, no matter
//                     how active it is;
//   * WRITE THROTTLE — renewal rewrites last_seen/expires only when the
//                     stored last_seen is at least this old, so a page
//                     load does not become a write on every request.
//
// `renewal` computes the next (expires_at, last_seen) pair for a live
// session touched `at`, capped by the absolute deadline; the service
// persists exactly this.

export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days of inactivity
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days from login
export const SESSION_WRITE_THRESHOLD_MS = 60 * 1000; // rewrite at most once a minute
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // invites live 7 days

/** Is a session alive at `now`? (not revoked, expiry in the future) */
export function isLive(expiresAt: Date, revokedAt: Date | null, now: Date): boolean {
  if (revokedAt !== null) return false;
  return expiresAt.getTime() > now.getTime();
}

export interface RenewalDecision {
  /** The renewal must be persisted (throttled). */
  write: boolean;
  /** The session's new expiry (idle-sliding, capped by the absolute deadline). */
  expiresAt: Date;
  /** The session's new last-seen stamp. */
  lastSeenAt: Date;
}

/**
 * Decide the renewal for a session logged in at `createdAt`, last touched
 * at `lastSeenAt` (null before the first touch), now active at `now`.
 * Pure — no clock, no I/O; `now` is passed in by the service.
 *
 * The idle window is measured from the last PERSISTED touch, and the
 * write only happens once the throttle elapsed — an un-persisted touch
 * within the window costs nothing (the next write extends the window
 * from `now`, so the effective idle budget is never shorter than
 * IDLE_TTL minus the throttle).
 */
export function renewal(
  createdAt: Date,
  lastSeenAt: Date | null,
  now: Date,
): RenewalDecision {
  const absoluteDeadline = new Date(createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS);
  const idleDeadline = new Date(now.getTime() + SESSION_IDLE_TTL_MS);
  const nextExpiry = idleDeadline.getTime() < absoluteDeadline.getTime() ? idleDeadline : absoluteDeadline;
  const lastSeenStamp = lastSeenAt ?? createdAt;
  const write = now.getTime() - lastSeenStamp.getTime() >= SESSION_WRITE_THRESHOLD_MS;
  return { write, expiresAt: nextExpiry, lastSeenAt: now };
}

/** Expiry stamped at issue time (the first idle window, always under the cap). */
export function initialExpiry(createdAt: Date): Date {
  const idle = new Date(createdAt.getTime() + SESSION_IDLE_TTL_MS);
  const absolute = new Date(createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS);
  return idle.getTime() < absolute.getTime() ? idle : absolute;
}

/** When a fresh invitation expires. */
export function inviteExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + INVITE_TTL_MS);
}

/** Has an invitation passed its expiry at `now`? */
export function isInviteExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
