// Input validation for the auth module. Pure, no I/O — unit-testable.
//
// Doctrine: validate at the boundary, throw typed AuthError('invalid_input')
// with a message a human can act on, and normalize before storing (emails
// are lowercased once, here, so uniqueness and lookups are consistent).

import { AuthError } from './errors';

const EMAIL_MAX = 254;
const DISPLAY_NAME_MAX = 100;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const NAME_MAX = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pragmatic email validation: one @, non-empty local part and domain, a dot
 * in the domain, no whitespace, bounded length. RFC 5322 completeness is
 * not the goal — honest rejection of garbage is.
 */
export function assertEmail(value: unknown, field = 'email'): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', `${field} must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > EMAIL_MAX) {
    throw new AuthError('invalid_input', `${field} must be 1–${EMAIL_MAX} characters`);
  }
  const at = normalized.indexOf('@');
  if (at <= 0 || at === normalized.length - 1 || normalized.indexOf('@', at + 1) !== -1) {
    throw new AuthError('invalid_input', `${field} must contain exactly one '@'`);
  }
  const domain = normalized.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    throw new AuthError('invalid_input', `${field} must have a well-formed domain`);
  }
  if (/\s/.test(normalized)) {
    throw new AuthError('invalid_input', `${field} must not contain whitespace`);
  }
  return normalized;
}

export function assertDisplayName(value: unknown, field = 'displayName'): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX) {
    throw new AuthError(
      'invalid_input',
      `${field} must be 1–${DISPLAY_NAME_MAX} characters after trimming`,
    );
  }
  return trimmed;
}

/**
 * Password policy: length only (8–200). The upper bound is a DoS guard for
 * the KDF, not a usability rule; complexity rules are deliberately absent.
 */
export function assertPassword(value: unknown, field = 'password'): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', `${field} must be a string`);
  }
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw new AuthError(
      'invalid_input',
      `${field} must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`,
    );
  }
  return value;
}

export function assertCompanyName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
    throw new AuthError('invalid_input', `${field} must be 1–${NAME_MAX} characters after trimming`);
  }
  return trimmed;
}

export function assertUuidInput(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AuthError('invalid_input', `${field} must be a uuid`);
  }
  return value.toLowerCase();
}

/** A presented session/invitation token: non-empty, bounded, no whitespace. */
export function assertToken(value: unknown, field = 'token'): string {
  if (typeof value !== 'string') {
    throw new AuthError('invalid_input', `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || /\s/.test(trimmed)) {
    throw new AuthError('invalid_input', `${field} is not a valid token`);
  }
  return trimmed;
}

export function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthError('invalid_input', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
