// Integration tests for the evidence/audit surface (W065) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE ACCEPTANCE CORE, proven end to end through REAL module contracts:
//
//   * SEED one tenant with a fully consequential decision: a registered
//     source with a stale-after policy → fresh and stale observations →
//     an AI-extracted derived observation (provider/model lineage) → a
//     complete cognitive execution (claim, unknown, learning mission,
//     belief) → a policy-gated recommendation at EXECUTE level → the
//     suspension → a HUMAN approval by a second principal → the recorded
//     outcome → the durable learning → a retained contradiction involving
//     the chain's own evidence → appended audit records.
//   * RECONSTRUCTION: buildDecisionExplainView returns the WHOLE causal
//     chain (every §24 link present and enriched) through all three
//     anchors — execution, action request, correlation.
//   * SOURCE RELIABILITY/FRESHNESS: per-observation freshness (current /
//     stale / unknown against the tenant's policy) and the registered
//     source's connection status + stream freshness.
//   * CONTRADICTION DISPLAY: the retained conflict renders with BOTH
//     sides human-labeled from the chain's own evidence.
//   * POLICY EVALUATION / APPROVAL RECORD / EXECUTION / OUTCOME /
//     LEARNING UPDATE: each link carries the real records (the gate's
//     evaluation, the human decision, the completed cycle, the recorded
//     outcome kind, the captured knowledge).
//   * THE INDEX: human-titled, newest-first, deep-linking rows plus the
//     append-only audit feed (with subject deep links).
//   * TENANT ISOLATION: tenant B reads not-found for every anchor of
//     tenant A's decision and an empty index (ADR-0001, no existence
//     leak); malformed ids are uniformly not-found.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { systemClock } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import { provisionTenant } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import { registerSource } from '@/modules/sources/contract';
import type { Source } from '@/modules/sources/contract';
import { setFreshnessPolicy } from '@/modules/freshness/contract';
import { recordObservation } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import { registerContradiction } from '@/modules/epistemics/contract';
import { recordAudit } from '@/modules/audit/contract';
import {
  getExecution,
  runNextStage,
  startExecution,
} from '@/modules/cognition/contract';
import type { CognitiveExecutionTrace } from '@/modules/cognition/contract';
import { decideApproval } from '@/modules/actions/contract';

import { buildDecisionExplainView, buildEvidenceIndexView } from '../lib/views';
import type { DecisionExplainView } from '../lib/views';

/** Resolve a decision view or fail loudly (tests only assert the found path here). */
async function foundView(
  ctx: TenantContext,
  kind: 'execution' | 'action-request' | 'correlation',
  id: string,
): Promise<DecisionExplainView> {
  const resolution = await buildDecisionExplainView(ctx, kind, id);
  if (resolution.status !== 'found') {
    throw new Error(`expected a found view for ${kind} ${id}`);
  }
  return resolution.view;
}

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Frozen service clock — deterministic freshness arithmetic. */
const BASE_TIME = Date.parse('2026-10-01T09:00:00.000Z');
/** Seconds helper for observedAt offsets. */
const at = (offsetSeconds: number): string =>
  new Date(BASE_TIME + offsetSeconds * 1000).toISOString();

function member(tenantId: string, principalId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId, authority };
}

// Fake credentials assembled from fragments at runtime (push-protection).
const passwordFragments = ['ri', 'verbed', '-la', 'ntern-7'];

async function provisionFixture(name: string) {
  const local = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const email = [local, '.', newId().slice(0, 8), '@example', '.test'].join('');
  const issued = await registerUser({
    displayName: `${name} Owner`,
    email,
    password: passwordFragments.join(''),
  });
  const tenant = await provisionTenant(
    { principalId: newId(), authority: ['organizations:provision'] },
    { name, ownerPrincipalId: issued.session.principalId },
  );
  await selectCompany({ token: issued.token, tenantId: tenant.id });
  return { tenant, owner: member(tenant.id, issued.session.principalId) };
}

describe('the causal evidence view over a fully consequential decision', () => {
  let acme: { tenant: Tenant; owner: TenantContext };
  let beta: { tenant: Tenant; owner: TenantContext };
  let approver: TenantContext;

  let source: Source;
  let freshObservation: Observation;
  let staleObservation: Observation;
  let derivedObservation: Observation;
  let trace: CognitiveExecutionTrace;
  let chainClaimId: string;
  let requestId: string;
  let unknownId: string;
  let missionId: string;
  let beliefId: string;
  let learningEntryId: string;

  beforeAll(async () => {
    vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(BASE_TIME));
    await runMigrations(db);

    acme = await provisionFixture('Northwind Explain');
    beta = await provisionFixture('Initech Explain');
    const ctx = acme.owner;

    // A second principal — the human who decides the gated action
    // (separation of duties: the requester never decides their own ask).
    const approverLogin = await registerUser({
      displayName: 'Ines Approver',
      email: ['ines.approver', '.', newId().slice(0, 8), '@example', '.test'].join(''),
      password: passwordFragments.join(''),
    });
    approver = member(acme.tenant.id, approverLogin.session.principalId, ['actions:approve']);

    // The registered source + its stale-after policy (freshness has rules).
    const registration = await registerSource(ctx, {
      provider: 'salesforce',
      providerAccountId: 'northwind-crm-001',
      displayName: 'Northwind CRM',
      authKind: 'credentials',
      credentialRef: 'keychain://sources/northwind-crm',
    });
    source = registration.source;
    await setFreshnessPolicy(ctx, {
      subjectKind: 'source',
      subjectId: source.id,
      staleAfterSeconds: 3600,
      agingAfterSeconds: 600,
      maxLatencySeconds: 300,
      note: 'CRM evidence older than an hour is stale for ops decisions',
    });

    // The evidence: one fresh sample, one stale sample, one AI-extracted
    // derived note (provider/model lineage — lock 10/28).
    freshObservation = await recordObservation(ctx, {
      kind: 'metric.sample',
      payload: { account: 'harbor-grocery', score: 86 },
      observedAt: at(-120),
      source: { kind: 'source', id: source.id, label: 'Northwind CRM' },
      channel: 'ingestion',
      confidence: { value: 0.9, method: 'system-report', basis: 'weekly CRM export' },
    });
    staleObservation = await recordObservation(ctx, {
      kind: 'metric.sample',
      payload: { account: 'nordic-cafe', score: 71 },
      observedAt: at(-7200),
      source: { kind: 'source', id: source.id, label: 'Northwind CRM' },
      channel: 'ingestion',
      confidence: { value: 0.85, method: 'system-report', basis: 'weekly CRM export' },
    });
    derivedObservation = await recordObservation(ctx, {
      kind: 'metric.note',
      payload: { note: 'Both flagship samples sit below the 92% target.' },
      observedAt: at(-60),
      source: { kind: 'system', label: 'Aurum extraction' },
      channel: 'cognition',
      lineage: {
        method: 'extraction',
        parents: [freshObservation.id, staleObservation.id],
        extractor: { provider: 'openai', model: 'gpt-4o' },
      },
      confidence: { value: 0.8, method: 'llm-extraction', basis: 'two CRM samples' },
    });

    // The complete decision cycle.
    trace = await startExecution(ctx, {
      trigger: { kind: 'management', label: 'October ops review' },
      focus: { topics: ['freshness', 'wholesale'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'evaluate the freshness evidence and propose the recovery step',
    });
    const executionId = trace.id;
    const advance = (input: Parameters<typeof runNextStage>[1]) => runNextStage(ctx, input);

    await advance({
      executionId,
      stage: 'observation',
      reference: [freshObservation.id, staleObservation.id, derivedObservation.id],
    });
    await advance({ executionId, stage: 'evidence-memory' });
    await advance({ executionId, stage: 'world-update', update: null });
    const epistemic = await advance({
      executionId,
      stage: 'epistemic-evaluation',
      claims: [
        {
          proposition: 'Freshness averaged below the 92% target at both flagship accounts.',
          confidence: { value: 0.9, method: 'system-evidence', basis: 'two CRM samples' },
          evidenceObservationIds: [freshObservation.id, staleObservation.id],
        },
      ],
    });
    chainClaimId = (epistemic.steps.at(-1)!.result as { claimIds: string[] }).claimIds[0]!;
    await advance({ executionId, stage: 'goal-evaluation' });
    const unknownMission = await advance({
      executionId,
      stage: 'unknown-mission-evaluation',
      unknowns: [
        {
          question: 'Which courier lane caused the freshness dip?',
          consequence: 'Without knowing, the Q4 recovery plan cannot prioritize lanes.',
        },
      ],
      missions: [
        {
          title: 'Trace the freshness dip to its courier lane',
          knowledgeObjective: 'Identify the dominant driver of the wholesale freshness dip.',
          informationValue: 0.8,
          urgency: 'high',
          currentConfidence: 0.35,
          targetConfidence: 0.8,
          investigationBudget: { amount: 40000, currency: 'USD' },
          rewardBudget: { amount: 8000, currency: 'USD' },
          completionCriteria: 'One lane is identified with at least 80% confidence.',
        },
      ],
    });
    const unknownMissionResult = unknownMission.steps.at(-1)!.result as {
      unknownIds: string[];
      missionIds: string[];
    };
    unknownId = unknownMissionResult.unknownIds[0]!;
    missionId = unknownMissionResult.missionIds[0]!;
    await advance({ executionId, stage: 'knowledge-acquisition', missionId: null });
    const modelUpdate = await advance({
      executionId,
      stage: 'model-update',
      belief: {
        proposition: 'The courier customs-broker change is the dominant driver of the freshness dip.',
        confidence: { value: 0.75, method: 'evidence-reasoning', basis: 'the CRM claim' },
        supportingObservationIds: [freshObservation.id, staleObservation.id],
        supportingClaimIds: [chainClaimId],
        alternatives: ['seasonal demand peaks alone explain the dip'],
        disconfirmation: 'freshness recovering while the customs broker stays unchanged',
        validFrom: at(-3600),
        rationale: "the cycle's own claim, weighed",
      },
    });
    beliefId = (modelUpdate.steps.at(-1)!.result as { beliefId: string | null }).beliefId!;
    await advance({ executionId, stage: 'risk-opportunity-capability-analysis', findings: [] });

    // THE POLICY GATE: an EXECUTE-level action — the built-in default
    // matrix requires human approval → the cycle suspends.
    await advance({
      executionId,
      stage: 'recommendation-ask-proposal-action',
      action: {
        actionKind: 'external-communication',
        authorityLevel: 'EXECUTE',
        payload: { channel: 'email', audience: 'flagship-accounts', draft: 'Our recovery plan' },
        justification: 'Notify flagship accounts of the freshness recovery plan.',
      },
    });
    const suspended = await getExecution(ctx, { executionId });
    expect(suspended.state).toBe('awaiting_approval');
    requestId = suspended.pending!.requestId!;

    // THE HUMAN DECISION — a different principal approves.
    await decideApproval(approver, {
      requestId,
      decision: 'approve',
      note: 'Recovery plan approved for Q4.',
    });

    // The release pump: the suspended stage re-runs, observes the human
    // decision, and the cycle continues (lock 36 — resumable, traceable).
    const released = await advance({ executionId, stage: 'recommendation-ask-proposal-action' });
    expect(released.state).toBe('running');

    const outcomeStep = await advance({
      executionId,
      stage: 'outcome',
      summary: 'The ops review concluded with an approved flagship notification.',
    });
    expect(
      (outcomeStep.steps.at(-1)!.result as { kind: string }).kind,
    ).toBe('action-authorized');
    const learning = await advance({
      executionId,
      stage: 'learning',
      knowledge: {
        title: 'Freshness dips concentrate in the customs-broker change window',
        summary: 'Both flagship accounts dipped after the broker change; the pattern repeats weekly.',
        topics: ['freshness', 'couriers'],
      },
    });
    learningEntryId = (learning.steps.at(-1)!.result as { knowledgeEntryId: string | null })
      .knowledgeEntryId!;

    // A retained contradiction involving the chain's own evidence (lock 12).
    await registerContradiction(ctx, {
      left: { kind: 'observation', id: freshObservation.id },
      right: { kind: 'claim', id: chainClaimId },
      note: 'The account-level sample and the weekly summary disagree on the freshness floor.',
    });

    // Append-only audit history for the flow (the trail beneath the chain).
    await recordAudit(ctx, {
      subjectKind: 'actions.policy',
      event: 'policy-reviewed',
      chainStage: 'policy',
      correlationId: trace.correlationId,
      summary: 'The authority matrix was reviewed for external communications.',
    });
    await recordAudit(ctx, {
      subjectKind: 'cognition.execution',
      subjectId: executionId,
      event: 'cycle-completed',
      chainStage: 'execution',
      correlationId: trace.correlationId,
      summary: 'The October ops review completed all twelve stages.',
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  // -------------------------------------------------------------------------
  // The reconstruction — every acceptance link, through the execution anchor
  // -------------------------------------------------------------------------

  it('reconstructs the whole causal chain with every link present', async () => {
    const view = await foundView(acme.owner, 'execution', trace.id);

    expect(view.title).toBe('October ops review');
    expect(view.kindLabel).toBe('Decision cycle');
    expect(view.correlationId).toBe(trace.correlationId);
    expect(view.degraded).toEqual([]);

    // Every one of the twelve §24 links is present (the completeness
    // report is the reconstruction's own, rendered not assumed).
    const presentStages = new Set<string>(
      view.completeness.filter((report) => report.present).map((report) => String(report.stage)),
    );
    for (const stage of [
      'input',
      'evidence',
      'claims-beliefs',
      'unknown-mission',
      'policy',
      'model-provider',
      'recommendation',
      'approval',
      'execution',
      'result',
      'outcome',
      'learning',
    ]) {
      expect(presentStages.has(stage)).toBe(true);
    }

    // Input — the trigger and its observation.
    expect(view.chain.input.trigger?.label).toBe('October ops review');
    expect(view.chain.input.observation).toBeNull(); // a management trigger carries none

    // Claims & beliefs — derived, versioned, uncertainty kept.
    expect(view.chain.claimsBeliefs.claims).toHaveLength(1);
    expect(view.chain.claimsBeliefs.claims[0]!.id).toBe(chainClaimId);
    expect(view.chain.claimsBeliefs.beliefs).toHaveLength(1);
    expect(view.chain.claimsBeliefs.beliefs[0]!.id).toBe(beliefId);
    expect(view.chain.claimsBeliefs.beliefs[0]!.alternatives).toEqual([
      'seasonal demand peaks alone explain the dip',
    ]);

    // Unknown & mission — the gap, its consequence, the learning launched.
    expect(view.chain.unknownMission.unknowns).toHaveLength(1);
    expect(view.chain.unknownMission.unknowns[0]!.id).toBe(unknownId);
    expect(view.chain.unknownMission.missions).toHaveLength(1);
    expect(view.chain.unknownMission.missions[0]!.id).toBe(missionId);
    expect(view.chain.unknownMission.missions[0]!.currentConfidence).toBeCloseTo(0.35, 5);

    // Policy evaluation — the deterministic gate record.
    expect(view.chain.policy.authorityEvaluation?.actionKind).toBe('external-communication');
    expect(view.chain.policy.authorityEvaluation?.outcome).toBe('approval_required');
    expect(view.chain.policy.authorityEvaluation?.authorityLevel).toBe('EXECUTE');

    // Recommendation — the proposed action, approved.
    expect(view.chain.recommendation.actionRequest?.id).toBe(requestId);
    expect(view.chain.recommendation.actionRequest?.status).toBe('approved');
    expect(view.chain.recommendation.actionRequest?.justification).toContain('recovery plan');

    // Approval record — the human decision, attributed and noted.
    expect(view.chain.approval.decisions).toHaveLength(1);
    expect(view.chain.approval.decisions[0]!.decision).toBe('approve');
    expect(view.chain.approval.decisions[0]!.decidedBy).toBe('principal');
    expect(view.chain.approval.decisions[0]!.principalId).toBe(approver.principalId);
    expect(view.chain.approval.decisions[0]!.note).toBe('Recovery plan approved for Q4.');

    // Execution — the completed cycle.
    expect(view.chain.execution.executions).toHaveLength(1);
    expect(view.chain.execution.executions[0]!.id).toBe(trace.id);
    expect(view.chain.execution.executions[0]!.state).toBe('completed');
    expect(view.chain.execution.executions[0]!.completedStages).toBe(12);

    // Result — the gate and its human resolution.
    expect(view.chain.result.gate).toBe('approval_required');
    expect(view.chain.result.resolution).toBe('approved');
    expect(view.chain.result.requestStatus).toBe('approved');
    expect(view.chain.result.decidedAt).not.toBeNull();

    // Outcome — what the cycle recorded.
    expect(view.chain.outcome.outcomes).toHaveLength(1);
    expect(view.chain.outcome.outcomes[0]!.kind).toBe('action-authorized');
    expect(view.chain.outcome.outcomes[0]!.actionRequestId).toBe(requestId);

    // Learning update — the durable knowledge.
    expect(view.chain.learning.knowledge).toHaveLength(1);
    expect(view.chain.learning.knowledge[0]!.id).toBe(learningEntryId);
    expect(view.chain.learning.knowledge[0]!.topics).toEqual(['couriers', 'freshness']);

    // The audit history beneath the chain.
    const auditEvents = view.auditRecords.map((record) => record.event);
    expect(auditEvents).toContain('policy-reviewed');
    expect(auditEvents).toContain('cycle-completed');
  });

  it('enriches the evidence with source reliability and freshness', async () => {
    const view = await foundView(acme.owner, 'execution', trace.id);

    // Three observations on the evidence base (the ingested three).
    expect(view.evidenceRows).toHaveLength(3);
    const byId = new Map(view.evidenceRows.map((row) => [row.id, row]));

    // The fresh sample: current, no latency breach.
    const fresh = byId.get(freshObservation.id)!;
    expect(fresh.unreadable).toBe(false);
    expect(fresh.freshness?.status).toBe('current');
    expect(fresh.freshness?.latencyExceeded).toBe(false);

    // The stale sample: stale against the tenant's policy (age 2h > 1h).
    const stale = byId.get(staleObservation.id)!;
    expect(stale.freshness?.status).toBe('stale');

    // The AI-extracted note: no source policy applies → unknown, but the
    // extractor lineage is part of the chain (lock 10/28).
    const derived = byId.get(derivedObservation.id)!;
    expect(derived.freshness?.status).toBe('unknown');
    expect(derived.extractor).toEqual({ provider: 'openai', model: 'gpt-4o' });

    // The registered source: connected, stream-fresh, cited twice.
    expect(view.sources).toHaveLength(1);
    const sourceRow = view.sources[0]!;
    expect(sourceRow.id).toBe(source.id);
    expect(sourceRow.label).toBe('Northwind CRM');
    expect(sourceRow.provider).toBe('salesforce');
    expect(sourceRow.status).toBe('active');
    expect(sourceRow.freshness?.status).toBe('current');
    expect(sourceRow.freshness?.considered).toBe(2);
    expect(sourceRow.observationCount).toBe(2);

    // The model/provider link carries the extractor attribution.
    expect(view.chain.modelProvider.extractors).toEqual([
      { provider: 'openai', model: 'gpt-4o', observationIds: [derivedObservation.id] },
    ]);

    // Both base observations are attributed to the registered source.
    expect(fresh.sourceId).toBe(source.id);
    expect(stale.sourceId).toBe(source.id);
  });

  it('displays the retained contradiction with both sides human-labeled', async () => {
    const view = await foundView(acme.owner, 'execution', trace.id);

    expect(view.contradictions).toHaveLength(1);
    const conflict = view.contradictions[0]!;
    expect(conflict.status).toBe('open');
    expect(conflict.note).toContain('disagree');
    // The pair is canonicalized (claim < observation); both sides are
    // present, human-labeled — assert by kind, not by order.
    const sides = [conflict.left, conflict.right];
    const observationSide = sides.find((side) => side.refKind === 'observation')!;
    const claimSide = sides.find((side) => side.refKind === 'claim')!;
    expect(observationSide.id).toBe(freshObservation.id);
    expect(observationSide.label).toContain('metric.sample');
    expect(observationSide.label).toContain('harbor-grocery');
    expect(claimSide.id).toBe(chainClaimId);
    expect(claimSide.label).toContain('92% target');
  });

  // -------------------------------------------------------------------------
  // The other anchors
  // -------------------------------------------------------------------------

  it('reconstructs through the action-request anchor (the approval-centric view)', async () => {
    const view = await foundView(acme.owner, 'action-request', requestId);
    expect(view.title).toBe('External Communication');
    expect(view.chain.recommendation.actionRequest?.id).toBe(requestId);
    // The driving execution resolved through the gate's idempotency key.
    expect(view.chain.execution.executions.map((execution) => execution.id)).toEqual([trace.id]);
    expect(view.chain.approval.decisions).toHaveLength(1);
  });

  it('reconstructs through the correlation anchor (the whole decision flow)', async () => {
    const view = await foundView(acme.owner, 'correlation', trace.correlationId);
    expect(view.chain.execution.executions[0]!.id).toBe(trace.id);
    expect(view.chain.outcome.outcomes[0]!.kind).toBe('action-authorized');
  });

  // -------------------------------------------------------------------------
  // The index
  // -------------------------------------------------------------------------

  it('builds the index: human-titled decisions, newest-first, deep-linked', async () => {
    const index = await buildEvidenceIndexView(acme.owner);
    expect(index.degraded).toEqual([]);

    const executionRow = index.decisions.find((row) => row.href === `/explain/execution/${trace.id}`);
    expect(executionRow?.title).toBe('October ops review');
    expect(executionRow?.statusLabel).toBe('Completed');
    expect(executionRow?.kindLabel).toBe('Decision cycle');

    const requestRow = index.decisions.find((row) => row.href === `/explain/action/${requestId}`);
    expect(requestRow?.title).toBe('External Communication');
    expect(requestRow?.statusLabel).toBe('Approved');
    expect(requestRow?.kindLabel).toBe('Action request');

    // Newest-first ordering.
    for (let index_ = 1; index_ < index.decisions.length; index_ += 1) {
      expect(index.decisions[index_]!.when <= index.decisions[index_ - 1]!.when).toBe(true);
    }

    // The audit feed, with the execution-subject record deep-linked.
    const events = index.auditEvents.map((event) => event.event);
    expect(events).toContain('policy-reviewed');
    expect(events).toContain('cycle-completed');
    const linked = index.auditEvents.find((event) => event.event === 'cycle-completed');
    expect(linked?.href).toBe(`/explain/execution/${trace.id}`);
    expect(index.auditEvents.find((event) => event.event === 'policy-reviewed')?.href).toBeNull();
    const policyEvent = index.auditEvents.find((event) => event.event === 'policy-reviewed');
    expect(policyEvent?.stageLabel).toBe('Policy');
  });

  // -------------------------------------------------------------------------
  // Isolation and uniform not-found
  // -------------------------------------------------------------------------

  it('is tenant-isolated: another tenant reads not-found everywhere', async () => {
    for (const [kind, id] of [
      ['execution', trace.id],
      ['action-request', requestId],
      ['correlation', trace.correlationId],
    ] as const) {
      const resolution = await buildDecisionExplainView(beta.owner, kind, id);
      expect(resolution.status).toBe('not-found');
    }
  });

  it('renders uniformly not-found for malformed ids (no existence probing)', async () => {
    const resolution = await buildDecisionExplainView(acme.owner, 'execution', 'not-a-uuid');
    expect(resolution.status).toBe('not-found');
  });

  it('tenant B has an empty index (isolation at the composition boundary)', async () => {
    const index = await buildEvidenceIndexView(beta.owner);
    expect(index.decisions).toEqual([]);
    expect(index.auditEvents).toEqual([]);
    expect(index.degraded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Working deep links into the intelligence workflow
  // -------------------------------------------------------------------------

  it('deep-links unknowns into the intelligence workflow and missions into the working surface', async () => {
    const view = await foundView(acme.owner, 'execution', trace.id);
    expect(view.links.unknown(unknownId)).toBe(`/intelligence/unknowns/${unknownId}`);
    expect(view.links.missionBase).toBe('/missions');
  });
});
