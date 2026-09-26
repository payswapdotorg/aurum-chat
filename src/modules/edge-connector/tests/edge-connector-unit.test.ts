// Unit tests for the edge-connector module's PURE logic (W088): the
// signed-envelope core (envelope.ts — canonical serialization, HMAC
// signing/verification, the dial-home proof material) and the validation
// guards (validation.ts — the frozen shapes). No database, no clock, no
// network (IMPLEMENTATION-STACK §7).

import { describe, expect, it } from 'vitest';
import {
  canonicalEnvelopeMaterial,
  canonicalJson,
  createHmacSigner,
  edgeAuthMaterial,
  verifyEnvelopeSignature,
} from '../envelope';
import {
  modeOfCapabilityKey,
  readCapabilityKeyOf,
  validateEdgeJobResult,
  validateIssueEdgeJobInput,
  validateRegisterEdgeRuntimeInput,
  validateVerifyEdgeJobEnvelopeInput,
} from '../validation';
import { EdgeConnectorError } from '../errors';
import type { EdgeJobEnvelope } from '../types';

// Fake key material assembled from fragments at runtime (never a
// realistic full token literal in source — the house push-protection
// discipline).
const KEY_MATERIAL = ['edge-enroll-', 'unit', '-k088'].join('');
const OTHER_KEY_MATERIAL = ['edge-enroll-', 'other', '-k088'].join('');

const signer = createHmacSigner({
  secretKeys: { 'key-2026-a': KEY_MATERIAL, 'key-2026-b': OTHER_KEY_MATERIAL },
});

const ENVELOPE: EdgeJobEnvelope = {
  jobId: '0b7b8a44-6707-48c7-93c5-13ab1d5c0f21',
  keyId: 'key-2026-a',
  tenantId: '1c8d9e55-1234-4c7a-9a0e-6f21a3b7c100',
  edgeId: '2d9eaf66-4321-4d8b-8b1f-7031b4c8d200',
  kind: 'execute',
  capabilityKey: 'write.customer-records',
  target: 'cust-1042',
  payload: { stage: 'onboarding-complete' },
  credentialRef: 'edge-vault://crm-write',
  systemKey: 'crm',
  nonce: '3eaf61b7-8765-4d9c-9c2a-8142c5d9e300',
  issuedAt: '2026-09-26T12:00:00.000Z',
  expiresAt: '2026-09-26T12:05:00.000Z',
};

function expectCode(code: EdgeConnectorError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected EdgeConnectorError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof EdgeConnectorError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// canonicalJson — the deterministic signed form
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('sorts object keys at every depth and drops insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 4, y: 5 }] } })).toBe(
      '{"a":{"c":[3,{"y":5,"z":4}],"d":2},"b":1}',
    );
  });

  it('is stable under parse→canonicalize round-trips', () => {
    const value = { payload: { stage: 'x', nested: { b: [1, 2], a: true } }, n: null };
    const once = canonicalJson(value);
    expect(canonicalJson(JSON.parse(once))).toBe(once);
  });

  it('preserves array order (order is meaning) and handles primitives', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// The signer + envelope signatures
// ---------------------------------------------------------------------------

describe('createHmacSigner + verifyEnvelopeSignature', () => {
  it('signs and verifies the canonical envelope material under the right key id', () => {
    const signature = signer.sign('key-2026-a', canonicalEnvelopeMaterial(ENVELOPE));
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyEnvelopeSignature(ENVELOPE, signature, signer)).toBe(true);
  });

  it('refuses a signature computed under a different key id (enrollment keys are per-edge)', () => {
    const wrongKey = signer.sign('key-2026-b', canonicalEnvelopeMaterial(ENVELOPE));
    expect(verifyEnvelopeSignature(ENVELOPE, wrongKey, signer)).toBe(false);
  });

  it('refuses a tampered envelope (any field change breaks the signature)', () => {
    const signature = signer.sign('key-2026-a', canonicalEnvelopeMaterial(ENVELOPE));
    const tampered: EdgeJobEnvelope = { ...ENVELOPE, target: 'cust-9999' };
    expect(verifyEnvelopeSignature(tampered, signature, signer)).toBe(false);
    const tamperedNonce: EdgeJobEnvelope = { ...ENVELOPE, nonce: '4faf61b7-8765-4d9c-9c2a-8142c5d9e301' };
    expect(verifyEnvelopeSignature(tamperedNonce, signature, signer)).toBe(false);
  });

  it('returns false for an unknown key id (never throws, never leaks which side failed)', () => {
    const outsider = createHmacSigner({ secretKeys: { 'key-unknown': 'nope' } });
    const signature = signer.sign('key-2026-a', canonicalEnvelopeMaterial(ENVELOPE));
    expect(verifyEnvelopeSignature(ENVELOPE, signature, outsider)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The dial-home proof material
// ---------------------------------------------------------------------------

describe('edgeAuthMaterial', () => {
  it('binds the proof to purpose, tenant, edge AND request nonce', () => {
    const base = {
      tenantId: ENVELOPE.tenantId,
      edgeId: ENVELOPE.edgeId,
      requestNonce: 'req-0001',
    };
    const material = edgeAuthMaterial('pull', base);
    expect(material).toBe(
      `edge-auth:v1:pull:${ENVELOPE.tenantId}:${ENVELOPE.edgeId}:req-0001`,
    );
    // Every dimension matters: cross-purpose, cross-tenant, cross-edge and
    // cross-nonce proofs are different material by construction.
    expect(edgeAuthMaterial('submit', base)).not.toBe(material);
    expect(
      edgeAuthMaterial('pull', { ...base, tenantId: 'other' }),
    ).not.toBe(material);
    expect(edgeAuthMaterial('pull', { ...base, edgeId: 'other' })).not.toBe(material);
    expect(
      edgeAuthMaterial('pull', { ...base, requestNonce: 'req-0002' }),
    ).not.toBe(material);
  });
});

// ---------------------------------------------------------------------------
// Validation guards
// ---------------------------------------------------------------------------

describe('validateRegisterEdgeRuntimeInput', () => {
  const GOOD = {
    name: 'Factory floor edge',
    description: 'Serves the on-prem MES',
    signingKeyId: 'key-2026-a',
    connectivity: ['private-api', 'database'],
    allowlist: [
      {
        capabilityKey: 'read.mes-orders',
        mode: 'read',
        connectivity: 'database',
        secretRef: 'edge-vault://mes-read',
        secretScopes: ['mes.orders.read'],
      },
      {
        capabilityKey: 'write.mes-orders',
        mode: 'write',
        connectivity: 'database',
        secretRef: 'edge-vault://mes-write',
        secretScopes: ['mes.orders.write'],
      },
    ],
    staleAfterSeconds: 120,
  };

  it('accepts a well-formed enrollment and applies defaults', () => {
    const valid = validateRegisterEdgeRuntimeInput(GOOD);
    expect(valid.heartbeatIntervalSeconds).toBe(60);
    expect(valid.allowlist).toHaveLength(2);
  });

  it('refuses allowlist entries whose connectivity the runtime does not declare', () => {
    expectCode(
      'invalid_input',
      () =>
        validateRegisterEdgeRuntimeInput({
          ...GOOD,
          connectivity: ['private-api'],
        }),
    );
  });

  it('refuses mode/prefix mismatches, duplicate keys and unknown fields', () => {
    expectCode(
      'invalid_input',
      () =>
        validateRegisterEdgeRuntimeInput({
          ...GOOD,
          allowlist: [
            {
              capabilityKey: 'read.mes-orders',
              mode: 'write',
              connectivity: 'database',
              secretRef: 'x',
              secretScopes: [],
            },
          ],
        }),
    );
    expectCode(
      'invalid_input',
      () =>
        validateRegisterEdgeRuntimeInput({
          ...GOOD,
          allowlist: [...GOOD.allowlist, GOOD.allowlist[0]!],
        }),
    );
    expectCode('invalid_input', () =>
      validateRegisterEdgeRuntimeInput({ ...GOOD, extra: 'nope' }),
    );
  });

  it('refuses a capability key outside the read./write. vocabulary', () => {
    expectCode(
      'invalid_input',
      () =>
        validateRegisterEdgeRuntimeInput({
          ...GOOD,
          allowlist: [
            {
              capabilityKey: 'admin.mes-orders',
              mode: 'read',
              connectivity: 'database',
              secretRef: 'x',
              secretScopes: [],
            },
          ],
        }),
    );
  });
});

describe('validateIssueEdgeJobInput', () => {
  it('enforces the kind/mode vocabulary (inspect reads, execute writes)', () => {
    expectCode('invalid_input', () =>
      validateIssueEdgeJobInput({
        edgeId: ENVELOPE.edgeId,
        kind: 'inspect',
        capabilityKey: 'write.customer-records',
        target: 'cust-1',
      }),
    );
    expectCode('invalid_input', () =>
      validateIssueEdgeJobInput({
        edgeId: ENVELOPE.edgeId,
        kind: 'execute',
        capabilityKey: 'read.customer-records',
        target: 'cust-1',
        payload: { a: 1 },
      }),
    );
  });

  it('inspect jobs carry no payload; execute jobs require one', () => {
    expectCode('invalid_input', () =>
      validateIssueEdgeJobInput({
        edgeId: ENVELOPE.edgeId,
        kind: 'inspect',
        capabilityKey: 'read.customer-records',
        target: 'cust-1',
        payload: { a: 1 },
      }),
    );
    expectCode('invalid_input', () =>
      validateIssueEdgeJobInput({
        edgeId: ENVELOPE.edgeId,
        kind: 'execute',
        capabilityKey: 'write.customer-records',
        target: 'cust-1',
      }),
    );
    const good = validateIssueEdgeJobInput({
      edgeId: ENVELOPE.edgeId,
      kind: 'execute',
      capabilityKey: 'write.customer-records',
      target: 'cust-1',
      payload: { stage: 'done' },
      ttlSeconds: 60,
    });
    expect(good.ttlSeconds).toBe(60);
  });
});

describe('validateEdgeJobResult', () => {
  it('requires the normalized read state on an accepted inspect result', () => {
    expectCode('invalid_input', () =>
      validateEdgeJobResult(
        { receipt: { status: 'accepted', receiptId: 'r-1', detail: null } },
        'inspect',
      ),
    );
    const good = validateEdgeJobResult(
      {
        receipt: { status: 'accepted', receiptId: 'r-1', detail: null },
        state: { found: true, state: { stage: 'x' } },
      },
      'inspect',
    );
    expect(good.state?.found).toBe(true);
  });

  it('refuses unknown receipt statuses (the W084 taxonomy is closed)', () => {
    expectCode('invalid_input', () =>
      validateEdgeJobResult(
        { receipt: { status: 'maybe', receiptId: null, detail: null } },
        'execute',
      ),
    );
  });
});

describe('validateVerifyEdgeJobEnvelopeInput', () => {
  it('validates the envelope shape, key ordering rules and expiry ordering', () => {
    const signature = 'a'.repeat(64);
    const valid = validateVerifyEdgeJobEnvelopeInput({
      envelope: { ...ENVELOPE, payload: null, kind: 'inspect' as const, capabilityKey: 'read.customer-records' },
      signature,
    });
    expect(valid.envelope.envelope.jobId).toBe(ENVELOPE.jobId);
  });

  it('refuses non-hex signatures, unknown fields and inverted expiry', () => {
    expectCode('invalid_envelope', () =>
      validateVerifyEdgeJobEnvelopeInput({ envelope: ENVELOPE, signature: 'zz' }),
    );
    expectCode('invalid_envelope', () =>
      validateVerifyEdgeJobEnvelopeInput({
        envelope: { ...ENVELOPE, sneaky: 1 },
        signature: 'a'.repeat(64),
      }),
    );
    expectCode('invalid_envelope', () =>
      validateVerifyEdgeJobEnvelopeInput({
        envelope: {
          ...ENVELOPE,
          issuedAt: '2026-09-26T12:05:00.000Z',
          expiresAt: '2026-09-26T12:00:00.000Z',
        },
        signature: 'a'.repeat(64),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Capability vocabulary helpers
// ---------------------------------------------------------------------------

describe('capability key helpers', () => {
  it('derives mode from the prefix and pairs read/write keys of a class', () => {
    expect(modeOfCapabilityKey('read.customer-records')).toBe('read');
    expect(modeOfCapabilityKey('write.customer-records')).toBe('write');
    expect(readCapabilityKeyOf('write.customer-records')).toBe('read.customer-records');
    expect(readCapabilityKeyOf('read.customer-records')).toBe('read.customer-records');
  });
});
