// Unit tests for the context module's PURE layers: the fingerprint
// derivation (derivation.ts) and the input validation (validation.ts). No
// database, no cross-module reads.
//
// The load-bearing proofs:
//   * THE NULL-SIGNAL LAW — absent dimensions are absent (null), never
//     faked; a zero-observation derivation is VALID and produces a
//     fingerprint that knows nothing but its goal/task/evidence;
//   * purity — same inputs produce deep-equal fingerprints and the inputs
//     are never mutated;
//   * the summary — headline composition from KNOWN dimensions only, the
//     known/absent report complete and disjoint, the null signal visible;
//   * validation — every frozen dimension shape enforced, no rule that
//     could pressure a caller into fabricating context.

import { describe, expect, it } from 'vitest';
import {
  MAX_HEADLINE_CHARS,
  absentDimensionKeys,
  deriveFingerprint,
  durationHeadlinePhrase,
  knownDimensionKeys,
  staffingHeadlinePhrase,
  summarizeFingerprint,
  type FingerprintDerivationSeed,
} from '../derivation';
import { validateDerivationInput } from '../validation';
import { ContextError } from '../errors';
import type { ContextFingerprint, ContextObservationsInput } from '../types';

const SEED: FingerprintDerivationSeed = {
  fingerprintId: '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f',
  tenantId: '11111111-1111-4111-8111-111111111111',
  goalId: '22222222-2222-4222-8222-222222222222',
  task: { title: 'Roof rebuild', kind: 'build' },
  derivedFrom: ['evidence-1', 'evidence-2'],
  derivedAt: '2026-10-06T12:00:00.000Z',
};

const FULL_OBSERVATIONS: ContextObservationsInput = {
  season: { window: 'spring', note: 'clear weather forecast' },
  duration: { durationClass: 'short', estimatedSpan: '~6 weeks' },
  staffing: {
    headcount: 6,
    experienceMix: { novice: 5, intermediate: 0, expert: 1 },
    note: 'seasonal hires',
  },
  workload: 'heavy',
  capabilities: { available: ['scaffolding'], missing: ['crane'] },
  environment: { factors: ['windy-site'] },
  constraints: {
    budgetNote: 'fixed price',
    slaNote: null,
    qualityTarget: 'code-compliant',
    riskTolerance: 'risk-averse',
    verificationRequirements: ['engineer-signoff'],
  },
  evidenceFreshness: { maxEvidenceAge: '48h', criticalFreshSurfaces: ['weather'] },
  additionalSignals: { region: 'north-coast' },
};

describe('the pure fingerprint derivation (W134)', () => {
  it('derives a full fingerprint from all-known observations', () => {
    const fingerprint = deriveFingerprint(SEED, FULL_OBSERVATIONS);
    expect(fingerprint.fingerprintId).toBe(SEED.fingerprintId);
    expect(fingerprint.tenantId).toBe(SEED.tenantId);
    expect(fingerprint.goalId).toBe(SEED.goalId);
    expect(fingerprint.task).toEqual({ title: 'Roof rebuild', kind: 'build' });
    expect(fingerprint.season).toEqual({ window: 'spring', note: 'clear weather forecast' });
    expect(fingerprint.duration).toEqual({ durationClass: 'short', estimatedSpan: '~6 weeks' });
    expect(fingerprint.staffing?.experienceMix).toEqual({ novice: 5, intermediate: 0, expert: 1 });
    expect(fingerprint.workload).toBe('heavy');
    expect(fingerprint.capabilities).toEqual({ available: ['scaffolding'], missing: ['crane'] });
    expect(fingerprint.environment).toEqual({ factors: ['windy-site'] });
    expect(fingerprint.constraints?.riskTolerance).toBe('risk-averse');
    expect(fingerprint.evidenceFreshness).toEqual({ maxEvidenceAge: '48h', criticalFreshSurfaces: ['weather'] });
    expect(fingerprint.additionalSignals).toEqual({ region: 'north-coast' });
    expect(fingerprint.derivedFrom).toEqual(['evidence-1', 'evidence-2']);
    expect(fingerprint.derivedAt).toBe('2026-10-06T12:00:00.000Z');
  });

  it('NULL-SIGNAL LAW: absent dimensions stay null, never faked', () => {
    const fingerprint = deriveFingerprint(SEED, {});
    expect(fingerprint.season).toBeNull();
    expect(fingerprint.duration).toBeNull();
    expect(fingerprint.staffing).toBeNull();
    expect(fingerprint.workload).toBeNull();
    expect(fingerprint.capabilities).toBeNull();
    expect(fingerprint.environment).toBeNull();
    expect(fingerprint.constraints).toBeNull();
    expect(fingerprint.evidenceFreshness).toBeNull();
    expect(fingerprint.additionalSignals).toEqual({});
    expect(fingerprint.task).toEqual({ title: 'Roof rebuild', kind: 'build' });
  });

  it('treats explicit null dimensions identically to absent ones', () => {
    const explicitNulls: ContextObservationsInput = {
      season: null,
      duration: null,
      staffing: null,
      workload: null,
      capabilities: null,
      environment: null,
      constraints: null,
      evidenceFreshness: null,
      additionalSignals: undefined,
    };
    const fromNulls = deriveFingerprint(SEED, explicitNulls);
    const fromNothing = deriveFingerprint(SEED, undefined);
    expect(fromNulls).toEqual(fromNothing);
  });

  it('is pure: identical inputs produce deep-equal fingerprints', () => {
    const first = deriveFingerprint(SEED, FULL_OBSERVATIONS);
    const second = deriveFingerprint(SEED, FULL_OBSERVATIONS);
    expect(first).toEqual(second);
  });

  it('is pure: the inputs are never mutated', () => {
    const observations: ContextObservationsInput = JSON.parse(JSON.stringify(FULL_OBSERVATIONS));
    const seed: FingerprintDerivationSeed = { ...SEED, derivedFrom: [...SEED.derivedFrom] };
    deriveFingerprint(seed, observations);
    expect(observations).toEqual(FULL_OBSERVATIONS);
    expect(seed.derivedFrom).toEqual(['evidence-1', 'evidence-2']);
  });

  it('defensively copies derivedFrom and additionalSignals (no shared references)', () => {
    const derivedFrom = ['evidence-1'];
    const additionalSignals = { region: 'north-coast' };
    const fingerprint = deriveFingerprint(
      { ...SEED, derivedFrom },
      { additionalSignals },
    );
    derivedFrom.push('evidence-2');
    additionalSignals.region = 'mutated';
    expect(fingerprint.derivedFrom).toEqual(['evidence-1']);
    expect(fingerprint.additionalSignals).toEqual({ region: 'north-coast' });
  });

  it('carries a null task when the task was unknown (null-signal law)', () => {
    const fingerprint = deriveFingerprint({ ...SEED, task: null }, {});
    expect(fingerprint.task).toBeNull();
  });
});

describe('the fingerprint summary (null signal made visible)', () => {
  it('composes the headline from known dimensions in canonical order', () => {
    const fingerprint = deriveFingerprint(SEED, FULL_OBSERVATIONS);
    const summary = summarizeFingerprint(fingerprint);
    // season · task.kind · duration · staffing · workload · riskTolerance · environment · signals
    expect(summary.headline).toBe(
      'spring · build · ~6 weeks · novice-heavy crew · heavy workload · risk-averse · windy-site · +1 signal',
    );
  });

  it('reports known and absent dimensions completely and disjointly', () => {
    const fingerprint = deriveFingerprint(SEED, FULL_OBSERVATIONS);
    const summary = summarizeFingerprint(fingerprint);
    expect(summary.knownDimensions).toEqual([
      'season',
      'duration',
      'staffing',
      'workload',
      'capabilities',
      'environment',
      'constraints',
      'evidenceFreshness',
    ]);
    expect(summary.absentDimensions).toEqual([]);
    expect(knownDimensionKeys(fingerprint)).toEqual(summary.knownDimensions);
    expect(absentDimensionKeys(fingerprint)).toEqual([]);
  });

  it('makes the null signal visible when nothing is known', () => {
    const fingerprint = deriveFingerprint({ ...SEED, task: null }, {});
    const summary = summarizeFingerprint(fingerprint);
    expect(summary.headline).toBe('no known context dimensions');
    expect(summary.knownDimensions).toEqual([]);
    expect(summary.absentDimensions).toEqual([
      'season',
      'duration',
      'staffing',
      'workload',
      'capabilities',
      'environment',
      'constraints',
      'evidenceFreshness',
    ]);
  });

  it('reports partial knowledge honestly (some known, some absent)', () => {
    const fingerprint = deriveFingerprint(SEED, {
      season: { window: 'fall', note: null },
      workload: 'light',
    });
    const summary = summarizeFingerprint(fingerprint);
    expect(summary.headline).toBe('fall · build · light workload');
    expect(summary.knownDimensions).toEqual(['season', 'workload']);
    expect(summary.absentDimensions).toEqual([
      'duration',
      'staffing',
      'capabilities',
      'environment',
      'constraints',
      'evidenceFreshness',
    ]);
  });

  it('derives the staffing phrase from headcount when no experience mix is known', () => {
    expect(staffingHeadlinePhrase({ headcount: 5, experienceMix: null, note: null })).toBe(
      '5-person crew',
    );
  });

  it('breaks experience-mix ties deterministically (novice < intermediate < expert)', () => {
    expect(
      staffingHeadlinePhrase({
        headcount: 2,
        experienceMix: { novice: 1, intermediate: 1, expert: 0 },
        note: null,
      }),
    ).toBe('novice-heavy crew');
    expect(
      staffingHeadlinePhrase({
        headcount: 2,
        experienceMix: { novice: 0, intermediate: 1, expert: 1 },
        note: null,
      }),
    ).toBe('intermediate-heavy crew');
  });

  it('falls back to the duration class when no span is known', () => {
    expect(durationHeadlinePhrase({ durationClass: 'ongoing', estimatedSpan: null })).toBe(
      'ongoing',
    );
    expect(durationHeadlinePhrase({ durationClass: 'long', estimatedSpan: '~9 months' })).toBe(
      '~9 months',
    );
  });

  it('caps the headline length with an ellipsis', () => {
    const fingerprint = deriveFingerprint(SEED, {
      environment: { factors: ['a'.repeat(300)] },
    });
    const summary = summarizeFingerprint(fingerprint);
    expect(summary.headline.length).toBe(MAX_HEADLINE_CHARS);
    expect(summary.headline.endsWith('…')).toBe(true);
  });
});

describe('derivation input validation (pure)', () => {
  function expectInvalid(fn: () => unknown): ContextError {
    try {
      fn();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      return error as ContextError;
    }
  }

  it('accepts a zero-observation derivation (null-signal law at the input surface)', () => {
    const valid = validateDerivationInput({ goalId: SEED.goalId });
    expect(valid.task).toBeNull();
    expect(valid.observations.season).toBeNull();
    expect(valid.observations.additionalSignals).toEqual({});
    expect(valid.derivedFrom).toEqual([]);
  });

  it('rejects a malformed goal id', () => {
    const error = expectInvalid(() => validateDerivationInput({ goalId: 'not-a-uuid' }));
    expect(error.code).toBe('invalid_derivation_input');
  });

  it('rejects invalid enum values for the frozen vocabularies', () => {
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: { duration: { durationClass: 'tiny' as never, estimatedSpan: null } },
      }),
    );
    expectInvalid(() =>
      validateDerivationInput({ goalId: SEED.goalId, observations: { workload: 'brutal' as never } }),
    );
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: { constraints: { riskTolerance: 'yolo' } as never },
      }),
    );
  });

  it('rejects malformed staffing (headcount and experience mix)', () => {
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: { staffing: { headcount: 0, experienceMix: null, note: null } },
      }),
    );
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: {
          staffing: { headcount: null, experienceMix: { novice: 0, intermediate: 0, expert: 0 }, note: null },
        },
      }),
    );
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: {
          staffing: { headcount: null, experienceMix: { senior: 3 } as never, note: null },
        },
      }),
    );
  });

  it('rejects a capability listed as both available and missing', () => {
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: {
          capabilities: { available: ['crane'], missing: ['crane'] },
        },
      }),
    );
  });

  it('rejects dimensions stated with no content (never guess what they mean)', () => {
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: { season: { window: '', note: null } },
      }),
    );
    expectInvalid(() =>
      validateDerivationInput({ goalId: SEED.goalId, observations: { environment: { factors: [] } } }),
    );
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: { evidenceFreshness: { maxEvidenceAge: null, criticalFreshSurfaces: [] } },
      }),
    );
    expectInvalid(() => validateDerivationInput({ goalId: SEED.goalId, task: { title: null, kind: null } }));
  });

  it('rejects oversized evidence refs and malformed additional signals', () => {
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        derivedFrom: Array.from({ length: 17 }, (_, index) => `ref-${index}`),
      }),
    );
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: { additionalSignals: { 'bad key!': 'value' } },
      }),
    );
    expectInvalid(() =>
      validateDerivationInput({
        goalId: SEED.goalId,
        observations: { additionalSignals: { region: '' } },
      }),
    );
  });
});

describe('the frozen type surface stays intact (regression)', () => {
  it('still exports the W124b ContextFingerprint shape (all dimensions optional)', () => {
    const fingerprint = deriveFingerprint(SEED, {}) as ContextFingerprint;
    // Every dimension is nullable in the frozen type — the null-signal law
    // is a TYPE property, not just a runtime behavior.
    expect(Object.keys(fingerprint)).toEqual(
      expect.arrayContaining([
        'fingerprintId',
        'tenantId',
        'goalId',
        'task',
        'season',
        'duration',
        'staffing',
        'workload',
        'capabilities',
        'environment',
        'constraints',
        'evidenceFreshness',
        'additionalSignals',
        'derivedFrom',
        'derivedAt',
      ]),
    );
  });
});
