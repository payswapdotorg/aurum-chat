// Unit tests for the W078 smoke check catalog: the invariants that keep
// the catalog and the driver from drifting (every driver verdict comes
// from a catalog lookup, and every acceptance bullet is covered).

import { describe, expect, it } from 'vitest';
import {
  W078_ACCEPTANCE_BULLETS,
  catalogConsistency,
  checksForAcceptance,
  smokeCheck,
  smokeChecks,
} from '../contract';

describe('the W078 smoke check catalog', () => {
  it('is internally consistent (unique ids, known categories/layers, full coverage)', () => {
    const consistency = catalogConsistency();
    expect(consistency.problems).toEqual([]);
    expect(consistency.ok).toBe(true);
  });

  it('declares the nine W078 acceptance bullets verbatim', () => {
    expect(W078_ACCEPTANCE_BULLETS).toHaveLength(9);
    expect(W078_ACCEPTANCE_BULLETS).toContain('sign-in/onboarding works on the hosted deployment');
    expect(W078_ACCEPTANCE_BULLETS).toContain('Chat is the primary root experience');
    expect(W078_ACCEPTANCE_BULLETS).toContain('seeded demo journeys work');
    expect(W078_ACCEPTANCE_BULLETS).toContain('browser journeys pass on production dogfood');
    expect(W078_ACCEPTANCE_BULLETS).toContain('worker/workflow retry and duplicate semantics are observed');
    expect(W078_ACCEPTANCE_BULLETS).toContain('health endpoint is green');
    expect(W078_ACCEPTANCE_BULLETS).toContain('queue depth and worker metrics are inspectable');
    expect(W078_ACCEPTANCE_BULLETS).toContain('deployment rollback is documented');
    expect(W078_ACCEPTANCE_BULLETS).toContain('environment separation is verified');
  });

  it('covers every acceptance bullet with at least one check', () => {
    for (const bullet of W078_ACCEPTANCE_BULLETS) {
      expect(checksForAcceptance(bullet).length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown check ids loudly (no silent drift)', () => {
    expect(() => smokeCheck('not-a-check')).toThrow(/unknown smoke check id/);
  });

  it('spans the three execution layers', () => {
    const layers = new Set(smokeChecks().map((check) => check.layer));
    expect([...layers].sort()).toEqual(['hosted', 'journey', 'repo']);
  });

  it('keeps the core journey matrix declared (auth, chat, seeded, worker, observability)', () => {
    const ids = new Set(smokeChecks().map((check) => check.id));
    for (const id of [
      'auth.signup',
      'auth.onboarding-company',
      'chat.turn',
      'seeded.persona-signin',
      'seeded.approval-decided',
      'worker.duplicate-acknowledged',
      'worker.dead-letter-invalid',
      'worker.not-found-consumed',
      'observability.worker-snapshot',
      'observability.metrics-advance',
      'health.green',
      'health.honest-refusal',
      'release.rollback-runbook',
      'env.demo-gate-refuses-production',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});
