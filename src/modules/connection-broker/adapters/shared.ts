// Shared infrastructure of the connection-broker adapters (MODULE-INTERNAL).
//
// Adapters are the ONLY place where broker-native wire dialects exist (lock
// 16 analog; IMPLEMENTATION-STACK §6 provider isolation): every adapter
// translates its broker's HTTP API and webhook envelopes into the canonical
// broker port types, and every failure — HTTP status, network error,
// malformed body — into a CanonicalProviderFailure through the W089 SDK
// taxonomy (§9 failure isolation: a broker/provider outage NEVER becomes a
// domain failure; it becomes canonical error state).
//
// CREDENTIAL ISOLATION: adapter instances hold their broker INSTANCE secret
// (e.g. a Nango secret key) as wiring-time configuration — it is used on the
// Authorization header and never returned, logged or persisted. Token
// values that appear inside broker API responses are DISCARDED at the
// adapter boundary: the canonical grant carries only the OPAQUE
// `credentialRef` (the reference into the broker's credential store).

import {
  canonicalFailure,
  normalizeProviderError,
  safeErrorDetail,
  type CanonicalErrorCategory,
  type CanonicalProviderFailure,
} from '@/modules/provider-sdk/contract';
import type {
  BrokerHttpClient,
  BrokerHttpRequest,
} from '../types';

/** The canonical gateway key every broker adapter declares. */
export const BROKER_GATEWAY = 'connection-broker';

/**
 * The canonical capability set every managed broker serves (declared by
 * every conforming broker adapter's W089 definition — equivalent
 * alternatives serve the same capabilities by definition).
 */
export const BROKER_CAPABILITIES = [
  'oauth-authorization',
  'token-refresh',
  'record-sync',
  'webhook-ingestion',
] as const;

/**
 * The error every broker-adapter failure becomes: the canonical normalized
 * failure plus a human message. Never carries a credential value.
 */
export class BrokerAdapterError extends Error {
  constructor(
    public readonly failure: CanonicalProviderFailure,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerAdapterError';
  }
}

/**
 * Map one HTTP status onto the canonical taxonomy (null = not an error
 * status). 404 is connection-scoped broker semantics: the broker no longer
 * knows the connection — the grant is gone, an operator must re-authorize
 * (auth_failure), exactly like the 401 the same endpoint answers with a
 * rejected instance secret.
 */
export function categoryForHttpStatus(status: number): CanonicalErrorCategory | null {
  if (status === 401 || status === 404) return 'auth_failure';
  if (status === 403) return 'permission_denied';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return null;
}

/**
 * Execute one broker HTTP request through the injected client. Network
 * errors and non-2xx statuses become BrokerAdapterError carrying the
 * canonical failure; 2xx returns the parsed body.
 */
export async function performRequest(
  client: BrokerHttpClient,
  brokerKey: string,
  request: BrokerHttpRequest,
): Promise<unknown> {
  let response;
  try {
    response = await client.request(request);
  } catch (error) {
    const failure = normalizeProviderError(error, {
      gateway: BROKER_GATEWAY,
      provider: brokerKey,
    });
    throw new BrokerAdapterError(
      failure,
      `the ${brokerKey} broker transport failed: ${failure.detail}`,
    );
  }
  const category = categoryForHttpStatus(response.status);
  if (category === null && (response.status < 200 || response.status >= 300)) {
    // Non-2xx statuses outside the canonical error ranges are still
    // refusals (e.g. 3xx from a misconfigured base URL).
    notOk(brokerKey, request, response.status, response.body, 'invalid_request');
  }
  if (category !== null) {
    notOk(brokerKey, request, response.status, response.body, category);
  }
  return response.body;
}

function notOk(
  brokerKey: string,
  request: BrokerHttpRequest,
  status: number,
  body: unknown,
  category: CanonicalErrorCategory,
): never {
  const failure = canonicalFailure(category, {
    gateway: BROKER_GATEWAY,
    provider: brokerKey,
    detail: `the ${brokerKey} broker responded ${status}: ${safeErrorDetail(body)}`,
  });
  throw new BrokerAdapterError(
    failure,
    `the ${brokerKey} broker responded ${status} to ${request.method} ${request.path}`,
  );
}

// ---------------------------------------------------------------------------
// Dialect-bound envelope parsing (each adapter mints its own helpers so
// every malformed rejection carries the adapter's broker key)
// ---------------------------------------------------------------------------

export interface DialectHelpers {
  requireObject(value: unknown, where: string): Record<string, unknown>;
  requireString(value: unknown, where: string): string;
  optionalString(value: unknown, where: string): string | null;
  requireIsoInstant(value: unknown, where: string): string;
  optionalIsoInstant(value: unknown, where: string): string | null;
  requireStringArray(value: unknown, where: string): string[];
  requireRecords(value: unknown, where: string): Record<string, unknown>[];
  malformed(where: string, problem: string): BrokerAdapterError;
}

/** Mint dialect-parsing helpers bound to one broker key. */
export function createDialectHelpers(brokerKey: string): DialectHelpers {
  const malformed = (where: string, problem: string): BrokerAdapterError => {
    const failure = canonicalFailure('malformed_response', {
      gateway: BROKER_GATEWAY,
      provider: brokerKey,
      detail: `${where} ${problem}`,
    });
    return new BrokerAdapterError(failure, `the ${brokerKey} broker response is malformed: ${where} ${problem}`);
  };
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const requireObject = (value: unknown, where: string): Record<string, unknown> => {
    if (!isPlainObject(value)) {
      throw malformed(where, 'must be an object');
    }
    return value;
  };
  const requireString = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw malformed(where, 'must be a non-empty string');
    }
    return value.trim();
  };
  const optionalString = (value: unknown, where: string): string | null => {
    if (value === undefined || value === null) return null;
    return requireString(value, where);
  };
  const requireIsoInstant = (value: unknown, where: string): string => {
    const text = requireString(value, where);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(text) ||
      Number.isNaN(Date.parse(text))
    ) {
      throw malformed(
        where,
        `must be a strict ISO 8601 timestamp with explicit offset (got '${text}')`,
      );
    }
    return text;
  };
  const optionalIsoInstant = (value: unknown, where: string): string | null => {
    if (value === undefined || value === null) return null;
    return requireIsoInstant(value, where);
  };
  const requireStringArray = (value: unknown, where: string): string[] => {
    if (!Array.isArray(value)) {
      throw malformed(where, 'must be an array of strings');
    }
    return value.map((entry) => requireString(entry, `${where}[]`));
  };
  const requireRecords = (value: unknown, where: string): Record<string, unknown>[] => {
    if (!Array.isArray(value)) {
      throw malformed(where, 'must be an array');
    }
    if (value.length > 200) {
      throw malformed(where, `supports at most 200 records per delivery (got ${value.length})`);
    }
    return value.map((entry, index) => requireObject(entry, `${where}[${index}]`));
  };
  return {
    requireObject,
    requireString,
    optionalString,
    requireIsoInstant,
    optionalIsoInstant,
    requireStringArray,
    requireRecords,
    malformed,
  };
}
