// Input validation of the auth module (W058) — pure helpers, no I/O.
//
// House style (organizations/validation.ts): every exported assert either
// returns the normalized value or throws AuthError('invalid_input') with
// a human message; nothing here touches the database or the clock.

import { AuthError } from './errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const DISPLAY_NAME_MAX = 200;
const EMAIL_MAX = 254;

/** Require a uuid-shaped string. */
export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AuthError('invalid_input', `${field} must be a uuid`);
  }
  return value.toLowerCase();
}

/**
 * Require an email address: trimmed, lowercased, shape-checked. The check
 * mirrors the auth_users CHECK constraint (lower(email), 3–254 chars).
 */
export function assertEmail(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', `${field} must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > EMAIL_MAX ||
    !EMAIL_PATTERN.test(normalized) ||
    normalized !== normalized.toLowerCase()
  ) {
    throw new AuthError('invalid_input', `${field} must be a valid email address`);
  }
  return normalized;
}

/** Require a display name (1–200 chars after trimming). */
export function assertDisplayName(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX) {
    throw new AuthError('invalid_input', `${field} must be 1–${DISPLAY_NAME_MAX} characters after trimming`);
  }
  return trimmed;
}

/** Require a session/invite token shape (base64url characters only, sane length). */
export function assertTokenShape(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuthError('invalid_input', `${field} must be a non-empty string`);
  }
  if (value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AuthError('invalid_input', `${field} is not a valid token`);
  }
  return value;
}

/** Invitable tenant role (owner is provisioning-only — never invitable). */
export function assertInvitableRole(value: unknown): 'member' | 'admin' {
  if (value === undefined || value === null) return 'member';
  if (value === 'member' || value === 'admin') return value;
  throw new AuthError('invalid_input', 'role must be "member" or "admin" (owners are created by provisioning)');
}

/** An optional, explicitly nullable workspace id (or absent = tenant-wide invite). */
export function assertOptionalWorkspaceId(
  value: unknown,
): string | null {
  if (value === undefined || value === null) return null;
  return assertUuid(value, 'workspaceId');
}
