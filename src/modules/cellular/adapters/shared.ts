// Shared envelope-parsing helpers for the cellular telecom adapters
// (MODULE-INTERNAL). Mirrors the channels/realtime adapters' helper
// discipline: deliberately boring, pure, provider-agnostic guards and
// E.164/ISO conversions, each throwing the canonical CellularError codes
// so every adapter stays a thin, auditable mapping from vendor reality
// to the canonical vocabulary.

import { CellularError } from '../errors';

function payloadError(message: string): CellularError {
  return new CellularError('invalid_provider_payload', message);
}

export function unsupportedEvent(message: string): CellularError {
  return new CellularError('unsupported_provider_event', message);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw payloadError(`${where} must be an object`);
  }
  return value;
}

export function requiredString(holder: Record<string, unknown>, field: string, where: string): string {
  const value = holder[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw payloadError(`${where}.${field} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(holder: Record<string, unknown>, field: string): string | null {
  const value = holder[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A non-negative integer field, null when absent. */
export function optionalNonNegativeInteger(
  holder: Record<string, unknown>,
  field: string,
  where: string,
): number | null {
  const value = holder[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 86_400) {
    throw payloadError(`${where}.${field} must be a non-negative integer of at most 86400`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Phone-number canonicalization (E.164)
// ---------------------------------------------------------------------------

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** Canonical E.164: strip formatting artifacts, ensure the leading `+`. */
export function toE164(raw: string, where: string): string {
  const digits = raw.replace(/[\s\-().]/g, '');
  const withPlus = digits.startsWith('+') ? digits : `+${digits}`;
  if (!E164_PATTERN.test(withPlus)) {
    throw payloadError(`${where} must be a valid E.164 phone number (got '${raw}')`);
  }
  return withPlus;
}

/** Strict caller-supplied E.164 normalization (config/outbound path → invalid_cellular_input). */
export function normalizeE164(raw: string, field: string): string {
  try {
    return toE164(raw, field);
  } catch (error) {
    if (error instanceof CellularError && error.code === 'invalid_provider_payload') {
      throw new CellularError(
        'invalid_cellular_input',
        `${field} must be a valid E.164 phone number for this provider (got '${raw}')`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Time conversions
// ---------------------------------------------------------------------------

/** Accepts any parseable ISO 8601 timestamp; null when absent. */
export function flexibleDateToIso(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) {
    throw payloadError(`${where} must be a parseable ISO 8601 date (got '${String(value)}')`);
  }
  return new Date(parsed).toISOString();
}
