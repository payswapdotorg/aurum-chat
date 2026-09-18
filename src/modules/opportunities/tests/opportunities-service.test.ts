// Integration tests for the opportunities module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W015
// acceptance: "Convert external/internal signals into evidence-backed
// opportunities with estimated value, confidence, affected goals and
// required capabilities."
//
//  * THE GOLDEN CONVERSION: observations + claims (seeded through the
//    W004/W007 contracts) + a goal (W008) + the impact-analysis judgment
//    convert into an evidence-backed opportunity with the exact derived
//    confidence (weakest evidence + corroboration, capped), the confidence
//    SNAPSHOT, the affected-goal label snapshotted from the goal's title,
//    the opaque capability/world references carried verbatim, the
//    recommended next action, the estimated value and the audit quartet —
//    all minted by the system, none caller-forgeable.
//  * THE POLICY GATE: below-confidence, below-value and currency-mismatch
//    candidates are RECORDED with deterministic reasons and produce no
//    opportunities; the run's counts and the snapshotted policy make the
//    decisions reconstructable.
//  * DUPLICATE DETECTION: a second conversion citing the exact same signal
//    set is recorded 'duplicate' pointing at the live opportunity — across
//    runs AND within one run — while a dismissed opportunity does NOT block
//    re-conversion of the same signals (a returning judgment is a NEW
//    record; re-analysis of a live one is a revision).
//  * VERSIONED/AUDITABLE: revisions append the next full-snapshot version
//    (evidence re-validated, confidence re-derived); expectedVersion
//    guards refuse stale writers; lifecycle transitions are surgical
//    (open→pursued terminal, open→dismissed, dismissed→open reactivation);
//    the storage layer rejects UPDATE/DELETE/TRUNCATE on versions, runs
//    and candidates and DELETE/TRUNCATE on identities outright (triggers) —
//    while the identity's version POINTER may still advance.
//  * CROSS-MODULE REFERENCE VALIDATION: missing, foreign-tenant and
//    principal-restricted evidence, foreign goals and foreign executions
//    are uniformly invalid_* (no existence leak); the 'cognitive-execution'
//    trigger requires and validates the loop linkage (W013).
//  * TENANT ISOLATION (ADR-0001) across every surface: foreign-tenant
//    opportunities, versions, runs and candidates read as missing; foreign
//    evidence never enters a conversion.
//  * THE MANAGEMENT LISTINGS: current views filtered by status, signal
//    origin, minimum confidence, affected goal, required capability, world
//    entity and title search (escaped), newest first; the run feed filtered
//    by trigger kind and originating execution with disposition counts.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { startExecution } from '@/modules/cognition/contract';
import { recordClaim } from '@/modules/epistemics/contract';
import { createGoal } from '@/modules/goals/contract';
import { recordObservation } from '@/modules/observations/contract';
import { OpportunitiesError } from '../errors';
import * as opportunitiesContract from '../contract';
import type {
  ConversionRun,
  Opportunity,
  SignalCandidateInput,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  convertSignals,
  getConversionCandidate,
  getConversionRun,
  getOpportunity,
  getOpportunityVersion,
  listConversionRuns,
  listOpportunities,
  listOpportunityVersions,
  reviseOpportunity,
} = opportunitiesContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantA = newId(); // the golden conversion (the main flow)
const tenantB = newId(); // the other tenant (isolation checks)
const tenantGate = newId(); // the policy gate
const tenantDup = newId(); // duplicate detection
const tenantVersioned = newId(); // versioning / audit / conflicts
const tenantRefs = newId(); // cross-module reference validation
const tenantList = newId(); // management listings
const tenantRuns = newId(); // run feed listings

function member(tenantId: string, principal = newId()): TenantContext {
  return { tenantId, principalId: principal, authority: [] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(OpportunitiesError);
    expect((error as OpportunitiesError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Seeding helpers (through the sibling CONTRACTS, never their tables)
// ---------------------------------------------------------------------------

function iso(minutes: number): string {
  return new Date(Date.parse('2026-09-14T08:00:00Z') + minutes * 60_000).toISOString();
}

async function seedObservation(
  ctx: TenantContext,
  input: { kind?: string; confidence: number; minutes: number; visibility?: 'tenant' | 'principal' },
): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: input.kind ?? 'market.signal',
    payload: { note: `signal @ ${input.minutes}` },
    observedAt: iso(input.minutes),
    source: { kind: 'source', label: 'test-harness' },
    channel: 'ingestion',
    confidence: { value: input.confidence, method: 'test' },
    permissions:
      input.visibility === undefined
        ? undefined
        : { visibility: input.visibility, principalId: input.visibility === 'principal' ? ctx.principalId : null },
  });
  return observation.id;
}

async function seedClaim(
  ctx: TenantContext,
  input: { proposition: string; confidence: number; observationIds: string[] },
): Promise<string> {
  const claim = await recordClaim(ctx, {
    proposition: input.proposition,
    confidence: { value: input.confidence, method: 'test' },
    evidenceObservationIds: input.observationIds,
  });
  return claim.id;
}

async function seedGoal(ctx: TenantContext, title: string): Promise<string> {
  const goal = await createGoal(ctx, {
    title,
    objective: `Achieve ${title}`,
    desiredState: `${title} is achieved`,
    horizonEnd: iso(60 * 24 * 90),
    owner: { kind: 'person', label: 'the board' },
    priority: 'high',
    successCriteria: 'The metric says so',
    actor: { kind: 'person', label: 'the ceo' },
  });
  return goal.id;
}

/** A minimal well-formed candidate (override what each test cares about). */
function candi(overrides: Partial<SignalCandidateInput> = {}): SignalCandidateInput {
  return {
    title: 'Expand document processing into DACH',
    description: 'External signals show unserved demand for German-language document processing.',
    signalOrigin: 'external',
    evidence: { observationIds: [], claimIds: [] },
    estimatedValue: { amount: 250_000_00, currency: 'EUR' },
    affectedGoals: [],
    requiredCapabilities: [],
    worldEntities: [],
    recommendedNextAction: { kind: 'recommend', statement: 'Put the DACH expansion on the board agenda.' },
    ...overrides,
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The golden conversion
// ---------------------------------------------------------------------------

describe('convertSignals — the golden conversion', () => {
  const ctx = member(tenantA);
  let obs1: string;
  let obs2: string;
  let claim1: string;
  let goal1: string;
  let run: ConversionRun;
  let opportunity: Opportunity;

  beforeAll(async () => {
    obs1 = await seedObservation(ctx, { confidence: 0.7, minutes: 1 });
    obs2 = await seedObservation(ctx, { confidence: 0.8, minutes: 2 });
    claim1 = await seedClaim(ctx, {
      proposition: 'DACH-region RFP volume is growing quarter over quarter',
      confidence: 0.6,
      observationIds: [obs1],
    });
    goal1 = await seedGoal(ctx, 'Grow EU revenue');
    run = await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      policy: { minConfidence: 0.5, minValue: { amount: 100_000_00, currency: 'EUR' } },
      candidates: [
        candi({
          evidence: { observationIds: [obs2, obs1], claimIds: [claim1] },
          affectedGoals: [{ goalId: goal1 }],
          requiredCapabilities: [{ capabilityId: newId(), label: 'German-language document processing' }],
          worldEntities: [{ entityId: newId(), label: 'DACH market' }],
        }),
      ],
      actor: { kind: 'system', id: 'cognition-worker' },
      rationale: 'integration fixture',
    });
    opportunity = await getOpportunity(ctx, run.candidates[0]!.createdOpportunityId!);
  });

  it('converts the candidate and records the run counts', () => {
    expect(run.counts).toEqual({ converted: 1, belowThreshold: 0, currencyMismatch: 0, duplicate: 0 });
    expect(run.triggerKind).toBe('manual');
    expect(run.policy).toEqual({ minConfidence: 0.5, minValue: { amount: 100_000_00, currency: 'EUR' } });
    expect(run.rationale).toBe('integration fixture');
    expect(run.changedByPrincipal).toBe(ctx.principalId);
  });

  it('records the decided candidate with the created link and no reason', () => {
    const candidate = run.candidates[0]!;
    expect(candidate.disposition).toBe('converted');
    expect(candidate.createdOpportunityId).toBe(opportunity.id);
    expect(candidate.existingOpportunityId).toBeNull();
    expect(candidate.reason).toBeNull();
    expect(candidate.title).toBe('Expand document processing into DACH');
    expect(candidate.estimatedValue).toEqual({ amount: 250_000_00, currency: 'EUR' });
  });

  it('creates the opportunity at version 1, status open, change kind created', () => {
    expect(opportunity.version).toBe(1);
    expect(opportunity.tenantId).toBe(tenantA);
    expect(opportunity.lastChange.kind).toBe('created');
    expect(opportunity.lastChange.actor).toEqual({ kind: 'system', id: 'cognition-worker', label: null });
    expect(opportunity.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(opportunity.lastChange.rationale).toBe('integration fixture');
    expect(opportunity.content.status).toBe('open');
    expect(opportunity.content.signalOrigin).toBe('external');
  });

  it('derives the confidence from the cited evidence (weakest + corroboration)', () => {
    // weakest = 0.6 (the claim); support = 3 → 0.6 + 2 × 0.05 = 0.7.
    expect(opportunity.content.confidence).toBe(0.7);
    expect(opportunity.content.evidence.support).toBe(3);
  });

  it('snapshots each cited reference and its confidence on the version', () => {
    const snapshot = opportunity.content.evidence.confidences;
    expect(snapshot).toHaveLength(3);
    const byId = new Map(snapshot.map((entry) => [entry.id, entry]));
    expect(byId.get(obs1)).toMatchObject({ kind: 'observation', value: 0.7 });
    expect(byId.get(obs2)).toMatchObject({ kind: 'observation', value: 0.8 });
    expect(byId.get(claim1)).toMatchObject({ kind: 'claim', value: 0.6 });
  });

  it('carries the goal reference with the title snapshotted as the label', () => {
    expect(opportunity.content.affectedGoals).toEqual([{ goalId: goal1, label: 'Grow EU revenue' }]);
  });

  it('carries the opaque capability and world references verbatim', () => {
    expect(opportunity.content.requiredCapabilities[0]!.label).toBe('German-language document processing');
    expect(opportunity.content.worldEntities[0]!.label).toBe('DACH market');
  });

  it('carries the estimated value and the recommended next action', () => {
    expect(opportunity.content.estimatedValue).toEqual({ amount: 250_000_00, currency: 'EUR' });
    expect(opportunity.content.recommendedNextAction).toEqual({
      kind: 'recommend',
      statement: 'Put the DACH expansion on the board agenda.',
    });
  });

  it('records the deterministic evidence fingerprint on the version', () => {
    expect(opportunity.evidenceFingerprint).toBe(`obs:${[obs1, obs2].sort().join(',')}|claims:${claim1}`);
  });

  it('serves the audit deep-links (run, candidate, version)', async () => {
    const deepRun = await getConversionRun(ctx, { runId: run.id });
    expect(deepRun.candidates).toHaveLength(1);
    expect(deepRun.candidates[0]!.id).toBe(run.candidates[0]!.id);
    const deepCandidate = await getConversionCandidate(ctx, { candidateId: run.candidates[0]!.id });
    expect(deepCandidate.runId).toBe(run.id);
    const version = await getOpportunityVersion(ctx, { opportunityId: opportunity.id, version: 1 });
    expect(version.changeKind).toBe('created');
    expect(version.content.evidence.observationIds).toEqual([obs1, obs2].sort());
  });
});

// ---------------------------------------------------------------------------
// The recordability policy gate
// ---------------------------------------------------------------------------

describe('convertSignals — the policy gate', () => {
  const ctx = member(tenantGate);
  let run: ConversionRun;

  beforeAll(async () => {
    const strong = await seedObservation(ctx, { confidence: 0.9, minutes: 1 });
    const weak = await seedObservation(ctx, { confidence: 0.2, minutes: 2 });
    run = await convertSignals(ctx, {
      trigger: { kind: 'scheduled' },
      policy: { minConfidence: 0.5, minValue: { amount: 100_000_00, currency: 'EUR' } },
      candidates: [
        candi({ title: 'Strong signal, good value', evidence: { observationIds: [strong] } }),
        candi({ title: 'Weak evidence', evidence: { observationIds: [weak] } }),
        candi({
          title: 'Strong signal, small value',
          evidence: { observationIds: [strong] },
          estimatedValue: { amount: 50_000_00, currency: 'EUR' },
        }),
        candi({
          title: 'Strong signal, foreign currency',
          evidence: { observationIds: [strong] },
          estimatedValue: { amount: 500_000_00, currency: 'USD' },
        }),
      ],
      actor: { kind: 'system', label: 'scheduler' },
    });
  });

  it('decides every candidate deterministically and counts the dispositions', () => {
    expect(run.counts).toEqual({ converted: 1, belowThreshold: 2, currencyMismatch: 1, duplicate: 0 });
    const [kept, weak, small, foreign] = run.candidates;
    expect(kept!.disposition).toBe('converted');
    expect(weak!.disposition).toBe('below_threshold');
    expect(weak!.reason).toContain('confidence');
    expect(weak!.confidence).toBe(0.2);
    expect(small!.disposition).toBe('below_threshold');
    expect(small!.reason).toContain('value');
    expect(foreign!.disposition).toBe('currency_mismatch');
    expect(foreign!.reason).toContain('EUR');
    expect(foreign!.reason).toContain('USD');
  });

  it('records the proposed judgment on non-converted candidates (the audit of what was considered)', () => {
    const weak = run.candidates[1]!;
    expect(weak.title).toBe('Weak evidence');
    expect(weak.signalOrigin).toBe('external');
    expect(weak.recommendedNextAction.kind).toBe('recommend');
  });

  it('creates exactly one opportunity (the eligible candidate)', async () => {
    const opportunities = await listOpportunities(ctx, { limit: 500 });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]!.content.title).toBe('Strong signal, good value');
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection (continuous conversion does not spam)
// ---------------------------------------------------------------------------

describe('convertSignals — duplicate detection', () => {
  const ctx = member(tenantDup);
  let obs1: string;
  let obs2: string;
  let first: ConversionRun;
  let second: ConversionRun;
  let inRun: ConversionRun;
  let afterDismissal: ConversionRun;

  beforeAll(async () => {
    obs1 = await seedObservation(ctx, { confidence: 0.9, minutes: 1 });
    obs2 = await seedObservation(ctx, { confidence: 0.9, minutes: 2 });

    first = await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      candidates: [candi({ title: 'First analysis', evidence: { observationIds: [obs1, obs2] } })],
      actor: { kind: 'person', label: 'analyst' },
    });

    second = await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      candidates: [candi({ title: 'Re-analysis of the same signals', evidence: { observationIds: [obs1, obs2] } })],
      actor: { kind: 'person', label: 'analyst' },
    });

    inRun = await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      // A fresh signal set so the first candidate converts fresh...
      candidates: [
        candi({ title: 'Twin A', evidence: { observationIds: [obs1] } }),
        // ...and its exact twin within the SAME run is a duplicate.
        candi({ title: 'Twin B', evidence: { observationIds: [obs1] } }),
      ],
      actor: { kind: 'person', label: 'analyst' },
    });

    // Dismiss the first opportunity, then convert the same signals again:
    // a dismissed record does not block a returning judgment.
    const firstId = first.candidates[0]!.createdOpportunityId!;
    await reviseOpportunity(ctx, {
      opportunityId: firstId,
      status: 'dismissed',
      rationale: 'not worth pursuing',
      actor: { kind: 'person', label: 'the ceo' },
    });
    afterDismissal = await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      candidates: [candi({ title: 'Return of the signal', evidence: { observationIds: [obs1, obs2] } })],
      actor: { kind: 'person', label: 'analyst' },
    });
  });

  it('converts the first analysis', () => {
    expect(first.counts.converted).toBe(1);
    expect(first.counts.duplicate).toBe(0);
  });

  it('records a later conversion of the exact signal set as a duplicate pointing at the live record', () => {
    expect(second.counts).toEqual({ converted: 0, belowThreshold: 0, currencyMismatch: 0, duplicate: 1 });
    const duplicate = second.candidates[0]!;
    expect(duplicate.existingOpportunityId).toBe(first.candidates[0]!.createdOpportunityId);
    expect(duplicate.createdOpportunityId).toBeNull();
    expect(duplicate.reason).toContain('already carried by live opportunity');
  });

  it('detects duplicates WITHIN one run (the second twin points at the first)', () => {
    expect(inRun.counts).toEqual({ converted: 1, belowThreshold: 0, currencyMismatch: 0, duplicate: 1 });
    expect(inRun.candidates[0]!.disposition).toBe('converted');
    expect(inRun.candidates[1]!.disposition).toBe('duplicate');
    expect(inRun.candidates[1]!.existingOpportunityId).toBe(inRun.candidates[0]!.createdOpportunityId);
  });

  it('re-converts the same signals after the live record was dismissed', () => {
    expect(afterDismissal.counts.converted).toBe(1);
    expect(afterDismissal.counts.duplicate).toBe(0);
    expect(afterDismissal.candidates[0]!.createdOpportunityId).not.toBe(
      first.candidates[0]!.createdOpportunityId,
    );
  });

  it('still sees exactly the distinct live records it created', async () => {
    // first (dismissed) + twin A + the returned one = 3 identities; the
    // duplicate twins never became records.
    const all = await listOpportunities(ctx, { limit: 500 });
    expect(all).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Versioning, revisions, lifecycle and optimistic concurrency
// ---------------------------------------------------------------------------

describe('reviseOpportunity — versioned understanding', () => {
  const ctx = member(tenantVersioned);
  let obs1: string;
  let obs2: string;
  let obs3: string;
  let opportunity: Opportunity;

  beforeAll(async () => {
    obs1 = await seedObservation(ctx, { confidence: 0.6, minutes: 1 });
    obs2 = await seedObservation(ctx, { confidence: 0.6, minutes: 2 });
    obs3 = await seedObservation(ctx, { confidence: 0.9, minutes: 3 });
    const run = await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      candidates: [candi({ evidence: { observationIds: [obs1] } })],
      actor: { kind: 'system', label: 'harness' },
    });
    opportunity = await getOpportunity(ctx, run.candidates[0]!.createdOpportunityId!);
  });

  it('revises the content and re-derives the confidence from the new evidence set', async () => {
    const revised = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      title: 'Expand document processing into DACH and Benelux',
      evidence: { observationIds: [obs1, obs2, obs3] },
      estimatedValue: { amount: 400_000_00, currency: 'EUR' },
      actor: { kind: 'person', label: 'analyst' },
      rationale: 'two more corroborating signals arrived',
      expectedVersion: 1,
    });
    expect(revised.version).toBe(2);
    expect(revised.lastChange.kind).toBe('revised');
    expect(revised.lastChange.rationale).toBe('two more corroborating signals arrived');
    expect(revised.content.title).toBe('Expand document processing into DACH and Benelux');
    // weakest = 0.6, support = 3 → 0.6 + 2 × 0.05 = 0.7 (re-derived, not carried).
    expect(revised.content.confidence).toBe(0.7);
    expect(revised.content.estimatedValue).toEqual({ amount: 400_000_00, currency: 'EUR' });
    // carried over unchanged (the patch omitted them)
    expect(revised.content.recommendedNextAction.statement).toBe(
      'Put the DACH expansion on the board agenda.',
    );
    opportunity = revised;
  });

  it('keeps the full append-only history listable and deep-linkable', async () => {
    const history = await listOpportunityVersions(ctx, { opportunityId: opportunity.id });
    expect(history.map((version) => version.version)).toEqual([1, 2]);
    expect(history[0]!.content.title).toBe('Expand document processing into DACH');
    const v1 = await getOpportunityVersion(ctx, { opportunityId: opportunity.id, version: 1 });
    expect(v1.content.confidence).toBe(0.6);
    expect(v1.content.evidence.support).toBe(1);
  });

  it('refuses a stale expectedVersion (optimistic concurrency)', async () => {
    await expectCode('opportunity_conflict', () =>
      reviseOpportunity(ctx, {
        opportunityId: opportunity.id,
        title: 'A stale writer',
        expectedVersion: 1,
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });

  it('refuses a revision that changes nothing', async () => {
    await expectCode('invalid_revision_input', () =>
      reviseOpportunity(ctx, {
        opportunityId: opportunity.id,
        expectedVersion: 2,
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });

  it('refuses a content revision on a dismissed opportunity', async () => {
    const run2 = await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      candidates: [candi({ title: 'Second opportunity', evidence: { observationIds: [obs3] } })],
      actor: { kind: 'system', label: 'harness' },
    });
    const secondId = run2.candidates[0]!.createdOpportunityId!;
    await reviseOpportunity(ctx, {
      opportunityId: secondId,
      status: 'dismissed',
      rationale: 'superseded',
      actor: { kind: 'person', label: 'the ceo' },
    });
    await expectCode('invalid_revision_input', () =>
      reviseOpportunity(ctx, {
        opportunityId: secondId,
        title: 'No content on a dismissed record',
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
    // ...but reactivation works, and is its own surgical change kind.
    const reactivated = await reviseOpportunity(ctx, {
      opportunityId: secondId,
      status: 'open',
      actor: { kind: 'person', label: 'the ceo' },
    });
    expect(reactivated.lastChange.kind).toBe('reactivated');
    expect(reactivated.content.status).toBe('open');
  });

  it('pursues surgically and makes the record terminal', async () => {
    const pursued = await reviseOpportunity(ctx, {
      opportunityId: opportunity.id,
      status: 'pursued',
      rationale: 'board approved the expansion',
      actor: { kind: 'person', label: 'the ceo' },
    });
    expect(pursued.lastChange.kind).toBe('pursued');
    expect(pursued.content.status).toBe('pursued');
    expect(pursued.version).toBe(3);

    await expectCode('invalid_revision_input', () =>
      reviseOpportunity(ctx, {
        opportunityId: opportunity.id,
        title: 'No content on a pursued record',
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
    await expectCode('invalid_revision_input', () =>
      reviseOpportunity(ctx, {
        opportunityId: opportunity.id,
        status: 'dismissed',
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
    await expectCode('invalid_revision_input', () =>
      reviseOpportunity(ctx, {
        opportunityId: opportunity.id,
        status: 'open',
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });

  it('rejects storage-level mutation of the audit trail outright (triggers)', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE opportunity_versions SET title = 'forged' WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM opportunity_versions WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`TRUNCATE opportunity_versions`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM opportunities WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrow(/erased/);
    await expect(
      db.query(`UPDATE opportunity_conversion_runs SET rationale = 'forged' WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM opportunity_conversion_candidates WHERE tenant_id = $1`, [tenantVersioned]),
    ).rejects.toThrow(/append-only/);
    // The identity's version POINTER may still advance — that is its only job.
    const stillThere = await getOpportunity(ctx, opportunity.id);
    expect(stillThere.version).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Cross-module reference validation (uniform invalid_*, no existence leak)
// ---------------------------------------------------------------------------

describe('convertSignals — cross-module reference validation', () => {
  const ctx = member(tenantRefs);
  const foreignCtx = member(newId());
  let obs1: string;
  let foreignObs: string;
  let foreignClaim: string;
  let foreignGoal: string;
  let foreignExecution: string;
  let validExecution: string;

  beforeAll(async () => {
    obs1 = await seedObservation(ctx, { confidence: 0.9, minutes: 1 });
    foreignObs = await seedObservation(foreignCtx, { confidence: 0.9, minutes: 1 });
    foreignClaim = await seedClaim(foreignCtx, {
      proposition: 'a foreign tenant claim',
      confidence: 0.9,
      observationIds: [foreignObs],
    });
    foreignGoal = await seedGoal(foreignCtx, 'Foreign goal');
    const foreignExecutionRecord = await startExecution(foreignCtx, {
      trigger: { kind: 'schedule', label: 'foreign sweep' },
      focus: { topics: ['anything'], entities: [] },
      actor: { kind: 'system', label: 'foreign worker' },
    });
    foreignExecution = foreignExecutionRecord.id;
    const validExecutionRecord = await startExecution(ctx, {
      trigger: { kind: 'schedule', label: 'nightly sweep' },
      focus: { topics: ['market'], entities: [] },
      actor: { kind: 'system', label: 'cognition worker' },
    });
    validExecution = validExecutionRecord.id;
  });

  it('refuses a missing observation reference', async () => {
    const missing = newId();
    await expectCode('invalid_evidence_ref', () =>
      convertSignals(ctx, {
        trigger: { kind: 'manual' },
        candidates: [candi({ evidence: { observationIds: [missing] } })],
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });

  it('refuses a foreign-tenant observation reference (no leak)', async () => {
    await expectCode('invalid_evidence_ref', () =>
      convertSignals(ctx, {
        trigger: { kind: 'manual' },
        candidates: [candi({ evidence: { observationIds: [foreignObs] } })],
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });

  it('refuses a principal-restricted observation of another principal', async () => {
    const otherPrincipalCtx = member(tenantRefs, newId());
    const restricted = await seedObservation(otherPrincipalCtx, {
      confidence: 0.9,
      minutes: 5,
      visibility: 'principal',
    });
    await expectCode('invalid_evidence_ref', () =>
      convertSignals(ctx, {
        trigger: { kind: 'manual' },
        candidates: [candi({ evidence: { observationIds: [restricted] } })],
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });

  it('refuses a missing claim reference and a foreign-tenant claim', async () => {
    await expectCode('invalid_evidence_ref', () =>
      convertSignals(ctx, {
        trigger: { kind: 'manual' },
        candidates: [candi({ evidence: { claimIds: [newId()] } })],
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
    await expectCode('invalid_evidence_ref', () =>
      convertSignals(ctx, {
        trigger: { kind: 'manual' },
        candidates: [candi({ evidence: { claimIds: [foreignClaim] } })],
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });

  it('refuses a foreign-tenant goal reference', async () => {
    await expectCode('invalid_goal_ref', () =>
      convertSignals(ctx, {
        trigger: { kind: 'manual' },
        candidates: [candi({ evidence: { observationIds: [obs1] }, affectedGoals: [{ goalId: foreignGoal }] })],
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });

  it("requires the loop linkage for 'cognitive-execution' triggers and validates it", async () => {
    await expectCode('invalid_conversion_input', () =>
      convertSignals(ctx, {
        trigger: { kind: 'cognitive-execution' },
        candidates: [candi({ evidence: { observationIds: [obs1] } })],
        actor: { kind: 'system', label: 'harness' },
      }),
    );
    await expectCode('invalid_origin_ref', () =>
      convertSignals(ctx, {
        trigger: { kind: 'cognitive-execution' },
        originatingExecutionId: foreignExecution,
        candidates: [candi({ evidence: { observationIds: [obs1] } })],
        actor: { kind: 'system', label: 'harness' },
      }),
    );
    const run = await convertSignals(ctx, {
      trigger: { kind: 'cognitive-execution' },
      originatingExecutionId: validExecution,
      candidates: [candi({ title: 'Loop-linked conversion', evidence: { observationIds: [obs1] } })],
      actor: { kind: 'system', label: 'harness' },
    });
    expect(run.originatingExecutionId).toBe(validExecution);
    expect(run.counts.converted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  const ctx = member(tenantA);
  const foreignCtx = member(tenantB);
  let opportunity: Opportunity;
  let run: ConversionRun;

  beforeAll(async () => {
    // tenantA already carries the golden conversion; make one on tenantB.
    const obs = await seedObservation(foreignCtx, { confidence: 0.9, minutes: 1 });
    const foreignRun = await convertSignals(foreignCtx, {
      trigger: { kind: 'manual' },
      candidates: [candi({ title: 'Another tenant opportunity', evidence: { observationIds: [obs] } })],
      actor: { kind: 'person', label: 'foreign analyst' },
    });
    opportunity = await getOpportunity(foreignCtx, foreignRun.candidates[0]!.createdOpportunityId!);
    run = foreignRun;

    // And one of tenantA's for the positive control below.
    const obsA = await seedObservation(ctx, { confidence: 0.9, minutes: 3 });
    await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      candidates: [candi({ title: 'Own tenant opportunity', evidence: { observationIds: [obsA] } })],
      actor: { kind: 'person', label: 'analyst' },
    });
  });

  it('reads another tenant\'s opportunity as missing (deep links included)', async () => {
    await expectCode('opportunity_not_found', () => getOpportunity(ctx, opportunity.id));
    await expectCode('opportunity_version_not_found', () =>
      getOpportunityVersion(ctx, { opportunityId: opportunity.id, version: 1 }),
    );
    await expectCode('opportunity_not_found', () =>
      listOpportunityVersions(ctx, { opportunityId: opportunity.id }),
    );
  });

  it('reads another tenant\'s run and candidates as missing', async () => {
    await expectCode('run_not_found', () => getConversionRun(ctx, { runId: run.id }));
    await expectCode('candidate_not_found', () =>
      getConversionCandidate(ctx, { candidateId: run.candidates[0]!.id }),
    );
  });

  it('never mixes listings across tenants', async () => {
    const mine = await listOpportunities(ctx, { limit: 500 });
    const theirs = await listOpportunities(foreignCtx, { limit: 500 });
    expect(mine.every((entry) => entry.tenantId === tenantA)).toBe(true);
    expect(theirs.every((entry) => entry.tenantId === tenantB)).toBe(true);
    expect(mine.map((entry) => entry.id)).not.toContain(opportunity.id);
    expect(theirs.map((entry) => entry.id)).not.toContain(mine[0]!.id);
  });

  it('reports a revision of a foreign opportunity as missing, not as a transition error', async () => {
    await expectCode('opportunity_not_found', () =>
      reviseOpportunity(ctx, {
        opportunityId: opportunity.id,
        status: 'dismissed',
        actor: { kind: 'person', label: 'analyst' },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The management listings
// ---------------------------------------------------------------------------

describe('listOpportunities — the management surface', () => {
  const ctx = member(tenantList);
  let goalA: string;
  let capabilityA: string;
  let entityA: string;
  let churnSaves: Opportunity;
  let dachExpansion: Opportunity;
  let upsell: Opportunity;

  beforeAll(async () => {
    const obsHigh = await seedObservation(ctx, { confidence: 0.85, minutes: 1 });
    const obsMid = await seedObservation(ctx, { confidence: 0.55, minutes: 2 });
    const obsLow = await seedObservation(ctx, { confidence: 0.3, minutes: 3 });
    goalA = await seedGoal(ctx, 'Reduce churn');
    capabilityA = newId();
    entityA = newId();

    // No policy → the default confidence gate (0.5) applies; pass a lower
    // one so the deliberately low-confidence candidate also converts.
    const run = await convertSignals(ctx, {
      trigger: { kind: 'scheduled' },
      policy: { minConfidence: 0.2 },
      candidates: [
        candi({
          title: 'Proactive churn saves',
          description: 'Internal signals show at-risk accounts.',
          signalOrigin: 'internal',
          evidence: { observationIds: [obsHigh] },
          affectedGoals: [{ goalId: goalA, label: 'custom label' }],
          requiredCapabilities: [{ capabilityId: capabilityA }],
          worldEntities: [{ entityId: entityA }],
          recommendedNextAction: { kind: 'investigate', statement: 'Mission: identify the churn drivers.' },
        }),
        candi({
          title: 'DACH expansion',
          evidence: { observationIds: [obsMid] },
        }),
        candi({
          title: 'Upsell the installed base',
          evidence: { observationIds: [obsLow] },
          estimatedValue: { amount: 900_000_00, currency: 'EUR' },
        }),
      ],
      actor: { kind: 'system', label: 'scheduler' },
    });
    const ids = run.candidates.map((candidate) => candidate.createdOpportunityId!);
    churnSaves = await getOpportunity(ctx, ids[0]!);
    dachExpansion = await getOpportunity(ctx, ids[1]!);
    upsell = await getOpportunity(ctx, ids[2]!);
    // Pursue one to have a second status in the data.
    await reviseOpportunity(ctx, {
      opportunityId: upsell.id,
      status: 'pursued',
      actor: { kind: 'person', label: 'the ceo' },
    });
  });

  it('lists current views newest first', async () => {
    const all = await listOpportunities(ctx, { limit: 500 });
    expect(all).toHaveLength(3);
    const recorded = all.map((entry) => Date.parse(entry.updatedAt));
    expect([...recorded].sort((a, b) => b - a)).toEqual(recorded);
  });

  it('filters by status', async () => {
    const open = await listOpportunities(ctx, { status: 'open', limit: 500 });
    expect(open).toHaveLength(2);
    expect(open.every((entry) => entry.content.status === 'open')).toBe(true);
    const pursued = await listOpportunities(ctx, { status: 'pursued', limit: 500 });
    expect(pursued.map((entry) => entry.id)).toEqual([upsell.id]);
  });

  it('filters by signal origin', async () => {
    const internal = await listOpportunities(ctx, { signalOrigin: 'internal', limit: 500 });
    expect(internal.map((entry) => entry.id)).toEqual([churnSaves.id]);
  });

  it('filters by minimum derived confidence', async () => {
    const confident = await listOpportunities(ctx, { minConfidence: 0.6, limit: 500 });
    expect(confident.map((entry) => entry.id)).toEqual([churnSaves.id]);
  });

  it('filters by affected goal (jsonb containment)', async () => {
    const byGoal = await listOpportunities(ctx, { goalId: goalA, limit: 500 });
    expect(byGoal.map((entry) => entry.id)).toEqual([churnSaves.id]);
    expect(byGoal[0]!.content.affectedGoals[0]!.label).toBe('custom label');
  });

  it('filters by required capability and world entity', async () => {
    const byCapability = await listOpportunities(ctx, { capabilityId: capabilityA, limit: 500 });
    expect(byCapability.map((entry) => entry.id)).toEqual([churnSaves.id]);
    const byEntity = await listOpportunities(ctx, { worldEntityId: entityA, limit: 500 });
    expect(byEntity.map((entry) => entry.id)).toEqual([churnSaves.id]);
  });

  it('searches titles case-insensitively without wildcard injection', async () => {
    const hits = await listOpportunities(ctx, { search: 'DACH', limit: 500 });
    expect(hits.map((entry) => entry.content.title)).toEqual(['DACH expansion']);
    const wildcard = await listOpportunities(ctx, { search: '%', limit: 500 });
    expect(wildcard).toHaveLength(0);
    const percent = await listOpportunities(ctx, { search: '100%', limit: 500 });
    expect(percent).toHaveLength(0);
    expect(dachExpansion.content.title).toBe('DACH expansion');
  });

  it('applies the limit', async () => {
    const limited = await listOpportunities(ctx, { limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The run feed
// ---------------------------------------------------------------------------

describe('listConversionRuns — the conversion audit feed', () => {
  const ctx = member(tenantRuns);
  let executionId: string;

  beforeAll(async () => {
    // Distinct signals per pass — each converts exactly one candidate.
    const obsScheduled = await seedObservation(ctx, { confidence: 0.9, minutes: 1 });
    const obsLoop = await seedObservation(ctx, { confidence: 0.9, minutes: 2 });
    const obsManual = await seedObservation(ctx, { confidence: 0.9, minutes: 3 });
    const execution = await startExecution(ctx, {
      trigger: { kind: 'schedule', label: 'nightly sweep' },
      focus: { topics: ['market'], entities: [] },
      actor: { kind: 'system', label: 'cognition worker' },
    });
    executionId = execution.id;
    await convertSignals(ctx, {
      trigger: { kind: 'scheduled' },
      candidates: [candi({ title: 'Scheduled sweep finding', evidence: { observationIds: [obsScheduled] } })],
      actor: { kind: 'system', label: 'scheduler' },
    });
    await convertSignals(ctx, {
      trigger: { kind: 'cognitive-execution' },
      originatingExecutionId: executionId,
      candidates: [candi({ title: 'Loop-linked finding', evidence: { observationIds: [obsLoop] } })],
      actor: { kind: 'system', label: 'harness' },
    });
    await convertSignals(ctx, {
      trigger: { kind: 'manual' },
      candidates: [candi({ title: 'Manual pass finding', evidence: { observationIds: [obsManual] } })],
      actor: { kind: 'person', label: 'analyst' },
    });
  });

  it('lists runs newest first with counts and policy snapshots', async () => {
    const feed = await listConversionRuns(ctx, { limit: 500 });
    expect(feed).toHaveLength(3);
    const recorded = feed.map((run) => Date.parse(run.recordedAt));
    expect([...recorded].sort((a, b) => b - a)).toEqual(recorded);
    expect(feed[0]!.counts.converted).toBe(1);
    expect(feed[0]!.policy.minConfidence).toBe(0.5); // the default, snapshotted
    expect(feed[0]!.policy.minValue).toBeNull();
  });

  it('filters by trigger kind', async () => {
    const scheduled = await listConversionRuns(ctx, { triggerKind: 'scheduled', limit: 500 });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.triggerKind).toBe('scheduled');
  });

  it('filters by originating execution', async () => {
    const linked = await listConversionRuns(ctx, { originatingExecutionId: executionId, limit: 500 });
    expect(linked).toHaveLength(1);
    expect(linked[0]!.originatingExecutionId).toBe(executionId);
    expect(linked[0]!.triggerKind).toBe('cognitive-execution');
  });

  it('serves the decided candidate chain with the run deep-link', async () => {
    const feed = await listConversionRuns(ctx, { triggerKind: 'cognitive-execution', limit: 1 });
    const deep = await getConversionRun(ctx, { runId: feed[0]!.id });
    expect(deep.candidates).toHaveLength(1);
    expect(deep.candidates[0]!.title).toBe('Loop-linked finding');
    expect(deep.candidates[0]!.disposition).toBe('converted');
  });
});
