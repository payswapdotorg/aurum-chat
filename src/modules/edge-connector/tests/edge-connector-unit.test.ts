// Unit tests for the edge-connector module's PURE logic (W088): the
// signed-envelope discipline (envelope.ts — the acceptance's "signed
// tenant-scoped jobs", tamper/replay rejection with machine-readable
// reasons), the honest health rendering (health.ts), the result
// normalization + secret screening (normalize.ts — "result
// normalization" + "local secret handling") and the validation guards
// (validation.ts — the open-vocabulary discipline). No database, no
// clock, no network (IMPLEMENTATION-STACK §7).

import { describe, expect, it } from 'vitest';
import {
  allowlistDigestOf,
  canonicalJson,
  envelopeDigest,
  signEnvelope,
  verifySignedEnvelope,
} from '../envelope';
import {
  DEFAULT_STALE_AFTER_MS,
  resolveAllowlistDrift,
  resolveEdgeHealth,
  resolveEdgeHealthView,
} from '../health';
import { normalizeEdgeJobResult, screenForSecrets } from '../normalize';
import {
  checkEdgeJobRequest,
  isEdgeKeyShape,
  isMachineReadableReason,
  isSystemClassShape,
  validateReportEdgeJobInput,
} from '../validation';
import { EdgeConnectorError } from '../errors';
import { createHmacSigner } from '../service';
import type { EdgeJobEnvelope } from '../types';

// Test keys/secrets are assembled from fragments at runtime (never a
// realistic full token literal in source — GitHub push protection).
const SIGNING_SECRET = ['edge-job-', 'signing-', 'secret-', 'w088'].join('');
const WRONG_SECRET = ['edge-job-', 'signing-', 'secret-', 'WRONG'].join('');

const signer = createHmacSigner({ secret: SIGNING_SECRET, keyRef: 'edge-jobs/v1' });

function envelope(overrides: Partial<EdgeJobEnvelope> = {}): EdgeJobEnvelope {
  return {
    v: 1,
    jobId: '0b7b8a44-6707-48c7-93c5-13ab1d5c0f21',
    tenantId: '1f2c3d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    edgeKey: 'acme-onprem-edge',
    systemClass: 'database',
    kind: 'execute',
    capabilityKey: 'write.customer-records',
    idempotencyKey: 'edge:test-key-001',
    request: {
      connectionId: '2b7b8a44-6707-48c7-93c5-13ab1d5c0f22',
      credentialRef: 'edge-vault://acme/db-write',
      systemKey: 'acme-onprem-crm',
      capabilityKey: 'write.customer-records',
      target: 'cust-1042',
      payload: { stage: 'onboarding-complete' },
      idempotencyKey: 'deep-action:t1:o1:execute',
    },
    submittedAt: '2026-09-24T12:00:00.000Z',
    submittedBy: 'principal-1',
    ...overrides,
  };
}

function expectInvalidInput(fn: () => unknown): EdgeConnectorError {
  try {
    fn();
    throw new Error('expected an EdgeConnectorError but the call succeeded');
  } catch (error) {
    if (!(error instanceof EdgeConnectorError)) throw error;
    return error;
  }
}

// ---------------------------------------------------------------------------
// The signed envelope
// ---------------------------------------------------------------------------

describe('canonical serialization', () => {
  it('is key-order-stable (two serializers never disagree)', () => {
    const a = { b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } };
    const b = { a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  it('drops undefined fields and keeps null explicit', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('sign/verify roundtrip (HMAC-SHA256 over canonical bytes)', () => {
  it('accepts an untampered signed envelope', () => {
    const signed = signEnvelope(envelope(), signer);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.signerKeyRef).toBe('edge-jobs/v1');
    const verdict = verifySignedEnvelope(signed, { verificationSecret: SIGNING_SECRET });
    expect(verdict).toEqual({ ok: true });
  });

  it('accepts with the expected tenant and edge scope', () => {
    const signed = signEnvelope(envelope(), signer);
    const verdict = verifySignedEnvelope(signed, {
      verificationSecret: SIGNING_SECRET,
      expectedTenantId: '1f2c3d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      expectedEdgeKey: 'acme-onprem-edge',
    });
    expect(verdict).toEqual({ ok: true });
  });
});

describe('tamper rejection (machine-readable reasons)', () => {
  it('rejects a mutated capabilityKey with bad_signature', () => {
    const signed = signEnvelope(envelope(), signer);
    const tampered = signEnvelope(envelope(), signer);
    tampered.envelope.capabilityKey = 'write.support-desk';
    expect(verifySignedEnvelope(tampered, { verificationSecret: SIGNING_SECRET })).toEqual({
      ok: false,
      reason: 'bad_signature',
      detail: expect.any(String),
    });
    expect(signed.envelope.capabilityKey).toBe('write.customer-records');
  });

  it('rejects a mutated payload with bad_signature', () => {
    const tampered = signEnvelope(envelope(), signer);
    (tampered.envelope.request as { payload: unknown }).payload = { stage: 'EXFILTRATED' };
    expect(verifySignedEnvelope(tampered, { verificationSecret: SIGNING_SECRET })).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a mutated tenantId with bad_signature (the signature covers tenancy)', () => {
    const tampered = signEnvelope(envelope(), signer);
    tampered.envelope.tenantId = '9e8d7c6b-5a4f-4c3d-2b1a-0f9e8d7c6b5a';
    expect(verifySignedEnvelope(tampered, { verificationSecret: SIGNING_SECRET })).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature minted with a different secret (bad_signature)', () => {
    const foreign = signEnvelope(envelope(), createHmacSigner({ secret: WRONG_SECRET, keyRef: 'edge-jobs/v1' }));
    expect(verifySignedEnvelope(foreign, { verificationSecret: SIGNING_SECRET })).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an unsupported envelope version before anything else', () => {
    const tampered = signEnvelope(envelope(), signer);
    (tampered.envelope as { v: number }).v = 2;
    expect(verifySignedEnvelope(tampered, { verificationSecret: SIGNING_SECRET })).toMatchObject({
      ok: false,
      reason: 'unsupported_version',
    });
  });

  it('rejects a malformed idempotency key shape (invalid_idempotency_key)', () => {
    const malformed = signEnvelope(envelope(), signer);
    malformed.envelope.idempotencyKey = 'not a valid key!';
    expect(verifySignedEnvelope(malformed, { verificationSecret: SIGNING_SECRET })).toMatchObject({
      ok: false,
      reason: 'invalid_idempotency_key',
    });
  });

  it('rejects structural garbage (invalid_envelope)', () => {
    expect(verifySignedEnvelope(null, { verificationSecret: SIGNING_SECRET })).toMatchObject({
      ok: false,
      reason: 'invalid_envelope',
    });
    expect(verifySignedEnvelope({}, { verificationSecret: SIGNING_SECRET })).toMatchObject({
      ok: false,
      reason: 'invalid_envelope',
    });
    expect(
      verifySignedEnvelope({ envelope: envelope(), signature: 'nothex', signerKeyRef: 'x' }, {
        verificationSecret: SIGNING_SECRET,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_envelope' });
  });

  it('flags a tenant mismatch with the machine-readable reason', () => {
    const signed = signEnvelope(envelope(), signer);
    const verdict = verifySignedEnvelope(signed, {
      verificationSecret: SIGNING_SECRET,
      expectedTenantId: '9e8d7c6b-5a4f-4c3d-2b1a-0f9e8d7c6b5a',
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'tenant_mismatch' });
  });

  it('flags an edge mismatch with the machine-readable reason', () => {
    const signed = signEnvelope(envelope(), signer);
    const verdict = verifySignedEnvelope(signed, {
      verificationSecret: SIGNING_SECRET,
      expectedEdgeKey: 'another-edge',
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'edge_mismatch' });
  });

  it('never places the verification secret in any rejection detail', () => {
    const tampered = signEnvelope(envelope(), signer);
    tampered.envelope.capabilityKey = 'write.support-desk';
    const verdict = verifySignedEnvelope(tampered, { verificationSecret: SIGNING_SECRET });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.detail).not.toContain(SIGNING_SECRET);
      expect(verdict.detail).not.toContain(WRONG_SECRET);
    }
  });
});

describe('envelope + allowlist digests', () => {
  it('binds the digest to the canonical envelope bytes', () => {
    const one = envelope();
    const two = envelope();
    two.request = { ...two.request } as typeof two.request;
    expect(envelopeDigest(one)).toBe(envelopeDigest(two));
    two.capabilityKey = 'write.support-desk';
    expect(envelopeDigest(one)).not.toBe(envelopeDigest(two));
  });

  it('makes the allowlist digest order-insensitive and duplicate-free', () => {
    expect(allowlistDigestOf(['a.b', 'c.d', 'e.f'])).toBe(allowlistDigestOf(['e.f', 'a.b', 'c.d']));
    expect(allowlistDigestOf(['a.b', 'a.b'])).toBe(allowlistDigestOf(['a.b']));
    expect(allowlistDigestOf(['a.b'])).not.toBe(allowlistDigestOf(['c.d']));
  });
});

// ---------------------------------------------------------------------------
// Honest health rendering
// ---------------------------------------------------------------------------

describe('edge health resolution', () => {
  const NOW = '2026-09-24T12:00:00Z';

  it('renders healthy within the staleness window', () => {
    expect(resolveEdgeHealth({ lastSeenAt: '2026-09-24T11:59:30Z', now: NOW })).toBe('healthy');
  });

  it('renders stale beyond the window', () => {
    const beyond = new Date(Date.parse(NOW) - DEFAULT_STALE_AFTER_MS - 1).toISOString();
    expect(resolveEdgeHealth({ lastSeenAt: beyond, now: NOW })).toBe('stale');
  });

  it('renders a never-seen edge stale (a silent edge is stale, honestly)', () => {
    expect(resolveEdgeHealth({ lastSeenAt: null, now: NOW })).toBe('stale');
  });

  it('surfaces allowlist drift only when something was reported', () => {
    expect(resolveAllowlistDrift('d1', null)).toBe(false);
    expect(resolveAllowlistDrift('d1', 'd1')).toBe(false);
    expect(resolveAllowlistDrift('d1', 'd2')).toBe(true);
  });

  it('assembles the honest health view', () => {
    const view = resolveEdgeHealthView({
      lastSeenAt: '2026-09-24T11:59:00Z',
      reportedVersion: '1.4.2',
      reportedAllowlistDigest: 'different-digest',
      recordedAllowlistDigest: allowlistDigestOf(['a.b']),
      now: NOW,
    });
    expect(view.status).toBe('healthy');
    expect(view.reportedVersion).toBe('1.4.2');
    expect(view.allowlistDrift).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Result normalization (provider objects never cross the edge seam)
// ---------------------------------------------------------------------------

describe('normalizeEdgeJobResult', () => {
  it('accepts a canonical inspect state', () => {
    const verdict = normalizeEdgeJobResult('inspect', { found: true, state: { stage: 'onboarding' } });
    expect(verdict).toEqual({ ok: true, result: { found: true, state: { stage: 'onboarding' } } });
  });

  it('accepts a canonical not-found state', () => {
    const verdict = normalizeEdgeJobResult('inspect', { found: false, state: null });
    expect(verdict).toEqual({ ok: true, result: { found: false, state: null } });
  });

  it('rejects a provider-native state object (a Date instance)', () => {
    const verdict = normalizeEdgeJobResult('inspect', { found: true, state: new Date() });
    expect(verdict).toEqual({ ok: false, reason: 'invalid_result' });
  });

  it('rejects extra keys (strict canonical shape)', () => {
    const verdict = normalizeEdgeJobResult('inspect', {
      found: true,
      state: {},
      nativeHandle: { confidential: true },
    });
    expect(verdict).toEqual({ ok: false, reason: 'invalid_result' });
  });

  it('rejects a non-boolean found', () => {
    expect(normalizeEdgeJobResult('inspect', { found: 'yes', state: null })).toEqual({
      ok: false,
      reason: 'invalid_result',
    });
  });

  it('accepts the three canonical receipt statuses', () => {
    for (const status of ['accepted', 'rejected', 'failed'] as const) {
      expect(
        normalizeEdgeJobResult('execute', { status, receiptId: 'rcpt-0001', detail: null }),
      ).toEqual({ ok: true, result: { status, receiptId: 'rcpt-0001', detail: null } });
    }
  });

  it('rejects a provider-native receipt object (receiptId as object)', () => {
    const verdict = normalizeEdgeJobResult('execute', {
      status: 'accepted',
      receiptId: { native: 'provider-receipt-handle' },
      detail: null,
    });
    expect(verdict).toEqual({ ok: false, reason: 'invalid_result' });
  });

  it('rejects an unknown receipt status', () => {
    expect(
      normalizeEdgeJobResult('execute', { status: 'partially-done', receiptId: null, detail: null }),
    ).toEqual({ ok: false, reason: 'invalid_result' });
  });

  it('rejects a receipt where a state was expected (kind mismatch)', () => {
    expect(
      normalizeEdgeJobResult('inspect', { status: 'accepted', receiptId: null, detail: null }),
    ).toEqual({ ok: false, reason: 'invalid_result' });
  });

  it('rejects an oversized state body', () => {
    const huge = { blob: 'x'.repeat(300_000) };
    expect(normalizeEdgeJobResult('inspect', { found: true, state: huge })).toEqual({
      ok: false,
      reason: 'invalid_result',
    });
  });
});

describe('screenForSecrets (the edge-side leak screen)', () => {
  const SECRETS = ['supersecret-db-password-42', 'another-api-key-9876'];

  it('detects a secret value embedded deep in a result', () => {
    expect(screenForSecrets({ state: { nested: { token: 'supersecret-db-password-42' } } }, SECRETS)).toBe(true);
  });

  it('passes a clean result', () => {
    expect(screenForSecrets({ state: { stage: 'onboarding' } }, SECRETS)).toBe(false);
  });

  it('ignores trivially short secrets (collision guard, honestly documented)', () => {
    expect(screenForSecrets({ state: { note: 'the word the appears here' } }, ['the'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation guards (the open-vocabulary discipline)
// ---------------------------------------------------------------------------

describe('open vocabularies (no closed CHECKs on keys/classes)', () => {
  it('accepts the first-party system classes AND arbitrary custom ones', () => {
    for (const key of ['api', 'mcp', 'openapi', 'database', 'file-share', 'browser']) {
      expect(isSystemClassShape(key)).toBe(true);
    }
    expect(isSystemClassShape('custom-vault.7')).toBe(true);
    expect(isSystemClassShape('Edge')).toBe(false);
    expect(isSystemClassShape('')).toBe(false);
    expect(isSystemClassShape('has space')).toBe(false);
  });

  it('shape-checks edge keys without closing the vocabulary', () => {
    expect(isEdgeKeyShape('acme-onprem-edge')).toBe(true);
    expect(isEdgeKeyShape('plant-2.mes')).toBe(true);
    expect(isEdgeKeyShape('NotValid')).toBe(false);
  });

  it('accepts only machine-readable reason codes', () => {
    expect(isMachineReadableReason('bad_signature')).toBe(true);
    expect(isMachineReadableReason('capability_not_allowed')).toBe(true);
    expect(isMachineReadableReason('a reason with spaces')).toBe(false);
    expect(isMachineReadableReason('A_REASON')).toBe(false);
  });
});

describe('submit-time request validation (opaque refs only)', () => {
  function executeRequest(overrides: Record<string, unknown> = {}) {
    return {
      connectionId: '2b7b8a44-6707-48c7-93c5-13ab1d5c0f22',
      credentialRef: 'edge-vault://acme/db-write',
      systemKey: 'acme-onprem-crm',
      capabilityKey: 'write.customer-records',
      target: 'cust-1042',
      payload: { stage: 'onboarding-complete' },
      idempotencyKey: 'deep-action:t1:o1:execute',
      ...overrides,
    };
  }

  it('accepts the canonical execute request', () => {
    expect(() => checkEdgeJobRequest('execute', executeRequest())).not.toThrow();
  });

  it('accepts the canonical inspect request', () => {
    expect(() =>
      checkEdgeJobRequest('inspect', {
        connectionId: '2b7b8a44-6707-48c7-93c5-13ab1d5c0f22',
        credentialRef: 'edge-vault://acme/db-read',
        systemKey: 'acme-onprem-crm',
        capabilityKey: 'read.customer-records',
        target: 'cust-1042',
        idempotencyKey: 'deep-action:t1:o1:inspect',
      }),
    ).not.toThrow();
  });

  it('rejects unknown keys (nothing smuggles through)', () => {
    const error = expectInvalidInput(() =>
      checkEdgeJobRequest('execute', executeRequest({ extra: 'field' })),
    );
    expect(error.code).toBe('invalid_input');
  });

  it('rejects a payload on an inspect request', () => {
    const error = expectInvalidInput(() =>
      checkEdgeJobRequest('inspect', executeRequest()),
    );
    expect(error.code).toBe('invalid_input');
  });

  it('rejects a non-object payload (provider objects never ride a request)', () => {
    const error = expectInvalidInput(() =>
      checkEdgeJobRequest('execute', executeRequest({ payload: new Date() })),
    );
    expect(error.code).toBe('invalid_input');
  });

  it('rejects a credential VALUE where an opaque reference belongs', () => {
    const error = expectInvalidInput(() =>
      checkEdgeJobRequest('execute', executeRequest({ credentialRef: 'password=hunter2;X' })),
    );
    expect(error.code).toBe('invalid_input');
  });
});

describe('report-time outcome validation', () => {
  function reportInput(overrides: Record<string, unknown> = {}) {
    return {
      edgeKey: 'acme-onprem-edge',
      edgeToken: 'edge-token-aaaaaaaaaaaa',
      jobId: '0b7b8a44-6707-48c7-93c5-13ab1d5c0f21',
      executedEnvelopeDigest: 'a'.repeat(64),
      outcome: { kind: 'failed', reason: 'executor_error' },
      ...overrides,
    };
  }

  it('accepts a machine-readable failure outcome', () => {
    expect(() => validateReportEdgeJobInput(reportInput())).not.toThrow();
  });

  it('rejects a free-text reason (a secret VALUE can never ride it either)', () => {
    const error = expectInvalidInput(() =>
      validateReportEdgeJobInput(
        reportInput({ outcome: { kind: 'failed', reason: 'password is supersecret-db-password-42' } }),
      ),
    );
    expect(error.code).toBe('invalid_input');
  });

  it('rejects a mixed outcome (reason on a result)', () => {
    const error = expectInvalidInput(() =>
      validateReportEdgeJobInput(
        reportInput({ outcome: { kind: 'result', result: { found: true, state: null }, reason: 'x' } }),
      ),
    );
    expect(error.code).toBe('invalid_input');
  });

  it('rejects a non-hex envelope digest', () => {
    const error = expectInvalidInput(() =>
      validateReportEdgeJobInput(reportInput({ executedEnvelopeDigest: 'not-a-digest' })),
    );
    expect(error.code).toBe('invalid_input');
  });
});
