// Integration tests for the audit module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W046 acceptance —
// "end-to-end reconstruction of input→evidence→belief/mission→policy→
// recommendation→approval→execution→outcome→learning":
//
//  * THE AUDIT TRAIL — append-only records: system-minted identity, tenancy
//    and commit times; filtered chronological listing; storage-level
//    immutability (UPDATE/DELETE/TRUNCATE rejected by triggers).
//  * THE RECONSTRUCTION (the acceptance core) — a full canonical cognitive
//    cycle (W013) driven through the REAL sibling contracts, including an
//    approval-gated action decided by a human, then reconstructed by all
//    three anchors (execution id, action request id, §25 correlation id)
//    with every §24 link present and deep-linked to the real records.
//  * HONEST ABSENCE — a mid-flight decision (suspended awaiting approval)
//    reconstructs with its later links absent and marked absent; a direct
//    authorization (no cognitive execution) reconstructs with the
//    approval-centric sub-chain only.
//  * PARTIAL VIEWS — a principal-restricted observation referenced as
//    cycle evidence is reported unreadable in place; the reconstruction
//    never fails on a restricted link.
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as auditContract from '../contract';
import { AuditError } from '../errors';
import * as actionsContract from '@/modules/actions/contract';
import * as cognitionContract from '@/modules/cognition/contract';
import { recordObservation } from '@/modules/observations/contract';
import { recordKnowledgeEntry, recordTransactiveEntry } from '@/modules/memory/contract';
import { createGoal } from '@/modules/goals/contract';
import {
  getAcquisitionPlan,
  recordAcquisitionOutcome,
} from '@/modules/knowledge-acquisition/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

const { getAuditRecord, listAuditRecords, recordAudit, reconstructDecision } = auditContract;
const {
  authorizeAction,
  decideApproval,
  setAuthorityPolicy,
  ACTIONS_AUTHORITY_ADMINISTER,
  ACTIONS_AUTHORITY_APPROVE,
} = actionsContract;
const { runNextStage, startExecution } = cognitionContract;

// Dedicated tenants per concern (and per test with absolute list
// assertions) so every assertion below sees only what it created itself.
const tenantTrail = newId();
const tenantList = newId();
const tenantStorage = newId();
const tenantE2E = newId();
const tenantMid = newId();
const tenantDirect = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantListA = newId();
const tenantListB = newId();
const tenantRestricted = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_ADMINISTER] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [ACTIONS_AUTHORITY_APPROVE] };
}

async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AuditError);
    expect((error as AuditError).code).toBe(code);
  }
}

/** A minimal tenant-visible observation. */
async function seedObservation(ctx: TenantContext, payload: unknown): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: 'channel.message',
    payload,
    observedAt: new Date().toISOString(),
    source: { kind: 'source', label: 'slack' },
    channel: 'slack',
    confidence: { value: 0.8, method: 'test' },
  });
  return observation.id;
}

/** An observation derived from a parent through a provider/model extractor. */
async function seedExtractedObservation(ctx: TenantContext, parentId: string): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: 'document.note',
    payload: { summary: 'structured churn extract' },
    observedAt: new Date().toISOString(),
    source: { kind: 'source', label: 'billing-export' },
    channel: 'ingestion',
    lineage: {
      method: 'extraction',
      parents: [parentId],
      extractor: { provider: 'z-ai', model: 'glm-4.6' },
    },
    confidence: { value: 0.9, method: 'extractor_trust' },
  });
  return observation.id;
}

async function seedGoal(ctx: TenantContext, title: string): Promise<string> {
  const goal = await createGoal(ctx, {
    title,
    objective: `Objective of ${title}`,
    desiredState: `${title} achieved`,
    horizonEnd: '2027-06-30T00:00:00.000Z',
    owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
    priority: 'high',
    successCriteria: `${title} success criteria`,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'W046 test seed',
  });
  return goal.id;
}

/** Drives a fresh minimal cycle from stage 1 up to (excluding) `upto`. */
async function driveMinimal(
  ctx: TenantContext,
  executionId: string,
  upto: number,
): Promise<ReturnType<typeof cognitionContract.getExecution> extends Promise<infer T> ? T : never> {
  let trace = await cognitionContract.getExecution(ctx, { executionId });
  for (let stage = trace.completedStages + 1; stage < upto; stage += 1) {
    trace = await runMinimalStage(ctx, executionId, stage);
  }
  return trace;
}

async function runMinimalStage(ctx: TenantContext, executionId: string, stage: number) {
  switch (stage) {
    case 1:
      return runNextStage(ctx, {
        executionId,
        stage: 'observation',
        record: [
          {
            kind: 'channel.message',
            payload: { text: 'churn spiked 12% in Q3' },
            observedAt: new Date().toISOString(),
            source: { kind: 'source', label: 'slack' },
            channel: 'slack',
            confidence: { value: 0.8, method: 'test' },
          },
        ],
      });
    case 2:
      return runNextStage(ctx, { executionId, stage: 'evidence-memory' });
    case 3:
      return runNextStage(ctx, { executionId, stage: 'world-update', update: null });
    case 4:
      return runNextStage(ctx, { executionId, stage: 'epistemic-evaluation', claims: [] });
    case 5:
      return runNextStage(ctx, { executionId, stage: 'goal-evaluation', relatedGoalIds: [] });
    case 6:
      return runNextStage(ctx, {
        executionId,
        stage: 'unknown-mission-evaluation',
        unknowns: [],
        missions: [],
      });
    case 7:
      return runNextStage(ctx, { executionId, stage: 'knowledge-acquisition', missionId: null });
    case 8:
      return runNextStage(ctx, { executionId, stage: 'model-update', belief: null });
    case 9:
      return runNextStage(ctx, {
        executionId,
        stage: 'risk-opportunity-capability-analysis',
        findings: [],
      });
    case 10:
      return runNextStage(ctx, { executionId, stage: 'recommendation-ask-proposal-action', action: null });
    case 11:
      return runNextStage(ctx, { executionId, stage: 'outcome', summary: 'cycle closed' });
    case 12:
      return runNextStage(ctx, { executionId, stage: 'learning', knowledge: null });
    default:
      throw new Error(`unexpected stage ${stage}`);
  }
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no update, erase or rewrite operation exists', async () => {
    // There is deliberately no updateAuditRecord, no deleteAuditRecord,
    // no amendReconstruction: the trail is append-only (§24) and the
    // reconstruction is a derived read.
    expect(Object.keys(auditContract).sort()).toEqual([
      'AUDIT_SUBJECT_ACTION_REQUEST',
      'AUDIT_SUBJECT_AUTHORITY_POLICY',
      'AUDIT_SUBJECT_COGNITIVE_EXECUTION',
      'AuditError',
      'CHAIN_STAGES',
      'DEFAULT_LIST_LIMIT',
      'MAX_DETAIL_BYTES',
      'MAX_EVENT_CHARS',
      'MAX_LIST_LIMIT',
      'MAX_SUBJECT_KIND_CHARS',
      'MAX_SUMMARY_CHARS',
      'chainCompleteness',
      'deriveExtractors',
      'executionIdFromIdempotencyKey',
      'getAuditRecord',
      'isChainStage',
      'isUuid',
      'listAuditRecords',
      'reconstructDecision',
      'recordAudit',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The append-only trail
// ---------------------------------------------------------------------------

describe('the append-only audit trail', () => {
  it('records events with system-minted identity, tenancy, principal and time', async () => {
    const ctx = member(tenantTrail);
    const recorded = await recordAudit(ctx, {
      subjectKind: 'actions.policy',
      subjectId: newId(),
      event: 'policy-changed',
      chainStage: 'policy',
      correlationId: newId(),
      summary: 'ASK on employee-messaging now requires approval',
      detail: { approvalLevels: ['ASK'] },
    });
    expect(recorded.tenantId).toBe(tenantTrail);
    expect(recorded.principalId).toBe(ctx.principalId);
    expect(recorded.subject.kind).toBe('actions.policy');
    expect(recorded.detail).toEqual({ approvalLevels: ['ASK'] });
    expect(recorded.recordedAt).toBeTruthy();
    // Read back — identical.
    const reloaded = await getAuditRecord(member(tenantTrail), { recordId: recorded.id });
    expect(reloaded).toEqual(recorded);
  });

  it('defaults the optionals (tenant-wide subject, no correlation, empty detail)', async () => {
    const recorded = await recordAudit(member(tenantTrail), {
      subjectKind: 'actions.policy',
      event: 'policy-changed',
      chainStage: 'policy',
      summary: 'default row updated',
    });
    expect(recorded.subject.id).toBeNull();
    expect(recorded.correlationId).toBeNull();
    expect(recorded.detail).toEqual({});
  });

  it('lists chronologically and honors every filter', async () => {
    const ctx = member(tenantList);
    const subjectId = newId();
    const correlationId = newId();
    const a = await recordAudit(ctx, {
      subjectKind: 'actions.policy',
      subjectId,
      event: 'policy-changed',
      chainStage: 'policy',
      correlationId,
      summary: 'first',
    });
    const b = await recordAudit(ctx, {
      subjectKind: 'actions.request',
      subjectId: newId(),
      event: 'approval-decided',
      chainStage: 'approval',
      correlationId,
      summary: 'second',
    });
    const c = await recordAudit(ctx, {
      subjectKind: 'cognition.execution',
      subjectId: newId(),
      event: 'outcome-recorded',
      chainStage: 'outcome',
      summary: 'third',
    });

    // Chronological, newest last.
    const all = await listAuditRecords(ctx, {});
    expect(all.map((record) => record.summary)).toEqual(['first', 'second', 'third']);

    // Subject filter (kind + id).
    expect((await listAuditRecords(ctx, { subjectKind: 'actions.policy', subjectId })).map((r) => r.id)).toEqual([a.id]);
    // Tenant-wide subjects: kind + null id.
    await recordAudit(ctx, {
      subjectKind: 'actions.policy',
      subjectId: null,
      event: 'policy-changed',
      chainStage: 'policy',
      summary: 'tenant-wide default row',
    });
    expect(
      (await listAuditRecords(ctx, { subjectKind: 'actions.policy', subjectId: null })).map((r) => r.summary),
    ).toEqual(['tenant-wide default row']);

    // Correlation, chain stage, event, window, limit.
    expect((await listAuditRecords(ctx, { correlationId })).map((r) => r.id)).toEqual([a.id, b.id]);
    expect((await listAuditRecords(ctx, { chainStage: 'approval' })).map((r) => r.id)).toEqual([b.id]);
    expect((await listAuditRecords(ctx, { event: 'outcome-recorded' })).map((r) => r.id)).toEqual([c.id]);
    expect((await listAuditRecords(ctx, { recordedFrom: '2020-01-01T00:00:00.000Z' })).length).toBe(4);
    expect((await listAuditRecords(ctx, { recordedFrom: '2100-01-01T00:00:00.000Z' })).length).toBe(0);
    expect((await listAuditRecords(ctx, { limit: 2 })).length).toBe(2);
  });

  it('rejects malformed writes and reads with typed errors', async () => {
    const ctx = member(tenantTrail);
    await expectCode('invalid_record_input', () =>
      recordAudit(ctx, {
        subjectKind: 'actions.policy',
        event: 'policy-changed',
        chainStage: 'policy',
        summary: 'smuggled',
        tenantId: newId(), // unknown key — identity is minted by the system
      } as never),
    );
    await expectCode('invalid_record_input', () =>
      recordAudit(ctx, {
        subjectKind: 'actions.policy',
        event: 'policy-changed',
        chainStage: 'policies',
        summary: 'bad stage',
      } as never),
    );
    await expectCode('invalid_query', () => getAuditRecord(ctx, { recordId: 'not-a-uuid' }));
    await expectCode('audit_record_not_found', () => getAuditRecord(ctx, { recordId: newId() }));
    await expectCode('invalid_query', () => listAuditRecords(ctx, { subjectId: newId() } as never));
  });

  it('is append-only at the storage level: UPDATE/DELETE/TRUNCATE are rejected', async () => {
    const ctx = member(tenantStorage);
    const recorded = await recordAudit(ctx, {
      subjectKind: 'cognition.execution',
      subjectId: newId(),
      event: 'outcome-recorded',
      chainStage: 'outcome',
      summary: 'immutable',
    });
    const db = getDb();
    await expect(
      db.query(`UPDATE audit_records SET summary = 'rewritten' WHERE id = $1`, [recorded.id]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_records WHERE id = $1`, [recorded.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`TRUNCATE audit_records`)).rejects.toThrow(/append-only/);
    // The record survived every attempt untouched.
    const reloaded = await getAuditRecord(ctx, { recordId: recorded.id });
    expect(reloaded.summary).toBe('immutable');
  });
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CORE — end-to-end reconstruction through the real
// sibling contracts, with a human decision at the approval gate.
// ---------------------------------------------------------------------------

describe('reconstructDecision — the full §24 chain (end-to-end)', () => {
  // Shared state filled by the driving `it` below (one describe-level
  // scenario so the whole chain is reconstructed from ONE cycle).
  let executionId = '';
  let correlationId = '';
  let actionRequestId = '';
  let triggerObservationId = '';
  let recordedObservationId = '';
  let claimId = '';
  let beliefId = '';
  let unknownId = '';
  let missionId = '';
  let learningEntryId = '';
  let knowledgeEntryId = '';
  let transactiveEntryId = '';

  it('runs a full approval-gated canonical cycle and reconstructs it by execution id', async () => {
    const driver = member(tenantE2E);
    const tenantAdmin = admin(tenantE2E);
    const human = approver(tenantE2E);

    // Tenant policy: asking employees requires human approval at ASK —
    // the consequential gate of this decision (§20).
    const policy = await setAuthorityPolicy(tenantAdmin, {
      actionKind: 'employee-messaging',
      approvalLevels: ['ASK'],
      note: 'targeted questions are consequential',
    });
    // The policy change history belongs to audit (the actions contract's
    // documented duty) — recorded here by the surface that drove it.
    await recordAudit(tenantAdmin, {
      subjectKind: 'actions.policy',
      subjectId: policy.id,
      event: 'policy-changed',
      chainStage: 'policy',
      summary: 'ASK on employee-messaging now requires human approval',
      detail: { approvalLevels: ['ASK'] },
    });

    // Pre-seeded organizational + transactive memory the cycle retrieves.
    const seedObsId = await seedObservation(driver, { note: 'prior churn context' });
    const knowledge = await recordKnowledgeEntry(driver, {
      kind: 'context',
      title: 'Q2 churn context',
      summary: 'Churn was flat through Q2; pricing changed in July.',
      topics: ['churn', 'pricing'],
      evidenceObservationIds: [seedObsId],
    });
    knowledgeEntryId = knowledge.id;
    const transactive = await recordTransactiveEntry(driver, {
      actor: { kind: 'person', id: PERSON_ID, label: 'VP Customer Success' },
      relation: 'knows',
      subjectLabel: 'churn drivers in legacy cohorts',
      topics: ['churn', 'pricing'],
      evidenceObservationIds: [seedObsId],
    });
    transactiveEntryId = transactive.id;

    const goalId = await seedGoal(driver, 'Q4 churn reduction');

    // The input: a provider-extracted observation triggers the cycle.
    const parentId = await seedObservation(driver, { note: 'raw churn export' });
    triggerObservationId = await seedExtractedObservation(driver, parentId);

    const trace0 = await startExecution(driver, {
      trigger: { kind: 'observation', id: triggerObservationId, label: 'churn extract' },
      focus: {
        topics: ['churn', 'pricing'],
        entities: [{ kind: 'competitor', label: 'Acme Corp' }],
      },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'W046 end-to-end decision evidence scenario',
    });
    executionId = trace0.id;
    correlationId = trace0.correlationId;

    // 1 — observation: record one new observation, reference the trigger.
    const step1 = await runNextStage(driver, {
      executionId,
      stage: 'observation',
      record: [
        {
          kind: 'channel.message',
          payload: { text: 'support ticket volume up 30%' },
          observedAt: new Date().toISOString(),
          source: { kind: 'source', label: 'slack' },
          channel: 'slack',
          confidence: { value: 0.8, method: 'test' },
        },
      ],
      reference: [triggerObservationId],
    });
    const observationResult = step1.steps[0]!.result as Extract<
      typeof step1.steps[0]['result'],
      { stage: 'observation' }
    >;
    recordedObservationId = observationResult.recordedObservationIds[0]!;

    // 2 — evidence/memory: retrieval through W010 (pre-seeded entries).
    const step2 = await runNextStage(driver, { executionId, stage: 'evidence-memory' });
    const memoryResult = step2.steps[1]!.result as Extract<
      typeof step2.steps[1]['result'],
      { stage: 'evidence-memory' }
    >;
    expect(memoryResult.knowledgeEntryIds).toContain(knowledgeEntryId);
    expect(memoryResult.transactiveEntryIds).toContain(transactiveEntryId);

    // 3 — world update: none this cycle.
    await runNextStage(driver, { executionId, stage: 'world-update', update: null });

    // 4 — epistemic evaluation: a claim derived from the cycle's evidence.
    const step4 = await runNextStage(driver, {
      executionId,
      stage: 'epistemic-evaluation',
      claims: [
        {
          proposition: 'Support ticket volume rose materially in Q3.',
          confidence: { value: 0.75, method: 'derived' },
          evidenceObservationIds: [triggerObservationId, recordedObservationId],
          rationale: 'counted from the recorded observation',
        },
      ],
    });
    const claimResult = step4.steps[3]!.result as Extract<
      typeof step4.steps[3]['result'],
      { stage: 'epistemic-evaluation' }
    >;
    claimId = claimResult.claimIds[0]!;

    // 5 — goal evaluation.
    await runNextStage(driver, {
      executionId,
      stage: 'goal-evaluation',
      relatedGoalIds: [goalId],
    });

    // 6 — unknown/mission: identify the gap, launch the mission.
    const step6 = await runNextStage(driver, {
      executionId,
      stage: 'unknown-mission-evaluation',
      unknowns: [
        {
          question: 'What is the dominant driver of the Q3 churn rise?',
          consequence: 'Churn reduction investments cannot be prioritized without it.',
          relatedObservationIds: [triggerObservationId, recordedObservationId],
        },
      ],
      missions: [
        {
          title: 'Churn root cause',
          knowledgeObjective: 'Why did churn rise in Q3 and what is the dominant driver?',
          informationValue: 0.8,
          urgency: 'high',
          currentConfidence: 0.1,
          targetConfidence: 0.85,
          investigationBudget: { amount: 250_00, currency: 'EUR' },
          rewardBudget: { amount: 50_00, currency: 'EUR' },
          candidateSources: [{ kind: 'system', label: 'billing-export' }],
          completionCriteria: 'A validated root-cause explanation with confidence >= 0.85.',
        },
      ],
    });
    const unknownMissionResult = step6.steps[5]!.result as Extract<
      typeof step6.steps[5]['result'],
      { stage: 'unknown-mission-evaluation' }
    >;
    unknownId = unknownMissionResult.unknownIds[0]!;
    missionId = unknownMissionResult.missionIds[0]!;

    // 7 — knowledge acquisition: the planner selects the system source;
    // the execution suspends until the answer lands, then the mission's
    // confidence rises to target and completes.
    const step7 = await runNextStage(driver, {
      executionId,
      stage: 'knowledge-acquisition',
      missionId,
    });
    expect(step7.state).toBe('awaiting_input');
    const plan = await getAcquisitionPlan(driver, step7.pending.planId!);
    expect(plan.decision).toBe('selected');
    await recordAcquisitionOutcome(driver, {
      planId: plan.id,
      outcome: 'answered',
      evidence: {
        payload: { rootCause: 'pricing change applied to legacy cohorts' },
        confidence: { value: 0.9, method: 'validated-analysis' },
      },
    });
    const step7b = await runNextStage(driver, { executionId, stage: 'knowledge-acquisition' });
    const acquisitionResult = step7b.steps[6]!.result as Extract<
      typeof step7b.steps[6]['result'],
      { stage: 'knowledge-acquisition' }
    >;
    expect(acquisitionResult.missionConfidence).toEqual({ from: 0.1, to: 0.9 });
    expect(acquisitionResult.missionCompleted).toBe(true);

    // 8 — model update: the working understanding, with provenance.
    const step8 = await runNextStage(driver, {
      executionId,
      stage: 'model-update',
      belief: {
        proposition: 'The Q3 churn rise is dominated by the legacy-cohort pricing change.',
        confidence: { value: 0.9, method: 'mission-evidence' },
        supportingObservationIds: [triggerObservationId],
        supportingClaimIds: [claimId],
        alternatives: ['support-load driven churn'],
        validFrom: new Date().toISOString(),
        rationale: 'mission answer reached target confidence',
      },
    });
    const beliefResult = step8.steps[7]!.result as Extract<
      typeof step8.steps[7]['result'],
      { stage: 'model-update' }
    >;
    beliefId = beliefResult.beliefId!;

    // 9 — analysis: a risk finding with evidence and an affected goal.
    await runNextStage(driver, {
      executionId,
      stage: 'risk-opportunity-capability-analysis',
      findings: [
        {
          kind: 'risk',
          statement: 'Legacy-cohort pricing churn threatens the Q4 churn goal.',
          evidenceObservationIds: [triggerObservationId],
          affectedGoalIds: [goalId],
        },
      ],
    });

    // 10 — THE POLICY GATE: the consequential ASK is approval-gated.
    const gated = await runNextStage(driver, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'employee-messaging',
        authorityLevel: 'ASK',
        payload: { to: 'vp-cs', question: 'Can you validate the cohort-pricing churn hypothesis?' },
        justification: 'validate the mission answer with the accountable owner',
      },
    });
    expect(gated.state).toBe('awaiting_approval');
    actionRequestId = gated.pending.requestId!;

    // The reasoning model attribution, recorded as audit evidence (§24
    // model/provider): the cycle's reasoning ran on a provider/model.
    await recordAudit(driver, {
      subjectKind: 'cognition.execution',
      subjectId: executionId,
      event: 'reasoning-attribution',
      chainStage: 'model-provider',
      correlationId,
      summary: 'Cycle reasoning produced through provider z-ai, model glm-4.6',
      detail: { provider: 'z-ai', model: 'glm-4.6' },
    });

    // The human decides (a different principal — separation of duties).
    await decideApproval(human, {
      requestId: actionRequestId,
      decision: 'approve',
      note: 'validated need',
    });
    await recordAudit(human, {
      subjectKind: 'actions.request',
      subjectId: actionRequestId,
      event: 'approval-decided',
      chainStage: 'approval',
      correlationId,
      summary: 'Human approved the targeted validation question',
      detail: { decision: 'approve', by: human.principalId },
    });

    // Resume through the gate, then outcome and learning.
    const resumed = await runNextStage(driver, {
      executionId,
      stage: 'recommendation-ask-proposal-action',
    });
    expect(resumed.completedStages).toBe(10);

    await runNextStage(driver, {
      executionId,
      stage: 'outcome',
      summary: 'Mission closed at target confidence; validation question authorized.',
    });
    const finished = await runNextStage(driver, {
      executionId,
      stage: 'learning',
      knowledge: {
        title: 'Q3 churn root cause: legacy-cohort pricing',
        summary: 'The Q3 churn rise is dominated by the pricing change applied to legacy cohorts.',
        topics: ['churn', 'pricing'],
      },
    });
    expect(finished.state).toBe('completed');
    learningEntryId = (finished.steps[11]!.result as Extract<
      typeof finished.steps[11]['result'],
      { stage: 'learning' }
    >).knowledgeEntryId!;

    // ================= THE RECONSTRUCTION =================
    const evidence = await reconstructDecision(driver, { executionId });

    expect(evidence.anchor).toEqual({ kind: 'execution', id: executionId });
    expect(evidence.correlationId).toBe(correlationId);
    expect(evidence.tenantId).toBe(tenantE2E);

    // Every §24 link is present — the acceptance line, asserted link by link.
    const present = new Map(evidence.completeness.map((link) => [link.stage, link.present]));
    for (const stage of auditContract.CHAIN_STAGES) {
      expect(present.get(stage), `§24 link '${stage}' must be present`).toBe(true);
    }

    // input — the triggering observation, with its content.
    expect(evidence.chain.input.trigger).toMatchObject({
      kind: 'observation',
      id: triggerObservationId,
      label: 'churn extract',
    });
    expect(evidence.chain.input.observation).toMatchObject({
      id: triggerObservationId,
      unreadable: false,
      kind: 'document.note',
      extractor: { provider: 'z-ai', model: 'glm-4.6' },
    });

    // evidence — the observations the decision rests on (input + cycle),
    // plus the memory the cycle retrieved.
    const evidenceIds = evidence.chain.evidence.observations.map((observation) => observation.id);
    expect(evidenceIds).toContain(triggerObservationId);
    expect(evidenceIds).toContain(recordedObservationId);
    expect(
      evidence.chain.evidence.observations.every((observation) => !observation.unreadable),
    ).toBe(true);
    expect(evidence.chain.evidence.knowledge.map((entry) => entry.id)).toContain(knowledgeEntryId);
    expect(evidence.chain.evidence.transactive.map((entry) => entry.id)).toContain(
      transactiveEntryId,
    );

    // claims/beliefs — deep-linked content, not just ids.
    expect(evidence.chain.claimsBeliefs.claims).toEqual([
      {
        id: claimId,
        proposition: 'Support ticket volume rose materially in Q3.',
        confidenceValue: 0.75,
        evidenceObservationIds: [triggerObservationId, recordedObservationId].sort(),
      },
    ]);
    expect(evidence.chain.claimsBeliefs.beliefs).toHaveLength(1);
    expect(evidence.chain.claimsBeliefs.beliefs[0]).toMatchObject({
      id: beliefId,
      version: 1,
      proposition: 'The Q3 churn rise is dominated by the legacy-cohort pricing change.',
      confidenceValue: 0.9,
      status: 'active',
    });

    // unknown/mission — the gap and the mission that closed it.
    expect(evidence.chain.unknownMission.unknowns).toEqual([
      {
        id: unknownId,
        question: 'What is the dominant driver of the Q3 churn rise?',
        consequence: 'Churn reduction investments cannot be prioritized without it.',
        status: 'open',
      },
    ]);
    expect(evidence.chain.unknownMission.missions).toHaveLength(1);
    expect(evidence.chain.unknownMission.missions[0]).toMatchObject({
      id: missionId,
      title: 'Churn root cause',
      status: 'completed',
      currentConfidence: 0.1, // the definition-side view; the completion froze the achieved value
      targetConfidence: 0.85,
      achievedConfidence: 0.9,
      acquisition: { confidence: { from: 0.1, to: 0.9 }, completed: true },
    });

    // policy — the matrix evaluation that governed the gated action.
    expect(evidence.chain.policy.authorityEvaluation).toMatchObject({
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      outcome: 'approval_required',
      resolvedVia: 'kind',
      policyNote: 'targeted questions are consequential',
    });

    // model/provider — the extraction lineage plus the recorded attribution.
    expect(evidence.chain.modelProvider.extractors).toEqual([
      { provider: 'z-ai', model: 'glm-4.6', observationIds: [triggerObservationId] },
    ]);
    expect(
      evidence.chain.modelProvider.events.map((record) => record.event),
    ).toContain('reasoning-attribution');

    // recommendation — the consequential action as proposed.
    expect(evidence.chain.recommendation.actionRequest).toMatchObject({
      id: actionRequestId,
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: { to: 'vp-cs', question: 'Can you validate the cohort-pricing churn hypothesis?' },
      justification: 'validate the mission answer with the accountable owner',
      requestedBy: driver.principalId,
      idempotencyKey: `cognition:${executionId}:action`,
      status: 'approved',
    });

    // approval — the human decision, attributed.
    expect(evidence.chain.approval.decisions).toHaveLength(1);
    expect(evidence.chain.approval.decisions[0]).toMatchObject({
      requestId: actionRequestId,
      decision: 'approve',
      decidedBy: 'principal',
      principalId: human.principalId,
    });

    // execution — the completed cognitive cycle.
    expect(evidence.chain.execution.directAuthorization).toBe(false);
    expect(evidence.chain.execution.executions).toHaveLength(1);
    expect(evidence.chain.execution.executions[0]).toMatchObject({
      id: executionId,
      state: 'completed',
      completedStages: 12,
      startedByPrincipal: driver.principalId,
    });

    // result — the gate outcome and its human resolution.
    expect(evidence.chain.result).toEqual({
      gate: 'approval_required',
      resolution: 'approved',
      requestStatus: 'approved',
      decidedAt: expect.any(String),
    });

    // outcome — the cycle's recorded result.
    expect(evidence.chain.outcome.outcomes).toEqual([
      {
        executionId,
        kind: 'action-authorized',
        summary: 'Mission closed at target confidence; validation question authorized.',
        actionRequestId,
        recordedAt: expect.any(String),
      },
    ]);

    // learning — the durable knowledge, evidence-backed.
    expect(evidence.chain.learning.knowledge).toEqual([
      {
        id: learningEntryId,
        kind: 'insight',
        title: 'Q3 churn root cause: legacy-cohort pricing',
        summary: 'The Q3 churn rise is dominated by the pricing change applied to legacy cohorts.',
        topics: ['churn', 'pricing'],
        evidenceObservationIds: [triggerObservationId, recordedObservationId].sort(),
      },
    ]);

    // audit history — the correlated trail, in chronological order.
    const auditEvents = evidence.auditRecords.map((record) => record.event);
    expect(auditEvents).toContain('reasoning-attribution');
    expect(auditEvents).toContain('approval-decided');
    const attributionIndex = auditEvents.indexOf('reasoning-attribution');
    const approvalIndex = auditEvents.indexOf('approval-decided');
    expect(attributionIndex).toBeLessThan(approvalIndex);
  });

  it('reconstructs the same decision anchored on the action request', async () => {
    const evidence = await reconstructDecision(member(tenantE2E), { actionRequestId });
    expect(evidence.anchor).toEqual({ kind: 'action-request', id: actionRequestId });
    // The driving execution is resolved through the documented
    // idempotency-key link, so the full chain is reconstructed.
    expect(evidence.chain.execution.executions.map((execution) => execution.id)).toEqual([
      executionId,
    ]);
    expect(evidence.chain.execution.directAuthorization).toBe(false);
    expect(evidence.chain.recommendation.actionRequest).toMatchObject({
      id: actionRequestId,
      status: 'approved',
    });
    expect(evidence.chain.result).toMatchObject({ gate: 'approval_required', resolution: 'approved' });
  });

  it('reconstructs the same decision anchored on the §25 correlation id', async () => {
    const evidence = await reconstructDecision(member(tenantE2E), { correlationId });
    expect(evidence.anchor).toEqual({ kind: 'correlation', id: correlationId });
    expect(evidence.chain.execution.executions.map((execution) => execution.id)).toEqual([
      executionId,
    ]);
    expect(evidence.chain.outcome.outcomes).toHaveLength(1);
    expect(evidence.chain.learning.knowledge).toHaveLength(1);
  });

  it('is a repeatable derived read: two reconstructions agree', async () => {
    const ctx = member(tenantE2E);
    const first = await reconstructDecision(ctx, { executionId });
    const second = await reconstructDecision(ctx, { executionId });
    expect(second.chain).toEqual(first.chain);
    expect(second.auditRecords).toEqual(first.auditRecords);
  });

  it('reads a multi-execution correlation flow chronologically: the root execution is the input, the last action is the decision', async () => {
    const ctx = member(tenantE2E);
    // A caused execution inherits the flow's §25 correlation id; it
    // proposes its own (policy-allowed) action — the flow's terminal
    // decision.
    const followUp = await startExecution(ctx, {
      trigger: { kind: 'system', id: null, label: 'follow-up cycle' },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      causation: { kind: 'execution', id: executionId },
    });
    expect(followUp.correlationId).toBe(correlationId);
    await driveMinimal(ctx, followUp.id, 10);
    const gatedFollowUp = await runNextStage(ctx, {
      executionId: followUp.id,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'employee-messaging',
        authorityLevel: 'ASK',
        payload: { to: 'vp-cs', question: 'follow-up?' },
        justification: 'follow-up to the validated answer',
      },
    });
    // The tenant's policy gates this ASK too — the human decides, then
    // the loop resumes through the gate.
    expect(gatedFollowUp.state).toBe('awaiting_approval');
    await decideApproval(approver(tenantE2E), {
      requestId: gatedFollowUp.pending.requestId!,
      decision: 'approve',
      note: 'follow-up validated',
    });
    await runNextStage(ctx, {
      executionId: followUp.id,
      stage: 'recommendation-ask-proposal-action',
    });
    await runNextStage(ctx, {
      executionId: followUp.id,
      stage: 'outcome',
      summary: 'Follow-up question approved and authorized.',
    });
    await runNextStage(ctx, { executionId: followUp.id, stage: 'learning', knowledge: null });

    const evidence = await reconstructDecision(ctx, { correlationId });
    // Both executions of the flow, in chronological order (listExecutions
    // is newest-first — the reconstruction sorts the flow back into a
    // story).
    expect(evidence.chain.execution.executions.map((each) => each.id)).toEqual([
      executionId,
      followUp.id,
    ]);
    // The flow's input is the ROOT execution's trigger; the flow's
    // terminal decision is the LAST proposed action request.
    expect(evidence.chain.input.trigger).toMatchObject({
      kind: 'observation',
      id: triggerObservationId,
    });
    expect(evidence.chain.recommendation.actionRequest).toMatchObject({
      status: 'approved',
      idempotencyKey: `cognition:${followUp.id}:action`,
    });
    // Both requests' decision trails are part of the approval link.
    const decisionRequestIds = new Set(
      evidence.chain.approval.decisions.map((decision) => decision.requestId),
    );
    expect(decisionRequestIds.size).toBe(2);
    // Outcomes of both cycles are reconstructed.
    expect(evidence.chain.outcome.outcomes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Honest absence — mid-flight decisions and direct authorizations
// ---------------------------------------------------------------------------

describe('reconstructDecision — what is absent is stated, never silent', () => {
  it('reconstructs a decision suspended at the approval gate with its later links absent', async () => {
    const driver = member(tenantMid);
    await setAuthorityPolicy(admin(tenantMid), {
      actionKind: 'employee-messaging',
      approvalLevels: ['ASK'],
    });
    const triggerId = await seedObservation(driver, { signal: 'mid-flight trigger' });
    const trace = await startExecution(driver, {
      trigger: { kind: 'observation', id: triggerId, label: null },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await driveMinimal(driver, trace.id, 10);
    const gated = await runNextStage(driver, {
      executionId: trace.id,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'employee-messaging',
        authorityLevel: 'ASK',
        payload: { to: 'vp-cs', question: 'mid-flight?' },
      },
    });
    expect(gated.state).toBe('awaiting_approval');

    const evidence = await reconstructDecision(driver, { executionId: trace.id });
    const present = new Map(evidence.completeness.map((link) => [link.stage, link.present]));
    // What exists so far: input, evidence, policy, recommendation,
    // execution (in flight) — and the pending result.
    expect(present.get('input')).toBe(true);
    expect(present.get('evidence')).toBe(true);
    expect(present.get('policy')).toBe(true);
    expect(present.get('recommendation')).toBe(true);
    expect(present.get('execution')).toBe(true);
    expect(present.get('result')).toBe(true);
    // What does not exist yet: no claims/beliefs/missions in this minimal
    // cycle, no decision on the pending gate, no outcome, no learning.
    expect(present.get('approval')).toBe(false);
    expect(present.get('outcome')).toBe(false);
    expect(present.get('learning')).toBe(false);
    expect(evidence.chain.result).toMatchObject({ requestStatus: 'pending', decidedAt: null });
    expect(evidence.chain.approval.decisions).toEqual([]);

    // The human rejects; the loop completes; the links fill in.
    await decideApproval(approver(tenantMid), {
      requestId: gated.pending.requestId!,
      decision: 'reject',
      note: 'not now',
    });
    await runNextStage(driver, { executionId: trace.id, stage: 'recommendation-ask-proposal-action' });
    await runNextStage(driver, {
      executionId: trace.id,
      stage: 'outcome',
      summary: 'The proposed question was rejected.',
    });
    await runNextStage(driver, { executionId: trace.id, stage: 'learning', knowledge: null });
    const completed = await reconstructDecision(driver, { executionId: trace.id });
    const presentAfter = new Map(completed.completeness.map((link) => [link.stage, link.present]));
    expect(presentAfter.get('approval')).toBe(true);
    expect(presentAfter.get('outcome')).toBe(true);
    expect(completed.chain.result).toMatchObject({
      gate: 'approval_required',
      resolution: 'rejected',
      requestStatus: 'rejected',
    });
    expect(completed.chain.outcome.outcomes[0]).toMatchObject({ kind: 'action-refused' });
    expect(presentAfter.get('learning')).toBe(false); // nothing durable was learned — honest
  });

  it('reconstructs a direct authorization (no cognitive execution) with the approval-centric sub-chain', async () => {
    const ctx = member(tenantDirect);
    // Built-in default matrix: ASK is allowed — the request is approved by
    // policy itself, outside any cognitive execution.
    const request = await authorizeAction(ctx, {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: { to: 'vp-sales', question: 'direct ask' },
      justification: 'operator instruction',
    });
    expect(request.status).toBe('approved');

    const evidence = await reconstructDecision(ctx, { actionRequestId: request.id });
    expect(evidence.anchor).toEqual({ kind: 'action-request', id: request.id });
    expect(evidence.correlationId).toBeNull();
    expect(evidence.chain.execution.directAuthorization).toBe(true);
    expect(evidence.chain.execution.executions).toEqual([]);

    const present = new Map(evidence.completeness.map((link) => [link.stage, link.present]));
    expect(present.get('input')).toBe(false); // honest: nothing triggered this
    expect(present.get('evidence')).toBe(false);
    expect(present.get('claims-beliefs')).toBe(false);
    expect(present.get('unknown-mission')).toBe(false);
    expect(present.get('policy')).toBe(true);
    expect(present.get('model-provider')).toBe(false);
    expect(present.get('recommendation')).toBe(true);
    expect(present.get('approval')).toBe(true); // the policy auto-decision
    expect(present.get('execution')).toBe(true); // the direct authorization itself
    expect(present.get('result')).toBe(true);
    expect(present.get('outcome')).toBe(false);
    expect(present.get('learning')).toBe(false);

    expect(evidence.chain.policy.authorityEvaluation).toMatchObject({
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      outcome: 'allowed',
      resolvedVia: 'built-in',
    });
    expect(evidence.chain.approval.decisions).toEqual([
      {
        id: expect.any(String),
        requestId: request.id,
        decision: 'approve',
        decidedBy: 'policy',
        principalId: null,
        note: expect.any(String), // the matrix's deterministic rationale
        decidedAt: expect.any(String),
      },
    ]);
    expect(evidence.chain.result).toEqual({
      gate: 'allowed',
      resolution: null,
      requestStatus: 'approved',
      decidedAt: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// Partial views — restricted links never fail a reconstruction
// ---------------------------------------------------------------------------

describe('reconstructDecision — partial views over restricted evidence', () => {
  it('reports a principal-restricted observation unreadable instead of failing', async () => {
    const owner = member(tenantRestricted);
    // A principal-visibility observation: readable only by its owner.
    const restricted = await recordObservation(owner, {
      kind: 'channel.message',
      payload: { text: 'confidential' },
      observedAt: new Date().toISOString(),
      source: { kind: 'person', label: 'ceo' },
      channel: 'slack',
      confidence: { value: 0.9, method: 'test' },
      permissions: { visibility: 'principal', principalId: owner.principalId },
    });
    const trace = await startExecution(owner, {
      trigger: { kind: 'observation', id: restricted.id, label: null },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await driveMinimal(owner, trace.id, 13); // no-action cycle to completion

    // Another member of the SAME tenant reconstructs: the restricted
    // observation is an unreadable marker, not an error, not a leak.
    const colleague = member(tenantRestricted);
    const evidence = await reconstructDecision(colleague, { executionId: trace.id });
    expect(evidence.chain.input.observation).toEqual({ id: restricted.id, unreadable: true });
    const marker = evidence.chain.evidence.observations.find(
      (observation) => observation.id === restricted.id,
    );
    expect(marker).toEqual({ id: restricted.id, unreadable: true });
    // The chain itself is complete — the reconstruction succeeded.
    const present = new Map(evidence.completeness.map((link) => [link.stage, link.present]));
    expect(present.get('input')).toBe(true);
    expect(present.get('evidence')).toBe(true);
    expect(present.get('execution')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('reports foreign anchors uniformly as missing — reads and reconstructions', async () => {
    const insider = member(tenantIsoA);
    const outsider = member(tenantIsoB);

    // An execution, a request and an audit record in tenant A.
    const triggerId = await seedObservation(insider, { signal: 'isolation trigger' });
    const trace = await startExecution(insider, {
      trigger: { kind: 'observation', id: triggerId, label: null },
      focus: { topics: ['churn'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
    });
    await driveMinimal(insider, trace.id, 13);
    const request = await authorizeAction(insider, {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: { to: 'vp-cs', question: 'isolation?' },
    });
    const recorded = await recordAudit(insider, {
      subjectKind: 'cognition.execution',
      subjectId: trace.id,
      event: 'outcome-recorded',
      chainStage: 'outcome',
      correlationId: trace.correlationId,
      summary: 'tenant A history',
    });

    // Tenant B sees none of it — uniformly not-found, no existence leak.
    await expectCode('execution_not_found', () =>
      reconstructDecision(outsider, { executionId: trace.id }),
    );
    await expectCode('action_request_not_found', () =>
      reconstructDecision(outsider, { actionRequestId: request.id }),
    );
    await expectCode('execution_not_found', () =>
      reconstructDecision(outsider, { correlationId: trace.correlationId }),
    );
    await expectCode('audit_record_not_found', () =>
      getAuditRecord(outsider, { recordId: recorded.id }),
    );
    expect(await listAuditRecords(outsider, {})).toEqual([]);

    // An unknown flow reconstructs as nothing here, for either tenant.
    await expectCode('execution_not_found', () =>
      reconstructDecision(insider, { correlationId: newId() }),
    );
  });

  it('scopes the audit trail listing to the calling tenant', async () => {
    const a = member(tenantListA);
    const b = member(tenantListB);
    await recordAudit(a, {
      subjectKind: 'actions.request',
      subjectId: newId(),
      event: 'approval-decided',
      chainStage: 'approval',
      summary: 'tenant A event',
    });
    await recordAudit(b, {
      subjectKind: 'actions.request',
      subjectId: newId(),
      event: 'approval-decided',
      chainStage: 'approval',
      summary: 'tenant B event',
    });
    expect((await listAuditRecords(a, {})).map((record) => record.summary)).toEqual([
      'tenant A event',
    ]);
    expect((await listAuditRecords(b, {})).map((record) => record.summary)).toEqual([
      'tenant B event',
    ]);
  });
});
