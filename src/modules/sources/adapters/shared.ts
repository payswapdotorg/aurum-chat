// Shared envelope-parsing helpers for the source adapters (MODULE-INTERNAL).
//
// Every webhook-capable adapter parses the envelope shape its provider's
// transport delivers. These helpers keep that parsing uniform: strict
// object/string/ISO checks with the canonical error codes, and a shared
// rejection for providers that have no webhook support at all.

import { SourcesError } from '../errors';
import { record, type WebhookParseResult } from './types';
import type { CanonicalSourceRecord, SourceProvider } from '../types';

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
    throw new SourcesError('invalid_provider_payload', `${where} must be an object`);
  }
  return value;
}

export function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SourcesError('invalid_provider_payload', `${where} must be a non-empty string`);
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
    throw new SourcesError(
      'invalid_provider_payload',
      `${where} must be a strict ISO 8601 timestamp with explicit offset (got '${text}')`,
    );
  }
  return text;
}

/** Extracts a bounded events array from an envelope. */
export function requireEvents(value: unknown, where: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new SourcesError('invalid_provider_payload', `${where} must be an array`);
  }
  if (value.length > 200) {
    throw new SourcesError(
      'invalid_provider_payload',
      `${where} supports at most 200 events per envelope (got ${value.length})`,
    );
  }
  return value.map((entry, index) => requireObject(entry, `${where}[${index}]`));
}

/** Recognized-but-non-record envelope (verification handshakes, pings). */
export function unsupportedEvent(message: string): never {
  throw new SourcesError('unsupported_provider_event', message);
}

/** The uniform answer of providers without webhook support. */
export function webhookUnsupported(provider: SourceProvider): never {
  throw new SourcesError(
    'ingestion_mode_unsupported',
    `provider '${provider}' supports no webhook ingestion — it is polled through the fetch transport`,
  );
}

export { record };
export type { WebhookParseResult, CanonicalSourceRecord };
