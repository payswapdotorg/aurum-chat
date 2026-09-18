// Integration tests for the briefings module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W032
// acceptance: "Generate policy-controlled proactive briefings for
// changes, goal drift, unknowns, risks, opportunities, capability gaps,
// workforce/agent performance and approvals."
//
//  * policies — claim-gated writes, upsert semantics, the
//    default-row-only delivery configuration, kind → default → built-in
//    resolution, and the uniform cross-tenant not-found discipline
//    (ADR-0001);
//  * generation — every section compiled from the REAL sibling
//    contracts (events, goals, epistemics, cognition, capabilities,
//    agents, actions), with deep links to the underlying records and
//    honest candidate counts;
//  * policy control — section disabling, item caps (truncation noted),
//    and section lookback windows trimming what a briefing covers;
//  * proactive windows — continuous default coverage (no gaps, no
//    overlaps) and the cadence window on the first briefing;
//  * delivery handoff — a policy-configured recipient pushes the
//    briefing through the notifications module (W031: kind 'briefing',
//    stable dedupe key, the notification carries the briefing id and is
//    delivered over a real channel);
//  * idempotency — a recorded key replays the original briefing and
//    re-attempts an unfinished delivery;
//  * tenant isolation — another tenant's briefings, sections and
//    policies are indistinguishable from missing; generation compiles
//    only the caller tenant's data;
//  * storage discipline — briefings and sections are immutable history
//    (only the one-way delivery link may move; triggers reject
//    UPDATE/DELETE/TRUNCATE).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  registerChannelConnection,
  setChannelTransport,
  type CanonicalDeliveryRequest,
  type ChannelTransport,
  type TransportReceipt,
} from '@/modules/channels/contract';
import { listNotifications } from '@/modules/notifications/contract';
import { authorizeAction } from '@/modules/actions/contract';
import {
  registerAgent,
  runAgentExecution,
  setAgentTransport,
  submitAgentExecution,
  type AgentRuntimeTransport,
  type AgentRuntimeTransportReceipt,
  type AgentRuntimeTransportRequest,
} from '@/modules/agents/contract';
import { appendEvent } from '@/modules/events/contract';
import { createGoal, reviseGoal } from '@/modules/goals/contract';
import { recordUnknown, resolveUnknown } from '@/modules/epistemics/contract';
import { recordObservation } from '@/modules/observations/contract';
import { runNextStage, startExecution } from '@/modules/cognition/contract';
import {
  registerCapability,
  registerRequirement,
  registerSupply,
} from '@/modules/capabilities/contract';
import { BriefingsError } from '../errors';
import * as briefingsContract from '../contract';
import type { GoalDriftItemDetail } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  generateBriefing,
  getBriefing,
  getBriefingPolicy,
  listBriefingPolicies,
  listBriefings,
  resolveBriefingPolicy,
  setBriefingPolicy,
} = briefingsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantPolicies = newId();
const tenantFull = newId();
const tenantPolicyControl = newId();
const tenantWindows = newId();
const tenantDelivery = newId();
const tenantIdempotency = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantEmpty = newId();
const tenantB = newId();

const PERSON_ID = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function policyAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['briefings:administer'] };
}

async function expectCode(
  code: BriefingsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected BriefingsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(BriefingsError);
    expect((error as BriefingsError).code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Recording transports (channels for notification delivery, agents for
// agent-workforce executions) — provider-neutral fakes, exactly like the
// sibling modules' own tests.
// ---------------------------------------------------------------------------

class RecordingChannelTransport implements ChannelTransport {
  readonly requests: CanonicalDeliveryRequest[] = [];
  private static counter = 0;

  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    RecordingChannelTransport.counter += 1;
    return {
      status: 'delivered',
      providerMessageId: `prov-out-${String(RecordingChannelTransport.counter).padStart(6, '0')}`,
      detail: null,
    };
  }
}

class SucceedingAgentTransport implements AgentRuntimeTransport {
  readonly requests: AgentRuntimeTransportRequest[] = [];
  private static counter = 0;

  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    this.requests.push(request);
    SucceedingAgentTransport.counter += 1;
    const taskId = `fake-${String(SucceedingAgentTransport.counter).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload: {
        id: `run_${taskId}`,
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'triaged' }],
          },
        ],
        usage: { input_tokens: 1200, output_tokens: 800 },
      },
      providerTaskId: taskId,
      detail: null,
    };
  }
}

let channelTransport: RecordingChannelTransport;

// ---------------------------------------------------------------------------
// Clock control (the service/cognition clocks read the same systemClock)
// ---------------------------------------------------------------------------

const BASE_TIME = Date.parse('2026-09-14T12:00:00Z');
let clockMs = BASE_TIME;

function setClock(at: number): void {
  clockMs = at;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
}

function advance(seconds: number): void {
  setClock(clockMs + seconds * 1_000);
}

// ---------------------------------------------------------------------------
// Seed helpers (every seed goes through the OWNING module's contract)
// ---------------------------------------------------------------------------

async function seedEvent(
  ctx: TenantContext,
  type: string,
  occurredAt: string,
): Promise<string> {
  const event = await appendEvent(ctx, {
    type,
    payload: { note: `event ${type}` },
    occurredAt,
    actor: { kind: 'person', id: PERSON_ID, label: 'COO' },
    source: { kind: 'system', label: 'aurum-test' },
  });
  return event.id;
}

async function seedGoal(
  ctx: TenantContext,
  title: string,
  horizonEnd: string,
  priority: 'critical' | 'high' | 'medium' | 'low' = 'high',
): Promise<string> {
  const goal = await createGoal(ctx, {
    title,
    objective: `Objective of ${title}`,
    desiredState: `${title} achieved`,
    horizonEnd,
    owner: { kind: 'person', id: PERSON_ID, label: 'COO' },
    priority,
    successCriteria: `${title} success criteria`,
    actor: { kind: 'person', id: PERSON_ID },
    rationale: 'W032 test seed',
  });
  return goal.id;
}

async function seedObservation(ctx: TenantContext): Promise<string> {
  const observation = await recordObservation(ctx, {
    kind: 'channel.message',
    payload: { text: 'churn spiked 12% in Q3' },
    observedAt: new Date(clockMs).toISOString(),
    source: { kind: 'source', label: 'slack' },
    channel: 'slack',
    confidence: { value: 0.8, method: 'test' },
  });
  return observation.id;
}

/**
 * Drives one cognitive execution (W013) minimally up to and INCLUDING
 * the risk-opportunity-capability-analysis stage with the given
 * findings — the honest way findings get onto the cognition trace.
 */
async function seedExecutionWithFindings(
  ctx: TenantContext,
  findings: { kind: 'risk' | 'opportunity' | 'capability-gap'; statement: string }[],
): Promise<string> {
  const triggerObservationId = await seedObservation(ctx);
  const trace = await startExecution(ctx, {
    trigger: { kind: 'observation', id: triggerObservationId, label: null },
    focus: { topics: ['churn', 'pricing'], entities: [] },
    actor: { kind: 'system', label: 'aurum-cognition' },
    rationale: 'W032 findings seed',
  });
  await runNextStage(ctx, {
    executionId: trace.id,
    stage: 'observation',
    record: [
      {
        kind: 'channel.message',
        payload: { text: 'support ticket volume up 30%' },
        observedAt: new Date(clockMs).toISOString(),
        source: { kind: 'source', label: 'slack' },
        channel: 'slack',
        confidence: { value: 0.8, method: 'test' },
      },
    ],
    reference: [triggerObservationId],
  });
  await runNextStage(ctx, { executionId: trace.id, stage: 'evidence-memory' });
  await runNextStage(ctx, { executionId: trace.id, stage: 'world-update', update: null });
  await runNextStage(ctx, { executionId: trace.id, stage: 'epistemic-evaluation', claims: [] });
  await runNextStage(ctx, { executionId: trace.id, stage: 'goal-evaluation', relatedGoalIds: [] });
  await runNextStage(ctx, {
    executionId: trace.id,
    stage: 'unknown-mission-evaluation',
    unknowns: [],
    missions: [],
  });
  await runNextStage(ctx, {
    executionId: trace.id,
    stage: 'knowledge-acquisition',
    missionId: null,
  });
  await runNextStage(ctx, { executionId: trace.id, stage: 'model-update', belief: null });
  await runNextStage(ctx, {
    executionId: trace.id,
    stage: 'risk-opportunity-capability-analysis',
    findings: findings.map((finding) => ({
      kind: finding.kind,
      statement: finding.statement,
      evidenceObservationIds: [],
      affectedGoalIds: [],
    })),
  });
  return trace.id;
}

async function seedCapabilityGap(
  ctx: TenantContext,
  name: string,
): Promise<{ capabilityId: string }> {
  const capability = await registerCapability(ctx, {
    name,
    description: 'W032 test capability',
    actor: { kind: 'person', id: PERSON_ID, label: 'COO' },
    rationale: 'W032 test seed',
  });
  await registerRequirement(ctx, {
    capabilityId: capability.id,
    source: { kind: 'goal', label: 'churn reduction' },
    level: 0.8,
    actor: { kind: 'person', id: PERSON_ID, label: 'COO' },
    rationale: 'demand without supply',
  });
  return { capabilityId: capability.id };
}

async function seedCoveredCapability(
  ctx: TenantContext,
  name: string,
): Promise<{ capabilityId: string }> {
  const capability = await registerCapability(ctx, {
    name,
    actor: { kind: 'person', id: PERSON_ID, label: 'COO' },
    rationale: 'W032 test seed',
  });
  await registerRequirement(ctx, {
    capabilityId: capability.id,
    source: { kind: 'goal', label: 'churn reduction' },
    level: 0.5,
    actor: { kind: 'person', id: PERSON_ID, label: 'COO' },
    rationale: 'covered demand',
  });
  await registerSupply(ctx, {
    capabilityId: capability.id,
    supplier: { kind: 'employee', id: PERSON_ID, label: 'Analyst' },
    level: 0.9,
    actor: { kind: 'person', id: PERSON_ID, label: 'COO' },
    rationale: 'supply covering the demand',
  });
  return { capabilityId: capability.id };
}

async function seedAgentExecution(
  ctx: TenantContext,
  slug: string,
): Promise<{ agentId: string; succeeded: string }> {
  const agent = (
    await registerAgent(
      { ...ctx, authority: ['agents:administer'] },
      {
        slug,
        displayName: slug,
        role: 'conversation triage',
        provider: 'openai-assistants',
        instructions: 'Triage the conversation and propose a reply.',
        permissions: ['observe', 'analyze', 'recommend'],
        runtimeConfig: { assistantId: `asst_${slug}` },
      },
    )
  ).agent;
  const submission = await submitAgentExecution(ctx, {
    agentId: agent.id,
    task: { queue: 'inbound' },
    requestedPermissions: ['observe'],
  });
  const execution = await runAgentExecution(ctx, { executionId: submission.id });
  expect(execution.status).toBe('succeeded');
  return { agentId: agent.id, succeeded: submission.id };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await runMigrations(getDb());
  // One active sending connection per provider per delivering tenant.
  for (const tenantId of [tenantDelivery, tenantIdempotency]) {
    await registerChannelConnection(member(tenantId), {
      provider: 'slack',
      providerAccountId: 'AURUMOPS',
      credentialRef: 'secret-store://slack',
    });
  }
});

afterAll(async () => {
  setChannelTransport(null);
  setAgentTransport(null);
  await closeDb();
});

beforeEach(() => {
  setClock(BASE_TIME);
  channelTransport = new RecordingChannelTransport();
  setChannelTransport(channelTransport);
  setAgentTransport(new SucceedingAgentTransport());
});

afterEach(() => {
  vi.restoreAllMocks();
  setChannelTransport(null);
  setAgentTransport(null);
});

// ---------------------------------------------------------------------------
// Policy management
// ---------------------------------------------------------------------------

describe('briefing policies', () => {
  it('policy writes require the administer claim; reads do not', async () => {
    const ctx = member(tenantPolicies);
    await expectCode('forbidden', () =>
      setBriefingPolicy(ctx, { sectionKind: 'unknowns', maxItems: 5 }),
    );
    const created = await setBriefingPolicy(policyAdmin(tenantPolicies), {
      sectionKind: 'unknowns',
      maxItems: 5,
      windowSeconds: 600,
      note: 'tight unknowns',
    });
    expect(created.sectionKind).toBe('unknowns');
    expect(created.maxItems).toBe(5);
    expect(created.note).toBe('tight unknowns');
    const read = await getBriefingPolicy(ctx, { sectionKind: 'unknowns' });
    expect(read.id).toBe(created.id);
  });

  it('upserts update the same row; the default row is addressable as null', async () => {
    const admin = policyAdmin(tenantPolicies);
    const first = await setBriefingPolicy(admin, {
      sectionKind: null,
      windowSeconds: 3_600,
    });
    const second = await setBriefingPolicy(admin, {
      sectionKind: null,
      windowSeconds: 7_200,
      deliveryRecipient: { provider: 'slack', providerAccountId: 'U777OPER' },
    });
    expect(second.id).toBe(first.id);
    expect(second.windowSeconds).toBe(7_200);
    const rows = await listBriefingPolicies(admin, {});
    expect(rows.some((row) => row.id === second.id && row.deliveryRecipient !== null)).toBe(true);
  });

  it('rejects a delivery recipient on a section-kind row (coherence)', async () => {
    await expectCode('invalid_policy_input', () =>
      setBriefingPolicy(policyAdmin(tenantPolicies), {
        sectionKind: 'changes',
        deliveryRecipient: { provider: 'slack', providerAccountId: 'U777OPER' },
      }),
    );
  });

  it('reads resolve kind → default → built-in; exact reads are not-found when absent', async () => {
    const admin = policyAdmin(tenantPolicies);
    const ctx = member(tenantPolicies);
    await setBriefingPolicy(admin, { sectionKind: null, enabled: false, maxItems: 9 });
    await setBriefingPolicy(admin, { sectionKind: 'unknowns', maxItems: 4 });

    const kindResolved = await resolveBriefingPolicy(ctx, { sectionKind: 'unknowns' });
    expect(kindResolved).toMatchObject({ source: 'kind', enabled: true, maxItems: 4 });
    const defaultResolved = await resolveBriefingPolicy(ctx, { sectionKind: 'changes' });
    expect(defaultResolved).toMatchObject({
      source: 'tenant-default',
      enabled: false,
      maxItems: 9,
    });
    await expectCode('policy_not_found', () =>
      getBriefingPolicy(member(tenantEmpty), { sectionKind: 'unknowns' }),
    );
    await expectCode('policy_not_found', () =>
      getBriefingPolicy(ctx, { sectionKind: 'risks' }),
    );
  });

  it('cross-tenant policy reads are uniformly not-found', async () => {
    await setBriefingPolicy(policyAdmin(tenantPolicies), { sectionKind: 'risks', maxItems: 2 });
    await expectCode('policy_not_found', () =>
      getBriefingPolicy(member(tenantB), { sectionKind: 'risks' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Generation — every section, compiled from the real sibling contracts
// ---------------------------------------------------------------------------

describe('generateBriefing — the full W032 section set', () => {
  it('compiles every section from the dependency contracts with deep links', async () => {
    const ctx = member(tenantFull);

    // changes: one event inside the window, one outside.
    await seedEvent(ctx, 'invoice.registered', '2026-09-14T11:00:00Z');
    await seedEvent(ctx, 'contract.renewed', '2026-09-01T00:00:00Z');

    // goal drift: one overdue goal, one revised-in-window goal, one
    // unchanged (last changed two days ago, horizon healthy).
    await seedGoal(ctx, 'Overdue goal', '2026-09-01T00:00:00Z'); // overdue
    const revisedGoalId = await seedGoal(ctx, 'Revised goal', '2027-06-30T00:00:00Z');
    await reviseGoal(ctx, {
      goalId: revisedGoalId,
      priority: 'critical',
      actor: { kind: 'person', id: PERSON_ID },
      rationale: 'priority raised',
    });
    setClock(BASE_TIME - 2 * 86_400 * 1_000);
    await seedGoal(ctx, 'Healthy goal', '2027-12-31T00:00:00Z');
    setClock(BASE_TIME);

    // unknowns: two open, one resolved (resolution cites a real observation).
    await recordUnknown(ctx, {
      question: 'What is the dominant driver of the Q3 churn rise?',
      consequence: 'Churn reduction investments cannot be prioritized without it.',
    });
    await recordUnknown(ctx, {
      question: 'Which competitor is poaching the enterprise accounts?',
      consequence: 'Retention plays cannot be targeted without the answer.',
    });
    const resolvedUnknown = await recordUnknown(ctx, {
      question: 'Which supplier ships the defective part?',
      consequence: 'Warranty cost cannot be attributed.',
    });
    const resolutionObservationId = await seedObservation(ctx);
    await resolveUnknown(ctx, {
      unknownId: resolvedUnknown.id,
      resolution: { kind: 'observation', id: resolutionObservationId },
      note: 'closed by analysis',
    });

    // risks + opportunities: one execution carrying both, recorded now.
    const executionId = await seedExecutionWithFindings(ctx, [
      { kind: 'risk', statement: 'Legacy-cohort pricing churn threatens the Q4 churn goal.' },
      { kind: 'opportunity', statement: 'Cohort-aware retention offers look materially cheaper.' },
    ]);

    // capability gaps: one uncovered, one covered.
    const { capabilityId } = await seedCapabilityGap(ctx, 'cohort-pricing-analysis');
    await seedCoveredCapability(ctx, 'general-triage');

    // workforce: one active agent with a succeeded execution.
    const { agentId } = await seedAgentExecution(ctx, 'triage-analyst');

    // approvals: one pending EXECUTE-level request (default matrix gates it).
    const gated = await authorizeAction(ctx, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { proposal: 'hire churn analyst agent' },
      justification: 'W032 approvals seed',
    });
    expect(gated.status).toBe('pending');

    // Generate with an explicit 7-day window (sections trim to their own
    // 24h default lookback — the intersection semantics).
    const { briefing, deduped, deliveredNotificationId } = await generateBriefing(ctx, {
      trigger: { kind: 'scheduled', label: 'nightly' },
      windowFrom: '2026-09-07T12:00:00Z',
      windowTo: '2026-09-14T12:00:00Z',
    });
    expect(deduped).toBe(false);
    expect(deliveredNotificationId).toBeNull(); // no delivery recipient configured
    expect(briefing.trigger).toEqual({ kind: 'scheduled', label: 'nightly' });
    expect(briefing.windowFrom).toBe('2026-09-07T12:00:00.000Z');
    expect(briefing.windowTo).toBe('2026-09-14T12:00:00.000Z');
    expect(briefing.generatedBy).toBe(ctx.principalId);
    expect(briefing.policySource).toBe('built-in'); // no default row configured

    const sectionsByKind = new Map(briefing.sections.map((section) => [section.sectionKind, section]));

    // changes: only the in-window event (the 24h lookback trims the 7d window).
    const changes = sectionsByKind.get('changes')!;
    expect(changes.enabled).toBe(true);
    expect(changes.windowFrom).toBe('2026-09-13T12:00:00.000Z'); // lookback won
    expect(changes.items).toHaveLength(1);
    expect(changes.items[0]!.detail.section).toBe('changes');
    expect(changes.items[0]!.summary).toContain('invoice.registered');
    expect(changes.items[0]!.refs).toEqual([
      { module: 'events', kind: 'event', id: expect.any(String) },
    ]);

    // goal drift: the overdue goal first, then the revised one; the healthy
    // goal is absent.
    const goalDrift = sectionsByKind.get('goal-drift')!;
    expect(goalDrift.items.map((entry) => (entry.detail as GoalDriftItemDetail).signal)).toEqual([
      'overdue',
      'revised',
    ]);
    const overdue = goalDrift.items[0]!.detail as GoalDriftItemDetail;
    expect(overdue.horizonEnd).toBe('2026-09-01T00:00:00.000Z');
    const revised = goalDrift.items[1]!.detail as GoalDriftItemDetail;
    expect(revised.goalId).toBe(revisedGoalId);
    expect(revised.changeKind).toBe('revised');

    // unknowns: the two open ones; the resolved one is absent.
    const unknowns = sectionsByKind.get('unknowns')!;
    expect(unknowns.items).toHaveLength(2);
    expect(unknowns.items.map((entry) => entry.refs[0]!.module)).toEqual(['epistemics', 'epistemics']);

    // risks + opportunities: the seeded findings, linked to the execution.
    const risks = sectionsByKind.get('risks')!;
    expect(risks.items).toHaveLength(1);
    expect(risks.items[0]!.summary).toContain('Legacy-cohort pricing churn');
    expect(risks.items[0]!.refs[0]).toEqual({
      module: 'cognition',
      kind: 'execution',
      id: executionId,
    });
    const opportunities = sectionsByKind.get('opportunities')!;
    expect(opportunities.items).toHaveLength(1);
    expect(opportunities.items[0]!.summary).toContain('Cohort-aware retention offers');

    // capability gaps: the uncovered capability; the covered one is absent.
    const gaps = sectionsByKind.get('capability-gaps')!;
    expect(gaps.items).toHaveLength(1);
    expect(gaps.items[0]!.refs).toEqual([
      { module: 'capabilities', kind: 'capability', id: capabilityId },
    ]);
    expect((gaps.items[0]!.detail as { gapStatus: string }).gapStatus).toBe('uncovered');

    // workforce: the agent rollup with its in-window execution.
    const workforce = sectionsByKind.get('workforce-performance')!;
    expect(workforce.items).toHaveLength(1);
    const rollup = workforce.items[0]!.detail as {
      section: 'workforce-performance';
      agentId: string;
      executions: number;
      succeeded: number;
      costMinor: number;
    };
    expect(rollup.agentId).toBe(agentId);
    expect(rollup.executions).toBe(1);
    expect(rollup.succeeded).toBe(1);
    expect(rollup.costMinor).toBeGreaterThan(0);

    // approvals: the pending request, linked to the actions module.
    const approvals = sectionsByKind.get('approvals')!;
    expect(approvals.items).toHaveLength(1);
    expect(approvals.items[0]!.summary).toContain('agent-recruitment');
    expect(approvals.items[0]!.refs).toEqual([
      { module: 'actions', kind: 'action-request', id: gated.id },
    ]);

    // The headline counts what management sees.
    expect(briefing.headline).toBe('Briefing — 8/8 sections, 10 items');

    // Reads: the feed (no items) and the deep read (items).
    const feed = await listBriefings(ctx, {});
    expect(feed).toHaveLength(1);
    const deep = await getBriefing(ctx, { briefingId: briefing.id });
    expect(deep.sections).toHaveLength(8);
    expect(deep.sections.map((section) => section.sectionKind)).toEqual([
      'changes',
      'goal-drift',
      'unknowns',
      'risks',
      'opportunities',
      'capability-gaps',
      'workforce-performance',
      'approvals',
    ]);
  });

  it('a fresh tenant generates an honest empty briefing (all sections, zero items)', async () => {
    const { briefing } = await generateBriefing(member(tenantEmpty), {});
    expect(briefing.headline).toBe('Briefing — 8/8 sections, 0 items');
    for (const section of briefing.sections) {
      expect(section.enabled).toBe(true);
      expect(section.items).toHaveLength(0);
      expect(section.candidateCount).toBe(0);
    }
    expect(briefing.policySource).toBe('built-in');
    expect(briefing.defaultWindowSeconds).toBe(86_400);
    // First briefing default window: windowTo − cadence (24h).
    expect(briefing.windowFrom).toBe('2026-09-13T12:00:00.000Z');
  });

  it('findings recorded outside the section window do not appear', async () => {
    const ctx = member(tenantFull);
    // An execution whose analysis step landed 3 days before the briefing.
    setClock(BASE_TIME - 3 * 86_400 * 1_000);
    await seedExecutionWithFindings(ctx, [
      { kind: 'risk', statement: 'Old risk outside the window.' },
    ]);
    setClock(BASE_TIME);
    const { briefing } = await generateBriefing(ctx, {
      windowFrom: '2026-09-13T12:00:00Z',
      windowTo: '2026-09-14T12:00:00Z',
    });
    const risks = briefing.sections.find((section) => section.sectionKind === 'risks')!;
    expect(risks.items.map((entry) => entry.summary)).not.toContain('Old risk outside the window.');
  });
});

// ---------------------------------------------------------------------------
// Policy control of generation
// ---------------------------------------------------------------------------

describe('generateBriefing — policy-controlled', () => {
  it('disables a section via its kind row; the row documents it', async () => {
    const ctx = member(tenantPolicyControl);
    await recordUnknown(ctx, {
      question: 'Why are renewals slowing?',
      consequence: 'Revenue forecast cannot be trusted.',
    });
    await setBriefingPolicy(policyAdmin(tenantPolicyControl), {
      sectionKind: 'unknowns',
      enabled: false,
    });
    const { briefing } = await generateBriefing(ctx, {});
    const unknowns = briefing.sections.find((section) => section.sectionKind === 'unknowns')!;
    expect(unknowns.enabled).toBe(false);
    expect(unknowns.items).toHaveLength(0);
    expect(unknowns.policySource).toBe('kind');
    expect(briefing.headline).toBe('Briefing — 7/8 sections, 0 items');
  });

  it('the default row disables every section without its own row', async () => {
    const ctx = member(tenantPolicyControl);
    await setBriefingPolicy(policyAdmin(tenantPolicyControl), {
      sectionKind: null,
      enabled: false,
    });
    await setBriefingPolicy(policyAdmin(tenantPolicyControl), {
      sectionKind: 'approvals',
      enabled: true,
    });
    const { briefing } = await generateBriefing(ctx, {});
    expect(briefing.sections.filter((section) => section.enabled)).toHaveLength(1);
    expect(briefing.sections.find((section) => section.sectionKind === 'approvals')!.enabled).toBe(true);
    expect(briefing.policySource).toBe('tenant-default');
  });

  it('item caps truncate honestly (candidate count retained)', async () => {
    const ctx = member(tenantPolicyControl);
    for (let index = 0; index < 3; index += 1) {
      await seedEvent(ctx, `batch.event.${index}`, '2026-09-14T10:00:00Z');
    }
    await setBriefingPolicy(policyAdmin(tenantPolicyControl), {
      sectionKind: 'changes',
      maxItems: 2,
      windowSeconds: 86_400,
    });
    const { briefing } = await generateBriefing(ctx, {
      windowFrom: '2026-09-14T00:00:00Z',
      windowTo: '2026-09-14T12:00:00Z',
    });
    const changes = briefing.sections.find((section) => section.sectionKind === 'changes')!;
    expect(changes.items).toHaveLength(2);
    expect(changes.candidateCount).toBe(3);
    expect(changes.maxItems).toBe(2);
    expect(changes.policySource).toBe('kind');
  });

  it('the section lookback window trims what the briefing covers', async () => {
    const ctx = member(tenantPolicyControl);
    await seedEvent(ctx, 'recent.event', '2026-09-14T11:30:00Z');
    await seedEvent(ctx, 'stale.event', '2026-09-14T08:00:00Z');
    await setBriefingPolicy(policyAdmin(tenantPolicyControl), {
      sectionKind: 'changes',
      windowSeconds: 3_600, // one hour lookback
    });
    const { briefing } = await generateBriefing(ctx, {
      windowFrom: '2026-09-10T12:00:00Z',
      windowTo: '2026-09-14T12:00:00Z',
    });
    const changes = briefing.sections.find((section) => section.sectionKind === 'changes')!;
    expect(changes.windowFrom).toBe('2026-09-14T11:00:00.000Z');
    expect(changes.items.map((entry) => (entry.detail as { type: string }).type)).toEqual([
      'recent.event',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Proactive windows (continuity)
// ---------------------------------------------------------------------------

describe('generateBriefing — proactive default windows', () => {
  it('each briefing continues where the previous one ended (no gaps, no overlaps)', async () => {
    const ctx = member(tenantWindows);
    const first = await generateBriefing(ctx, { windowTo: '2026-09-14T12:00:00Z' });
    expect(first.briefing.windowFrom).toBe('2026-09-13T12:00:00.000Z'); // cadence fallback
    advance(3_600);
    const second = await generateBriefing(ctx, {});
    expect(second.briefing.windowFrom).toBe('2026-09-14T12:00:00.000Z'); // continuity
    expect(second.briefing.windowTo).toBe('2026-09-14T13:00:00.000Z');
    // The second briefing's sections never re-cover the first's window.
    for (const section of second.briefing.sections) {
      expect(section.windowFrom >= second.briefing.windowFrom).toBe(true);
    }
    advance(60);
    const third = await generateBriefing(ctx, {});
    expect(third.briefing.windowFrom).toBe('2026-09-14T13:00:00.000Z');
    expect(third.briefing.windowTo).toBe('2026-09-14T13:01:00.000Z');
  });

  it('the cadence window comes from the default row', async () => {
    const ctx = member(tenantWindows);
    await setBriefingPolicy(policyAdmin(tenantWindows), {
      sectionKind: null,
      windowSeconds: 600,
    });
    const { briefing } = await generateBriefing(ctx, { windowTo: '2026-09-14T12:00:00Z' });
    expect(briefing.windowFrom).toBe('2026-09-14T11:50:00.000Z');
    expect(briefing.defaultWindowSeconds).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// The delivery handoff (W031)
// ---------------------------------------------------------------------------

describe('generateBriefing — policy-controlled delivery handoff', () => {
  it('pushes the briefing as one notification through the notifications contract', async () => {
    const ctx = member(tenantDelivery);
    await setBriefingPolicy(policyAdmin(tenantDelivery), {
      sectionKind: null,
      deliveryRecipient: { provider: 'slack', providerAccountId: 'U777OPER' },
    });
    await seedEvent(ctx, 'delivered.event', '2026-09-14T10:00:00Z');
    const { briefing, deliveredNotificationId } = await generateBriefing(ctx, {
      trigger: { kind: 'scheduled', label: 'nightly' },
    });
    expect(deliveredNotificationId).not.toBeNull();
    expect(briefing.deliveryNotificationId).toBe(deliveredNotificationId);
    expect(briefing.deliveryRecipient).toEqual({
      provider: 'slack',
      providerAccountId: 'U777OPER',
      displayName: null,
    });

    // The notification exists through the notifications contract, carries
    // the briefing reference, and was delivered over the channel.
    const notifications = await listNotifications(ctx, {
      notificationKind: 'briefing',
    });
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(notification.id).toBe(deliveredNotificationId);
    expect(notification.subject).toBe(briefing.headline);
    expect(notification.dedupeKey).toBe(`briefing:${briefing.id}`);
    expect(notification.correlationId).toBe(briefing.id);
    expect(notification.status).toBe('delivered');
    expect((notification.data as { briefingId?: string }).briefingId).toBe(briefing.id);
    expect(channelTransport.requests).toHaveLength(1);

    // A later policy edit never rewrites the recorded briefing's snapshot.
    await setBriefingPolicy(policyAdmin(tenantDelivery), {
      sectionKind: null,
      deliveryRecipient: null,
    });
    const deep = await getBriefing(ctx, { briefingId: briefing.id });
    expect(deep.deliveryRecipient).toEqual({
      provider: 'slack',
      providerAccountId: 'U777OPER',
      displayName: null,
    });
    expect(deep.deliveryNotificationId).toBe(deliveredNotificationId);
  });
});

// ---------------------------------------------------------------------------
// Idempotent generation
// ---------------------------------------------------------------------------

describe('generateBriefing — idempotency', () => {
  it('a recorded key replays the original briefing (first write wins)', async () => {
    const ctx = member(tenantIdempotency);
    const first = await generateBriefing(ctx, {
      trigger: { kind: 'scheduled', label: 'nightly' },
      idempotencyKey: 'worker-nightly-2026-09-14',
    });
    advance(60);
    const replay = await generateBriefing(ctx, {
      trigger: { kind: 'scheduled', label: 'nightly' },
      idempotencyKey: 'worker-nightly-2026-09-14',
    });
    expect(replay.deduped).toBe(true);
    expect(replay.briefing.id).toBe(first.briefing.id);
    expect(replay.briefing.generatedAt).toBe(first.briefing.generatedAt);
    const feed = await listBriefings(ctx, {});
    expect(feed).toHaveLength(1);

    // The notification side is dedupe-stable too: the replay does not push
    // a second notification when delivery was already done.
    await setBriefingPolicy(policyAdmin(tenantIdempotency), {
      sectionKind: null,
      deliveryRecipient: { provider: 'slack', providerAccountId: 'U777OPER' },
    });
    const delivered = await generateBriefing(ctx, {
      idempotencyKey: 'worker-delivered-once',
    });
    expect(delivered.deliveredNotificationId).not.toBeNull();
    const before = channelTransport.requests.length;
    const replayDelivered = await generateBriefing(ctx, {
      idempotencyKey: 'worker-delivered-once',
    });
    expect(replayDelivered.deduped).toBe(true);
    expect(replayDelivered.deliveredNotificationId).toBe(delivered.deliveredNotificationId);
    expect(channelTransport.requests.length).toBe(before); // no second delivery
    // Exactly ONE notification exists: the first key never pushed (no
    // recipient configured then); the delivered key pushed once.
    const notifications = await listNotifications(ctx, { notificationKind: 'briefing' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.dedupeKey).toBe(`briefing:${delivered.briefing.id}`);
    expect(notifications[0]!.status).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it("another tenant's briefings and sections are indistinguishable from missing", async () => {
    const ctxA = member(tenantIsolation);
    await seedEvent(ctxA, 'tenant-a.event', '2026-09-14T10:00:00Z');
    const { briefing } = await generateBriefing(ctxA, {});

    await expectCode('briefing_not_found', () =>
      getBriefing(member(tenantB), { briefingId: briefing.id }),
    );
    const feedB = await listBriefings(member(tenantB), {});
    expect(feedB).toHaveLength(0);
  });

  it('generation compiles only the caller tenant\u2019s data', async () => {
    const ctxA = member(tenantIsolation);
    await seedEvent(ctxA, 'tenant-a.only', '2026-09-14T10:00:00Z');
    const ctxB = member(tenantB);
    await seedEvent(ctxB, 'tenant-b.only', '2026-09-14T10:00:00Z');
    const { briefing } = await generateBriefing(ctxB, {
      windowFrom: '2026-09-14T00:00:00Z',
      windowTo: '2026-09-14T12:00:00Z',
    });
    const changes = briefing.sections.find((section) => section.sectionKind === 'changes')!;
    expect(changes.items).toHaveLength(1);
    expect((changes.items[0]!.detail as { type: string }).type).toBe('tenant-b.only');
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (immutability)
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('briefings are immutable history; only the one-way delivery link moves', async () => {
    const ctx = member(tenantStorage);
    const { briefing } = await generateBriefing(ctx, {});
    const db = getDb();
    await expect(db.query(`UPDATE briefings SET headline = 'rewritten' WHERE id = $1`, [briefing.id])).rejects.toThrow();
    await expect(db.query(`DELETE FROM briefings WHERE id = $1`, [briefing.id])).rejects.toThrow();
    await expect(db.query(`TRUNCATE briefings`)).rejects.toThrow();

    // The one-way delivery link is the single allowed move.
    await db.query(
      `UPDATE briefings SET delivery_notification_id = gen_random_uuid(), updated_at = now() WHERE id = $1`,
      [briefing.id],
    );
    const filled = await getBriefing(ctx, { briefingId: briefing.id });
    expect(filled.deliveryNotificationId).not.toBeNull();
    // ...and it never moves again.
    await expect(
      db.query(`UPDATE briefings SET delivery_notification_id = gen_random_uuid() WHERE id = $1`, [
        briefing.id,
      ]),
    ).rejects.toThrow();
  });

  it('briefing sections are strictly append-only', async () => {
    const ctx = member(tenantStorage);
    const { briefing } = await generateBriefing(ctx, {});
    const db = getDb();
    const sectionId = (
      await db.query<{ id: string }>(`SELECT id FROM briefing_sections WHERE briefing_id = $1 LIMIT 1`, [
        briefing.id,
      ])
    ).rows[0]!.id;
    await expect(
      db.query(`UPDATE briefing_sections SET item_count = 99 WHERE id = $1`, [sectionId]),
    ).rejects.toThrow();
    await expect(db.query(`DELETE FROM briefing_sections WHERE id = $1`, [sectionId])).rejects.toThrow();
    await expect(db.query(`TRUNCATE briefing_sections`)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Input discipline on the service surface
// ---------------------------------------------------------------------------

describe('service input discipline', () => {
  it('rejects malformed generation inputs and queries', async () => {
    const ctx = member(tenantEmpty);
    await expectCode('invalid_briefing_input', () =>
      generateBriefing(ctx, { trigger: { kind: 'cron' } }),
    );
    await expectCode('invalid_briefing_input', () =>
      generateBriefing(ctx, { windowTo: '2026-09-14' }),
    );
    await expectCode('invalid_briefing_input', () =>
      generateBriefing(ctx, {
        windowFrom: '2026-09-14T12:00:00Z',
        windowTo: '2026-09-14T11:00:00Z',
      }),
    );
    await expectCode('invalid_briefing_input', () =>
      generateBriefing(ctx, { idempotencyKey: 'not legal!' }),
    );
    await expectCode('invalid_briefing_query', () => getBriefing(ctx, { briefingId: 'nope' }));
    await expectCode('invalid_briefing_query', () => listBriefings(ctx, { limit: 501 }));
    await expectCode('invalid_briefing_query', () => listBriefings(ctx, { triggerKind: 'cron' }));
    await expectCode('briefing_not_found', () =>
      getBriefing(ctx, { briefingId: '44444444-4444-4444-8444-444444444444' }),
    );
  });

  it('lists with filters (trigger kind, window overlap)', async () => {
    const ctx = member(tenantEmpty);
    const first = await generateBriefing(ctx, {
      trigger: { kind: 'scheduled' },
      windowTo: '2026-09-14T12:00:00Z',
    });
    advance(3_600);
    const second = await generateBriefing(ctx, {
      trigger: { kind: 'on_demand' },
    });
    const scheduled = await listBriefings(ctx, { triggerKind: 'scheduled' });
    expect(scheduled.map((entry) => entry.id)).toEqual([first.briefing.id]);
    const overlapping = await listBriefings(ctx, {
      windowFrom: '2026-09-14T12:30:00Z',
      windowTo: '2026-09-14T12:30:00Z',
    });
    expect(overlapping.map((entry) => entry.id)).toEqual([second.briefing.id]);
    const latest = await listBriefings(ctx, { limit: 1 });
    expect(latest[0]!.id).toBe(second.briefing.id);
  });
});
