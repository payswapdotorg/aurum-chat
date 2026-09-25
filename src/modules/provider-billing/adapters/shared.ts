// Shared infrastructure of the provider-billing settlement adapters
// (MODULE-INTERNAL).
//
// Adapters are the ONLY place where billing-provider wire dialects exist
// (IMPLEMENTATION-STACK §6 provider isolation): every adapter translates
// its billing provider's HTTP API into the canonical settlement port
// types, and every failure — HTTP status, network error, malformed body —
// into a CanonicalProviderFailure through the W089 SDK taxonomy (§9
// failure isolation: a billing-provider outage NEVER becomes a domain
// failure; it becomes canonical error state).
//
// SECRET ISOLATION: adapter instances hold their billing-provider instance
// key (e.g. a platform billing API key) as wiring-time configuration — it
// is used on the Authorization header and never returned, logged or
// persisted. No credential value ever reaches a domain table or a
// contract result (GOVERNANCE mandatory invariant).
//
// IDEMPOTENT CHARGING (the settlement acceptance core): every charge
// request carries the settlement's id as its idempotency key. Retries and
// crash recoveries of one settlement re-present the SAME key, so a
// conforming billing provider performs the charge exactly once per logical
// settlement and replays the original receipt (the W080 discipline applied
// to money movement).

import {
  canonicalFailure,
  normalizeProviderError,
  safeErrorDetail,
  type CanonicalErrorCategory,
  type CanonicalProviderFailure,
} from '@/modules/provider-sdk/contract';

/** The canonical gateway key every settlement adapter declares. */
export const SETTLEMENT_GATEWAY = 'provider-billing';

/**
 * The canonical capability set every settlement adapter serves (declared by
 * every conforming adapter's W089 definition — materially different
 * billing mechanics, the same capabilities by definition).
 */
export const SETTLEMENT_ADAPTER_CAPABILITIES = [
  'usage-settlement',
  'settlement-receipts',
] as const;

/** The injected network client the adapters speak (real fetch or test double). */
export interface SettlementHttpClient {
  request(request: SettlementHttpRequest): Promise<SettlementHttpResponse>;
}

export interface SettlementHttpRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface SettlementHttpResponse {
  status: number;
  body: unknown;
}

/**
 * The error every settlement-adapter failure becomes: the canonical
 * normalized failure plus a human message. Never carries a credential
 * value.
 */
export class SettlementAdapterError extends Error {
  constructor(
    public readonly failure: CanonicalProviderFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SettlementAdapterError';
  }
}

/** Map one HTTP status onto the canonical taxonomy (null = not an error). */
export function categoryForHttpStatus(status: number): CanonicalErrorCategory | null {
  if (status === 401) return 'auth_failure';
  if (status === 403) return 'permission_denied';
  if (status === 402 || status === 409) return 'quota_exhausted';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return null;
}

/** Execute one billing HTTP request; failures become canonical adapter errors. */
export async function performRequest(
  client: SettlementHttpClient,
  adapterKey: string,
  request: SettlementHttpRequest,
): Promise<unknown> {
  let response: SettlementHttpResponse;
  try {
    response = await client.request(request);
  } catch (error) {
    const failure = normalizeProviderError(error, {
      gateway: SETTLEMENT_GATEWAY,
      provider: adapterKey,
    });
    throw new SettlementAdapterError(
      failure,
      `the ${adapterKey} settlement transport failed: ${failure.detail}`,
    );
  }
  const category = categoryForHttpStatus(response.status);
  if (category === null && (response.status < 200 || response.status >= 300)) {
    notOk(adapterKey, request, response.status, response.body, 'invalid_request');
  }
  if (category !== null) {
    notOk(adapterKey, request, response.status, response.body, category);
  }
  return response.body;
}

function notOk(
  adapterKey: string,
  request: SettlementHttpRequest,
  status: number,
  body: unknown,
  category: CanonicalErrorCategory,
): never {
  const failure = canonicalFailure(category, {
    gateway: SETTLEMENT_GATEWAY,
    provider: adapterKey,
    detail: `the ${adapterKey} settlement provider responded ${status}: ${safeErrorDetail(body)}`,
  });
  throw new SettlementAdapterError(
    failure,
    `the ${adapterKey} settlement provider responded ${status} to ${request.method} ${request.path}`,
  );
}

// ---------------------------------------------------------------------------
// Dialect-bound response parsing (each adapter mints its own helpers so
// every malformed rejection carries the adapter's key)
// ---------------------------------------------------------------------------

export interface SettlementDialectHelpers {
  requireObject(value: unknown, where: string): Record<string, unknown>;
  requireString(value: unknown, where: string): string;
  requireNonNegativeInteger(value: unknown, where: string): number;
  requireIsoInstant(value: unknown, where: string): string;
  malformed(where: string, problem: string): SettlementAdapterError;
}

/** Mint dialect-parsing helpers bound to one adapter key. */
export function createSettlementDialectHelpers(adapterKey: string): SettlementDialectHelpers {
  const malformed = (where: string, problem: string): SettlementAdapterError => {
    const failure = canonicalFailure('malformed_response', {
      gateway: SETTLEMENT_GATEWAY,
      provider: adapterKey,
      detail: `${where} ${problem}`,
    });
    return new SettlementAdapterError(
      failure,
      `the ${adapterKey} settlement provider response is malformed: ${where} ${problem}`,
    );
  };
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  const requireObject = (value: unknown, where: string): Record<string, unknown> => {
    if (!isPlainObject(value)) throw malformed(where, 'must be an object');
    return value;
  };
  const requireString = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 255) {
      throw malformed(where, 'must be a non-empty string of at most 255 characters');
    }
    return value.trim();
  };
  const requireNonNegativeInteger = (value: unknown, where: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw malformed(where, 'must be a non-negative integer');
    }
    return value;
  };
  const requireIsoInstant = (value: unknown, where: string): string => {
    const text = requireString(value, where);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(text) ||
      Number.isNaN(Date.parse(text))
    ) {
      throw malformed(where, `must be a strict ISO 8601 timestamp (got '${text}')`);
    }
    return text;
  };
  return { requireObject, requireString, requireNonNegativeInteger, requireIsoInstant, malformed };
}
