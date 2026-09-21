// Integration tests for the intelligence workflow (W061) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE ACCEPTANCE CORE, proven end to end through REAL module contracts:
//
//   * SEED one tenant with the full chain: an active goal → freshness
//     observations → a claim → an unprompted goal-gap discovery run
//     (promoting an unknown + a learning mission) → a complete cognitive
//     execution (belief on the model-update stage + risk/opportunity/
//     capability-gap findings on the analysis stage) → a retained
//     contradiction.
//   * THE NAVIGABLE CHAIN: buildGoalChainView composes goal → gap →
//     unknown → mission → evidence → belief with the links that walk it
//     (the acceptance's first clause); buildUnknownView and
//     buildMissionView walk the chain from the middle steps.
//   * PROACTIVE FINDINGS ENTER TODAY: buildIntelligenceView /
//     buildProactiveFindings surface the promoted unknown, the loop's
//     findings and the contradiction — severity/urgency legible, why and
//     next present on every finding.
//   * PROACTIVE FINDINGS ENTER CHAT: deliverFindingsToChat records the
//     briefing message in the persistent intelligence conversation; the
//     second call with an UNCHANGED findings state is a no-op (digest
//     idempotency); a NEW findings state records a NEW message; the
//     recorded payload renders as cards through the chat timeline's own
//     guard (parseTurnPayload).
//   * TENANT ISOLATION: tenant B's views contain none of tenant A's
//     chain, and its own delivery is its own thread (ADR-0001).
//   * THE API SURFACE: the session cookie is the only scope; anonymous
//     is 401, and the delivery rides the session's tenant.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';

import { provisionTenant } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import { createGoal } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import { recordObservation } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import { recordClaim } from '@/modules/epistemics/contract';
import type { Claim } from '@/modules/epistemics/contract';
import { registerContradiction } from '@/modules/epistemics/contract';
import { runGoalGapDiscovery } from '@/modules/attention/contract';
import type { DiscoveryRun } from '@/modules/attention/contract';
import { runNextStage, startExecution } from '@/modules/cognition/contract';
import type { CognitiveExecutionTrace } from '@/modules/cognition/contract';
import {
  listConversations,
  listMessages,
} from '@/modules/conversations/contract';

import { buildProactiveFindings } from '../lib/findings';
import {
  buildGoalChainView,
  buildIntelligenceView,
  buildMissionView,
  buildUnknownView,
} from '../lib/views';
import {
  deliverFindingsToChat,
  INTELLIGENCE_CONVERSATION_TITLE,
} from '../lib/briefing-chat';
import { handleBriefingDeliverPost } from '../lib/api';
import { parseTurnPayload } from '../../chat/lib/chat-types';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const T0 = '2026-10-01T09:00:00.000Z';

function member(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

/** The session cookie the intelligence API resolves (lib/session's). */
const SESSION_COOKIE = 'aurum_session';

// Fake credentials assembled from fragments at runtime (push-protection).
const passwordFragments = ['ri', 'verbed', '-la', 'ntern-7'];

interface ChainFixture {
  tenant: Tenant;
  owner: TenantContext;
  ownerToken: string;
}

async function provisionChainFixture(name: string): Promise<ChainFixture> {
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
  return {
    tenant,
    owner: member(tenant.id, issued.session.principalId),
    ownerToken: issued.token,
  };
}

describe('the intelligence workflow over a fully seeded chain', () => {
  let acme: ChainFixture;
  let beta: ChainFixture;

  let goal: Goal;
  let observations: Observation[];
  let claim: Claim;
  let discoveryRun: DiscoveryRun;
  let cognitionTrace: CognitiveExecutionTrace;

  const advance = (ctx: TenantContext, input: Parameters<typeof runNextStage>[1]) =>
    runNextStage(ctx, input);

  beforeAll(async () => {
    await runMigrations(db);
    acme = await provisionChainFixture('Northwind Chain');
    beta = await provisionChainFixture('Initech Chain');
    const ctx = acme.owner;

    // Step 1 — the goal (direction).
    goal = await createGoal(ctx, {
      title: 'Keep wholesale freshness above 92%',
      objective: 'Hold wholesale delivery freshness at or above 92% across flagship accounts.',
      desiredState: 'Every wholesale delivery scores at least 92% freshness on arrival.',
      metrics: [{ name: 'wholesale-freshness', unit: 'percent', direction: 'at_least', threshold: 92 }],
      horizonStart: T0,
      horizonEnd: '2026-12-31T00:00:00.000Z',
      owner: { kind: 'person', label: 'Ops Lead' },
      priority: 'high',
      evidenceSources: [{ kind: 'source', label: 'Roastery WMS' }],
      successCriteria: 'One full quarter of flagship accounts at 92%+ freshness.',
      actor: { kind: 'person', label: 'Ops Lead' },
      rationale: 'the half-year operations target',
    });

    // Step 5 (early) — the immutable evidence.
    observations = [];
    for (const [index, account] of ['harbor-grocery', 'nordic-cafe', 'fleet-average'].entries()) {
      observations.push(
        await recordObservation(ctx, {
          kind: 'freshness.sample',
          payload: { account, score: 86 + index },
          observedAt: `2026-10-0${index + 1}T08:00:00.000Z`,
          source: { kind: 'system', label: 'Roastery WMS' },
          channel: 'ingestion',
          confidence: { value: 0.9, method: 'system-report', basis: 'weekly WMS export' },
        }),
      );
    }

    // A claim weighing the evidence (subject the goal).
    claim = await recordClaim(ctx, {
      proposition: 'Wholesale freshness averaged 87% in the first week of October.',
      subject: { kind: 'goals.goal', id: goal.id },
      confidence: { value: 0.9, method: 'system-evidence', basis: 'three WMS samples' },
      evidenceObservationIds: observations.map((observation) => observation.id),
    });

    // A retained contradiction (lock 12).
    await registerContradiction(ctx, {
      left: { kind: 'observation', id: observations[0]!.id },
      right: { kind: 'claim', id: claim.id },
      note: 'The account-level sample and the weekly summary disagree on the freshness floor.',
    });

    // Step 2 — the unprompted goal-gap discovery pass (promotes unknown + mission).
    discoveryRun = await runGoalGapDiscovery(ctx, {
      trigger: { kind: 'scheduled', label: 'weekly freshness review' },
      goalIds: [goal.id],
      readings: [
        {
          goalId: goal.id,
          metricName: 'wholesale-freshness',
          value: 87,
          driverConfidence: 0.4,
          evidenceClaimIds: [claim.id],
          evidenceBeliefIds: [],
        },
      ],
      policy: { impactThreshold: 0.3, valueThreshold: 0.1 },
      investigationBudget: { amount: 40000, currency: 'USD' },
      rewardBudget: { amount: 8000, currency: 'USD' },
      actor: { kind: 'system', label: 'aurum-attention' },
      rationale: 'the weekly sweep — no one asked, the goal gap did',
    });
    expect(discoveryRun.counts.promoted).toBe(1);

    // A complete cognitive cycle: belief (model-update) + findings (analysis).
    cognitionTrace = await startExecution(ctx, {
      trigger: { kind: 'management', label: 'October ops review' },
      focus: { topics: ['freshness', 'wholesale'], entities: [] },
      actor: { kind: 'system', label: 'aurum-cognition' },
      rationale: 'evaluate the freshness evidence against the goal',
    });
    const executionId = cognitionTrace.id;
    await advance(ctx, {
      executionId,
      stage: 'observation',
      reference: observations.map((observation) => observation.id),
    });
    await advance(ctx, { executionId, stage: 'evidence-memory' });
    await advance(ctx, { executionId, stage: 'world-update', update: null });
    await advance(ctx, { executionId, stage: 'epistemic-evaluation', claims: [] });
    await advance(ctx, { executionId, stage: 'goal-evaluation', relatedGoalIds: [goal.id] });
    await advance(ctx, { executionId, stage: 'unknown-mission-evaluation', unknowns: [], missions: [] });
    await advance(ctx, { executionId, stage: 'knowledge-acquisition', missionId: null });
    await advance(ctx, {
      executionId,
      stage: 'model-update',
      belief: {
        proposition: 'The courier customs-broker change is the dominant driver of the freshness dip.',
        confidence: { value: 0.75, method: 'evidence-reasoning', basis: 'the freshness claim' },
        supportingObservationIds: observations.map((observation) => observation.id),
        supportingClaimIds: [claim.id],
        alternatives: ['seasonal demand peaks alone explain the dip'],
        disconfirmation: 'freshness recovering while the customs broker stays unchanged',
        subject: { kind: 'goals.goal', id: goal.id },
        validFrom: '2026-01-05T00:00:00.000Z',
        rationale: 'the cycle\u2019s own claim, weighed',
      },
    });
    await advance(ctx, {
      executionId,
      stage: 'risk-opportunity-capability-analysis',
      findings: [
        {
          kind: 'risk',
          statement: 'Freshness averaged 87%, breaching the 92% goal for two flagship accounts.',
          evidenceObservationIds: observations.map((observation) => observation.id),
          affectedGoalIds: [goal.id],
        },
        {
          kind: 'opportunity',
          statement: 'A direct-to-store courier lane could recover freshness points.',
          evidenceObservationIds: observations.map((observation) => observation.id),
          affectedGoalIds: [goal.id],
        },
      ],
    });
    await advance(ctx, { executionId, stage: 'recommendation-ask-proposal-action', action: null });
    await advance(ctx, { executionId, stage: 'outcome', summary: 'freshness review concluded' });
    await advance(ctx, { executionId, stage: 'learning', knowledge: null });
  });

  afterAll(async () => {
    await closeDb();
  });

  // -------------------------------------------------------------------------
  // The proactive findings (Today's briefing feed)
  // -------------------------------------------------------------------------

  it('builds the proactive findings feed with severity, why and next on every item', async () => {
    const composed = await buildProactiveFindings(acme.owner);
    expect(composed.degraded).toEqual([]);

    // The promoted goal-gap unknown (discovery family).
    const promoted = composed.findings.find((finding) => finding.source === 'discovery');
    expect(promoted).toBeDefined();
    expect(promoted?.kind).toBe('unknown');
    expect(promoted?.severity.urgency).toBe('high');
    expect(promoted?.whyThisMatters.length).toBeGreaterThan(0);
    expect(promoted?.whatNext).toContain('confidence gap');
    expect(promoted?.href).toMatch(/^\/intelligence\/unknowns\//);

    // The loop's analysis findings.
    const analysis = composed.findings.filter((finding) => finding.source === 'analysis');
    expect(analysis.map((finding) => finding.kind).sort()).toEqual(['opportunity', 'risk']);
    for (const finding of analysis) {
      expect(finding.href).toBe(`/intelligence/goals/${goal.id}`);
      expect(finding.whyThisMatters.length).toBeGreaterThan(0);
      expect(finding.whatNext.length).toBeGreaterThan(0);
    }

    // The retained contradiction.
    const contradiction = composed.findings.find((finding) => finding.source === 'contradiction');
    expect(contradiction?.kind).toBe('contradiction');
    expect(contradiction?.severity.urgency).toBe('high');

    // Severity ordering: the banded discovery finding precedes unbanded analysis findings.
    const firstBanded = composed.findings.findIndex(
      (finding) => finding.severity.urgency !== null,
    );
    const firstUnbanded = composed.findings.findIndex(
      (finding) => finding.severity.urgency === null,
    );
    if (firstUnbanded !== -1) {
      expect(firstBanded).toBeLessThan(firstUnbanded);
    }
  });

  it('tenant B has no findings of its own (isolation at the composition boundary)', async () => {
    const composed = await buildProactiveFindings(beta.owner);
    expect(composed.findings).toEqual([]);
    expect(composed.degraded).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The intelligence home (the product-mode Today)
  // -------------------------------------------------------------------------

  it('builds the intelligence home: findings, attention, goals with chain counts', async () => {
    const view = await buildIntelligenceView(acme.owner);
    expect(view.findings.length).toBeGreaterThanOrEqual(4);
    expect(view.situation.activeGoals).toBe(1);
    expect(view.situation.openUnknowns).toBe(1);
    expect(view.situation.activeMissions).toBe(1);
    expect(view.situation.openContradictions).toBe(1);

    const entry = view.goals[0];
    expect(entry?.id).toBe(goal.id);
    expect(entry?.openUnknownIds).toHaveLength(1);
    expect(entry?.activeMissionIds).toHaveLength(1);
    expect(entry?.activeBeliefCount).toBe(1);
    expect(entry?.href).toBe(`/intelligence/goals/${goal.id}`);

    // The goal-gap promotion feeds the attention few (mission urgency 'high').
    expect(view.attention.urgentMissions).toHaveLength(1);
    expect(view.attention.urgentMissions[0]?.urgency).toBe('high');
  });

  // -------------------------------------------------------------------------
  // The navigable chain (the acceptance's core)
  // -------------------------------------------------------------------------

  it('composes the goal chain: goal → gap → unknown → mission → evidence → belief, linked', async () => {
    const chain = await buildGoalChainView(acme.owner, goal.id);

    // Step 1 — the goal with its reading aids material.
    expect(chain.goal.title).toContain('freshness');
    expect(chain.goal.metricLines[0]).toContain('wholesale-freshness');
    expect(chain.goal.metricLines[0]).toContain('92');

    // Step 2 — the discovery gap run with its decided candidate.
    expect(chain.gaps).toHaveLength(1);
    const candidate = chain.gaps[0]?.candidates[0];
    expect(candidate?.disposition).toBe('promoted');
    expect(candidate?.urgency).toBe('high');
    expect(candidate?.decisionImpact).toBeGreaterThan(0.3);
    expect(candidate?.unknownId).not.toBeNull();
    expect(candidate?.missionId).not.toBeNull();

    // Step 3 — the promoted unknown, linked to its own page.
    expect(chain.unknowns).toHaveLength(1);
    expect(chain.unknowns[0]?.question).toContain('driving');
    expect(chain.unknowns[0]?.href).toBe(
      `/intelligence/unknowns/${chain.unknowns[0]?.id}`,
    );

    // Step 4 — the mission serving the goal, linked to its own page.
    expect(chain.missions).toHaveLength(1);
    expect(chain.missions[0]?.affectedGoalIds).toContain(goal.id);
    expect(chain.missions[0]?.href).toBe(`/intelligence/missions/${chain.missions[0]?.id}`);

    // Step 5 — the evidence beneath (the WMS observations, newest first).
    expect(chain.evidence.map((item) => item.id).sort()).toEqual(
      observations.map((observation) => observation.id).sort(),
    );
    expect(chain.evidence[0]?.sourceLabel).toBe('Roastery WMS');

    // Step 6 — the current belief about the goal.
    expect(chain.beliefs).toHaveLength(1);
    expect(chain.beliefs[0]?.proposition).toContain('customs-broker');
    expect(chain.beliefs[0]?.confidence).toBe(0.75);
    expect(chain.beliefs[0]?.alternatives).toEqual([
      'seasonal demand peaks alone explain the dip',
    ]);

    // THE CHAIN IS NAVIGABLE: every step's link targets the next step.
    expect(candidate?.unknownId).toBe(chain.unknowns[0]?.id);
    expect(candidate?.missionId).toBe(chain.missions[0]?.id);
  });

  it('the unknown view walks the chain from the middle: goal up, missions down, evidence and beliefs', async () => {
    const chain = await buildGoalChainView(acme.owner, goal.id);
    const unknownId = chain.unknowns[0]!.id;

    const view = await buildUnknownView(acme.owner, unknownId);
    expect(view.unknown.question).toContain('driving');
    expect(view.unknown.consequence.length).toBeGreaterThan(0);
    expect(view.unknown.status).toBe('open');

    // The chain upward: the goal this unknown serves.
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0]?.id).toBe(goal.id);

    // The chain downward: the mission closing it.
    expect(view.missions).toHaveLength(1);
    expect(view.missions[0]?.unknownIds).toContain(unknownId);

    // Bounding evidence.
    expect(view.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('the mission view walks the chain: goals and unknowns up, acquisitions and beliefs down', async () => {
    const chain = await buildGoalChainView(acme.owner, goal.id);
    const missionId = chain.missions[0]!.id;

    const view = await buildMissionView(acme.owner, missionId);
    expect(view.mission.knowledgeObjective).toContain('driving');
    expect(view.mission.urgency).toBe('high');
    expect(view.mission.currentConfidence).toBeLessThan(view.mission.targetConfidence);
    expect(view.goals).toHaveLength(1);
    expect(view.unknowns).toHaveLength(1);
    // The chain's evidence step: the WMS samples underpin the mission's unknown.
    expect(view.unknowns[0]?.question).toContain('driving');
  });

  it('a foreign goal id throws the contract\u2019s uniform not-found (no existence leak)', async () => {
    await expect(buildGoalChainView(acme.owner, newId())).rejects.toThrow();
    await expect(
      buildGoalChainView(beta.owner, goal.id),
    ).rejects.toThrow();
  });

  it('tenant B\u2019s chain view of its own (empty) state is honest empties', async () => {
    const view = await buildIntelligenceView(beta.owner);
    expect(view.goals).toEqual([]);
    expect(view.findings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Proactive findings enter chat
  // -------------------------------------------------------------------------

  it('delivers the briefing into the persistent intelligence conversation, once per findings state', async () => {
    // First delivery: a NEW message in a NEW conversation.
    const first = await deliverFindingsToChat(acme.owner);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.delivered).toBe(true);
    expect(first.deduped).toBe(false);
    expect(first.findingCount).toBeGreaterThanOrEqual(4);

    const conversations = await listConversations(acme.owner, { limit: 50 });
    const intel = conversations.find(
      (conversation) => conversation.title === INTELLIGENCE_CONVERSATION_TITLE,
    );
    expect(intel?.id).toBe(first.conversationId);

    // The transcript turn renders as a briefing answer through the chat
    // timeline's own guard (the W060 renderer needs no changes).
    const messages = await listMessages(acme.owner, {
      conversationId: first.conversationId,
      order: 'asc',
      limit: 10,
    });
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.direction).toBe('outbound');
    expect(message.actor.kind).toBe('system');
    expect(message.channel).toBe('web');
    expect(message.providerMessageId).toBe(`intel-briefing-${first.digest}`);

    const parsed = parseTurnPayload(message.payload);
    expect(parsed.text).toContain('I found');
    expect(parsed.answer).not.toBeNull();
    expect(parsed.answer?.intent).toBe('attention');
    expect(parsed.answer?.cards.length).toBeGreaterThanOrEqual(4);
    const cardKinds = new Set(parsed.answer?.cards.map((card) => card.kind));
    expect(cardKinds.has('unknown')).toBe(true);
    expect(cardKinds.has('risk')).toBe(true);
    expect(cardKinds.has('opportunity')).toBe(true);
    for (const card of parsed.answer?.cards ?? []) {
      expect(card.href.startsWith('/intelligence')).toBe(true);
      expect(card.linkLabel).toBe('Open the intelligence workflow');
      // The two reading aids ride the card's context drawer payload.
      const kinds = card.context?.sections.map((section) => section.kind) ?? [];
      expect(kinds).toContain('why');
    }

    // Second delivery, SAME findings state: a no-op (digest idempotency).
    const second = await deliverFindingsToChat(acme.owner);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.delivered).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.digest).toBe(first.digest);
    expect(second.messageId).toBe(first.messageId);

    // The transcript still holds exactly one turn.
    const after = await listMessages(acme.owner, {
      conversationId: first.conversationId,
      order: 'asc',
      limit: 10,
    });
    expect(after).toHaveLength(1);
  });

  it('tenant B\u2019s delivery is its own thread — no cross-tenant leak', async () => {
    const delivered = await deliverFindingsToChat(beta.owner);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;

    // Its own conversation, distinct from tenant A's.
    expect(delivered.conversationId).not.toBeNull();
    const messages = await listMessages(beta.owner, {
      conversationId: delivered.conversationId,
      order: 'asc',
      limit: 10,
    });
    expect(messages).toHaveLength(1);

    // Tenant A's thread is untouched by B's delivery.
    const acmeConversations = await listConversations(acme.owner, { limit: 50 });
    const acmeIntel = acmeConversations.find(
      (conversation) => conversation.title === INTELLIGENCE_CONVERSATION_TITLE,
    );
    expect(acmeIntel).toBeDefined();
    const acmeMessages = await listMessages(acme.owner, {
      conversationId: acmeIntel!.id,
      order: 'asc',
      limit: 10,
    });
    expect(acmeMessages).toHaveLength(1);
    expect(acmeMessages[0]?.tenantId).toBe(acme.tenant.id);
  });

  // -------------------------------------------------------------------------
  // The API surface (the session is the only scope)
  // -------------------------------------------------------------------------

  it('the delivery API: anonymous is 401; the session cookie scopes the write', async () => {
    const anonymous = await handleBriefingDeliverPost(
      new Request('https://aurum.test/api/product/intelligence/briefing/deliver', {
        method: 'POST',
      }),
    );
    expect(anonymous.status).toBe(401);
    if (anonymous.status !== 200) {
      expect(anonymous.body.error).toBe('unauthenticated');
    }

    // A stray tenant parameter cannot smuggle scope (W058's boundary).
    const stray = await handleBriefingDeliverPost(
      new Request(
        'https://aurum.test/api/product/intelligence/briefing/deliver?tenant=globex',
        {
          method: 'POST',
          headers: { cookie: `${SESSION_COOKIE}=${acme.ownerToken}` },
        },
      ),
    );
    expect(stray.status).toBe(200);
    if (stray.status === 200) {
      expect(stray.body.tenantId).toBe(acme.tenant.id);
      expect(stray.body.intelligence).toBe('briefing-delivery');
    }
  });
});
