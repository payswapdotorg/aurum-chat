// Shared normalization helpers for the agent-runtime adapters
// (MODULE-INTERNAL). Deliberately boring, pure and provider-agnostic —
// the same discipline as the llm module's adapters/shared.ts: every
// helper fails with the canonical `provider_malformed_response` (or
// `invalid_runtime_config` for configuration) so a runtime response that
// cannot be normalized is a LOUD failure, never a silent substitute
// value.

import { malformedResponse } from './types';

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
    throw malformedResponse(`${where} must be an object (got ${describeType(value)})`);
  }
  return value;
}

export function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw malformedResponse(`${where} must be an array (got ${describeType(value)})`);
  }
  return value;
}

export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

export function optionalString(holder: Record<string, unknown>, field: string): string | null {
  const value = holder[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Non-negative integer count (token counts, operations). */
export function optionalCount(
  holder: Record<string, unknown>,
  field: string,
  where: string,
): number | null {
  const value = holder[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformedResponse(`${where}.${field} must be a non-negative integer when present`);
  }
  return value;
}

/** Provider task ids are opaque printable strings. */
export function boundedId(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw malformedResponse(`${where} must be a string when present`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 255 || /[\p{Cc}]/u.test(trimmed)) {
    throw malformedResponse(`${where} must be at most 255 printable characters`);
  }
  return trimmed;
}

/** Canonical summaries are bounded, so one runaway runtime cannot blow up evidence rows. */
export function boundedSummary(value: unknown, where: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw malformedResponse(`${where} must be a string when present`);
  }
  if (value.length > maxLength) {
    throw malformedResponse(`${where} must be at most ${maxLength} characters (got ${value.length})`);
  }
  return value;
}
