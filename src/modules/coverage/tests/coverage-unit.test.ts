// Unit tests for the coverage module's pure logic (no database): the
// frozen §4/§5 vocabularies, input/query validation (including the
// no-credentials-in-coverage-state guard), and the W125 measurement
// model — rollup precedence, the nine separately-measured dimensions and
// gap derivation.

import { describe, expect, it } from 'vitest';
import { CoverageError } from '../errors';
import * as coverageContract from '../contract';
import {
  COVERAGE_DIMENSIONS,
  COVERAGE_SOURCE_REGISTRIES,
  COVERAGE_STATES,
  DEPTH_BASIS_TARGET,
  deriveGaps,
  derivePolicyRestrictions,
  isCoverageDimension,
  isCoverageSourceRegistry,
  isCoverageState,
  measureDimensions,
  rollupSurfaces,
  validateEvaluateSnapshotQuery,
  validateListClaimsQuery,
  validateListGapsQuery,
  validateListSnapshotsQuery,
  validateListSourcesQuery,
  validateListSurfacesQuery,
  validateRecordClaimInput,
  validateRegisterSourceInput,
  validateRegisterSurfaceInput,
} from '../validation';
import type { CoverageClaim, CoverageState } from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e90';
const UUID_C = '2d4f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e91';
const INSTANT = '2026-10-04T12:00:00.000Z';

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CoverageError);
    expect((error as CoverageError).code).toBe(code);
  }
}

function minimalSurfaceInput(): Record<string, unknown> {
  return { key: 'support-tickets', label: 'Support tickets' };
}

function minimalSourceInput(): Record<string, unknown> {
  return { registry: 'source', ref: UUID_A };
}

function minimalClaimInput(): Record<string, unknown> {
  return {
    surfaceKey: 'support-tickets',
    source: { registry: 'source', ref: UUID_A },
    observationBasis: { kind: 'observation-set', ids: [UUID_B, UUID_C] },
    state: 'COVERED',
    confidenceValue: 0.9,
    reason: 'authorized Zendesk sync within freshness policy',
  };
}

function claim(
  surfaceKey: string,
  sourceRef: string,
  state: CoverageState,
  overrides: Partial<CoverageClaim> = {},
): CoverageClaim {
  return {
    id: `claim-${surfaceKey}-${sourceRef}`,
    tenantId: 'tenant-1',
    surfaceKey,
    source: { registry: 'source', ref: sourceRef },
    observationBasis: { kind: 'observation-set', ids: [UUID_B, UUID_C], lastObservedAt: INSTANT },
    state,
    freshness: { lastUsableAt: INSTANT, policyMaxAgeSeconds: 3600 },
    confidenceValue: 0.8,
    reason: 'test claim',
    evaluatedAt: INSTANT,
    evaluatedBy: 'principal-1',
    ...overrides,
  };
}

describe('the §5 coverage-state vocabulary (frozen)', () => {
  it('is exactly the COMPANY-COVERAGE-ARCHITECTURE §5 list, in order', () => {
    expect([...COVERAGE_STATES]).toEqual([
      'COVERED',
      'PARTIAL',
      'STALE',
      'UNAVAILABLE',
      'UNAUTHORIZED',
      'EXCLUDED',
      'UNKNOWN',
    ]);
  });

  it('guards the vocabulary through the contract', () => {
    expect(coverageContract.isCoverageState('COVERED')).toBe(true);
    expect(coverageContract.isCoverageState('covered')).toBe(false);
    expect(coverageContract.isCoverageState('DISCONNECTED')).toBe(false);
    expect(isCoverageState(null)).toBe(false);
  });
});

describe('the §4 coverage-dimension vocabulary (frozen)', () => {
  it('is exactly the architecture §4 list, in order — never one percentage', () => {
    expect([...COVERAGE_DIMENSIONS]).toEqual([
      'breadth',
      'depth',
      'freshness',
      'identity-continuity',
      'provenance-completeness',
      'temporal-completeness',
      'outcome-completeness',
      'permission-completeness',
      'goal-sufficiency',
    ]);
    expect(COVERAGE_DIMENSIONS.length).toBe(9);
  });

  it('guards the vocabulary through the contract', () => {
    expect(isCoverageDimension('freshness')).toBe(true);
    expect(isCoverageDimension('happiness')).toBe(false);
    expect(isCoverageDimension(42)).toBe(false);
  });
});

describe('the §3 source-registry vocabulary', () => {
  it('is exactly the §3 registries', () => {
    expect([...COVERAGE_SOURCE_REGISTRIES]).toEqual(['source', 'channel', 'meeting', 'integration']);
    expect(isCoverageSourceRegistry('source')).toBe(true);
    expect(isCoverageSourceRegistry('provider')).toBe(false);
  });
});

describe('validateRegisterSurfaceInput', () => {
  it('accepts a minimal surface and normalizes the optionals', () => {
    const valid = validateRegisterSurfaceInput(minimalSurfaceInput());
    expect(valid).toEqual({
      key: 'support-tickets',
      label: 'Support tickets',
      description: null,
    });
  });

  it('accepts a description', () => {
    const valid = validateRegisterSurfaceInput({
      ...minimalSurfaceInput(),
      description: 'Work/support records from authorized systems',
    });
    expect(valid.description).toBe('Work/support records from authorized systems');
  });

  it('rejects unknown fields — callers cannot smuggle identity or tenancy', () => {
    for (const smuggled of ['id', 'tenantId', 'createdAt', 'evaluatedBy']) {
      expectCode('invalid_surface_input', () =>
        validateRegisterSurfaceInput({ ...minimalSurfaceInput(), [smuggled]: UUID_A }),
      );
    }
  });

  it('rejects credential-shaped fields — credentials never enter coverage state (§13)', () => {
    for (const field of ['accessToken', 'api_key', 'clientSecret', 'password', 'credential']) {
      expectCode('invalid_surface_input', () =>
        validateRegisterSurfaceInput({ ...minimalSurfaceInput(), [field]: 'x' }),
      );
    }
  });

  it('rejects bad keys, labels and descriptions', () => {
    expectCode('invalid_surface_input', () =>
      validateRegisterSurfaceInput({ ...minimalSurfaceInput(), key: 'Support Tickets' }),
    );
    expectCode('invalid_surface_input', () =>
      validateRegisterSurfaceInput({ ...minimalSurfaceInput(), key: 'x'.repeat(65) }),
    );
    expectCode('invalid_surface_input', () =>
      validateRegisterSurfaceInput({ ...minimalSurfaceInput(), label: '' }),
    );
    expectCode('invalid_surface_input', () =>
      validateRegisterSurfaceInput({ ...minimalSurfaceInput(), label: 'x'.repeat(129) }),
    );
    expectCode('invalid_surface_input', () =>
      validateRegisterSurfaceInput({ ...minimalSurfaceInput(), description: 'x'.repeat(1025) }),
    );
  });
});

describe('validateRegisterSourceInput', () => {
  it('accepts a minimal source and normalizes the optionals', () => {
    const valid = validateRegisterSourceInput(minimalSourceInput());
    expect(valid).toEqual({ registry: 'source', ref: UUID_A, label: null });
  });

  it('rejects unknown and credential-shaped fields', () => {
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({ ...minimalSourceInput(), tenantId: 't' }),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({ ...minimalSourceInput(), apiKey: 'k' }),
    );
  });

  it('rejects unknown registries and bad refs', () => {
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({ ...minimalSourceInput(), registry: 'provider' }),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({ ...minimalSourceInput(), ref: '' }),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({ ...minimalSourceInput(), ref: 'x'.repeat(257) }),
    );
  });

  it('rejects raw-credential-looking refs — opaque registry references only (§13)', () => {
    for (const ref of [
      'sk-abcdefghijklmnopqrstuvwxyz1234567890',
      'ghp_abcdefghijklmnopqrstuvwxyzabcdef123456789012',
      'xoxb-1234567890',
      'AKIAIOSFODNN7EXAMPLE',
      '-----BEGIN RSA PRIVATE KEY-----',
    ]) {
      expectCode('invalid_source_input', () =>
        validateRegisterSourceInput({ ...minimalSourceInput(), ref }),
      );
    }
  });
});

describe('validateRecordClaimInput', () => {
  it('accepts a full claim and normalizes the optionals', () => {
    const valid = validateRecordClaimInput(minimalClaimInput());
    expect(valid).toEqual({
      surfaceKey: 'support-tickets',
      sourceRegistry: 'source',
      sourceRef: UUID_A,
      basisKind: 'observation-set',
      basisIds: [UUID_B, UUID_C],
      lastObservedAt: null,
      state: 'COVERED',
      lastUsableAt: null,
      policyMaxAgeSeconds: null,
      confidenceValue: 0.9,
      reason: 'authorized Zendesk sync within freshness policy',
    });
  });

  it('accepts freshness and observation instants', () => {
    const valid = validateRecordClaimInput({
      ...minimalClaimInput(),
      observationBasis: {
        kind: 'connection-health',
        ids: [UUID_B],
        lastObservedAt: INSTANT,
      },
      freshness: { lastUsableAt: INSTANT, policyMaxAgeSeconds: 86400 },
    });
    expect(valid.lastObservedAt).toBe(INSTANT);
    expect(valid.lastUsableAt).toBe(INSTANT);
    expect(valid.policyMaxAgeSeconds).toBe(86400);
  });

  it('rejects unknown fields and credential-shaped fields at every level', () => {
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), id: UUID_A }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), evaluatedAt: INSTANT }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), apiToken: 'x' }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        source: { registry: 'source', ref: UUID_A, secret: 'x' },
      }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        observationBasis: { kind: 'observation-set', ids: [], password: 'x' },
      }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        freshness: { lastUsableAt: INSTANT, apiToken: 'x' },
      }),
    );
  });

  it('rejects bad states, confidences, reasons, bases and instants', () => {
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), state: 'DISCONNECTED' }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), confidenceValue: 1.1 }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), confidenceValue: -0.1 }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), confidenceValue: 'high' }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), reason: '' }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({ ...minimalClaimInput(), reason: 'x'.repeat(2049) }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        observationBasis: { kind: 'not a kind', ids: [] },
      }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        observationBasis: { kind: 'observation-set', ids: ['not-a-uuid'] },
      }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        observationBasis: { kind: 'observation-set', ids: [UUID_B], lastObservedAt: '2026-10-04' },
      }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        freshness: { lastUsableAt: 'yesterday', policyMaxAgeSeconds: 3600 },
      }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        freshness: { lastUsableAt: INSTANT, policyMaxAgeSeconds: 0 },
      }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        source: { registry: 'registry', ref: UUID_A },
      }),
    );
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        source: { registry: 'source', ref: 'ghp_abcdefghijklmnopqrstuvwxyzabcdef123456789012' },
      }),
    );
  });

  it('caps the basis size', () => {
    const ids = Array.from({ length: 257 }, (_unused, i) =>
      UUID_A.slice(0, 35) + i.toString(16).padStart(1, '0'),
    ).map((id) => `${id.slice(0, 35)}${UUID_A.slice(35)}`);
    expectCode('invalid_claim_input', () =>
      validateRecordClaimInput({
        ...minimalClaimInput(),
        observationBasis: { kind: 'observation-set', ids },
      }),
    );
  });
});

describe('query validators', () => {
  it('listSurfaces/listSources/listSnapshots default the limit', () => {
    expect(validateListSurfacesQuery(undefined).limit).toBe(100);
    expect(validateListSourcesQuery(null).limit).toBe(100);
    expect(validateListSnapshotsQuery(undefined).limit).toBe(100);
  });

  it('listSources validates the registry filter', () => {
    expect(validateListSourcesQuery({ registry: 'channel' }).registry).toBe('channel');
    expectCode('invalid_query', () => validateListSourcesQuery({ registry: 'provider' }));
  });

  it('listClaims validates filters and limit bounds', () => {
    const valid = validateListClaimsQuery({ surfaceKey: 'meetings', state: 'STALE', limit: 5 });
    expect(valid).toEqual({ surfaceKey: 'meetings', state: 'STALE', sourceRef: null, limit: 5 });
    expectCode('invalid_query', () => validateListClaimsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListClaimsQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListClaimsQuery({ state: 'nope' }));
    expectCode('invalid_query', () => validateListClaimsQuery({ surfaceKey: 'NOPE' }));
  });

  it('listGaps validates filters', () => {
    const valid = validateListGapsQuery({ dimension: 'freshness', material: true });
    expect(valid.dimension).toBe('freshness');
    expect(valid.material).toBe(true);
    expectCode('invalid_query', () => validateListGapsQuery({ dimension: 'happiness' }));
    expectCode('invalid_query', () => validateListGapsQuery({ material: 'yes' }));
    expectCode('invalid_query', () => validateListGapsQuery({ snapshotId: 'not-a-uuid' }));
  });

  it('evaluateSnapshot defaults to all surfaces and validates subsets', () => {
    expect(validateEvaluateSnapshotQuery(undefined).surfaceKeys).toBeNull();
    const valid = validateEvaluateSnapshotQuery({ surfaceKeys: ['meetings'] });
    expect(valid.surfaceKeys).toEqual(['meetings']);
    expectCode('invalid_query', () => validateEvaluateSnapshotQuery({ surfaceKeys: [] }));
    expectCode('invalid_query', () => validateEvaluateSnapshotQuery({ surfaceKeys: ['NOPE'] }));
    expectCode('invalid_query', () => validateEvaluateSnapshotQuery({ surfaces: [] }));
  });
});

describe('rollupSurfaces (§3 rollup, §5 precedence)', () => {
  const surfaces = [
    { key: 'support-tickets' },
    { key: 'meetings' },
    { key: 'finance' },
    { key: 'customer-interactions' },
  ];

  it('one COVERED source makes the surface COVERED (beats PARTIAL/STALE)', () => {
    const rollups = rollupSurfaces(surfaces, [
      claim('support-tickets', 'src-a', 'COVERED'),
      claim('support-tickets', 'src-b', 'PARTIAL'),
    ]);
    expect(rollups[0]!.state).toBe('COVERED');
    expect(rollups[0]!.contributingSources).toBe(2);
  });

  it('STALE beats UNAVAILABLE; nothing beats UNKNOWN', () => {
    expect(
      rollupSurfaces(surfaces, [claim('meetings', 'src-a', 'STALE'), claim('meetings', 'src-b', 'UNAVAILABLE')])[1]!
        .state,
    ).toBe('STALE');
    expect(rollupSurfaces(surfaces, [claim('meetings', 'src-a', 'UNAVAILABLE')])[1]!.state).toBe(
      'UNAVAILABLE',
    );
    expect(rollupSurfaces(surfaces, [])[1]!.state).toBe('UNKNOWN');
  });

  it('policy-only claims roll up UNKNOWN (intentional absence is not a blind spot)', () => {
    const rollups = rollupSurfaces(surfaces, [
      claim('customer-interactions', 'crm', 'UNAUTHORIZED'),
    ]);
    expect(rollups[3]!.state).toBe('UNKNOWN');
    expect(rollups[3]!.confidenceValue).toBe(0);
    expect(rollups[3]!.lastUsableAt).toBeNull();
  });

  it('confidence is the evidence-claim mean and lastUsableAt the maximum', () => {
    const rollups = rollupSurfaces(surfaces, [
      claim('support-tickets', 'src-a', 'COVERED', { confidenceValue: 1 }),
      claim('support-tickets', 'src-b', 'STALE', {
        confidenceValue: 0.5,
        freshness: { lastUsableAt: '2026-10-04T13:00:00.000Z', policyMaxAgeSeconds: null },
      }),
    ]);
    expect(rollups[0]!.confidenceValue).toBe(0.75);
    expect(rollups[0]!.lastUsableAt).toBe('2026-10-04T13:00:00.000Z');
  });
});

describe('measureDimensions (§4 — nine separate dimensions)', () => {
  const surfaces = [
    { key: 'support-tickets' },
    { key: 'meetings' },
    { key: 'finance' },
    { key: 'customer-interactions' },
  ];

  function measurements(claims: CoverageClaim[], sourceCount: number, referenceTime = INSTANT) {
    return measureDimensions({ surfaces, latestClaims: claims, sourceCount, referenceTime });
  }

  it('measures breadth as the represented-surface fraction', () => {
    const dims = measurements(
      [
        claim('support-tickets', 'src-a', 'COVERED'),
        claim('meetings', 'src-b', 'STALE'),
      ],
      2,
    );
    const breadth = dims[0]!;
    expect(breadth.dimension).toBe('breadth');
    expect(breadth.value).toBe(0.5);
    expect(breadth.state).toBe('PARTIAL');
  });

  it('measures depth as the normalized mean basis size (documented proxy)', () => {
    const dims = measurements(
      [
        claim('support-tickets', 'src-a', 'COVERED', {
          observationBasis: {
            kind: 'observation-set',
            ids: Array.from({ length: DEPTH_BASIS_TARGET }, () => UUID_A),
            lastObservedAt: null,
          },
        }),
        claim('meetings', 'src-b', 'PARTIAL', {
          observationBasis: { kind: 'observation-set', ids: [UUID_A], lastObservedAt: null },
        }),
      ],
      2,
    );
    const depth = dims[1]!;
    expect(depth.value).toBe(0.55); // mean(1.0, 0.1)
    expect(depth.state).toBe('PARTIAL');
    expect(depth.basis).toContain('registry proxy');
  });

  it('measures freshness only through policy-carrying claims', () => {
    const fresh = claim('support-tickets', 'src-a', 'COVERED', {
      freshness: { lastUsableAt: '2026-10-04T11:30:00.000Z', policyMaxAgeSeconds: 3600 },
    });
    const outside = claim('meetings', 'src-b', 'STALE', {
      freshness: { lastUsableAt: '2026-10-04T06:00:00.000Z', policyMaxAgeSeconds: 3600 },
    });
    const noPolicy = claim('finance', 'src-c', 'COVERED', {
      freshness: { lastUsableAt: null, policyMaxAgeSeconds: null },
    });
    const dims = measurements([fresh, outside, noPolicy], 3);
    const freshness = dims[2]!;
    expect(freshness.value).toBe(0.5);
    expect(freshness.state).toBe('PARTIAL');
    expect(freshness.basis).toContain('2 policy-carrying claims');
  });

  it('measures provenance and temporal completeness from evidence ids', () => {
    const dims = measurements(
      [
        claim('support-tickets', 'src-a', 'COVERED'),
        claim('meetings', 'src-b', 'PARTIAL', {
          observationBasis: { kind: 'observation-set', ids: [], lastObservedAt: null },
        }),
      ],
      2,
    );
    expect(dims[4]!.value).toBe(0.5); // provenance: 1 of 2 carries ids
    expect(dims[5]!.value).toBe(0.5); // temporal: 1 of 2 has >= 2 ids
  });

  it('measures permission completeness over registered sources', () => {
    const dims = measurements(
      [
        claim('support-tickets', 'src-a', 'COVERED'),
        claim('meetings', 'src-b', 'STALE'),
        claim('customer-interactions', 'crm', 'UNAUTHORIZED'),
      ],
      3,
    );
    const permission = dims[7]!;
    expect(permission.value).toBe(0.667); // 2 of 3 registered sources non-UNAUTHORIZED
    expect(permission.state).toBe('PARTIAL');
  });

  it('identity continuity, outcome completeness and goal sufficiency stay honestly UNKNOWN', () => {
    const dims = measurements(
      [claim('support-tickets', 'src-a', 'COVERED')],
      1,
    );
    const identity = dims[3]!;
    const outcome = dims[6]!;
    const goal = dims[8]!;
    for (const measurement of [identity, outcome, goal]) {
      expect(measurement.value).toBeNull();
      expect(measurement.state).toBe('UNKNOWN');
      expect(measurement.basis.length).toBeGreaterThan(0);
    }
    expect(identity.basis).toContain('W095');
    expect(outcome.basis).toContain('W040');
    expect(goal.basis).toContain('W127');
  });

  it('returns all nine dimensions in the frozen order — never one percentage', () => {
    const dims = measurements([], 0);
    expect(dims.map((d) => d.dimension)).toEqual([...COVERAGE_DIMENSIONS]);
  });

  it('measures zero and null honestly when there is nothing to measure', () => {
    const dims = measurements([], 0);
    // breadth: 0 of the 4 considered surfaces are represented — a real
    // zero, stated as PARTIAL (all expected evidence is missing).
    expect(dims[0]!.value).toBe(0);
    expect(dims[0]!.state).toBe('PARTIAL');
    expect(dims[1]!.value).toBeNull(); // depth: no evidence-bearing surface
    expect(dims[2]!.value).toBeNull(); // freshness: no policy-carrying claim
    expect(dims[7]!.value).toBeNull(); // permission: no registered source
  });
});

describe('deriveGaps (§3 — a gap is an attention input)', () => {
  it('PARTIAL and STALE produce MATERIAL gaps on their implicated dimension', () => {
    const gaps = deriveGaps([
      { surfaceKey: 'support-tickets', state: 'PARTIAL', contributingSources: 2, confidenceValue: 0.5, lastUsableAt: null },
      { surfaceKey: 'meetings', state: 'STALE', contributingSources: 1, confidenceValue: 0.8, lastUsableAt: INSTANT },
    ]);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]!).toEqual({
      surfaceKey: 'support-tickets',
      dimension: 'depth',
      state: 'PARTIAL',
      reason: 'some expected evidence exists, but material portions are missing',
      material: true,
    });
    expect(gaps[1]!.dimension).toBe('freshness');
    expect(gaps[1]!.material).toBe(true);
  });

  it('UNAVAILABLE and UNKNOWN produce immaterial breadth gaps', () => {
    const gaps = deriveGaps([
      { surfaceKey: 'finance', state: 'UNAVAILABLE', contributingSources: 1, confidenceValue: 0.3, lastUsableAt: null },
      { surfaceKey: 'crm-notes', state: 'UNKNOWN', contributingSources: 0, confidenceValue: 0, lastUsableAt: null },
    ]);
    expect(gaps).toHaveLength(2);
    expect(gaps.every((gap) => gap.dimension === 'breadth' && !gap.material)).toBe(true);
  });

  it('COVERED and policy states produce NO gaps', () => {
    const gaps = deriveGaps([
      { surfaceKey: 'support-tickets', state: 'COVERED', contributingSources: 1, confidenceValue: 0.9, lastUsableAt: INSTANT },
      { surfaceKey: 'customer-interactions', state: 'UNAUTHORIZED', contributingSources: 1, confidenceValue: 0, lastUsableAt: null },
      { surfaceKey: 'hr-records', state: 'EXCLUDED', contributingSources: 1, confidenceValue: 0, lastUsableAt: null },
    ]);
    expect(gaps).toHaveLength(0);
  });
});

describe('derivePolicyRestrictions (§5 — intentional absences, stated calmly)', () => {
  it('lists UNAUTHORIZED/EXCLUDED claims once per surface+state, never COVERED ones', () => {
    const restrictions = derivePolicyRestrictions([
      claim('customer-interactions', 'crm', 'UNAUTHORIZED', { reason: 'CRM authorization revoked' }),
      claim('customer-interactions', 'web', 'UNAUTHORIZED', { reason: 'duplicate restriction' }),
      claim('hr-records', 'hris', 'EXCLUDED', { reason: 'policy excludes HR records' }),
      claim('support-tickets', 'zendesk', 'COVERED'),
    ]);
    expect(restrictions).toEqual([
      { surfaceKey: 'customer-interactions', note: 'CRM authorization revoked' },
      { surfaceKey: 'hr-records', note: 'policy excludes HR records' },
    ]);
  });
});
