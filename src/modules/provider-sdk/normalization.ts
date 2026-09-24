// Canonical error normalization (W089; handoff §9 failure isolation: "The
// adapter converts provider-specific failure into canonical capability/
// error state").
//
// One table — CANONICAL_FAILURE_SEMANTICS — is the single source of truth
// binding every CanonicalErrorCategory to its retryable/recovery/
// health-impact semantics. Adapters classify provider-native errors via a
// small provider-specific classifier and fall through to the SDK's
// conservative heuristics; the result is always a CanonicalProviderFailure
// that carries NO provider-native object (only safe, bounded detail text).
//
// Pure: no database, no clock, no network.

import { ProviderSdkError } from './errors';
import type {
  CanonicalErrorCategory,
  CanonicalFailureRecovery,
  CanonicalFailureSemantics,
  CanonicalHealthImpact,
  CanonicalProviderFailure,
  ProviderErrorClassifier,
} from './types';

// ---------------------------------------------------------------------------
// The semantics table (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Rationale per category (reviewed against the llm module's execution-path
// discipline — any failed provider interaction cools the target down):
 *
 *   auth_failure          operator · unavailable — every request fails until
 *                          credentials are rotated; stop routing there.
 *   permission_denied     operator · unavailable — scopes/entitlement must be
 *                          re-granted.
 *   quota_exhausted       operator · unavailable — period/budget exhaustion
 *                          does not heal within a retry window.
 *   rate_limited          automatic · degraded — the provider is up; back
 *                          off and retry (retryAfterMs when conveyed).
 *   provider_unavailable  automatic · unavailable — outage/5xx/refused; cool
 *                          down and fail over (the llm precedent).
 *   timeout               automatic · degraded — one timed-out request does
 *                          not prove an outage; retry with caution.
 *   malformed_response    operator · degraded — adapter/provider contract
 *                          drift; investigate, but a single malformed
 *                          response is not proof of an outage.
 *   unsupported_capability none · none — a capability-level fact about the
 *                          provider, not a health event.
 *   invalid_request       none · none — the caller must fix the request.
 *   canceled              none · none — not a provider failure at all.
 *   unknown_failure       operator · unavailable — unclassifiable failures
 *                          are treated conservatively (route elsewhere until
 *                          investigated), mirroring the llm module's
 *                          any-failure cooldown.
 */
export const CANONICAL_FAILURE_SEMANTICS: Readonly<
  Record<CanonicalErrorCategory, CanonicalFailureSemantics>
> = {
  auth_failure: { category: 'auth_failure', retryable: false, recovery: 'operator', healthImpact: 'unavailable' },
  permission_denied: { category: 'permission_denied', retryable: false, recovery: 'operator', healthImpact: 'unavailable' },
  quota_exhausted: { category: 'quota_exhausted', retryable: false, recovery: 'operator', healthImpact: 'unavailable' },
  rate_limited: { category: 'rate_limited', retryable: true, recovery: 'automatic', healthImpact: 'degrade' },
  provider_unavailable: { category: 'provider_unavailable', retryable: true, recovery: 'automatic', healthImpact: 'unavailable' },
  timeout: { category: 'timeout', retryable: true, recovery: 'automatic', healthImpact: 'degrade' },
  malformed_response: { category: 'malformed_response', retryable: false, recovery: 'operator', healthImpact: 'degrade' },
  unsupported_capability: { category: 'unsupported_capability', retryable: false, recovery: 'none', healthImpact: 'none' },
  invalid_request: { category: 'invalid_request', retryable: false, recovery: 'none', healthImpact: 'none' },
  canceled: { category: 'canceled', retryable: false, recovery: 'none', healthImpact: 'none' },
  unknown_failure: { category: 'unknown_failure', retryable: false, recovery: 'operator', healthImpact: 'unavailable' },
};

export function isCanonicalErrorCategory(value: unknown): value is CanonicalErrorCategory {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(CANONICAL_FAILURE_SEMANTICS, value)
  );
}

/** The semantics row of one category (throws on an unknown category). */
export function canonicalFailureSemantics(category: CanonicalErrorCategory): CanonicalFailureSemantics {
  const row = CANONICAL_FAILURE_SEMANTICS[category];
  if (row === undefined) {
    throw new ProviderSdkError(
      'invalid_definition',
      `unknown canonical error category '${String(category)}'`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// The canonical failure value
// ---------------------------------------------------------------------------

export interface CanonicalFailureContext {
  readonly gateway: string;
  readonly provider: string;
  /** Provider-specific classifier consulted before the SDK heuristics. */
  readonly classify?: ProviderErrorClassifier | null;
}

const MAX_DETAIL_LENGTH = 500;

/** Bounded, safe detail text for a failure (never a credential value). */
export function safeErrorDetail(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = `${error.name}: ${error.message}`;
  else if (typeof error === 'string') text = error;
  else {
    try {
      text = JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }
  if (text.length > MAX_DETAIL_LENGTH) text = `${text.slice(0, MAX_DETAIL_LENGTH)}…`;
  return text;
}

/** Extract a numeric retry hint (milliseconds) when the error conveys one. */
export function retryAfterMsFrom(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null;
  const record = error as Record<string, unknown>;
  for (const field of ['retryAfterMs', 'retryAfter', 'retry_delay_ms']) {
    const value = record[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

/**
 * Build the canonical failure for a category. The retryable/recovery/
 * health-impact triplet is DERIVED from the semantics table — callers can
 * never invent inconsistent semantics.
 */
export function canonicalFailure(
  category: CanonicalErrorCategory,
  context: { gateway: string; provider: string; detail: string; retryAfterMs?: number | null },
): CanonicalProviderFailure {
  if (!isCanonicalErrorCategory(category)) {
    throw new ProviderSdkError('invalid_definition', `unknown canonical error category '${String(category)}'`);
  }
  const semantics = canonicalFailureSemantics(category);
  let detail = context.detail;
  if (detail.length > MAX_DETAIL_LENGTH) detail = `${detail.slice(0, MAX_DETAIL_LENGTH)}…`;
  return {
    category: semantics.category,
    retryable: semantics.retryable,
    recovery: semantics.recovery,
    healthImpact: semantics.healthImpact,
    gateway: context.gateway,
    provider: context.provider,
    detail,
    retryAfterMs: context.retryAfterMs ?? null,
  };
}

// ---------------------------------------------------------------------------
// Heuristic classification (the conservative default)
// ---------------------------------------------------------------------------

/**
 * Inspect an unknown error for well-known provider-failure signals. Never
 * guesses confidently: anything unrecognized returns null (→ unknown_failure).
 */
export function classifyProviderErrorHeuristically(error: unknown): CanonicalErrorCategory | null {
  if (error === null || error === undefined) return null;

  const name = error instanceof Error ? error.name : null;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;

  // Well-known error names.
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (name === 'NetworkError') return 'provider_unavailable';

  // Node/system error codes (ECONNREFUSED & friends), on the error or in the message.
  const code =
    error !== null && typeof error === 'object' ? (error as Record<string, unknown>)['code'] : undefined;
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'timeout';
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'EAI_AGAIN'
  ) {
    return 'provider_unavailable';
  }
  if (message !== null) {
    if (/\bETIMEDOUT\b|\btimed out\b/i.test(message)) return 'timeout';
    if (/\bECONNREFUSED\b|\bECONNRESET\b|\bENOTFOUND\b/i.test(message)) return 'provider_unavailable';
  }

  // HTTP-ish status fields.
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const raw = record['status'] ?? record['statusCode'] ?? record['httpStatus'];
    if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
      if (raw === 401) return 'auth_failure';
      if (raw === 403) return 'permission_denied';
      if (raw === 408) return 'timeout';
      if (raw === 429) return 'rate_limited';
      if (raw >= 500) return 'provider_unavailable';
    }
  }
  return null;
}

/**
 * Normalize ANY thrown value into the canonical failure taxonomy:
 *   1. the provider-specific classifier (when it recognizes the error);
 *   2. the SDK's conservative heuristics;
 *   3. unknown_failure (conservative: operator recovery, unavailable impact).
 */
export function normalizeProviderError(
  error: unknown,
  context: CanonicalFailureContext,
): CanonicalProviderFailure {
  let category: CanonicalErrorCategory | null = null;
  if (context.classify !== undefined && context.classify !== null) {
    category = context.classify(error);
  }
  if (category === null) category = classifyProviderErrorHeuristically(error);
  if (category === null) category = 'unknown_failure';
  return canonicalFailure(category, {
    gateway: context.gateway,
    provider: context.provider,
    detail: safeErrorDetail(error),
    retryAfterMs: retryAfterMsFrom(error),
  });
}

/** Convenience: the recovery class of a category (from the table). */
export function recoveryForCategory(category: CanonicalErrorCategory): CanonicalFailureRecovery {
  return canonicalFailureSemantics(category).recovery;
}

/** Convenience: the health impact of a category (from the table). */
export function healthImpactForCategory(category: CanonicalErrorCategory): CanonicalHealthImpact {
  return canonicalFailureSemantics(category).healthImpact;
}
