// Unit tests for the provider-sdk error normalization (W089; §9 failure
// isolation): the semantics table, the heuristic classifier, provider
// classifier precedence, and the unknown fallback. These are the
// error-mapping normalization cases the work item mandates.

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_FAILURE_SEMANTICS,
  canonicalFailure,
  canonicalFailureSemantics,
  classifyProviderErrorHeuristically,
  healthImpactForCategory,
  isCanonicalErrorCategory,
  normalizeProviderError,
  recoveryForCategory,
  retryAfterMsFrom,
  safeErrorDetail,
} from '../contract';
import { ProviderSdkError } from '../errors';
import type { CanonicalErrorCategory } from '../types';

const CONTEXT = { gateway: 'example-gateway', provider: 'alpha' } as const;

describe('provider-sdk normalization — the canonical semantics table', () => {
  it('covers exactly the canonical vocabulary with consistent semantics', () => {
    const categories = Object.keys(CANONICAL_FAILURE_SEMANTICS).sort();
    expect(categories).toEqual([
      'auth_failure',
      'canceled',
      'invalid_request',
      'malformed_response',
      'permission_denied',
      'provider_unavailable',
      'quota_exhausted',
      'rate_limited',
      'timeout',
      'unknown_failure',
      'unsupported_capability',
    ]);
    for (const category of categories as CanonicalErrorCategory[]) {
      const row = CANONICAL_FAILURE_SEMANTICS[category];
      expect(row.category).toBe(category);
      expect(canonicalFailureSemantics(category)).toBe(row);
      expect(recoveryForCategory(category)).toBe(row.recovery);
      expect(healthImpactForCategory(category)).toBe(row.healthImpact);
      // The recovery class and the retryable flag must agree: only
      // automatic recovery may be retryable.
      expect(row.retryable).toBe(row.recovery === 'automatic');
      // The three recovery classes and health impacts all appear.
      expect(['automatic', 'operator', 'none']).toContain(row.recovery);
      expect(['degrade', 'unavailable', 'none']).toContain(row.healthImpact);
    }
  });

  it('recognizes and rejects categories', () => {
    expect(isCanonicalErrorCategory('timeout')).toBe(true);
    expect(isCanonicalErrorCategory('explode')).toBe(false);
    expect(isCanonicalErrorCategory(undefined)).toBe(false);
  });

  it('derives the full failure value from the table (callers cannot invent semantics)', () => {
    const failure = canonicalFailure('rate_limited', {
      gateway: CONTEXT.gateway,
      provider: CONTEXT.provider,
      detail: 'slow down',
      retryAfterMs: 2_500,
    });
    expect(failure).toEqual({
      category: 'rate_limited',
      retryable: true,
      recovery: 'automatic',
      healthImpact: 'degrade',
      gateway: 'example-gateway',
      provider: 'alpha',
      detail: 'slow down',
      retryAfterMs: 2_500,
    });
    // A missing retry hint is null, never invented.
    expect(
      canonicalFailure('rate_limited', { gateway: 'g', provider: 'p', detail: 'x' }).retryAfterMs,
    ).toBeNull();
  });

  it('rejects unknown categories loudly', () => {
    expect(() => canonicalFailure('explode' as CanonicalErrorCategory, { gateway: 'g', provider: 'p', detail: 'x' })).toThrowError(
      ProviderSdkError,
    );
    expect(() => canonicalFailureSemantics('explode' as CanonicalErrorCategory)).toThrowError(
      ProviderSdkError,
    );
  });

  it('bounds the safe detail text', () => {
    const long = 'x'.repeat(10_000);
    expect(safeErrorDetail(new Error(long)).length).toBeLessThanOrEqual(501);
    expect(
      canonicalFailure('timeout', { gateway: 'g', provider: 'p', detail: long }).detail.length,
    ).toBeLessThanOrEqual(501);
    expect(safeErrorDetail('plain string')).toBe('plain string');
    expect(safeErrorDetail({ json: true })).toBe('{"json":true}');
    expect(safeErrorDetail(Symbol('unserializable'))).toContain('Symbol');
  });
});

describe('provider-sdk normalization — heuristic classification', () => {
  it('classifies HTTP-ish status fields', () => {
    expect(classifyProviderErrorHeuristically({ status: 401 })).toBe('auth_failure');
    expect(classifyProviderErrorHeuristically({ statusCode: 403 })).toBe('permission_denied');
    expect(classifyProviderErrorHeuristically({ status: 408 })).toBe('timeout');
    expect(classifyProviderErrorHeuristically({ status: 429 })).toBe('rate_limited');
    expect(classifyProviderErrorHeuristically({ statusCode: 503 })).toBe('provider_unavailable');
    expect(classifyProviderErrorHeuristically({ status: 500 })).toBe('provider_unavailable');
    // Not provider failures:
    expect(classifyProviderErrorHeuristically({ status: 400 })).toBeNull();
    expect(classifyProviderErrorHeuristically({ status: 404 })).toBeNull();
  });

  it('classifies connection/timeout error codes and names', () => {
    const code = (value: string): { code: string } => ({ code: value });
    expect(classifyProviderErrorHeuristically(code('ETIMEDOUT'))).toBe('timeout');
    expect(classifyProviderErrorHeuristically(code('ECONNABORTED'))).toBe('timeout');
    expect(classifyProviderErrorHeuristically(code('ECONNREFUSED'))).toBe('provider_unavailable');
    expect(classifyProviderErrorHeuristically(code('ENOTFOUND'))).toBe('provider_unavailable');
    expect(classifyProviderErrorHeuristically(code('ECONNRESET'))).toBe('provider_unavailable');
    expect(classifyProviderErrorHeuristically(code('EPIPE'))).toBe('provider_unavailable');
    expect(classifyProviderErrorHeuristically(new Error('request timed out after 30s'))).toBe('timeout');
    expect(classifyProviderErrorHeuristically(new Error('connect ECONNREFUSED 10.0.0.1:443'))).toBe(
      'provider_unavailable',
    );
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(classifyProviderErrorHeuristically(abort)).toBe('timeout');
    const network = new Error('fetch failed');
    network.name = 'NetworkError';
    expect(classifyProviderErrorHeuristically(network)).toBe('provider_unavailable');
  });

  it('returns null for unrecognized values (never a confident guess)', () => {
    expect(classifyProviderErrorHeuristically(new Error('a novel hiccup'))).toBeNull();
    expect(classifyProviderErrorHeuristically('a string')).toBeNull();
    expect(classifyProviderErrorHeuristically({ weird: true })).toBeNull();
    expect(classifyProviderErrorHeuristically(null)).toBeNull();
    expect(classifyProviderErrorHeuristically(undefined)).toBeNull();
  });
});

describe('provider-sdk normalization — normalizeProviderError', () => {
  it('consults the provider classifier first', () => {
    const classifierCalls: unknown[] = [];
    const failure = normalizeProviderError(new Error('provider said no'), {
      ...CONTEXT,
      classify: (error) => {
        classifierCalls.push(error);
        return 'auth_failure';
      },
    });
    expect(classifierCalls).toHaveLength(1);
    expect(failure.category).toBe('auth_failure');
    expect(failure.gateway).toBe(CONTEXT.gateway);
    expect(failure.provider).toBe(CONTEXT.provider);
    expect(failure.retryable).toBe(false);
  });

  it('falls through to heuristics when the classifier declines', () => {
    const failure = normalizeProviderError(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      ...CONTEXT,
      classify: () => null,
    });
    expect(failure.category).toBe('provider_unavailable');
    expect(failure.retryable).toBe(true);
    expect(failure.recovery).toBe('automatic');
  });

  it('normalizes any garbage into the conservative unknown_failure', () => {
    for (const garbage of [new Error('novel'), 'string', { odd: 1 }, 42, null, undefined]) {
      const failure = normalizeProviderError(garbage, CONTEXT);
      expect(failure.category).toBe('unknown_failure');
      expect(failure.retryable).toBe(false);
      expect(failure.recovery).toBe('operator');
      expect(failure.healthImpact).toBe('unavailable');
    }
  });

  it('extracts a numeric retry hint when the error conveys one', () => {
    expect(retryAfterMsFrom({ retryAfterMs: 1_000 })).toBe(1_000);
    expect(retryAfterMsFrom({ retryAfter: 5_000 })).toBe(5_000);
    expect(retryAfterMsFrom({ retry_delay_ms: 250 })).toBe(250);
    expect(retryAfterMsFrom({ retryAfterMs: -5 })).toBeNull();
    expect(retryAfterMsFrom({ retryAfterMs: 'soon' })).toBeNull();
    expect(retryAfterMsFrom(new Error('no hint'))).toBeNull();
    const failure = normalizeProviderError(
      Object.assign(new Error('slow down'), { retryAfterMs: 1_234 }),
      CONTEXT,
    );
    expect(failure.category).toBe('unknown_failure');
    expect(failure.retryAfterMs).toBe(1_234);
  });

  it('keeps the taxonomy honest end to end (every category via the pipeline)', () => {
    const specimens: ReadonlyArray<[unknown, CanonicalErrorCategory]> = [
      [Object.assign(new Error('expired key'), { status: 401 }), 'auth_failure'],
      [Object.assign(new Error('missing scope'), { status: 403 }), 'permission_denied'],
      [Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 9_000 }), 'rate_limited'],
      [Object.assign(new Error('upstream down'), { status: 503 }), 'provider_unavailable'],
      [new Error('request timed out'), 'timeout'],
      [new Error('inexplicable'), 'unknown_failure'],
    ];
    for (const [error, expected] of specimens) {
      const failure = normalizeProviderError(error, CONTEXT);
      expect(failure.category).toBe(expected);
      const row = CANONICAL_FAILURE_SEMANTICS[expected];
      expect(failure.retryable).toBe(row.retryable);
      expect(failure.recovery).toBe(row.recovery);
      expect(failure.healthImpact).toBe(row.healthImpact);
      expect(failure.provider).toBe('alpha');
      expect(failure.gateway).toBe('example-gateway');
    }
  });
});
