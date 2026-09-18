// Integration tests for W052 — Knowledge Source Ranking (ADR-0018)
// against the embedded PostgreSQL (PGlite, `:memory:`) through the db
// port. These carry the ADR-0018 REQUIRED VERIFICATION:
//
//   "Synthetic tests prove source selection changes when reliability,
//    freshness, relevance or cost changes, and that the persisted
//    rationale identifies which signal caused the change."
//
//  * ROUTING FOLLOWS THE EVIDENCE — four synthetic flips, each isolating
//    one signal:
//      - RELIABILITY: an employee and a system with answered histories
//        are ranked (the system wins on its stronger record); the system
//        then fails repeatedly and the SAME evidence base re-routes the
//        next mission to the employee — only reliability (and its basis
//        counts) moved;
//      - FRESHNESS: two parallel tenants with identical histories except
//        WHICH source's evidence is stale select opposite sources — only
//        freshness (and its basis clock) differs; a fresh answer then
//        flips the stale tenant's routing dynamically;
//      - RELEVANCE: two employees' transactive records differ in subject
//        coverage; recording richer subject evidence for the loser flips
//        the routing — only relevance (and its matched topics) moved;
//      - AUTHORITY: two employees 'know' vs 'have experience with' the
//        subject; a 'decides' entry for the weaker one flips the routing
//        — only authority (and its relations) moved;
//      - COST: identical evidence, different explicit cost policy — only
//        signals.cost (and the cost share) moved.
//  * LEARNING NEVER OVERRIDES EXPLICIT POLICY (ADR-0018): the
//    best-evidenced source is excluded when its access scope is
//    'forbidden'.
//  * DETERMINISM: the same learned state, mission and instant produce
//    identical derivation snapshots and the same selection.
//  * THE W051 POSTURE: the missions goal-gap discovery launches (their
//    menus are the gap's acquisition paths) rank through the shared
//    missions contract — no attention import (it would be a
//    migration-order cycle via cognition).
//  * TENANT ISOLATION (ADR-0001) with uniform not-found semantics and no
//    cross-tenant track-record leakage.
//  * APPEND-ONLY: UPDATE/DELETE/TRUNCATE on source_rankings are rejected
//    by triggers.
//  * The read surface and the input guards.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  attestIdentity,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { recordTransactiveEntry } from '@/modules/memory/contract';
import { recordObservation } from '@/modules/observations/contract';
import {
  createPerson,
  createEmployee,
  linkExternalIdentity,
  type Person,
} from '@/modules/people/contract';
import {
  completeMission,
  createMission,
  type CreateMissionInput,
  type Mission,
  type MissionCandidate,
  type MissionCandidateKind,
} from '@/modules/missions/contract';
import { KnowledgeAcquisitionError } from '../errors';
import * as kaContract from '../contract';
import type {
  CandidateSignals,
  RankedSource,
  RankMissionSourcesInput,
  SourceRanking,
} from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  getSourceRanking,
  listSourceRankings,
  planNextAcquisition,
  rankMissionSources,
  recordAcquisitionOutcome,
} = kaContract;

// Dedicated tenants keep each concern's learned state isolated.
const tenantReliability = newId();
const tenantFreshA = newId();
const tenantFreshB = newId();
const tenantRelevance = newId();
const tenantAuthority = newId();
const tenantCost = newId();
const tenantPolicy = newId();
const tenantDeterminism = newId();
const tenantOrigin = newId();
const tenantIsoX = newId();
const tenantIsoY = newId();
const tenantAppendOnly = newId();
const tenantReads = newId();
const tenantGuards = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function manager(tenantId: string): TenantContext {
  return {
    tenantId,
    principalId: newId(),
    authority: [IDENTITY_AUTHORITY_ATTEST, IDENTITY_AUTHORITY_LINK],
  };
}

async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeAcquisitionError);
    expect((error as KnowledgeAcquisitionError).code).toBe(code);
  }
}

// The frozen evaluation instant — freshness is derived against it.
const FIXED_NOW = '2026-09-14T12:00:00.000Z';
const FIXED_NOW_MINUS_90D = '2026-06-16T12:00:00.000Z';
let clockSpy: ReturnType<typeof vi.spyOn>;

function setClock(instant: string): void {
  clockSpy.mockImplementation(() => new Date(instant));
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

let identityCounter = 0;

/** A person with an active employment and a verified linked identity. */
async function askableEmployee(tenantId: string, fullName: string): Promise<Person> {
  const person = await createPerson(member(tenantId), { fullName });
  await createEmployee(member(tenantId), {
    personId: person.id,
    title: `Title of ${fullName}`,
  });
  identityCounter += 1;
  const registered = await registerExternalIdentity(member(tenantId), {
    provider: 'slack',
    providerAccountId: `slack-w052-${identityCounter}`,
  });
  const attested = await attestIdentity(manager(tenantId), {
    identityId: registered.identity.id,
    evidence: `admin attestation for ${fullName}`,
  });
  await linkExternalIdentity(manager(tenantId), { personId: person.id, identityId: attested.id });
  return person;
}

function missionInput(overrides: Partial<CreateMissionInput> = {}): CreateMissionInput {
  return {
    title: 'Churn root cause',
    knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
    affectedGoals: [],
    unknownIds: [],
    informationValue: 0.8,
    urgency: 'high',
    currentConfidence: 0.1,
    targetConfidence: 0.85,
    investigationBudget: { amount: 250_00, currency: 'EUR' },
    rewardBudget: { amount: 50_00, currency: 'EUR' },
    rewardTerms: null,
    candidateSources: [],
    completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
    actor: { kind: 'person', label: 'COO' },
    rationale: 'W052 fixture',
    ...overrides,
  };
}

async function seedMission(
  ctx: TenantContext,
  overrides: Partial<CreateMissionInput> = {},
): Promise<Mission> {
  return createMission(ctx, missionInput(overrides));
}

/** The explicit ranking policy for one candidate (cost + access). */
function policy(
  kind: MissionCandidateKind,
  ref: { id?: string | null; label?: string | null },
  overrides: Partial<kaContract.SourcePolicyInput> = {},
): kaContract.SourcePolicyInput {
  return {
    kind,
    id: ref.id ?? null,
    label: ref.label ?? null,
    cost: 0,
    access: 'allowed',
    ...overrides,
  };
}

function rankInput(
  missionId: string,
  policies: kaContract.SourcePolicyInput[],
  rationale: string | null = null,
): RankMissionSourcesInput {
  return {
    missionId,
    policies,
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale,
  };
}

/** Uniform caller-supplied signals for direct planner calls (track seeding). */
function seedSignals(candidate: MissionCandidate): CandidateSignals {
  return {
    kind: candidate.kind,
    id: candidate.id ?? null,
    label: candidate.label ?? null,
    relevance: 0.5,
    reliability: 0.5,
    freshness: 0.5,
    authority: 0.5,
    expectedQuality: 0.5,
    priorContributionValue: 0,
    cost: 0,
    access: 'allowed',
  };
}

/**
 * Seeds ONE terminal outcome on a source's track record through the
 * public planner + outcome surface: a fresh single-candidate mission, a
 * plan that selects it, and the outcome. This is how learned state comes
 * to exist — no shortcuts, no direct table writes.
 */
async function seedOutcome(
  ctx: TenantContext,
  candidate: MissionCandidate,
  outcome: 'answered' | 'failed',
  options: { confidence?: number; observedAt?: string } = {},
): Promise<void> {
  const mission = await seedMission(ctx, { candidateSources: [candidate] });
  const plan = await planNextAcquisition(ctx, {
    missionId: mission.id,
    candidates: [seedSignals(candidate)],
    actor: { kind: 'system', label: 'w052-fixture' },
  });
  expect(plan.decision).toBe('selected'); // single eligible candidate
  if (outcome === 'answered') {
    await recordAcquisitionOutcome(ctx, {
      planId: plan.id,
      outcome: 'answered',
      evidence: {
        payload: { answer: `${candidate.label ?? candidate.id} answered` },
        confidence: {
          value: options.confidence ?? 0.8,
          method: 'source_trust',
          basis: 'fixture',
        },
        ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
      },
    });
  } else {
    await recordAcquisitionOutcome(ctx, {
      planId: plan.id,
      outcome: 'failed',
      note: 'fixture failure',
    });
  }
}

/** Seeds a transactive-memory entry about a person (W010, through the contract). */
async function seedTransactive(
  ctx: TenantContext,
  person: Person,
  relation: 'knows' | 'owns' | 'decides' | 'has_experience_with' | 'influences' | 'can_perform',
  topics: string[],
  subjectLabel: string,
): Promise<void> {
  const observation = await recordObservation(ctx, {
    kind: 'org.transactive-assertion',
    payload: { actor: person.fullName, relation, topics },
    observedAt: FIXED_NOW,
    source: { kind: 'person', id: person.id, label: person.fullName },
    channel: 'w052-fixture',
    confidence: { value: 0.9, method: 'fixture' },
  });
  await recordTransactiveEntry(ctx, {
    actor: { kind: 'person', id: person.id, label: person.fullName },
    relation,
    subjectLabel,
    topics,
    evidenceObservationIds: [observation.id],
  });
}

/** One candidate's derivation entry out of a persisted ranking. */
function derivedOf(
  ranking: SourceRanking,
  kind: MissionCandidateKind,
  ref: { id?: string | null; label?: string | null },
): RankedSource {
  const entry = ranking.derived.find(
    (source) =>
      source.candidate.kind === kind &&
      (ref.id !== undefined && ref.id !== null
        ? source.candidate.id === ref.id
        : source.candidate.label === ref.label),
  );
  expect(entry).toBeDefined();
  return entry!;
}

beforeAll(async () => {
  clockSpy = vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(FIXED_NOW));
  await runMigrations(getDb());
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

// ---------------------------------------------------------------------------
// The derivation surface: evidence → separately represented signals
// ---------------------------------------------------------------------------

describe('rankMissionSources (deriving the ADR-0018 signals from source evidence)', () => {
  it('derives every signal from persisted evidence and persists the rationale with its basis', async () => {
    const ctx = member(tenantReliability);
    const ada = await askableEmployee(tenantReliability, 'Ada Lovelace');
    await seedOutcome(ctx, { kind: 'person', id: ada.id, label: 'Ada Lovelace' }, 'answered', {
      confidence: 0.8,
    });
    await seedOutcome(ctx, { kind: 'person', id: ada.id, label: 'Ada Lovelace' }, 'answered', {
      confidence: 0.8,
    });

    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: ada.id, label: 'VP Customer Success' },
        { kind: 'system', label: 'billing-export' },
      ],
    });
    const { ranking, plan } = await rankMissionSources(
      ctx,
      rankInput(mission.id, [
        policy('person', { id: ada.id, label: 'VP Customer Success' }),
        policy('system', { label: 'billing-export' }),
      ]),
    );

    // The record: identity, tenancy, mission version, audit quartet.
    expect(ranking.tenantId).toBe(tenantReliability);
    expect(ranking.missionId).toBe(mission.id);
    expect(ranking.missionVersion).toBe(mission.version);
    expect(ranking.actor).toEqual({ kind: 'system', id: null, label: 'aurum-cognition' });
    expect(ranking.rankedByPrincipal).toBe(ctx.principalId);
    expect(ranking.rationale).toBeNull();
    expect(ranking.recordedAt).toBe(FIXED_NOW);
    expect(ranking.decision).toBe('selected');
    expect(ranking.planId).toBe(plan.id);

    // The subject topics are the mission's content words (title first).
    expect(ranking.subjectTopics).toEqual([
      'churn', 'root', 'cause', 'rise', 'q3', 'dominant', 'driver',
    ]);

    // Ada: answered twice at confidence 0.8, evidence observed now —
    // every learned signal is derivable from the persisted basis.
    const adaDerived = derivedOf(ranking, 'person', { id: ada.id });
    expect(adaDerived.signals.relevance).toBe(0.5); // no transactive record: neutral
    expect(adaDerived.signals.reliability).toBe(0.75); // (2+1)/(2+2)
    expect(adaDerived.signals.freshness).toBe(1); // evidence observed at the evaluation instant
    expect(adaDerived.signals.authority).toBe(0.5); // neutral
    expect(adaDerived.signals.expectedQuality).toBe(0.8); // mean evidence confidence
    expect(adaDerived.signals.priorContributionValue).toBeCloseTo(2 / 6, 6);
    expect(adaDerived.signals.cost).toBe(0);
    expect(adaDerived.signals.access).toBe('allowed');
    expect(adaDerived.basis.outcomes).toEqual({ answered: 2, unavailable: 0, failed: 0 });
    expect(adaDerived.basis.evidenceConfidenceMean).toBe(0.8);
    expect(adaDerived.basis.latestEvidenceObservedAt).toBe(FIXED_NOW);
    expect(adaDerived.basis.transactiveEntryIds).toEqual([]);
    expect(adaDerived.basis.matchedTopics).toEqual([]);
    expect(adaDerived.basis.relations).toEqual([]);

    // The system with no history: the neutral priors (not zero) + an empty basis.
    const systemDerived = derivedOf(ranking, 'system', { label: 'billing-export' });
    expect(systemDerived.signals).toEqual({
      relevance: 0.5, reliability: 0.5, freshness: 0.5, authority: 0.5,
      expectedQuality: 0.5, priorContributionValue: 0, cost: 0, access: 'allowed',
    });
    expect(systemDerived.basis).toEqual({
      outcomes: { answered: 0, unavailable: 0, failed: 0 },
      evidenceConfidenceMean: null,
      latestEvidenceObservedAt: null,
      transactiveEntryIds: [],
      matchedTopics: [],
      relations: [],
    });

    // The same fixed-weight arithmetic the planner's own snapshot carries:
    // Ada 0.30·0.5 + 0.20·0.75 + 0.15·0.5 + 0.15·0.8 + 0.10·1 + 0.05·(2/6).
    expect(adaDerived.score).toBeCloseTo(0.611667, 6);
    const planAda = plan.ranked.find((entry) => entry.candidate.kind === 'person')!;
    expect(planAda.score).toBe(adaDerived.score); // one arithmetic, two snapshots
    expect(plan.chosen?.kind).toBe('person');
    expect(plan.action).toBe('ask-person'); // the evidence put the employee on top
  });

  it('is deterministic: the same learned state, mission and instant produce the identical snapshot', async () => {
    const ctx = member(tenantDeterminism);
    await seedOutcome(ctx, { kind: 'system', label: 'ledger-api' }, 'answered');
    const menu = [
      { kind: 'system' as const, label: 'ledger-api' },
      { kind: 'external' as const, label: 'churn-benchmark' },
    ];
    const first = await seedMission(ctx, { candidateSources: menu });
    const second = await seedMission(ctx, { candidateSources: menu });

    const one = await rankMissionSources(
      ctx,
      rankInput(first.id, [policy('system', { label: 'ledger-api' }), policy('external', { label: 'churn-benchmark' })]),
    );
    const two = await rankMissionSources(
      ctx,
      rankInput(second.id, [policy('system', { label: 'ledger-api' }), policy('external', { label: 'churn-benchmark' })]),
    );

    // ADR-0018: "the same inputs and the same learned state produce the
    // same ordering" — identical derivation, identical selection.
    expect(two.ranking.derived).toEqual(one.ranking.derived);
    expect(two.ranking.subjectTopics).toEqual(one.ranking.subjectTopics);
    expect(two.plan.chosen).toEqual(one.plan.chosen);
    expect(two.plan.ranked.map((entry) => entry.score)).toEqual(
      one.plan.ranked.map((entry) => entry.score),
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-0018 required verification — routing changes when evidence changes
// ---------------------------------------------------------------------------

describe('ADR-0018 verification: routing changes when source evidence changes', () => {
  it('RELIABILITY: failures erode a system\u2019s standing and re-route to the employee (employee and system compared on the same dimensions)', async () => {
    const ctx = member(tenantReliability);
    const ada = await askableEmployee(tenantReliability, 'Grace Hopper');
    const adaRef = { kind: 'person' as const, id: ada.id, label: 'Grace Hopper' };
    const systemRef = { kind: 'system' as const, label: 'billing-export' };

    // The system's record is stronger: 4 answered vs Ada's 2.
    await seedOutcome(ctx, adaRef, 'answered', { confidence: 0.8 });
    await seedOutcome(ctx, adaRef, 'answered', { confidence: 0.8 });
    for (let i = 0; i < 4; i += 1) {
      await seedOutcome(ctx, systemRef, 'answered', { confidence: 0.8 });
    }

    const menu = [adaRef, systemRef];
    const missionOne = await seedMission(ctx, {
      candidateSources: menu,
      title: 'Churn root cause',
    });
    const first = await rankMissionSources(
      ctx,
      rankInput(missionOne.id, [
        policy('person', { id: ada.id, label: 'Grace Hopper' }),
        policy('system', { label: 'billing-export' }),
      ]),
    );
    // Ada: .30·.5 + .20·.75 + .15·.5 + .15·.8 + .10·1 + .05·(2/6) = 0.611667
    // System: .30·.5 + .20·(5/6) + .15·.5 + .15·.8 + .10·1 + .05·.5 = 0.636667
    expect(derivedOf(first.ranking, 'person', { id: ada.id }).score).toBeCloseTo(0.611667, 6);
    expect(derivedOf(first.ranking, 'system', { label: 'billing-export' }).score).toBeCloseTo(0.636667, 6);
    expect(first.plan.chosen).toEqual({ kind: 'system', id: null, label: 'billing-export' });
    expect(first.plan.action).toBe('query-system');

    // The evidence changes: the system fails ten times in a row.
    for (let i = 0; i < 10; i += 1) {
      await seedOutcome(ctx, systemRef, 'failed');
    }

    const missionTwo = await seedMission(ctx, { candidateSources: menu });
    const second = await rankMissionSources(
      ctx,
      rankInput(missionTwo.id, [
        policy('person', { id: ada.id, label: 'Grace Hopper' }),
        policy('system', { label: 'billing-export' }),
      ]),
    );

    // ROUTING CHANGED: the employee wins now (targeted questioning).
    expect(second.plan.chosen).toEqual({ kind: 'person', id: ada.id, label: 'Grace Hopper' });
    expect(second.plan.action).toBe('ask-person');
    expect(second.plan.question).toContain('Grace Hopper');
    expect(second.plan.question).toContain(missionTwo.content.knowledgeObjective);
    expect(second.plan.askPolicy).toEqual({ outcome: 'allowed', resolvedVia: 'built-in' });

    // THE PERSISTED RATIONALE IDENTIFIES THE SIGNAL: only the system's
    // reliability moved (0.833333 → 0.3125), because its basis now counts
    // ten failures; Ada's derivation is identical between the snapshots.
    const systemBefore = derivedOf(first.ranking, 'system', { label: 'billing-export' });
    const systemAfter = derivedOf(second.ranking, 'system', { label: 'billing-export' });
    expect(systemBefore.signals.reliability).toBeCloseTo(5 / 6, 6);
    expect(systemAfter.signals.reliability).toBeCloseTo(5 / 16, 6);
    expect(systemAfter.basis.outcomes).toEqual({ answered: 4, unavailable: 0, failed: 10 });
    expect(systemBefore.basis.outcomes).toEqual({ answered: 4, unavailable: 0, failed: 0 });
    expect(systemAfter.signals.relevance).toBe(systemBefore.signals.relevance);
    expect(systemAfter.signals.freshness).toBe(systemBefore.signals.freshness);
    expect(systemAfter.signals.authority).toBe(systemBefore.signals.authority);
    expect(systemAfter.signals.expectedQuality).toBe(systemBefore.signals.expectedQuality);
    expect(systemAfter.signals.priorContributionValue).toBe(systemBefore.signals.priorContributionValue);
    expect(derivedOf(second.ranking, 'person', { id: ada.id })).toEqual(
      derivedOf(first.ranking, 'person', { id: ada.id }),
    );

    // The deterministic order flipped with the scores.
    expect(first.ranking.derived[0]!.candidate.kind).toBe('system');
    expect(second.ranking.derived[0]!.candidate.kind).toBe('person');
  });

  it('FRESHNESS: which source\u2019s evidence is stale decides the routing (isolated across identical tenants, then flipped by a fresh answer)', async () => {
    const ledger = { kind: 'system' as const, label: 'ledger-api' };
    const archive = { kind: 'system' as const, label: 'archive-api' };

    // Universe A: ledger's evidence is current, archive's is 90 days old.
    const ctxA = member(tenantFreshA);
    await seedOutcome(ctxA, ledger, 'answered', { observedAt: FIXED_NOW });
    await seedOutcome(ctxA, archive, 'answered', { observedAt: FIXED_NOW_MINUS_90D });
    // Universe B: identical — except the evidence clocks are swapped.
    const ctxB = member(tenantFreshB);
    await seedOutcome(ctxB, ledger, 'answered', { observedAt: FIXED_NOW_MINUS_90D });
    await seedOutcome(ctxB, archive, 'answered', { observedAt: FIXED_NOW });

    const menu = [ledger, archive];
    const missionA = await seedMission(ctxA, { candidateSources: menu });
    const missionB = await seedMission(ctxB, { candidateSources: menu });
    const inA = await rankMissionSources(
      ctxA,
      rankInput(missionA.id, [policy('system', { label: 'ledger-api' }), policy('system', { label: 'archive-api' })]),
    );
    const inB = await rankMissionSources(
      ctxB,
      rankInput(missionB.id, [policy('system', { label: 'ledger-api' }), policy('system', { label: 'archive-api' })]),
    );

    // Same histories, same confidences — opposite routing. FRESHNESS is
    // the only signal that differs between the two universes.
    expect(inA.plan.chosen).toEqual({ kind: 'system', id: null, label: 'ledger-api' });
    expect(inB.plan.chosen).toEqual({ kind: 'system', id: null, label: 'archive-api' });
    const aLedger = derivedOf(inA.ranking, 'system', { label: 'ledger-api' });
    const bLedger = derivedOf(inB.ranking, 'system', { label: 'ledger-api' });
    const aArchive = derivedOf(inA.ranking, 'system', { label: 'archive-api' });
    const bArchive = derivedOf(inB.ranking, 'system', { label: 'archive-api' });
    expect(aLedger.signals.freshness).toBe(1);
    expect(aArchive.signals.freshness).toBe(0.125); // 0.5 ** (90/30)
    expect(bLedger.signals.freshness).toBe(0.125);
    expect(bArchive.signals.freshness).toBe(1);
    // everything else is identical across the universes
    for (const signal of ['relevance', 'reliability', 'authority', 'expectedQuality', 'priorContributionValue'] as const) {
      expect(aLedger.signals[signal]).toBe(bLedger.signals[signal]);
      expect(aArchive.signals[signal]).toBe(bArchive.signals[signal]);
    }
    // the basis names the evidence clock that caused it
    expect(aLedger.basis.latestEvidenceObservedAt).toBe(FIXED_NOW);
    expect(aArchive.basis.latestEvidenceObservedAt).toBe(FIXED_NOW_MINUS_90D);

    // The dynamic flip: archive answers again with current evidence and
    // takes the lead in universe A (freshness 0.125 → 1 with the new
    // evidence clock; reliability/prior value move with the new answer
    // too — the rationale shows each).
    await seedOutcome(ctxA, archive, 'answered', { observedAt: FIXED_NOW });
    const missionA2 = await seedMission(ctxA, { candidateSources: menu });
    const flipped = await rankMissionSources(
      ctxA,
      rankInput(missionA2.id, [policy('system', { label: 'ledger-api' }), policy('system', { label: 'archive-api' })]),
    );
    expect(flipped.plan.chosen).toEqual({ kind: 'system', id: null, label: 'archive-api' });
    const archiveAfter = derivedOf(flipped.ranking, 'system', { label: 'archive-api' });
    expect(archiveAfter.signals.freshness).toBe(1);
    expect(archiveAfter.basis.latestEvidenceObservedAt).toBe(FIXED_NOW);
    expect(archiveAfter.basis.outcomes).toEqual({ answered: 2, unavailable: 0, failed: 0 });
  });

  it('RELEVANCE: richer transactive subject evidence flips the routing between two employees', async () => {
    const ctx = member(tenantRelevance);
    const aya = await askableEmployee(tenantRelevance, 'Aya Fujimura');
    const bea = await askableEmployee(tenantRelevance, 'Bea Okafor');

    // The mission's subject: churn + pricing (+ wording).
    const overrides = {
      title: 'Churn drivers',
      knowledgeObjective: 'What drives churn and pricing sensitivity this quarter?',
    };
    // Aya is on record for two subject topics; Bea for one.
    await seedTransactive(ctx, aya, 'knows', ['churn', 'pricing'], 'churn and pricing');
    await seedTransactive(ctx, bea, 'knows', ['churn'], 'churn');

    const menu = [
      { kind: 'person' as const, id: aya.id, label: 'Aya Fujimura' },
      { kind: 'person' as const, id: bea.id, label: 'Bea Okafor' },
    ];
    const missionOne = await seedMission(ctx, { candidateSources: menu, ...overrides });
    const first = await rankMissionSources(
      ctx,
      rankInput(missionOne.id, [
        policy('person', { id: aya.id, label: 'Aya Fujimura' }),
        policy('person', { id: bea.id, label: 'Bea Okafor' }),
      ]),
    );
    // Aya: .30·(2/3) + .20·.5 + .15·.7 + .15·.5 + .10·.5 + 0 = 0.53
    // Bea: .30·.5   + .20·.5 + .15·.7 + .15·.5 + .10·.5 + 0 = 0.48
    expect(first.plan.chosen?.kind).toBe('person');
    expect(first.plan.chosen?.id).toBe(aya.id);

    // The evidence changes: Bea is recorded on a third subject topic.
    await seedTransactive(ctx, bea, 'knows', ['churn', 'pricing', 'sensitivity'], 'churn pricing sensitivity');

    const missionTwo = await seedMission(ctx, { candidateSources: menu, ...overrides });
    const second = await rankMissionSources(
      ctx,
      rankInput(missionTwo.id, [
        policy('person', { id: aya.id, label: 'Aya Fujimura' }),
        policy('person', { id: bea.id, label: 'Bea Okafor' }),
      ]),
    );
    expect(second.plan.chosen?.id).toBe(bea.id); // ROUTING CHANGED

    // THE PERSISTED RATIONALE: only Bea's relevance moved (0.5 → 0.75),
    // because her matched topics grew; her authority (still 'knows') and
    // Aya's whole derivation are unchanged.
    const beaBefore = derivedOf(first.ranking, 'person', { id: bea.id });
    const beaAfter = derivedOf(second.ranking, 'person', { id: bea.id });
    expect(beaBefore.signals.relevance).toBe(0.5); // one match ≈ neutral
    expect(beaAfter.signals.relevance).toBe(0.75); // three matches
    expect(beaBefore.basis.matchedTopics).toEqual(['churn']);
    expect(beaAfter.basis.matchedTopics).toEqual(['churn', 'pricing', 'sensitivity']);
    expect(beaAfter.signals.authority).toBe(beaBefore.signals.authority);
    expect(beaAfter.basis.relations).toEqual(['knows']);
    expect(derivedOf(second.ranking, 'person', { id: aya.id })).toEqual(
      derivedOf(first.ranking, 'person', { id: aya.id }),
    );
    expect(second.ranking.subjectTopics).toContain('churn');
    expect(second.ranking.subjectTopics).toContain('pricing');
    expect(second.ranking.subjectTopics).toContain('sensitivity');
  });

  it('AUTHORITY: a \u2018decides\u2019 relation flips the routing between two equally relevant employees', async () => {
    const ctx = member(tenantAuthority);
    const cara = await askableEmployee(tenantAuthority, 'Cara Lindqvist');
    const dee = await askableEmployee(tenantAuthority, 'Dee Mwangi');

    const overrides = {
      title: 'Vendor risk',
      knowledgeObjective: 'Which vendor carries the most compliance risk?',
    };
    // Both cover the subject equally; Dee merely KNOWS it, Cara has
    // experience with it — the weaker §7 relation.
    await seedTransactive(ctx, cara, 'has_experience_with', ['vendor', 'risk'], 'vendor risk');
    await seedTransactive(ctx, dee, 'knows', ['vendor', 'risk'], 'vendor risk');

    const menu = [
      { kind: 'person' as const, id: cara.id, label: 'Cara Lindqvist' },
      { kind: 'person' as const, id: dee.id, label: 'Dee Mwangi' },
    ];
    const missionOne = await seedMission(ctx, { candidateSources: menu, ...overrides });
    const first = await rankMissionSources(
      ctx,
      rankInput(missionOne.id, [
        policy('person', { id: cara.id, label: 'Cara Lindqvist' }),
        policy('person', { id: dee.id, label: 'Dee Mwangi' }),
      ]),
    );
    // Same relevance for both; authority decides: knows (0.7) > has_experience_with (0.6).
    expect(first.plan.chosen?.id).toBe(dee.id);

    // The evidence changes: Cara is recorded as DECIDING the subject.
    await seedTransactive(ctx, cara, 'decides', ['vendor'], 'vendor decisions');

    const missionTwo = await seedMission(ctx, { candidateSources: menu, ...overrides });
    const second = await rankMissionSources(
      ctx,
      rankInput(missionTwo.id, [
        policy('person', { id: cara.id, label: 'Cara Lindqvist' }),
        policy('person', { id: dee.id, label: 'Dee Mwangi' }),
      ]),
    );
    expect(second.plan.chosen?.id).toBe(cara.id); // ROUTING CHANGED

    // THE PERSISTED RATIONALE: only Cara's authority moved (0.6 → 1.0);
    // her relevance (matched topics unchanged) and Dee's whole
    // derivation are identical between the snapshots.
    const caraBefore = derivedOf(first.ranking, 'person', { id: cara.id });
    const caraAfter = derivedOf(second.ranking, 'person', { id: cara.id });
    expect(caraBefore.signals.authority).toBe(0.6);
    expect(caraAfter.signals.authority).toBe(1.0);
    expect(caraBefore.basis.relations).toEqual(['has_experience_with']);
    expect(caraAfter.basis.relations).toEqual(['decides', 'has_experience_with']);
    expect(caraAfter.signals.relevance).toBe(caraBefore.signals.relevance);
    expect(caraAfter.basis.matchedTopics).toEqual(caraBefore.basis.matchedTopics);
    expect(derivedOf(second.ranking, 'person', { id: dee.id })).toEqual(
      derivedOf(first.ranking, 'person', { id: dee.id }),
    );
  });

  it('COST: the explicit cost policy re-routes between equally evidenced sources', async () => {
    const ctx = member(tenantCost);
    const cheap = { kind: 'system' as const, label: 'cheap-api' };
    const rich = { kind: 'system' as const, label: 'rich-api' };
    // Identical evidence: two answered each, same confidence, same clock.
    for (const source of [cheap, rich]) {
      await seedOutcome(ctx, source, 'answered', { confidence: 0.8, observedAt: FIXED_NOW });
      await seedOutcome(ctx, source, 'answered', { confidence: 0.8, observedAt: FIXED_NOW });
    }

    const menu = [cheap, rich];
    // Equal cost policy: a full tie — the deterministic key order decides.
    const missionOne = await seedMission(ctx, { candidateSources: menu });
    const first = await rankMissionSources(
      ctx,
      rankInput(missionOne.id, [
        policy('system', { label: 'cheap-api' }),
        policy('system', { label: 'rich-api' }),
      ]),
    );
    expect(first.plan.chosen).toEqual({ kind: 'system', id: null, label: 'cheap-api' });

    // The policy changes: cheap-api now costs 100_00 of the 250_00
    // budget (cost share 0.4, penalty 0.06) — the ONLY thing that moved.
    const missionTwo = await seedMission(ctx, { candidateSources: menu });
    const second = await rankMissionSources(
      ctx,
      rankInput(missionTwo.id, [
        policy('system', { label: 'cheap-api' }, { cost: 100_00 }),
        policy('system', { label: 'rich-api' }),
      ]),
    );
    expect(second.plan.chosen).toEqual({ kind: 'system', id: null, label: 'rich-api' });

    const cheapBefore = derivedOf(first.ranking, 'system', { label: 'cheap-api' });
    const cheapAfter = derivedOf(second.ranking, 'system', { label: 'cheap-api' });
    expect(cheapBefore.score).toBeCloseTo(0.611667, 6);
    expect(cheapAfter.score).toBeCloseTo(0.551667, 6); // 0.611667 − 0.15·0.4
    expect(cheapAfter.signals.cost).toBe(100_00);
    expect(cheapBefore.signals.cost).toBe(0);
    expect(cheapAfter.costShare).toBe(0.4);
    // every learned signal is unchanged — cost is policy, never learned
    expect(cheapAfter.basis).toEqual(cheapBefore.basis);
    expect(cheapAfter.signals.reliability).toBe(cheapBefore.signals.reliability);
    expect(cheapAfter.signals.freshness).toBe(cheapBefore.signals.freshness);
    expect(derivedOf(second.ranking, 'system', { label: 'rich-api' })).toEqual(
      derivedOf(first.ranking, 'system', { label: 'rich-api' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Explicit policy vs learned state
// ---------------------------------------------------------------------------

describe('learned state never overrides explicit access policy (ADR-0018)', () => {
  it('excludes the best-evidenced source when its access scope is forbidden', async () => {
    const ctx = member(tenantPolicy);
    const eve = await askableEmployee(tenantPolicy, 'Eve Sørensen');
    // Eve's evidence is stellar: three confident answers + transactive
    // authority on the mission's subject.
    for (let i = 0; i < 3; i += 1) {
      await seedOutcome(ctx, { kind: 'person', id: eve.id, label: 'Eve Sørensen' }, 'answered', {
        confidence: 0.9,
        observedAt: FIXED_NOW,
      });
    }
    await seedTransactive(ctx, eve, 'decides', ['churn', 'q3'], 'churn in Q3');

    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'person', id: eve.id, label: 'Eve Sørensen' },
        { kind: 'system', label: 'weak-api' },
      ],
    });
    const { ranking, plan } = await rankMissionSources(
      ctx,
      rankInput(mission.id, [
        policy('person', { id: eve.id, label: 'Eve Sørensen' }, { access: 'forbidden' }),
        policy('system', { label: 'weak-api' }),
      ]),
    );

    // Learning happened: the ranking records Eve's strong derived signals…
    const eveDerived = derivedOf(ranking, 'person', { id: eve.id });
    expect(eveDerived.signals.reliability).toBeCloseTo(4 / 5, 6);
    expect(eveDerived.signals.expectedQuality).toBe(0.9);
    expect(eveDerived.signals.authority).toBe(1.0);
    expect(eveDerived.signals.relevance).toBeCloseTo(2 / 3, 6); // churn + q3 matched
    expect(eveDerived.signals.access).toBe('forbidden'); // …but the explicit policy stands
    // …and the planner excluded her for exactly that reason.
    const planEve = plan.ranked.find((entry) => entry.candidate.kind === 'person')!;
    expect(planEve.status).toBe('excluded');
    expect(planEve.exclusion).toBe('access_forbidden');
    expect(plan.chosen).toEqual({ kind: 'system', id: null, label: 'weak-api' });
  });

  it('decides no_candidate (persisted, planless) when policy forbids the only source', async () => {
    const ctx = member(tenantPolicy);
    const mission = await seedMission(ctx, {
      candidateSources: [{ kind: 'system', label: 'sealed-api' }],
    });
    const { ranking, plan } = await rankMissionSources(
      ctx,
      rankInput(mission.id, [policy('system', { label: 'sealed-api' }, { access: 'forbidden' })]),
    );
    expect(plan.decision).toBe('no_candidate');
    expect(ranking.decision).toBe('no_candidate');
    expect(ranking.planId).toBeNull();
    expect(ranking.derived).toHaveLength(1);
    // The no-candidate ranking is retrievable evidence like any other.
    const read = await getSourceRanking(ctx, ranking.id);
    expect(read.decision).toBe('no_candidate');
  });

  it('ranks an empty menu to no_candidate with an empty derivation', async () => {
    const ctx = member(tenantPolicy);
    const mission = await seedMission(ctx, { candidateSources: [] });
    const { ranking, plan } = await rankMissionSources(ctx, rankInput(mission.id, []));
    expect(plan.decision).toBe('no_candidate');
    expect(ranking.derived).toEqual([]);
    expect(ranking.subjectTopics).toEqual(
      missionSubjectTopicsOf(mission.content.title, mission.content.knowledgeObjective),
    );
  });
});

function missionSubjectTopicsOf(title: string, objective: string): string[] {
  // The pure derivation, imported through the contract, is the single
  // definition — the test compares the persisted snapshot against it.
  return kaContract.missionSubjectTopics(title, objective);
}

// ---------------------------------------------------------------------------
// The W051 posture (goal-gap missions rank like any other)
// ---------------------------------------------------------------------------

describe('the W051 posture (missions launched by goal-gap discovery)', () => {
  it('ranks a W051-shaped mission — a label-only person path beside a system path — through the shared missions contract', async () => {
    // W051 promotes goal gaps into missions whose candidate menu IS the
    // gap's acquisition paths (person paths are commonly label-only — a
    // role, not a resolved employee). This module imports nothing from
    // attention (attention → cognition → knowledge-acquisition would be
    // a migration-order cycle); the chain runs through the missions
    // contract, and this is the shape it produces.
    const ctx = member(tenantOrigin);
    const mission = await createMission(ctx, {
      ...missionInput({
        title: 'Churn segment breakdown',
        knowledgeObjective: 'Which customer segment drives the churn increase?',
      }),
      candidateSources: [
        { kind: 'person', label: 'Head of CX' }, // W051 proposal paths are label-only
        { kind: 'system', label: 'Billing CRM' },
      ],
      rationale: 'unprompted goal-gap discovery · gap churn|driver',
    });

    const { ranking, plan } = await rankMissionSources(
      ctx,
      rankInput(mission.id, [
        policy('person', { label: 'Head of CX' }),
        policy('system', { label: 'Billing CRM' }),
      ]),
    );
    // Both paths are derived and ranked on the same dimensions; the
    // label-only person is excluded by the planner's own gate (it cannot
    // be targeted at an employee) and the system path is selected.
    expect(ranking.derived).toHaveLength(2);
    expect(derivedOf(ranking, 'person', { label: 'Head of CX' }).signals.relevance).toBe(0.5);
    expect(plan.chosen).toEqual({ kind: 'system', id: null, label: 'Billing CRM' });
    const headOfCx = plan.ranked.find((entry) => entry.candidate.kind === 'person')!;
    expect(headOfCx.exclusion).toBe('person_unresolvable');
    // The chain is reconstructable across the two modules' records: the
    // mission's rationale names the gap, the ranking names the mission
    // and the plan, the plan carries the selection rationale.
    expect(mission.content.candidateSources).toEqual([
      { kind: 'person', id: null, label: 'Head of CX' },
      { kind: 'system', id: null, label: 'Billing CRM' },
    ]);
    expect(ranking.missionId).toBe(mission.id);
    expect(ranking.planId).toBe(plan.id);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('never leaks another tenant\u2019s rankings — or its learned track records', async () => {
    const ctxX = member(tenantIsoX);
    const ctxY = member(tenantIsoY);
    // Tenant X's 'billing-export' has an answered history; tenant Y's
    // same-labeled source has none.
    await seedOutcome(ctxX, { kind: 'system', label: 'billing-export' }, 'answered');

    const missionX = await seedMission(ctxX, {
      candidateSources: [{ kind: 'system', label: 'billing-export' }],
    });
    const inX = await rankMissionSources(
      ctxX,
      rankInput(missionX.id, [policy('system', { label: 'billing-export' })]),
    );
    expect(derivedOf(inX.ranking, 'system', { label: 'billing-export' }).basis.outcomes).toEqual({
      answered: 1,
      unavailable: 0,
      failed: 0,
    });

    // Tenant Y ranks the same-labeled source: NO track record leaks —
    // its derivation is built from tenant Y's (empty) evidence only.
    const missionY = await seedMission(ctxY, {
      candidateSources: [{ kind: 'system', label: 'billing-export' }],
    });
    const inY = await rankMissionSources(
      ctxY,
      rankInput(missionY.id, [policy('system', { label: 'billing-export' })]),
    );
    expect(derivedOf(inY.ranking, 'system', { label: 'billing-export' }).basis.outcomes).toEqual({
      answered: 0,
      unavailable: 0,
      failed: 0,
    });
    expect(derivedOf(inY.ranking, 'system', { label: 'billing-export' }).signals.reliability).toBe(0.5);

    // Cross-tenant reads are indistinguishable from missing records.
    await expectCode('ranking_not_found', () => getSourceRanking(ctxY, inX.ranking.id));
    await expectCode('ranking_not_found', () => getSourceRanking(ctxX, newId()));
    await expectCode('mission_not_found', () =>
      rankMissionSources(ctxY, rankInput(missionX.id, [policy('system', { label: 'billing-export' })])),
    );
    // Lists stay tenant-scoped.
    const feedY = await listSourceRankings(ctxY, {});
    expect(feedY.map((ranking) => ranking.id)).not.toContain(inX.ranking.id);
    expect(feedY.map((ranking) => ranking.tenantId)).toEqual([tenantIsoY]);
  });
});

// ---------------------------------------------------------------------------
// Append-only storage
// ---------------------------------------------------------------------------

describe('append-only storage (triggers reject mutation)', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on source_rankings', async () => {
    const ctx = member(tenantAppendOnly);
    const mission = await seedMission(ctx, {
      candidateSources: [{ kind: 'system', label: 'any-api' }],
    });
    const { ranking } = await rankMissionSources(
      ctx,
      rankInput(mission.id, [policy('system', { label: 'any-api' })]),
    );
    await expect(
      getDb().query(`UPDATE source_rankings SET rationale = 'rewritten'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(`DELETE FROM source_rankings WHERE id = $1`, [ranking.id]),
    ).rejects.toThrow(/append-only/);
    await expect(getDb().query(`TRUNCATE TABLE source_rankings`)).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Reads + input guards
// ---------------------------------------------------------------------------

describe('reads (getSourceRanking / listSourceRankings)', () => {
  it('round-trips the full record and lists by mission/decision, latest first', async () => {
    const ctx = member(tenantReads);
    const missionA = await seedMission(ctx, {
      candidateSources: [{ kind: 'system', label: 'ledger-api' }],
    });
    const missionB = await seedMission(ctx, {
      candidateSources: [{ kind: 'system', label: 'ledger-api' }],
    });

    const first = await rankMissionSources(
      ctx,
      rankInput(missionA.id, [policy('system', { label: 'ledger-api' })], 'nightly pass'),
    );
    // A later pass at a later instant (the evaluation clock moves).
    setClock('2026-09-14T13:00:00.000Z');
    const second = await rankMissionSources(
      ctx,
      rankInput(missionB.id, [policy('system', { label: 'ledger-api' })], 'morning pass'),
    );
    expect(second.ranking.recordedAt).toBe('2026-09-14T13:00:00.000Z');

    const read = await getSourceRanking(ctx, second.ranking.id);
    expect(read).toEqual(second.ranking);
    expect(read.rationale).toBe('morning pass');
    expect(read.derived).toHaveLength(1);

    // The tenant feed, latest first; the per-mission feed stays scoped.
    const feed = await listSourceRankings(ctx, {});
    expect(feed.map((ranking) => ranking.id)).toEqual([second.ranking.id, first.ranking.id]);
    const feedA = await listSourceRankings(ctx, { missionId: missionA.id });
    expect(feedA.map((ranking) => ranking.id)).toEqual([first.ranking.id]);

    // Re-ranking the SAME mission: the planner's lock-17 gate excludes
    // the candidate the first pass already chose — the ranking records
    // the no_candidate decision (planless), which the decision filter finds.
    const again = await rankMissionSources(
      ctx,
      rankInput(missionA.id, [policy('system', { label: 'ledger-api' })]),
    );
    expect(again.ranking.decision).toBe('no_candidate');
    expect(again.ranking.planId).toBeNull();
    const selectedOnly = await listSourceRankings(ctx, { decision: 'no_candidate' });
    expect(selectedOnly.map((ranking) => ranking.id)).toEqual([again.ranking.id]);

    await expectCode('ranking_not_found', () => getSourceRanking(ctx, 'not-a-uuid'));
    await expectCode('invalid_query', () => listSourceRankings(ctx, { nope: 1 } as never));
    await expectCode('invalid_query', () => listSourceRankings(ctx, { limit: 0 }));
  });
});

describe('input guards (the ranking input carries policy, never signals)', () => {
  it('rejects malformed inputs with invalid_ranking_input', async () => {
    const ctx = member(tenantGuards);
    const mission = await seedMission(ctx, {
      candidateSources: [{ kind: 'system', label: 'ledger-api' }],
    });
    const base = rankInput(mission.id, [policy('system', { label: 'ledger-api' })]);

    // unknown key (learned signals can never be smuggled in)
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, { ...base, policies: [{ ...base.policies[0]!, relevance: 0.9 }] } as never),
    );
    // bad access vocabulary / negative cost / untraceable target
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, rankInput(mission.id, [
        policy('system', { label: 'ledger-api' }, { access: 'maybe' as never }),
      ])),
    );
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, rankInput(mission.id, [policy('system', { label: 'ledger-api' }, { cost: -1 })])),
    );
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, rankInput(mission.id, [{ kind: 'system', id: null, label: null, cost: 0, access: 'allowed' }])),
    );
    // duplicate policy for one candidate
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, rankInput(mission.id, [
        policy('system', { label: 'ledger-api' }),
        policy('system', { label: 'ledger-api' }),
      ])),
    );
    // malformed actor / mission id
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, { ...base, actor: { kind: 'robot', label: 'x' } } as never),
    );
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, rankInput('not-a-uuid', [])),
    );
  });

  it('requires policy coverage of exactly the mission menu (missing and extra are rejected)', async () => {
    const ctx = member(tenantGuards);
    const mission = await seedMission(ctx, {
      candidateSources: [
        { kind: 'system', label: 'ledger-api' },
        { kind: 'document', label: 'Q3 pricing memo' },
      ],
    });
    // missing coverage
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, rankInput(mission.id, [policy('system', { label: 'ledger-api' })])),
    );
    // extra policy
    await expectCode('invalid_ranking_input', () =>
      rankMissionSources(ctx, rankInput(mission.id, [
        policy('system', { label: 'ledger-api' }),
        policy('document', { label: 'Q3 pricing memo' }),
        policy('external', { label: 'churn benchmark' }),
      ])),
    );
    // full coverage is accepted
    const { ranking } = await rankMissionSources(
      ctx,
      rankInput(mission.id, [
        policy('system', { label: 'ledger-api' }),
        policy('document', { label: 'Q3 pricing memo' }),
      ]),
    );
    expect(ranking.derived).toHaveLength(2);
  });

  it('rejects unknown and terminal missions (no leak, no ranking of the finished)', async () => {
    const ctx = member(tenantGuards);
    await expectCode('mission_not_found', () =>
      rankMissionSources(ctx, rankInput(newId(), [])),
    );
    const terminal = await seedMission(ctx, {
      candidateSources: [{ kind: 'system', label: 'ledger-api' }],
    });
    await completeMission(ctx, {
      missionId: terminal.id,
      achievedConfidence: 0.9,
      outcome: 'Answered elsewhere.',
      actor: { kind: 'person', label: 'COO' },
    });
    await expectCode('mission_not_active', () =>
      rankMissionSources(ctx, rankInput(terminal.id, [policy('system', { label: 'ledger-api' })])),
    );
  });

  it('rejects a malformed context (invalid_context)', async () => {
    const mission = await seedMission(member(tenantGuards), {
      candidateSources: [{ kind: 'system', label: 'ledger-api' }],
    });
    await expectCode('invalid_context', () =>
      rankMissionSources(
        { tenantId: '', principalId: newId(), authority: [] },
        rankInput(mission.id, [policy('system', { label: 'ledger-api' })]),
      ),
    );
  });
});
