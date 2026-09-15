// Shared normalization helpers for the LLM provider adapters
// (MODULE-INTERNAL). Deliberately boring, pure and provider-agnostic — the
// same discipline as the channels module's adapters/shared.ts: every helper
// fails with the canonical `provider_malformed_response` so a provider
// response that cannot be normalized is a LOUD failure, never a silent
// substitute value.

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

export function requiredString(holder: Record<string, unknown>, field: string, where: string): string {
  const value = holder[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw malformedResponse(`${where}.${field} must be a non-empty string`);
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

/** Non-negative integer token count (the usage fields providers report). */
export function requiredTokenCount(holder: Record<string, unknown>, field: string, where: string): number {
  const value = holder[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformedResponse(`${where}.${field} must be a non-negative integer token count`);
  }
  return value;
}

/** Provider execution ids are opaque printable strings. */
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

/** Canonical output text — bounded, so one runaway provider cannot blow up evidence rows. */
export function boundedText(value: unknown, field: string, where: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw malformedResponse(`${where}.${field} must be a string (got ${describeType(value)})`);
  }
  if (value.length > maxLength) {
    throw malformedResponse(
      `${where}.${field} must be at most ${maxLength} characters (got ${value.length})`,
    );
  }
  return value;
}

/** Canonical embedding vector: finite floats, dimension-bounded. */
export function parseVector(value: unknown, where: string, maxDimensions: number): number[] {
  if (!Array.isArray(value)) {
    throw malformedResponse(`${where} must be an array of numbers (got ${describeType(value)})`);
  }
  if (value.length === 0) {
    throw malformedResponse(`${where} must contain at least one dimension`);
  }
  if (value.length > maxDimensions) {
    throw malformedResponse(
      `${where} exceeds the maximum of ${maxDimensions} dimensions (got ${value.length})`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw malformedResponse(`${where}[${index}] must be a finite number`);
    }
    return entry;
  });
}
