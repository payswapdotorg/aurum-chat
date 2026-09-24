// Unit tests for the provider-sdk hot-swap evidence format (W089): the
// deterministic builder, the canonical record format, digest stability and
// tamper detection — building on the llm module's hot-swap verification
// precedent (same-request digest, differing targets, deterministic
// structural comparison).

import { describe, expect, it } from 'vitest';
import {
  buildHotSwapEvidence,
  canonicalRequestDigest,
  stableCanonicalJson,
  validateHotSwapEvidenceRecord,
} from '../contract';
import { ProviderSdkError } from '../errors';

const EXECUTED_AT = '2026-09-23T12:00:00.000Z';

const BASE_INPUT = {
  gateway: 'llm',
  capability: 'text-generation',
  providerA: { provider: 'openai', target: 'gpt-4o', resultKind: 'completed' as const },
  providerB: { provider: 'anthropic', target: 'claude-sonnet-4-5', resultKind: 'completed' as const },
  outcome: 'equivalent' as const,
  evidenceId: '0192f0a1-0000-7000-8000-000000000001',
  executedAt: EXECUTED_AT,
};

describe('provider-sdk evidence — stable serialization and digest', () => {
  it('serializes objects deterministically regardless of key order', () => {
    const left = { b: 1, a: { d: [3, 2], c: 'x' } };
    const right = { a: { c: 'x', d: [3, 2] }, b: 1 };
    expect(stableCanonicalJson(left)).toBe(stableCanonicalJson(right));
    expect(stableCanonicalJson(left)).toBe('{"a":{"c":"x","d":[3,2]},"b":1}');
  });

  it('digests the same canonical request to the same SHA-256 hex', () => {
    const request = { capability: 'text-generation', messages: [{ role: 'user', content: 'hi' }] };
    const first = canonicalRequestDigest(request);
    const second = canonicalRequestDigest({ messages: [{ content: 'hi', role: 'user' }], capability: 'text-generation' });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    // A different request digests differently.
    expect(canonicalRequestDigest({ ...request, messages: [] })).not.toBe(first);
  });
});

describe('provider-sdk evidence — the builder', () => {
  it('builds a canonical record from a gateway-computed digest', () => {
    const record = buildHotSwapEvidence({
      ...BASE_INPUT,
      requestDigest: 'a'.repeat(64),
      note: 'seeded equivalence',
    });
    expect(record).toEqual({
      sdk: 'provider-hot-swap-evidence',
      evidenceVersion: 1,
      gateway: 'llm',
      capability: 'text-generation',
      requestDigest: 'a'.repeat(64),
      providerA: { provider: 'openai', target: 'gpt-4o', resultKind: 'completed' },
      providerB: { provider: 'anthropic', target: 'claude-sonnet-4-5', resultKind: 'completed' },
      outcome: 'equivalent',
      comparison: 'deterministic-structural',
      evidenceId: '0192f0a1-0000-7000-8000-000000000001',
      executedAt: EXECUTED_AT,
      note: 'seeded equivalence',
    });
    expect(validateHotSwapEvidenceRecord(record)).toEqual([]);
  });

  it('computes the digest over the canonical request when none is supplied', () => {
    const canonicalRequest = { messages: [{ role: 'user', content: 'same request' }] };
    const record = buildHotSwapEvidence({ ...BASE_INPUT, canonicalRequest });
    expect(record.requestDigest).toBe(canonicalRequestDigest(canonicalRequest));
    expect(validateHotSwapEvidenceRecord(record)).toEqual([]);
  });

  it('is deterministic: identical inputs produce identical records', () => {
    const first = buildHotSwapEvidence({ ...BASE_INPUT, requestDigest: 'b'.repeat(64) });
    const second = buildHotSwapEvidence({ ...BASE_INPUT, requestDigest: 'b'.repeat(64) });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('carries failures on either side without inventing an outcome', () => {
    const record = buildHotSwapEvidence({
      ...BASE_INPUT,
      providerB: { provider: 'anthropic', target: 'claude-sonnet-4-5', resultKind: 'failed' },
      outcome: 'failed',
      requestDigest: 'c'.repeat(64),
    });
    expect(record.providerB.resultKind).toBe('failed');
    expect(record.outcome).toBe('failed');
    expect(validateHotSwapEvidenceRecord(record)).toEqual([]);
  });

  it('rejects malformed inputs loudly', () => {
    // No digest source at all.
    expect(() => buildHotSwapEvidence(BASE_INPUT)).toThrowError(ProviderSdkError);
    // Bad digest.
    expect(() => buildHotSwapEvidence({ ...BASE_INPUT, requestDigest: 'not-hex' })).toThrowError(
      /requestDigest/,
    );
    // Identical swap targets.
    expect(() =>
      buildHotSwapEvidence({
        ...BASE_INPUT,
        providerB: BASE_INPUT.providerA,
        requestDigest: 'd'.repeat(64),
      }),
    ).toThrowError(/differ/);
    // Bad timestamp / empty ids.
    expect(() =>
      buildHotSwapEvidence({ ...BASE_INPUT, executedAt: 'yesterday', requestDigest: 'e'.repeat(64) }),
    ).toThrowError(/executedAt/);
    expect(() =>
      buildHotSwapEvidence({ ...BASE_INPUT, evidenceId: '  ', requestDigest: 'f'.repeat(64) }),
    ).toThrowError(/evidenceId/);
    // Oversized note.
    expect(() =>
      buildHotSwapEvidence({ ...BASE_INPUT, note: 'x'.repeat(501), requestDigest: '0'.repeat(64) }),
    ).toThrowError(/note/);
  });
});

describe('provider-sdk evidence — the validator', () => {
  const valid = () => buildHotSwapEvidence({ ...BASE_INPUT, requestDigest: '1'.repeat(64) });

  it('accepts the builder output (build → validate roundtrip)', () => {
    expect(validateHotSwapEvidenceRecord(valid())).toEqual([]);
  });

  it('accepts every canonical outcome and both result kinds', () => {
    for (const outcome of ['equivalent', 'completed-divergent', 'failed'] as const) {
      const record = buildHotSwapEvidence({ ...BASE_INPUT, outcome, requestDigest: '2'.repeat(64) });
      expect(validateHotSwapEvidenceRecord(record)).toEqual([]);
    }
    const withNullTarget = buildHotSwapEvidence({
      ...BASE_INPUT,
      providerA: { provider: 'peer', target: null, resultKind: 'failed' },
      requestDigest: '3'.repeat(64),
    });
    expect(validateHotSwapEvidenceRecord(withNullTarget)).toEqual([]);
  });

  it('detects tampering with every canonical field', () => {
    const cases: ReadonlyArray<[string, (record: ReturnType<typeof valid>) => unknown]> = [
      ['sdk', (r) => ({ ...r, sdk: 'someone-elses-evidence' })],
      ['evidenceVersion', (r) => ({ ...r, evidenceVersion: 2 })],
      ['gateway', (r) => ({ ...r, gateway: '' })],
      ['capability', (r) => ({ ...r, capability: 7 })],
      ['requestDigest', (r) => ({ ...r, requestDigest: 'zz' })],
      ['providerA shape', (r) => ({ ...r, providerA: { provider: '' } })],
      ['resultKind', (r) => ({ ...r, providerB: { ...r.providerB, resultKind: 'maybe' } })],
      ['same targets', (r) => ({ ...r, providerB: r.providerA })],
      ['outcome', (r) => ({ ...r, outcome: 'probably-fine' })],
      ['comparison', (r) => ({ ...r, comparison: 'semantic-and-authoritative' })],
      ['executedAt', (r) => ({ ...r, executedAt: '2026-09-23' })],
      ['note', (r) => ({ ...r, note: 42 })],
    ];
    for (const [label, tamper] of cases) {
      const issues = validateHotSwapEvidenceRecord(tamper(valid()));
      expect(issues.length, `tampering with ${label} must be detected`).toBeGreaterThan(0);
    }
  });

  it('rejects non-objects outright', () => {
    expect(validateHotSwapEvidenceRecord(null)).toEqual(['the record must be an object']);
    expect(validateHotSwapEvidenceRecord('nope')).toEqual(['the record must be an object']);
    expect(validateHotSwapEvidenceRecord([])).toEqual(['the record must be an object']);
  });
});
