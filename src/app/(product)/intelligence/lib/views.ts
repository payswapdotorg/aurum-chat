// Intelligence discovery (W061) — the workflow view builders.
//
// THE ACCEPTANCE CORE: "goal → gap → unknown → mission → evidence → belief
// path is navigable". Each builder composes ONE workflow node from module
// contracts only (lock 31/32), with the links that walk the chain in both
// directions:
//
//   * buildIntelligenceView  — the area home = the product-mode TODAY
//     briefing: the proactive findings feed (severity legible, why/next
//     always visible), the attention few, the active goals with their
//     chain counts (gap/unknown/mission links), the capability gaps, and
//     the situation counts. Nothing here is persisted (lock 34).
//   * buildGoalChainView     — THE CHAIN for one goal: the goal itself,
//     its discovery gaps (W051 runs + decided candidates), the unknowns
//     subject-scoped to it (W007), the missions serving it (W011), the
//     evidence beneath (W004 observations, reached through the unknowns'
//     and claims' evidence links), and the current beliefs (W007, subject
//     'goals.goal'). Every step links to the next.
//   * buildUnknownView       — one unknown: why it matters (the recorded
//     consequence), the missions closing it, the goal it serves, the
//     bounding evidence/claims/beliefs, and the resolution that closed it.
//   * buildMissionView       — one mission: what it needs to learn, the
//     confidence progress, the affected goals and unknowns (the chain
//     upward), the acquisitions the loop ran for it (from W013 traces),
//     and the beliefs its unknowns resolved into.
//
// Honest degradation per family (the answers.ts discipline): a failing
// read yields an empty section plus a `degraded` note; a missing record
// throws the owning contract's not-found error for the page to render.

import type { TenantContext } from '@/infra/tenant';
import { now } from '@/infra/clock';
import { listActionRequests } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import {
  getDiscoveryRun,
  listDiscoveryRuns,
} from '@/modules/attention/contract';
import type { DiscoveryCandidate, DiscoveryRun } from '@/modules/attention/contract';
import { analyzeGaps } from '@/modules/capabilities/contract';
import type { CapabilityGap } from '@/modules/capabilities/contract';
import {
  getBelief,
  getClaim,
  getUnknown,
  listBeliefs,
  listBeliefHistory,
  listClaims,
  listContradictions,
  listUnknowns,
} from '@/modules/epistemics/contract';
import type { Belief, BeliefVersion, Claim, Unknown } from '@/modules/epistemics/contract';
import { getGoal, listGoals } from '@/modules/goals/contract';
import type { Goal, GoalPriority } from '@/modules/goals/contract';
import { getMission, listMissions } from '@/modules/missions/contract';
import type { Mission, MissionUrgency } from '@/modules/missions/contract';
import {
  getExecution,
  listExecutions,
} from '@/modules/cognition/contract';
import type { CognitiveExecution } from '@/modules/cognition/contract';
import { getObservation } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import { buildProactiveFindings } from './findings';
import type { ProactiveFinding } from './findings';

// ---------------------------------------------------------------------------
// Shared view models
// ---------------------------------------------------------------------------

/** The subject kind discovery promotions stamp onto unknowns (W051). */
export const GOAL_SUBJECT_KIND = 'goals.goal';

/** One evidence item (an immutable observation, W004). */
export interface EvidenceItem {
  id: string;
  kind: string;
  observedAt: string;
  sourceLabel: string;
  channel: string;
  confidence: number | null;
}

/** One belief view (the working understanding, W007 lock 11). */
export interface BeliefItem {
  id: string;
  proposition: string;
  confidence: number | null;
  method: string | null;
  alternatives: string[];
  disconfirmation: string | null;
  provenanceObservationIds: string[];
  supportingClaimIds: string[];
  status: string;
  /** Where the belief sits in the chain (its subject, when resolvable). */
  subjectLabel: string | null;
  /** Valid-time start of the rendered version (honest temporal provenance). */
  validFrom: string;
  recordedAt: string;
}

/** One mission summary row (the chain's step 4). */
export interface MissionRow {
  id: string;
  title: string;
  status: string;
  urgency: MissionUrgency;
  informationValue: number;
  currentConfidence: number;
  targetConfidence: number;
  knowledgeObjective: string;
  unknownIds: string[];
  affectedGoalIds: string[];
  href: string;
}

/** One unknown row (the chain's step 3). */
export interface UnknownRow {
  id: string;
  question: string;
  consequence: string;
  status: string;
  recordedAt: string;
  resolvedAt: string | null;
  href: string;
}

/** One decided goal-gap candidate (the chain's step 2). */
export interface GapCandidateRow {
  id: string;
  gapKey: string;
  gapKind: string;
  missingKnowledge: string;
  consequence: string;
  disposition: string;
  urgency: string;
  decisionImpact: number;
  informationValue: number;
  currentConfidence: number;
  requiredConfidence: number;
  unknownId: string | null;
  missionId: string | null;
  recordedAt: string;
}

/** One discovery run over a goal (the chain's step 2 container). */
export interface GapRunRow {
  id: string;
  triggerKind: string;
  triggerLabel: string | null;
  recordedAt: string;
  counts: { total: number; promoted: number; dismissed: number; alreadyCovered: number };
  candidates: GapCandidateRow[];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function toMissionRow(mission: Mission): MissionRow {
  const content = mission.content;
  return {
    id: mission.id,
    title: clip(content.title, 120),
    status: content.status,
    urgency: content.urgency,
    informationValue: content.informationValue,
    currentConfidence: content.currentConfidence,
    targetConfidence: content.targetConfidence,
    knowledgeObjective: clip(content.knowledgeObjective, 400),
    unknownIds: [...content.unknownIds],
    affectedGoalIds: content.affectedGoals.map((goal) => goal.goalId),
    href: `/intelligence/missions/${mission.id}`,
  };
}

function toUnknownRow(unknown: Unknown): UnknownRow {
  return {
    id: unknown.id,
    question: clip(unknown.question, 200),
    consequence: clip(unknown.consequence, 400),
    status: unknown.status,
    recordedAt: unknown.recordedAt,
    resolvedAt: unknown.resolvedAt,
    href: `/intelligence/unknowns/${unknown.id}`,
  };
}

function toGapRun(run: DiscoveryRun): GapRunRow {
  return {
    id: run.id,
    triggerKind: run.trigger.kind,
    triggerLabel: run.trigger.label,
    recordedAt: run.recordedAt,
    counts: { ...run.counts },
    candidates: run.candidates.map((candidate: DiscoveryCandidate) => ({
      id: candidate.id,
      gapKey: candidate.gapKey,
      gapKind: candidate.gapKind,
      missingKnowledge: clip(candidate.missingKnowledge, 300),
      consequence: clip(candidate.consequence, 400),
      disposition: candidate.disposition,
      urgency: candidate.urgency,
      decisionImpact: candidate.decisionImpact,
      informationValue: candidate.informationValue,
      currentConfidence: candidate.currentConfidence,
      requiredConfidence: candidate.requiredConfidence,
      unknownId: candidate.epistemicsUnknownId,
      missionId: candidate.missionId,
      recordedAt: candidate.recordedAt,
    })),
  };
}

async function safe<T>(family: string, degraded: string[], read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

/** Resolve up to `cap` observation ids to evidence items (bounded, quiet). */
async function resolveEvidence(
  ctx: TenantContext,
  ids: readonly string[],
  cap: number,
  family: string,
  degraded: string[],
): Promise<EvidenceItem[]> {
  const unique = [...new Set(ids)].slice(0, cap);
  const items: EvidenceItem[] = [];
  for (const id of unique) {
    const observation: Observation | null = await safe(family, degraded, () =>
      getObservation(ctx, id),
    );
    if (observation === null) continue;
    items.push({
      id: observation.id,
      kind: observation.kind,
      observedAt: observation.observedAt,
      sourceLabel: observation.source.label ?? observation.source.kind,
      channel: observation.channel,
      confidence: observation.confidence.value,
    });
  }
  items.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  return items;
}

/**
 * Resolve beliefs (anchors → statements) through bounded reads.
 *
 * The primary path is `getBelief` (the version valid AS OF NOW). When the
 * current version cannot be resolved — e.g. the belief's only version
 * starts in the future relative to the service clock — the RECORDED
 * history is the honest fallback: the latest recorded version is what the
 * belief asserts, rendered with its own validFrom so the page never
 * claims a not-yet-valid understanding is current.
 */
async function resolveBeliefs(
  ctx: TenantContext,
  anchors: readonly { id: string }[],
  cap: number,
  degraded: string[] = [],
): Promise<BeliefItem[]> {
  const items: BeliefItem[] = [];
  for (const anchor of anchors.slice(0, cap)) {
    let belief: Belief | null = await safe('beliefs', degraded, () =>
      getBelief(ctx, { beliefId: anchor.id }),
    );
    if (belief === null) {
      // Fallback: the recorded version history (the assertion itself).
      const history: BeliefVersion[] | null = await safe('beliefs', degraded, () =>
        listBeliefHistory(ctx, { beliefId: anchor.id }),
      );
      const latest = history === null ? undefined : history[history.length - 1];
      if (latest !== undefined) {
        belief = {
          id: anchor.id,
          tenantId: ctx.tenantId,
          subject: null,
          status: 'active',
          retireReason: null,
          createdAt: latest.recordedAt,
          retiredAt: null,
          version: latest.version,
          statement: latest.statement,
          provenance: latest.provenance,
          validFrom: latest.validFrom,
          validTo: latest.validTo,
          recordedAt: latest.recordedAt,
          current: latest.current,
          rationale: latest.rationale,
        };
        // The fallback resolution succeeded — drop the degraded marker
        // this attempt pushed (the belief IS readable).
        const index = degraded.lastIndexOf('beliefs');
        if (index !== -1) degraded.splice(index, 1);
      }
    }
    if (belief === null) continue;
    items.push({
      id: belief.id,
      proposition: clip(belief.statement.proposition, 400),
      confidence: belief.statement.confidence.value,
      method: belief.statement.confidence.method,
      alternatives: belief.statement.alternatives.map((alternative) => clip(alternative, 200)),
      disconfirmation:
        belief.statement.disconfirmation === null
          ? null
          : clip(belief.statement.disconfirmation, 300),
      provenanceObservationIds: [...belief.provenance.observationIds],
      supportingClaimIds: [...belief.statement.supportingClaimIds],
      status: belief.status,
      subjectLabel:
        belief.subject === null
          ? null
          : belief.subject.kind === GOAL_SUBJECT_KIND
            ? 'this goal'
            : `${belief.subject.kind}`,
      recordedAt: belief.recordedAt,
      validFrom: belief.validFrom,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// The intelligence home (the product-mode Today briefing)
// ---------------------------------------------------------------------------

/** One active goal with its chain counts (the chain's entry points). */
export interface GoalChainEntry {
  id: string;
  title: string;
  priority: GoalPriority;
  objective: string;
  horizonEnd: string;
  openUnknownIds: string[];
  activeMissionIds: string[];
  activeBeliefCount: number;
  href: string;
}

/** The capability-gap view for the workflow home (the chain's context). */
export interface CapabilityGapRow {
  capabilityId: string;
  name: string;
  statusLabel: string;
  unmetCount: number;
  requirementCount: number;
  supplyCount: number;
}

/** The composed intelligence home view (Today briefing + chain entries). */
export interface IntelligenceView {
  generatedAt: string;
  findings: ProactiveFinding[];
  degraded: string[];
  attention: {
    pendingApprovals: {
      count: number;
      capped: boolean;
      latest: { id: string; actionKind: string; authorityLevel: string; requestedAt: string }[];
    };
    urgentMissions: MissionRow[];
  };
  situation: {
    activeGoals: number;
    openUnknowns: number;
    activeMissions: number;
    openContradictions: number;
  };
  goals: GoalChainEntry[];
  capabilityGaps: CapabilityGapRow[];
}

const COUNT_CAP = 100;

function boundedCount(rows: unknown[], cap: number = COUNT_CAP): { count: number; capped: boolean } {
  return { count: rows.length, capped: rows.length >= cap };
}

/** Build the intelligence home view: Today's briefing and the chain entries. */
export async function buildIntelligenceView(ctx: TenantContext): Promise<IntelligenceView> {
  const degraded: string[] = [];

  const [findings, goals, unknowns, missions, pendingRequests, contradictions, gaps, beliefAnchors] =
    await Promise.all([
      buildProactiveFindings(ctx),
      safe('goals', degraded, () => listGoals(ctx, { status: 'active', limit: COUNT_CAP })),
      safe('unknowns', degraded, () => listUnknowns(ctx, { status: 'open', limit: COUNT_CAP })),
      safe('missions', degraded, () => listMissions(ctx, { status: 'active', limit: COUNT_CAP })),
      safe('approvals', degraded, () =>
        listActionRequests(ctx, { status: 'pending', limit: COUNT_CAP }),
      ),
      safe('contradictions', degraded, () =>
        listContradictions(ctx, { status: 'open', limit: COUNT_CAP }),
      ),
      safe('gaps', degraded, () => analyzeGaps(ctx, { limit: 20 })),
      safe('beliefs', degraded, () => listBeliefs(ctx, { status: 'active', limit: COUNT_CAP })),
    ]);

  const goalList = goals ?? [];
  const unknownList = unknowns ?? [];
  const missionList = missions ?? [];
  const requestList = pendingRequests ?? [];
  const contradictionList = contradictions ?? [];
  const gapList = gaps ?? [];

  // Group the unknown/mission/belief sets per goal (subject refs + affected goals).
  const unknownsByGoal = new Map<string, string[]>();
  for (const unknown of unknownList) {
    if (unknown.subject === null || unknown.subject.kind !== GOAL_SUBJECT_KIND) continue;
    const list = unknownsByGoal.get(unknown.subject.id) ?? [];
    list.push(unknown.id);
    unknownsByGoal.set(unknown.subject.id, list);
  }
  const missionsByGoal = new Map<string, string[]>();
  for (const mission of missionList) {
    for (const goalRef of mission.content.affectedGoals) {
      const list = missionsByGoal.get(goalRef.goalId) ?? [];
      list.push(mission.id);
      missionsByGoal.set(goalRef.goalId, list);
    }
  }
  const beliefsByGoal = new Map<string, number>();
  for (const anchor of beliefAnchors ?? []) {
    if (anchor.subject === null || anchor.subject.kind !== GOAL_SUBJECT_KIND) continue;
    beliefsByGoal.set(anchor.subject.id, (beliefsByGoal.get(anchor.subject.id) ?? 0) + 1);
  }

  const entries: GoalChainEntry[] = goalList.slice(0, 6).map((goal) => ({
    id: goal.id,
    title: clip(goal.content.title, 120),
    priority: goal.content.priority,
    objective: clip(goal.content.objective, 200),
    horizonEnd: goal.content.horizon.end,
    openUnknownIds: unknownsByGoal.get(goal.id) ?? [],
    activeMissionIds: missionsByGoal.get(goal.id) ?? [],
    activeBeliefCount: beliefsByGoal.get(goal.id) ?? 0,
    href: `/intelligence/goals/${goal.id}`,
  }));

  const urgentMissions = missionList
    .filter((mission) => mission.content.urgency === 'critical' || mission.content.urgency === 'high')
    .slice(0, 4)
    .map(toMissionRow);

  return {
    generatedAt: now().toISOString(),
    findings: findings.findings,
    degraded: [...new Set([...findings.degraded, ...degraded])],
    attention: {
      pendingApprovals: {
        ...boundedCount(requestList),
        latest: requestList.slice(0, 3).map((request: ActionRequest) => ({
          id: request.id,
          actionKind: request.actionKind,
          authorityLevel: request.authorityLevel,
          requestedAt: request.requestedAt,
        })),
      },
      urgentMissions,
    },
    situation: {
      activeGoals: goalList.length,
      openUnknowns: unknownList.length,
      activeMissions: missionList.length,
      openContradictions: contradictionList.length,
    },
    goals: entries,
    capabilityGaps: gapList
      .filter((gap: CapabilityGap) => gap.status !== 'covered')
      .slice(0, 5)
      .map((gap: CapabilityGap) => ({
        capabilityId: gap.capability.id,
        name: gap.capability.name,
        statusLabel:
          gap.status === 'uncovered'
            ? 'No active supply'
            : gap.status === 'level_shortfall'
              ? 'Level shortfall'
              : 'Capacity shortfall',
        unmetCount: gap.unmet.length,
        requirementCount: gap.activeRequirementCount,
        supplyCount: gap.activeSupplyCount,
      })),
  };
}

// ---------------------------------------------------------------------------
// The goal chain view (the acceptance's navigable path)
// ---------------------------------------------------------------------------

/** The full chain view for one goal. */
export interface GoalChainView {
  generatedAt: string;
  goal: {
    id: string;
    title: string;
    objective: string;
    desiredState: string;
    successCriteria: string;
    priority: GoalPriority;
    status: string;
    horizonEnd: string;
    ownerLabel: string;
    metricLines: string[];
    updatedAt: string;
  };
  gaps: GapRunRow[];
  unknowns: UnknownRow[];
  missions: MissionRow[];
  evidence: EvidenceItem[];
  beliefs: BeliefItem[];
  degraded: string[];
}

/** How many evidence items the chain page resolves (bounded view). */
export const CHAIN_EVIDENCE_CAP = 12;

/** How many beliefs the chain page resolves (bounded view). */
export const CHAIN_BELIEF_CAP = 8;

/**
 * Build the navigable chain for one goal: gap → unknown → mission →
 * evidence → belief, each step linked to the next. Throws the goals
 * contract's `goal_not_found` for a foreign/missing id (the page renders
 * the honest not-found state).
 */
export async function buildGoalChainView(
  ctx: TenantContext,
  goalId: string,
): Promise<GoalChainView> {
  const degraded: string[] = [];
  const goal: Goal = await getGoal(ctx, goalId);

  const [runSummaries, unknowns, missions, claimRows, beliefAnchors] = await Promise.all([
    safe('gaps', degraded, () =>
      listDiscoveryRuns(ctx, { affectedGoalId: goalId, limit: 10 }),
    ),
    safe('unknowns', degraded, () =>
      listUnknowns(ctx, { subjectKind: GOAL_SUBJECT_KIND, subjectId: goalId, limit: 50 }),
    ),
    safe('missions', degraded, () => listMissions(ctx, { affectedGoalId: goalId, limit: 50 })),
    safe('claims', degraded, () =>
      listClaims(ctx, { subjectKind: GOAL_SUBJECT_KIND, subjectId: goalId, limit: 50 }),
    ),
    safe('beliefs', degraded, () =>
      listBeliefs(ctx, { subjectKind: GOAL_SUBJECT_KIND, subjectId: goalId, limit: 20 }),
    ),
  ]);

  // The gap runs with their decided candidates (W051 audit surface).
  const gapRuns: GapRunRow[] = [];
  for (const summary of runSummaries ?? []) {
    const run: DiscoveryRun | null = await safe('gaps', degraded, () =>
      getDiscoveryRun(ctx, { runId: summary.id }),
    );
    if (run !== null) gapRuns.push(toGapRun(run));
  }
  gapRuns.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));

  // Unknowns also reachable through the missions' unknown refs (missions
  // may close gaps whose subject is another record).
  const unknownRows = new Map<string, UnknownRow>();
  for (const unknown of unknowns ?? []) {
    unknownRows.set(unknown.id, toUnknownRow(unknown));
  }
  for (const mission of missions ?? []) {
    for (const unknownId of mission.content.unknownIds) {
      if (unknownRows.has(unknownId)) continue;
      const unknown: Unknown | null = await safe('unknowns', degraded, () =>
        getUnknown(ctx, { unknownId }),
      );
      if (unknown !== null) unknownRows.set(unknown.id, toUnknownRow(unknown));
    }
  }

  const missionRows = (missions ?? []).map(toMissionRow);

  // Evidence: the observations under the unknowns and the goal-subject
  // claims (the chain's step 5 — immutable W004 records).
  const observationIds: string[] = [];
  for (const unknown of unknowns ?? []) {
    observationIds.push(...unknown.relatedObservationIds);
  }
  for (const claim of claimRows ?? []) {
    observationIds.push(...claim.evidenceObservationIds);
  }
  const evidence = await resolveEvidence(ctx, observationIds, CHAIN_EVIDENCE_CAP, 'evidence', degraded);

  // Beliefs: the current working understanding about this goal (step 6).
  const beliefs = await resolveBeliefs(ctx, beliefAnchors ?? [], CHAIN_BELIEF_CAP, degraded);

  const content = goal.content;
  return {
    generatedAt: now().toISOString(),
    goal: {
      id: goal.id,
      title: clip(content.title, 200),
      objective: clip(content.objective, 500),
      desiredState: clip(content.desiredState, 500),
      successCriteria: clip(content.successCriteria, 500),
      priority: content.priority,
      status: content.status,
      horizonEnd: content.horizon.end,
      ownerLabel: content.owner.label ?? content.owner.kind,
      metricLines: content.metrics.slice(0, 4).map((metric) => {
        const bound =
          metric.direction === 'at_least'
            ? `≥ ${metric.threshold ?? '?'}`
            : metric.direction === 'at_most'
              ? `≤ ${metric.threshold ?? '?'}`
              : `${metric.lowerBound ?? '?'}…${metric.upperBound ?? '?'}`;
        return `${metric.name}: ${bound}${metric.unit === null ? '' : ` ${metric.unit}`}`;
      }),
      updatedAt: goal.updatedAt,
    },
    gaps: gapRuns,
    unknowns: [...unknownRows.values()],
    missions: missionRows,
    evidence,
    beliefs,
    degraded: [...new Set(degraded)],
  };
}

// ---------------------------------------------------------------------------
// The unknown view (step 3 in detail)
// ---------------------------------------------------------------------------

/** The full detail view for one unknown. */
export interface UnknownView {
  generatedAt: string;
  unknown: {
    id: string;
    question: string;
    consequence: string;
    status: string;
    recordedAt: string;
    resolvedAt: string | null;
    resolutionNote: string | null;
    note: string | null;
  };
  goals: { id: string; title: string; priority: GoalPriority; href: string }[];
  missions: MissionRow[];
  evidence: EvidenceItem[];
  claims: { id: string; proposition: string; confidence: number | null; recordedAt: string }[];
  beliefs: BeliefItem[];
  degraded: string[];
}

/** Build the detail view for one unknown (throws the contract's not-found). */
export async function buildUnknownView(
  ctx: TenantContext,
  unknownId: string,
): Promise<UnknownView> {
  const degraded: string[] = [];
  const unknown: Unknown = await getUnknown(ctx, { unknownId });

  const missions = await safe('missions', degraded, () =>
    listMissions(ctx, { unknownId, limit: 20 }),
  );

  // The goal this unknown serves (the chain upward).
  const goals: UnknownView['goals'] = [];
  if (unknown.subject !== null && unknown.subject.kind === GOAL_SUBJECT_KIND) {
    const subjectId = unknown.subject.id;
    const goal: Goal | null = await safe('goals', degraded, () => getGoal(ctx, subjectId));
    if (goal !== null) {
      goals.push({
        id: goal.id,
        title: clip(goal.content.title, 120),
        priority: goal.content.priority,
        href: `/intelligence/goals/${goal.id}`,
      });
    }
  }

  // Bounding claims (whose evidence observations also bound the gap —
  // discovery promotions link claims, not raw observations).
  const claims: UnknownView['claims'] = [];
  const claimEvidenceIds: string[] = [];
  for (const claimId of unknown.relatedClaimIds.slice(0, 6)) {
    const claim: Claim | null = await safe('claims', degraded, () =>
      getClaim(ctx, { claimId }),
    );
    if (claim === null) continue;
    claims.push({
      id: claim.id,
      proposition: clip(claim.proposition, 400),
      confidence: claim.confidence.value,
      recordedAt: claim.recordedAt,
    });
    claimEvidenceIds.push(...claim.evidenceObservationIds);
  }

  // Bounding evidence: the observations the unknown references, plus the
  // evidence its related claims were derived from.
  const evidence = await resolveEvidence(
    ctx,
    [...unknown.relatedObservationIds, ...claimEvidenceIds],
    8,
    'evidence',
    degraded,
  );

  // The beliefs that bound the gap + the resolution belief (the chain's end).
  const beliefAnchors = unknown.relatedBeliefIds.map((id) => ({ id }));
  if (unknown.resolution !== null && unknown.resolution.kind === 'belief') {
    beliefAnchors.unshift({ id: unknown.resolution.id });
  }
  const beliefs = await resolveBeliefs(ctx, beliefAnchors, 6, degraded);

  return {
    generatedAt: now().toISOString(),
    unknown: {
      id: unknown.id,
      question: clip(unknown.question, 500),
      consequence: clip(unknown.consequence, 500),
      status: unknown.status,
      recordedAt: unknown.recordedAt,
      resolvedAt: unknown.resolvedAt,
      resolutionNote: unknown.resolutionNote,
      note: unknown.note === null ? null : clip(unknown.note, 400),
    },
    goals,
    missions: (missions ?? []).map(toMissionRow),
    evidence,
    claims,
    beliefs,
    degraded: [...new Set(degraded)],
  };
}

// ---------------------------------------------------------------------------
// The mission view (step 4 in detail)
// ---------------------------------------------------------------------------

/** One acquisition the loop ran for a mission (from a W013 trace). */
export interface AcquisitionRow {
  executionId: string;
  decision: string;
  chosenLabel: string | null;
  action: string | null;
  outcomeNote: string | null;
  evidenceObservationId: string | null;
  missionCompleted: boolean;
  recordedAt: string;
}

/** The full detail view for one mission. */
export interface MissionView {
  generatedAt: string;
  mission: {
    id: string;
    title: string;
    knowledgeObjective: string;
    completionCriteria: string;
    status: string;
    urgency: MissionUrgency;
    informationValue: number;
    currentConfidence: number;
    targetConfidence: number;
    investigationBudget: string;
    rewardBudget: string;
    rewardTerms: string | null;
    candidateSourceLabels: string[];
    completion: { achievedConfidence: number; outcome: string | null } | null;
    updatedAt: string;
  };
  goals: { id: string; title: string; priority: GoalPriority; href: string }[];
  unknowns: UnknownRow[];
  acquisitions: AcquisitionRow[];
  beliefs: BeliefItem[];
  degraded: string[];
}

/** How many recent executions the mission view scans for acquisitions. */
export const MISSION_SCAN_EXECUTIONS = 25;

/** Build the detail view for one mission (throws the contract's not-found). */
export async function buildMissionView(
  ctx: TenantContext,
  missionId: string,
): Promise<MissionView> {
  const degraded: string[] = [];
  const mission: Mission = await getMission(ctx, missionId);
  const content = mission.content;

  // The chain upward: affected goals + the unknowns it closes.
  const goals: MissionView['goals'] = [];
  for (const goalRef of content.affectedGoals.slice(0, 4)) {
    const goal: Goal | null = await safe('goals', degraded, () => getGoal(ctx, goalRef.goalId));
    if (goal === null) continue;
    goals.push({
      id: goal.id,
      title: clip(goal.content.title, 120),
      priority: goal.content.priority,
      href: `/intelligence/goals/${goal.id}`,
    });
  }
  const unknowns: UnknownRow[] = [];
  const beliefAnchors: { id: string }[] = [];
  for (const unknownId of content.unknownIds.slice(0, 6)) {
    const unknown: Unknown | null = await safe('unknowns', degraded, () =>
      getUnknown(ctx, { unknownId }),
    );
    if (unknown === null) continue;
    unknowns.push(toUnknownRow(unknown));
    for (const beliefId of unknown.relatedBeliefIds) beliefAnchors.push({ id: beliefId });
    if (unknown.resolution !== null && unknown.resolution.kind === 'belief') {
      beliefAnchors.push({ id: unknown.resolution.id });
    }
  }

  // The acquisitions the loop ran for this mission (W013 traces).
  const acquisitions: AcquisitionRow[] = [];
  const executions: CognitiveExecution[] | null = await safe('cognition', degraded, () =>
    listExecutions(ctx, { limit: MISSION_SCAN_EXECUTIONS }),
  );
  for (const execution of executions ?? []) {
    const trace = await safe('cognition', degraded, () =>
      getExecution(ctx, { executionId: execution.id }),
    );
    if (trace === null) continue;
    for (const step of trace.steps) {
      const result = step.result;
      if (result.stage !== 'knowledge-acquisition') continue;
      if (result.missionId !== missionId) continue;
      acquisitions.push({
        executionId: execution.id,
        decision: result.decision,
        chosenLabel: result.chosen === null ? null : result.chosen.label,
        action: result.action,
        outcomeNote: result.outcome === null ? null : result.outcome.note,
        evidenceObservationId: result.outcome === null ? null : result.outcome.evidenceObservationId,
        missionCompleted: result.missionCompleted,
        recordedAt: step.recordedAt,
      });
    }
  }
  acquisitions.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));

  // The resulting beliefs (the chain's end, when the unknowns resolved).
  const beliefs = await resolveBeliefs(ctx, beliefAnchors, 6, degraded);

  const budget = (b: { amount: number; currency: string }): string =>
    `${(b.amount / 100).toFixed(2)} ${b.currency}`;

  return {
    generatedAt: now().toISOString(),
    mission: {
      id: mission.id,
      title: clip(content.title, 200),
      knowledgeObjective: clip(content.knowledgeObjective, 500),
      completionCriteria: clip(content.completionCriteria, 500),
      status: content.status,
      urgency: content.urgency,
      informationValue: content.informationValue,
      currentConfidence: content.currentConfidence,
      targetConfidence: content.targetConfidence,
      investigationBudget: budget(content.investigationBudget),
      rewardBudget: budget(content.rewardBudget),
      rewardTerms: content.rewardTerms === null ? null : clip(content.rewardTerms, 300),
      candidateSourceLabels: content.candidateSources
        .slice(0, 6)
        .map((candidate) => candidate.label ?? candidate.kind),
      completion:
        mission.completion === null
          ? null
          : {
              achievedConfidence: mission.completion.achievedConfidence,
              outcome: mission.completion.outcome === null ? null : clip(mission.completion.outcome, 400),
            },
      updatedAt: mission.updatedAt,
    },
    goals,
    unknowns,
    acquisitions,
    beliefs,
    degraded: [...new Set(degraded)],
  };
}
