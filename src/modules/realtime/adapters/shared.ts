// Shared envelope-parsing helpers for the realtime adapters (MODULE-INTERNAL).
//
// Every event-capable adapter parses the envelope shape its provider's
// transport delivers. These helpers keep that parsing uniform: strict
// object/string/ISO/E.164 checks with the canonical error codes, and a
// shared rejection for recognized-but-non-record envelopes.

import { RealtimeError } from '../errors';

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

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
    throw new RealtimeError('invalid_provider_payload', `${where} must be an object`);
  }
  return value;
}

export function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RealtimeError('invalid_provider_payload', `${where} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, where);
}

export function requireIsoInstant(value: unknown, where: string): string {
  const text = requireString(value, where);
  if (!ISO_INSTANT_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw new RealtimeError(
      'invalid_provider_payload',
      `${where} must be a strict ISO 8601 timestamp with explicit offset (got '${text}')`,
    );
  }
  return text;
}

export function optionalIsoInstant(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  return requireIsoInstant(value, where);
}

export function optionalConfidence(value: unknown, where: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RealtimeError(
      'invalid_provider_payload',
      `${where} must be a number in [0, 1] (got ${String(value)})`,
    );
  }
  return value;
}

export function optionalByteSize(value: unknown, where: string): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new RealtimeError(
      'invalid_provider_payload',
      `${where} must be a non-negative integer (got ${String(value)})`,
    );
  }
  return value;
}

/** Extracts a bounded events array from a batch envelope. */
export function requireEvents(value: unknown, where: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new RealtimeError('invalid_provider_payload', `${where} must be an array`);
  }
  if (value.length > 200) {
    throw new RealtimeError(
      'invalid_provider_payload',
      `${where} supports at most 200 events per envelope (got ${value.length})`,
    );
  }
  return value.map((entry, index) => requireObject(entry, `${where}[${index}]`));
}

/** Recognized-but-non-record envelope (verification handshakes, pings). */
export function unsupportedEvent(message: string): never {
  throw new RealtimeError('unsupported_provider_event', message);
}
