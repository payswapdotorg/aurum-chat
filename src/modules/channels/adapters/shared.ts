// Shared normalization helpers for the provider adapters (MODULE-INTERNAL).
//
// These are deliberately boring, pure and provider-agnostic: guards,
// E.164/epoch/ISO conversions, printable-string checks and thread-key
// builders. Every helper throws the canonical ChannelsError codes so each
// adapter stays a thin, auditable mapping from provider reality to the
// canonical vocabulary.

import { ChannelsError } from '../errors';

function payloadError(message: string): ChannelsError {
  return new ChannelsError('invalid_provider_payload', message);
}

export function unsupportedEvent(message: string): ChannelsError {
  return new ChannelsError('unsupported_provider_event', message);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export function asObject(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw payloadError(`${where} must be an object (got ${describeType(value)})`);
  }
  return value;
}

export function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw payloadError(`${where} must be an array (got ${describeType(value)})`);
  }
  return value;
}

export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

export function requiredString(holder: Record<string, unknown>, field: string, where: string): string {
  const value = holder[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw payloadError(`${where}.${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(holder: Record<string, unknown>, field: string): string | null {
  const value = holder[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Bounded display text (the canonical bound is 200 — identity/conversations labels). */
export function boundedText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

// ---------------------------------------------------------------------------
// Phone-number canonicalization (E.164) — WhatsApp, Signal, SMS, voice
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

/** Strict caller-supplied E.164 normalization (config/outbound path → invalid_channel_input). */
export function normalizeE164Account(raw: string): string {
  try {
    return toE164(raw, 'providerAccountId');
  } catch (error) {
    if (error instanceof ChannelsError && error.code === 'invalid_provider_payload') {
      throw new ChannelsError(
        'invalid_channel_input',
        `providerAccountId must be a valid E.164 phone number for this provider (got '${raw}')`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Time conversions — provider epochs to strict ISO 8601
// ---------------------------------------------------------------------------

export function epochSecondsToIso(value: unknown, where: string): string {
  const seconds = epochNumber(value, where);
  const millis = Math.floor(seconds * 1_000);
  if (!Number.isSafeInteger(millis)) {
    throw payloadError(`${where} is out of range for a unix-seconds timestamp`);
  }
  return new Date(millis).toISOString();
}

export function epochMillisToIso(value: unknown, where: string): string {
  const millis = epochNumber(value, where);
  if (!Number.isSafeInteger(millis)) {
    throw payloadError(`${where} is out of range for a unix-milliseconds timestamp`);
  }
  return new Date(millis).toISOString();
}

function epochNumber(value: unknown, where: string): number {
  let numberValue: number;
  if (typeof value === 'number') {
    numberValue = value;
  } else if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    // Slack `ts` values arrive as "<seconds>.<fraction>" strings.
    numberValue = Number(value.trim());
  } else {
    throw payloadError(`${where} must be a unix epoch (number or numeric string)`);
  }
  if (!Number.isFinite(numberValue)) {
    throw payloadError(`${where} must be a finite unix epoch`);
  }
  return numberValue;
}

/** Accepts strict ISO 8601 or RFC 2822 (email Date headers); null when absent. */
export function flexibleDateToIso(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) {
    throw payloadError(`${where} must be a parseable ISO 8601 or RFC 2822 date (got '${String(value)}')`);
  }
  return new Date(parsed).toISOString();
}

// ---------------------------------------------------------------------------
// Thread keys — OPAQUE provider-native conversation anchors
// ---------------------------------------------------------------------------

/** WhatsApp/SMS-style pairwise chat: the two E.164 ends, order-independent. */
export function pairThreadKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export function threadKey(parts: string[]): string {
  return parts.join(':');
}

/** Maps an HTTP content type to the canonical attachment kind. */
export function kindFromMimeType(mimeType: string | null, fallback: 'image' | 'audio' | 'video' | 'document'): 'image' | 'audio' | 'video' | 'document' {
  if (mimeType === null) return fallback;
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('video/')) return 'video';
  return 'document';
}
