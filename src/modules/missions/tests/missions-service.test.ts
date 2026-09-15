// Integration tests for the missions module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W011 acceptance:
//
//  * FIRST-CLASS missions with the full work-item field set ("knowledge
//    objective, affected goals, information value, urgency, target
//    confidence, budget, candidate sources/people, rewards and completion
//    criteria"):
//      - create round-trips every field; defaults apply; identity,
//        version, status, change kind, commit time and acting principal
//        are system-minted;
//      - affected goals are opaque forward references (no goals-module
//        coupling, no cross-module FK);
//      - epistemic unknown references are validated through the
//        epistemics contract: readable unknowns link, missing and
//        foreign-tenant unknown ids are uniformly invalid_unknown_ref
//        (no existence leak) — on create AND on unknown-changing
//        revisions;
//      - budgets are integer minor units + currency.
//  * VERSIONED/AUDITABLE mission changes (the goals W008 discipline):
//      - a mission is an identity plus an append-only chain of
//        full-snapshot versions; revising appends version N+1, carries
//        untouched fields over, replaces arrays wholesale, and the merged
//        snapshot is re-validated like a fresh create (gap rule spans
//        patch and current);
//      - every version records who (actor + authenticated principal),
//        when (recorded_at), what (change_kind + self-contained snapshot)
//        and why (rationale); the trail is listable ascending and
//        deep-linkable;
//      - the storage layer rejects UPDATE/DELETE/TRUNCATE on versions and
//        DELETE/TRUNCATE on missions outright (triggers) — history cannot
//        be rewritten even by a caller bypassing the service;
//      - a raced version append fails cleanly with mission_conflict.
//  * LIFECYCLE: completeMission (active → completed) is a surgical
//    terminal version carrying the completion record (achieved confidence
//    + outcome); abandonMission (active → abandoned) requires a reason;
//    terminal states accept nothing.
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).
//  * the management listing: urgency-rank ordering and the status /
//    urgency / affected-goal / unknown / candidate / search filters over
//    CURRENT versions.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { recordUnknown } from '@/modules/epistemics/contract';
import { MissionsError } from '../errors';
import * as missionsContract from '../contract';
import type { CreateMissionInput, Mission } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  abandonMission,
  completeMission,
  createMission,
  getMission,
  getMissionVersion,
  listMissionVersions,
  listMissions,
  reviseMission,
} = missionsContract;

// Dedicated tenants keep each concern's data isolated from the others, so
// every assertion below sees only what it created itself.
const tenantA = newId();
const tenantB = newId();
const tenantIso = newId();
const tenantLifecycle = newId();
const tenantAudit = newId();
const tenantConflict = newId();
const tenantList = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const PERSON_ID_2 = '5a7d3e9f-6b1c-4d2a-8e4b-3f5c7d9e1a2b';
const GOAL_ID_1 = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const GOAL_ID_2 = '2d4b0a5c-3e6d-4fac-9b5a-9c4d8e7f6a1b';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(MissionsError);
    expect((error as MissionsError).code).toBe(code);
  }
}

/** Seeds one epistemics unknown in `ctx`'s tenant (the validated ref source). */
async function seedUnknown(ctx: TenantContext, question: string): Promise<string> {
  const unknown = await recordUnknown(ctx, {
    question,
    consequence: 'Churn reduction decisions cannot be prioritized without it.',
  });
  return unknown.id;
}

/** A full W011 definition, parameterized for the suites below. */
function missionInput(overrides: Partial<CreateMissionInput> = {}): CreateMissionInput {
  return {
    title: 'Churn root cause',
    knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
    affectedGoals: [{ goalId: GOAL_ID_1, label: 'Q4 churn reduction' }],
    unknownIds: [],
    informationValue: 0.8,
    urgency: 'high',
    currentConfidence: 0.1,
    targetConfidence: 0.85,
    investigationBudget: { amount: 250_00, currency: 'EUR' },
    rewardBudget: { amount: 50_00, currency: 'EUR' },
    rewardTerms: 'A validated root-cause contribution earns a bonus.',
    candidateSources: [
      { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
      { kind: 'system', label: 'billing-export' },
    ],
    completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'goal-gap-2026-09',
    ...overrides,
  };
}

async function seedMission(
  ctx: TenantContext,
  overrides: Partial<CreateMissionInput> = {},
): Promise<Mission> {
  return createMission(ctx, missionInput(overrides));
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', async () => {
    // There is deliberately no updateMissionVersion, no deleteMission, no
    // eraseHistory and no setStatus shortcut: revising appends, lifecycle
    // transitions are dedicated surgical operations, and erasure is
    // impossible by trigger.
    expect(Object.keys(missionsContract).sort()).toEqual([
      'DEFAULT_LIST_LIMIT',
      'MAX_AFFECTED_GOALS',
      'MAX_BUDGET_AMOUNT',
      'MAX_CANDIDATE_SOURCES',
      'MAX_COMPLETION_CRITERIA_LENGTH',
      'MAX_KNOWLEDGE_OBJECTIVE_LENGTH',
      'MAX_LIST_LIMIT',
      'MAX_PARTY_LABEL_LENGTH',
      'MAX_RATIONALE_LENGTH',
      'MAX_REASON_LENGTH',
      'MAX_REWARD_TERMS_LENGTH',
      'MAX_SEARCH_LENGTH',
      'MAX_TITLE_LENGTH',
      'MAX_UNKNOWN_REFS',
      'MISSION_CANDIDATE_KINDS',
      'MISSION_CHANGE_KINDS',
      'MISSION_PARTY_KINDS',
      'MISSION_STATUSES',
      'MISSION_URGENCIES',
      'MissionsError',
      'abandonMission',
      'completeMission',
      'createMission',
      'escapeLike',
      'getMission',
      'getMissionVersion',
      'isMissionCandidateKind',
      'isMissionChangeKind',
      'isMissionPartyKind',
      'isMissionStatus',
      'isMissionUrgency',
      'isUuid',
      'listMissionVersions',
      'listMissions',
      'reviseMission',
    ]);
  });
});

describe('createMission / getMission (the W011 definition, version 1)', () => {
  it('defines a mission with system-minted identity, version and audit fields', async () => {
    const ctx = member(tenantA);
    const before = new Date();
    const mission = await createMission(ctx, missionInput());
    const after = new Date();

    expect(mission.version).toBe(1);
    expect(mission.content.status).toBe('active'); // minted, not caller-chosen
    expect(mission.completion).toBeNull(); // only a completed mission carries one
    expect(mission.lastChange.kind).toBe('created');
    expect(mission.lastChange.actor).toEqual({ kind: 'person', id: PERSON_ID, label: null });
    expect(mission.lastChange.changedByPrincipal).toBe(ctx.principalId);
    expect(mission.lastChange.rationale).toBe('goal-gap-2026-09');
    for (const stamp of [mission.createdAt, mission.updatedAt, mission.lastChange.recordedAt]) {
      expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before.getTime());
      expect(Date.parse(stamp)).toBeLessThanOrEqual(after.getTime());
    }
    expect(mission.updatedAt).toBe(mission.lastChange.recordedAt);
  });

  it('round-trips the full W011 field set — objective, affected goals, information value, urgency, confidences, budgets, rewards, candidates, completion criteria', async () => {
    const ctx = member(tenantA);
    const mission = await createMission(
      ctx,
      missionInput({
        urgency: 'critical',
        candidateSources: [
          { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
          { kind: 'system', label: 'billing-export' },
          { kind: 'document', label: 'Q3 pricing memo' },
          { kind: 'external', label: 'industry churn benchmark' },
          { kind: 'agent', label: 'churn-analyst' },
          { kind: 'analysis', label: 'cohort churn model' },
        ],
      }),
    );
    expect(mission.content.title).toBe('Churn root cause');
    expect(mission.content.knowledgeObjective).toBe(
      'Why did churn rise in Q3 and what is the dominant driver?',
    );
    expect(mission.content.affectedGoals).toEqual([
      { goalId: GOAL_ID_1, label: 'Q4 churn reduction' },
    ]);
    expect(mission.content.informationValue).toBe(0.8);
    expect(mission.content.urgency).toBe('critical');
    expect(mission.content.currentConfidence).toBe(0.1);
    expect(mission.content.targetConfidence).toBe(0.85);
    expect(mission.content.investigationBudget).toEqual({ amount: 250_00, currency: 'EUR' });
    expect(mission.content.rewardBudget).toEqual({ amount: 50_00, currency: 'EUR' });
    expect(mission.content.rewardTerms).toBe(
      'A validated root-cause contribution earns a bonus.',
    );
    expect(mission.content.candidateSources).toEqual([
      { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
      { kind: 'system', id: null, label: 'billing-export' },
      { kind: 'document', id: null, label: 'Q3 pricing memo' },
      { kind: 'external', id: null, label: 'industry churn benchmark' },
      { kind: 'agent', id: null, label: 'churn-analyst' },
      { kind: 'analysis', id: null, label: 'cohort churn model' },
    ]);
    expect(mission.content.completionCriteria).toBe(
      'A validated root-cause explanation with confidence >= 0.85.',
    );

    const read = await getMission(ctx, mission.id);
    expect(read).toEqual(mission);
  });

  it('applies the empty defaults (affected goals, unknowns, candidates, reward terms; current confidence 0)', async () => {
    const ctx = member(tenantA);
    const input = missionInput();
    delete input.affectedGoals;
    delete input.unknownIds;
    delete input.candidateSources;
    delete input.rewardTerms;
    delete input.currentConfidence;
    delete input.rationale;
    const mission = await createMission(ctx, input);
    expect(mission.content.affectedGoals).toEqual([]);
    expect(mission.content.unknownIds).toEqual([]);
    expect(mission.content.candidateSources).toEqual([]);
    expect(mission.content.rewardTerms).toBeNull();
    expect(mission.content.currentConfidence).toBe(0);
    expect(mission.lastChange.rationale).toBeNull();
  });

  it('reports unknown, malformed and foreign-tenant ids as mission_not_found (no leak)', async () => {
    const ctx = member(tenantA);
    await seedMission(ctx);
    await expectCode('mission_not_found', () => getMission(ctx, newId()));
    await expectCode('mission_not_found', () => getMission(ctx, 'not-a-uuid'));
    await expectCode('mission_not_found', () => getMission(member(tenantB), 'not-a-uuid'));
  });
});

describe('unknown references (the sanctioned epistemics dependency)', () => {
  it('links a mission to readable epistemics unknowns', async () => {
    const ctx = member(tenantA);
    const unknownA = await seedUnknown(ctx, 'Which pricing tier drives the churn spike?');
    const unknownB = await seedUnknown(ctx, 'Did the Q3 onboarding change affect retention?');
    const mission = await createMission(
      ctx,
      missionInput({ unknownIds: [unknownA, unknownB, unknownA] }), // duplicates normalize away
    );
    expect(mission.content.unknownIds).toEqual([unknownA, unknownB].sort());

    const revised = await reviseMission(ctx, {
      missionId: mission.id,
      unknownIds: [unknownB], // wholesale replacement, revalidated
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'narrowed to the onboarding question',
    });
    expect(revised.content.unknownIds).toEqual([unknownB]);
  });

  it('rejects missing unknown ids uniformly as invalid_unknown_ref — on create and on revision', async () => {
    const ctx = member(tenantA);
    const unknown = await seedUnknown(ctx, 'Is the supplier single-sourced?');

    await expectCode('invalid_unknown_ref', () =>
      createMission(ctx, missionInput({ unknownIds: [newId()] })),
    );
    const mission = await seedMission(ctx);
    await expectCode('invalid_unknown_ref', () =>
      reviseMission(ctx, {
        missionId: mission.id,
        unknownIds: [unknown, newId()],
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    // nothing was appended by the failed revision
    expect((await listMissionVersions(ctx, { missionId: mission.id })).length).toBe(1);
  });

  it('treats a foreign tenant\'s unknown exactly like a missing one (no leak)', async () => {
    const ctxA = member(tenantA);
    const foreignUnknown = await seedUnknown(member(tenantB), 'B-only question?');
    await expectCode('invalid_unknown_ref', () =>
      createMission(ctxA, missionInput({ unknownIds: [foreignUnknown] })),
    );
  });
});

describe('reviseMission (append-only versioning of the definition)', () => {
  it('appends version 2 and carries untouched fields over', async () => {
    const ctx = member(tenantA);
    const original = await seedMission(ctx);

    const revised = await reviseMission(ctx, {
      missionId: original.id,
      title: 'Churn root cause (refined)',
      urgency: 'critical',
      investigationBudget: { amount: 500_00, currency: 'EUR' },
      currentConfidence: 0.4,
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'budget raised after the first interview',
    });

    expect(revised.version).toBe(2);
    expect(revised.lastChange.kind).toBe('revised');
    expect(revised.lastChange.rationale).toBe('budget raised after the first interview');
    expect(revised.createdAt).toBe(original.createdAt); // identity unchanged
    expect(Date.parse(revised.updatedAt)).toBeGreaterThanOrEqual(Date.parse(original.updatedAt));

    // changed fields
    expect(revised.content.title).toBe('Churn root cause (refined)');
    expect(revised.content.urgency).toBe('critical');
    expect(revised.content.investigationBudget).toEqual({ amount: 500_00, currency: 'EUR' });
    expect(revised.content.currentConfidence).toBe(0.4); // progress is versioned content
    // untouched fields carry over exactly
    expect(revised.content.knowledgeObjective).toBe(original.content.knowledgeObjective);
    expect(revised.content.affectedGoals).toEqual(original.content.affectedGoals);
    expect(revised.content.unknownIds).toEqual(original.content.unknownIds);
    expect(revised.content.informationValue).toBe(original.content.informationValue);
    expect(revised.content.targetConfidence).toBe(original.content.targetConfidence);
    expect(revised.content.rewardBudget).toEqual(original.content.rewardBudget);
    expect(revised.content.rewardTerms).toBe(original.content.rewardTerms);
    expect(revised.content.candidateSources).toEqual(original.content.candidateSources);
    expect(revised.content.completionCriteria).toBe(original.content.completionCriteria);

    expect(await getMission(ctx, original.id)).toEqual(revised);
  });

  it('replaces arrays wholesale (affected goals and candidates)', async () => {
    const ctx = member(tenantA);
    const mission = await seedMission(ctx);

    const revised = await reviseMission(ctx, {
      missionId: mission.id,
      affectedGoals: [{ goalId: GOAL_ID_2 }],
      candidateSources: [{ kind: 'person', id: PERSON_ID_2 }],
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(revised.content.affectedGoals).toEqual([{ goalId: GOAL_ID_2, label: null }]);
    expect(revised.content.candidateSources).toEqual([
      { kind: 'person', id: PERSON_ID_2, label: null },
    ]);
  });

  it('revalidates the merged content — the gap rule spans patch and current', async () => {
    const ctx = member(tenantA);
    const mission = await seedMission(ctx); // current 0.1 → target 0.85

    // patch would raise current past the carried-over target
    await expectCode('invalid_revision_input', () =>
      reviseMission(ctx, {
        missionId: mission.id,
        currentConfidence: 0.85,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    // patch would lower the target to the carried-over current
    await expectCode('invalid_revision_input', () =>
      reviseMission(ctx, {
        missionId: mission.id,
        targetConfidence: 0.1,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    // equal target/current is equally not a gap
    await expectCode('invalid_revision_input', () =>
      reviseMission(ctx, {
        missionId: mission.id,
        currentConfidence: 0.8,
        targetConfidence: 0.8,
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    // nothing was appended by the failed revisions
    expect((await listMissionVersions(ctx, { missionId: mission.id })).length).toBe(1);
  });

  it('treats rewardTerms as tri-state (omitted / null clears / string sets)', async () => {
    const ctx = member(tenantA);
    const mission = await seedMission(ctx); // rewardTerms set
    expect(mission.content.rewardTerms).toBe('A validated root-cause contribution earns a bonus.');

    const cleared = await reviseMission(ctx, {
      missionId: mission.id,
      rewardTerms: null,
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(cleared.content.rewardTerms).toBeNull();

    const set = await reviseMission(ctx, {
      missionId: mission.id,
      rewardTerms: 'Doubled for a validated root cause.',
      actor: { kind: 'person', id: PERSON_ID },
    });
    expect(set.content.rewardTerms).toBe('Doubled for a validated root cause.');
  });

  it('records the audit quartet on each revision (who/when/what/why)', async () => {
    const ctx = member(tenantA);
    const mission = await seedMission(ctx);
    const principal = newId();
    const before = new Date();
    const revised = await reviseMission(
      memberAs(ctx.tenantId, principal),
      {
        missionId: mission.id,
        knowledgeObjective: 'Which pricing tier drives the churn spike, and since when?',
        actor: { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
        rationale: 'question sharpened after the first interview',
      },
    );
    const after = new Date();

    expect(revised.lastChange.actor).toEqual({
      kind: 'person',
      id: PERSON_ID,
      label: 'VP Customer Success',
    });
    expect(revised.lastChange.changedByPrincipal).toBe(principal);
    expect(revised.lastChange.rationale).toBe('question sharpened after the first interview');
    expect(Date.parse(revised.lastChange.recordedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(revised.lastChange.recordedAt)).toBeLessThanOrEqual(after.getTime());
    // the previous version's audit record is untouched
    const v1 = await getMissionVersion(ctx, { missionId: mission.id, version: 1 });
    expect(v1.changedByPrincipal).toBe(mission.lastChange.changedByPrincipal);
  });

  it('rejects empty revisions and revisions that smuggle lifecycle fields', async () => {
    const ctx = member(tenantA);
    const mission = await seedMission(ctx);
    await expectCode('invalid_revision_input', () =>
      reviseMission(ctx, { missionId: mission.id, actor: { kind: 'person', id: PERSON_ID } }),
    );
    await expectCode('invalid_revision_input', () =>
      reviseMission(ctx, {
        missionId: mission.id,
        status: 'completed', // not a revision field — dedicated operations only
        actor: { kind: 'person', id: PERSON_ID },
      } as never),
    );
  });
});

describe('lifecycle (completeMission / abandonMission)', () => {
  it('completes an active mission with a surgical version carrying the completion record', async () => {
    const ctx = member(tenantLifecycle);
    const mission = await seedMission(ctx);
    const principal = newId();

    const completed = await completeMission(memberAs(ctx.tenantId, principal), {
      missionId: mission.id,
      achievedConfidence: 0.9,
      outcome: 'Pricing-driven churn concentrated in the SME tier; onboarding was exonerated.',
      actor: { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
    });

    expect(completed.version).toBe(2);
    expect(completed.content.status).toBe('completed');
    expect(completed.lastChange.kind).toBe('completed');
    expect(completed.lastChange.changedByPrincipal).toBe(principal);
    expect(completed.lastChange.rationale).toBeNull(); // the why is the structured outcome
    expect(completed.completion).toEqual({
      achievedConfidence: 0.9,
      outcome: 'Pricing-driven churn concentrated in the SME tier; onboarding was exonerated.',
    });
    // the content snapshot is carried over frozen
    expect(completed.content.title).toBe(mission.content.title);
    expect(completed.content.targetConfidence).toBe(mission.content.targetConfidence);

    expect(await getMission(ctx, mission.id)).toEqual(completed);

    // the completion record lives on the completed version only
    const v2 = await getMissionVersion(ctx, { missionId: mission.id, version: 2 });
    expect(v2.completion).toEqual(completed.completion);
    const v1 = await getMissionVersion(ctx, { missionId: mission.id, version: 1 });
    expect(v1.completion).toBeNull();
  });

  it('abandons an active mission with a required reason on the audit trail', async () => {
    const ctx = member(tenantLifecycle);
    const mission = await seedMission(ctx, { title: 'Supplier concentration' });

    const abandoned = await abandonMission(ctx, {
      missionId: mission.id,
      reason: 'the affected goal was archived',
      actor: { kind: 'person', id: PERSON_ID },
    });

    expect(abandoned.version).toBe(2);
    expect(abandoned.content.status).toBe('abandoned');
    expect(abandoned.lastChange.kind).toBe('abandoned');
    expect(abandoned.lastChange.rationale).toBe('the affected goal was archived');
    expect(abandoned.completion).toBeNull(); // abandonment is not completion
  });

  it('terminal states accept nothing — completed/abandoned missions are dead ends', async () => {
    const ctx = member(tenantLifecycle);
    const toComplete = await seedMission(ctx, { title: 'To complete' });
    await completeMission(ctx, {
      missionId: toComplete.id,
      achievedConfidence: 0.9,
      outcome: 'Answered.',
      actor: { kind: 'person', id: PERSON_ID },
    });

    await expectCode('invalid_transition', () =>
      reviseMission(ctx, {
        missionId: toComplete.id,
        title: 'no more revisions',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('invalid_transition', () =>
      completeMission(ctx, {
        missionId: toComplete.id,
        achievedConfidence: 0.95,
        outcome: 'again',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('invalid_transition', () =>
      abandonMission(ctx, {
        missionId: toComplete.id,
        reason: 'not after completion',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );

    const toAbandon = await seedMission(ctx, { title: 'To abandon' });
    await abandonMission(ctx, {
      missionId: toAbandon.id,
      reason: 'overtaken by events',
      actor: { kind: 'person', id: PERSON_ID },
    });
    await expectCode('invalid_transition', () =>
      reviseMission(ctx, {
        missionId: toAbandon.id,
        title: 'no more revisions',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('invalid_transition', () =>
      completeMission(ctx, {
        missionId: toAbandon.id,
        achievedConfidence: 0.5,
        outcome: 'not after abandonment',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );

    // both missions are untouched at version 2
    expect((await getMission(ctx, toComplete.id)).version).toBe(2);
    expect((await getMission(ctx, toAbandon.id)).version).toBe(2);
  });
});

describe('audit trail and storage immutability', () => {
  it('lists the audit trail ascending and deep-links any version', async () => {
    const ctx = member(tenantAudit);
    const mission = await seedMission(ctx);
    await reviseMission(ctx, {
      missionId: mission.id,
      currentConfidence: 0.4,
      actor: { kind: 'person', id: PERSON_ID },
    });
    await reviseMission(ctx, {
      missionId: mission.id,
      currentConfidence: 0.6,
      actor: { kind: 'person', id: PERSON_ID },
    });

    const trail = await listMissionVersions(ctx, { missionId: mission.id });
    expect(trail.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(trail.map((version) => version.changeKind)).toEqual(['created', 'revised', 'revised']);
    // strictly increasing commit times, distinct version-row ids
    for (let index = 1; index < trail.length; index += 1) {
      expect(Date.parse(trail[index]!.recordedAt)).toBeGreaterThanOrEqual(
        Date.parse(trail[index - 1]!.recordedAt),
      );
      expect(trail[index]!.id).not.toBe(trail[index - 1]!.id);
    }
    // each version is a self-contained snapshot of the progress
    expect(trail.map((version) => version.content.currentConfidence)).toEqual([0.1, 0.4, 0.6]);

    const v2 = await getMissionVersion(ctx, { missionId: mission.id, version: 2 });
    expect(v2.content.currentConfidence).toBe(0.4);
    await expectCode('mission_version_not_found', () =>
      getMissionVersion(ctx, { missionId: mission.id, version: 4 }),
    );
  });

  it('rejects UPDATE/DELETE/TRUNCATE on versions and DELETE/TRUNCATE on missions at the storage level', async () => {
    const ctx = member(tenantAudit);
    const mission = await seedMission(ctx);

    await expect(
      getDb().query(`UPDATE mission_versions SET title = 'hacked' WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]),
    ).rejects.toThrow(/mission versions are append-only/);
    await expect(
      getDb().query(`DELETE FROM mission_versions WHERE tenant_id = $1`, [ctx.tenantId]),
    ).rejects.toThrow(/mission versions are append-only/);
    await expect(getDb().query(`TRUNCATE mission_versions`)).rejects.toThrow(
      /mission versions are append-only/,
    );
    await expect(
      getDb().query(`DELETE FROM missions WHERE tenant_id = $1`, [ctx.tenantId]),
    ).rejects.toThrow(/missions cannot be erased/);
    await expect(getDb().query(`TRUNCATE missions`)).rejects.toThrow(
      /missions cannot be erased|cannot truncate/i,
    );

    // the mission is untouched by the rejected mutations
    const after = await getMission(ctx, mission.id);
    expect(after.version).toBe(1);
    expect(after.content.title).toBe('Churn root cause');
  });
});

describe('concurrent writers (the version chain stays gapless)', () => {
  it('loses cleanly with mission_conflict when a concurrent writer appended first', async () => {
    const ctx = member(tenantConflict);
    const mission = await seedMission(ctx);

    // A caller that bypassed the service appended version 2 directly; the
    // pointer still reads 1, so the racing revision passes the optimistic
    // pointer guard and must be stopped by the version uniqueness.
    await getDb().query(
      `INSERT INTO mission_versions (
         tenant_id, mission_id, version, change_kind,
         title, knowledge_objective, information_value, urgency,
         current_confidence, target_confidence,
         investigation_budget_amount, investigation_budget_currency,
         reward_budget_amount, reward_budget_currency,
         completion_criteria, status,
         actor_kind, actor_label, changed_by_principal
       ) VALUES (
         $1, $2, 2, 'revised',
         'raced', 'raced', 0.5, 'low',
         0, 0.9,
         0, 'EUR', 0, 'EUR',
         'raced', 'active',
         'system', 'race', 'race'
       )`,
      [mission.tenantId, mission.id],
    );

    await expectCode('mission_conflict', () =>
      reviseMission(ctx, {
        missionId: mission.id,
        title: 'loser of the race',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    // the failed revision rolled back completely: the current version is
    // still version 1 with its original content
    const after = await getMission(ctx, mission.id);
    expect(after.version).toBe(1);
    expect(after.content.title).toBe('Churn root cause');
  });
});

describe('tenant isolation (ADR-0001)', () => {
  it('another tenant cannot read, revise, complete, abandon or audit a mission', async () => {
    const ctxA = member(tenantIso);
    const mission = await seedMission(ctxA);
    await reviseMission(ctxA, {
      missionId: mission.id,
      title: 'A-only revision',
      actor: { kind: 'person', id: PERSON_ID },
    });

    const ctxB = member(tenantB);
    await expectCode('mission_not_found', () => getMission(ctxB, mission.id));
    await expectCode('mission_not_found', () =>
      reviseMission(ctxB, {
        missionId: mission.id,
        title: 'B trying to revise A mission',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('mission_not_found', () =>
      completeMission(ctxB, {
        missionId: mission.id,
        achievedConfidence: 0.9,
        outcome: 'no',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('mission_not_found', () =>
      abandonMission(ctxB, {
        missionId: mission.id,
        reason: 'no',
        actor: { kind: 'person', id: PERSON_ID },
      }),
    );
    await expectCode('mission_version_not_found', () =>
      getMissionVersion(ctxB, { missionId: mission.id, version: 1 }),
    );
    await expectCode('mission_not_found', () => listMissionVersions(ctxB, { missionId: mission.id }));
    expect(await listMissions(ctxB, {})).toEqual([]);

    // A's mission is intact and unreachable-into
    const after = await getMission(ctxA, mission.id);
    expect(after.version).toBe(2);
    expect(after.content.title).toBe('A-only revision');
  });

  it('same-named missions in different tenants stay independent', async () => {
    // fresh tenants so earlier seeds (which share the default knowledge
    // objective) cannot pollute the search result
    const ctxA = member(newId());
    const ctxB = member(newId());
    const missionA = await seedMission(ctxA);
    const missionB = await seedMission(ctxB);

    await reviseMission(ctxA, {
      missionId: missionA.id,
      urgency: 'critical',
      actor: { kind: 'person', id: PERSON_ID },
    });

    const inA = await listMissions(ctxA, { search: 'churn' });
    expect(inA.map((mission) => mission.id)).toEqual([missionA.id]);
    expect(inA[0]!.version).toBe(2);
    const inB = await listMissions(ctxB, { search: 'churn' });
    expect(inB.map((mission) => mission.id)).toEqual([missionB.id]);
    expect(inB[0]!.version).toBe(1);
  });
});

describe('listMissions (the management listing)', () => {
  // Seeds (all in tenantList):
  //   Urgent  — critical, active,    goals [G1],        person PERSON_ID + system billing
  //   Epsilon — critical, completed, goals [G2],        no candidates
  //   Beta    — high,    active,     goals [G2],        system billing, objective mentions 'sole-source'
  //   Gamma   — medium,  active,     goals [G1, G2],    person PERSON_ID_2
  //   Zeta ×2 — medium,  active,     no candidates (title tie — resolves by mission id)
  //   Delta   — low,     active,     no candidates
  // Every seed carries a DISTINCT knowledge objective so search filters
  // match exactly the mission they name.
  const G1 = GOAL_ID_1;
  const G2 = GOAL_ID_2;
  let urgent: Mission;
  let epsilon: Mission;
  let zetaA: Mission;
  let zetaB: Mission;
  let unknownUrgent: string;

  beforeAll(async () => {
    const ctx = member(tenantList);
    unknownUrgent = await seedUnknown(ctx, 'Which pricing tier drives the churn spike?');

    urgent = await seedMission(ctx, {
      title: 'Churn root cause',
      urgency: 'critical',
      unknownIds: [unknownUrgent],
      affectedGoals: [{ goalId: G1 }],
      knowledgeObjective: 'Why did churn rise in Q3?',
      candidateSources: [
        { kind: 'person', id: PERSON_ID },
        { kind: 'system', label: 'billing-export' },
      ],
    });
    epsilon = await seedMission(ctx, {
      title: 'Epsilon competitor moves',
      urgency: 'critical',
      affectedGoals: [{ goalId: G2 }],
      knowledgeObjective: 'Are competitors changing pricing this quarter?',
      candidateSources: [],
    });
    await completeMission(ctx, {
      missionId: epsilon.id,
      achievedConfidence: 0.9,
      outcome: 'Tracked competitor pricing for the quarter.',
      actor: { kind: 'person', id: PERSON_ID },
    });
    await seedMission(ctx, {
      title: 'Beta supplier risk',
      urgency: 'high',
      affectedGoals: [{ goalId: G2 }],
      knowledgeObjective: 'Which suppliers are sole-source for critical inputs?',
      candidateSources: [{ kind: 'system', label: 'billing-export' }],
    });
    await seedMission(ctx, {
      title: 'Gamma pricing experiments',
      urgency: 'medium',
      affectedGoals: [{ goalId: G1 }, { goalId: G2 }],
      knowledgeObjective: 'Which pricing experiments moved retention?',
      candidateSources: [{ kind: 'person', id: PERSON_ID_2 }],
    });
    zetaA = await seedMission(ctx, {
      title: 'Zeta',
      urgency: 'medium',
      knowledgeObjective: 'What drives the renewal lag?',
      affectedGoals: [],
      candidateSources: [],
    });
    zetaB = await seedMission(ctx, {
      title: 'Zeta',
      urgency: 'medium',
      knowledgeObjective: 'What drives the renewal lag?',
      affectedGoals: [],
      candidateSources: [],
    });
    await seedMission(ctx, {
      title: 'Delta onboarding NPS',
      urgency: 'low',
      knowledgeObjective: 'What drives onboarding NPS?',
      affectedGoals: [],
      candidateSources: [],
    });
  });

  it('orders by urgency rank (critical first), then title, then id', async () => {
    const missions = await listMissions(member(tenantList), {});
    expect(missions.map((mission) => mission.content.title)).toEqual([
      'Churn root cause',
      'Epsilon competitor moves',
      'Beta supplier risk',
      'Gamma pricing experiments',
      'Zeta',
      'Zeta',
      'Delta onboarding NPS',
    ]);
    expect(missions[0]!.id).toBe(urgent.id);
    expect(missions[1]!.id).toBe(epsilon.id);
    // the title tie between the two Zetas resolves by mission id, ascending
    const zetas = [zetaA.id, zetaB.id].sort();
    expect(missions[4]!.id).toBe(zetas[0]);
    expect(missions[5]!.id).toBe(zetas[1]);
  });

  it('filters by status', async () => {
    const ctx = member(tenantList);
    const completed = await listMissions(ctx, { status: 'completed' });
    expect(completed.map((mission) => mission.id)).toEqual([epsilon.id]);
    expect(completed[0]!.completion).toEqual({
      achievedConfidence: 0.9,
      outcome: 'Tracked competitor pricing for the quarter.',
    });
    const active = await listMissions(ctx, { status: 'active' });
    expect(active.map((mission) => mission.content.title)).toEqual([
      'Churn root cause',
      'Beta supplier risk',
      'Gamma pricing experiments',
      'Zeta',
      'Zeta',
      'Delta onboarding NPS',
    ]);
  });

  it('filters by urgency', async () => {
    const critical = await listMissions(member(tenantList), { urgency: 'critical' });
    expect(critical.map((mission) => mission.content.title)).toEqual([
      'Churn root cause',
      'Epsilon competitor moves',
    ]);
  });

  it('filters by affected goal (jsonb containment over opaque goal refs)', async () => {
    const ctx = member(tenantList);
    const ofG1 = await listMissions(ctx, { affectedGoalId: G1 });
    expect(ofG1.map((mission) => mission.content.title)).toEqual([
      'Churn root cause',
      'Gamma pricing experiments',
    ]);
    const ofG2 = await listMissions(ctx, { affectedGoalId: G2 });
    expect(ofG2.map((mission) => mission.content.title)).toEqual([
      'Epsilon competitor moves',
      'Beta supplier risk',
      'Gamma pricing experiments',
    ]);
  });

  it('filters by the epistemics unknown a mission closes', async () => {
    const ctx = member(tenantList);
    const closing = await listMissions(ctx, { unknownId: unknownUrgent });
    expect(closing.map((mission) => mission.id)).toEqual([urgent.id]);
    expect(await listMissions(ctx, { unknownId: newId() })).toEqual([]);
  });

  it('filters by candidate kind and candidate kind + id', async () => {
    const ctx = member(tenantList);
    const people = await listMissions(ctx, { candidateKind: 'person' });
    expect(people.map((mission) => mission.content.title)).toEqual([
      'Churn root cause',
      'Gamma pricing experiments',
    ]);
    const ofPerson = await listMissions(ctx, {
      candidateKind: 'person',
      candidateId: PERSON_ID,
    });
    expect(ofPerson.map((mission) => mission.id)).toEqual([urgent.id]);
    const systems = await listMissions(ctx, { candidateKind: 'system' });
    expect(systems.map((mission) => mission.content.title)).toEqual([
      'Churn root cause',
      'Beta supplier risk',
    ]);
  });

  it('searches titles AND knowledge objectives, case-insensitively, treating wildcards literally', async () => {
    const ctx = member(tenantList);
    // title match
    expect((await listMissions(ctx, { search: 'churn' })).map((m) => m.content.title)).toEqual([
      'Churn root cause',
    ]);
    // knowledge-objective match (the words are not in any title)
    expect((await listMissions(ctx, { search: 'sole-source' })).map((m) => m.content.title)).toEqual(
      ['Beta supplier risk'],
    );
    // '%' would match everything as an ILIKE pattern — escaped, it is a
    // literal with no match among the seeded titles/objectives.
    expect(await listMissions(ctx, { search: '%' })).toEqual([]);
    // '_' would match any single character in ILIKE — escaped, no match.
    expect(await listMissions(ctx, { search: 'Z_ta' })).toEqual([]);
    expect(await listMissions(ctx, { search: 'Zeta' })).toHaveLength(2);
  });

  it('limits results', async () => {
    const first = await listMissions(member(tenantList), { limit: 2 });
    expect(first.map((mission) => mission.content.title)).toEqual([
      'Churn root cause',
      'Epsilon competitor moves',
    ]);
  });

  it('lists only CURRENT versions — a revised mission appears once, with its latest content', async () => {
    const ctx = member(tenantList);
    const revised = await reviseMission(ctx, {
      missionId: urgent.id,
      title: 'Churn root cause prime',
      currentConfidence: 0.5,
      actor: { kind: 'person', id: PERSON_ID },
    });
    const missions = await listMissions(ctx, { search: 'churn' });
    expect(missions).toHaveLength(1);
    expect(missions[0]!.id).toBe(urgent.id);
    expect(missions[0]!.version).toBe(revised.version);
    expect(missions[0]!.content.title).toBe('Churn root cause prime');
    expect(missions[0]!.content.currentConfidence).toBe(0.5);
    // and the audit trail still holds the original
    const v1 = await getMissionVersion(ctx, { missionId: urgent.id, version: 1 });
    expect(v1.content.title).toBe('Churn root cause');
  });
});
