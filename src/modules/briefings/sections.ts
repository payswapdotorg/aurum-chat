// Section compilers of the briefings module (W032): the per-section read
// paths over the DEPENDENCY MODULE CONTRACTS — events (W003), goals
// (W008), epistemics (W007), cognition (W013), capabilities (W017),
// agents (W021) and actions (W009). Nothing here touches SQL: every
// read goes through a sibling contract, exactly as the module boundary
// rules require (cross-module imports of anything but `contract` are
// architecture violations).
//
// The compilers return CANDIDATE items in canonical order; the service
// applies the section's policy snapshot (item cap) via the pure
// `boundCandidates`. Section windows are inclusive lookback bounds
// [from, to] derived by the service from the briefing's coverage window
// and the section's resolved `windowSeconds`.
//
// Two section natures exist (documented per compiler):
//  * WINDOW sections read what happened INSIDE the section window
//    (changes, goal-drift revisions, risk/opportunity findings, agent
//    activity);
//  * STATE sections read the CURRENT situation as of the window end
//    (open unknowns, capability gaps, pending approvals, overdue goals)
//    — a briefing is management's situation view, not only a delta.
//
// Every item deep-links the underlying records (`refs`) — lock 34 /
// ADR-0010: briefings are derived intelligence; findings link to the
// underlying evidence and executions. Detail text is excerpt-bounded so
// a section's serialized payload stays small; the deep links carry the
// reader to the full records.

import { listActionRequests, type ActionRequest } from '@/modules/actions/contract';
import {
  analyzeGaps,
  GAP_STATUS_RANK,
  type GapResult,
} from '@/modules/capabilities/contract';
import {
  getExecution,
  listExecutions,
  type CognitiveExecutionTrace,
  type RecordedAnalysisFinding,
} from '@/modules/cognition/contract';
import {
  listUnknowns,
  type Unknown as EpistemicUnknown,
} from '@/modules/epistemics/contract';
import { listEvents, type Event } from '@/modules/events/contract';
import { listGoals, type Goal } from '@/modules/goals/contract';
import {
  listAgentExecutions,
  listAgents,
  type AgentDefinition,
  type AgentExecution,
} from '@/modules/agents/contract';
import type { TenantContext } from '@/infra/tenant';
import type {
  BriefingItem,
  BriefingItemDetail,
  BriefingRef,
  BriefingSectionKind,
} from './types';
import { excerptText, SECTION_SCAN_LIMITS } from './policy';

// ---------------------------------------------------------------------------
// Bounds (detail excerpting — keeps a section's payload small)
// ---------------------------------------------------------------------------

/** Summary bound of one briefing item (mirrors MAX_SUMMARY_LENGTH). */
export const MAX_SUMMARY_LENGTH = 500;
/** Question/statement/justification excerpt bound in item details. */
export const MAX_DETAIL_TEXT = 480;
/** Consequence excerpt bound in item details. */
export const MAX_DETAIL_CONSEQUENCE = 1_000;
/** Id-list excerpt bound in finding details (evidence/goals). */
export const MAX_DETAIL_IDS = 16;
/** Deep links per item. */
export const MAX_ITEM_REFS = 32;

// ---------------------------------------------------------------------------
// Window + candidate plumbing
// ---------------------------------------------------------------------------

/** A section's inclusive lookback window (UTC instants). */
export interface SectionWindow {
  from: Date;
  to: Date;
}

function inWindow(instant: string, window: SectionWindow): boolean {
  const at = Date.parse(instant);
  return at >= window.from.getTime() && at <= window.to.getTime();
}

function ref(module: string, kind: string, id: string): BriefingRef {
  return { module, kind, id };
}

/** Build one item: summary excerpted, refs capped, detail attached. */
function item(summary: string, refs: BriefingRef[], detail: BriefingItemDetail): BriefingItem {
  return {
    summary: excerptText(summary, MAX_SUMMARY_LENGTH),
    refs: refs.slice(0, MAX_ITEM_REFS),
    detail,
  };
}

/** `YYYY-MM-DD` of an ISO instant (deterministic display date). */
function isoDate(instant: string): string {
  return instant.slice(0, 10);
}

// ---------------------------------------------------------------------------
// changes — meaningful changes (events, W003) inside the section window
// ---------------------------------------------------------------------------

/**
 * WINDOW section: the events recorded by the events module whose
 * `occurredAt` falls inside the section window, newest first (the
 * contract's descending sequence order — the canonical replay order
 * reversed). Each item links the immutable event envelope.
 */
async function compileChanges(ctx: TenantContext, window: SectionWindow): Promise<BriefingItem[]> {
  const events: Event[] = await listEvents(ctx, {
    occurredFrom: window.from.toISOString(),
    occurredTo: window.to.toISOString(),
    order: 'desc',
    limit: SECTION_SCAN_LIMITS.events,
  });
  return events.map((event) => {
    const actorLabel = event.actor.label ?? event.actor.id ?? event.actor.kind;
    return item(
      `Event ${event.type} #${event.sequence} — ${actorLabel}`,
      [ref('events', 'event', event.id)],
      {
        section: 'changes',
        type: event.type,
        typeVersion: event.typeVersion,
        occurredAt: event.occurredAt,
        recordedAt: event.recordedAt,
        sequence: event.sequence,
        actor: { kind: event.actor.kind, label: event.actor.label ?? null },
      },
    );
  });
}

// ---------------------------------------------------------------------------
// goal-drift — overdue horizons + in-window revisions (goals, W008)
// ---------------------------------------------------------------------------

/**
 * STATE + WINDOW hybrid over the tenant's ACTIVE goals:
 *  * overdue — the horizon ended strictly before the window's as-of
 *    moment (state: the goal is off its declared timeline NOW);
 *  * revised — the current version was committed inside the section
 *    window (delta: management's direction moved).
 * 'overdue' wins when a goal is both. Ordering: overdue first (most
 * overdue first), then revised (newest change first).
 */
async function compileGoalDrift(ctx: TenantContext, window: SectionWindow): Promise<BriefingItem[]> {
  const goals: Goal[] = await listGoals(ctx, {
    status: 'active',
    limit: SECTION_SCAN_LIMITS.goals,
  });
  const overdue: { goal: Goal; horizonEnd: number }[] = [];
  const revised: { goal: Goal; changedAt: number }[] = [];
  for (const goal of goals) {
    const horizonEnd = Date.parse(goal.content.horizon.end);
    const changedAt = Date.parse(goal.lastChange.recordedAt);
    if (horizonEnd < window.to.getTime()) {
      overdue.push({ goal, horizonEnd });
    } else if (changedAt >= window.from.getTime()) {
      revised.push({ goal, changedAt });
    }
  }
  overdue.sort((a, b) => a.horizonEnd - b.horizonEnd || a.goal.id.localeCompare(b.goal.id));
  revised.sort((a, b) => b.changedAt - a.changedAt || a.goal.id.localeCompare(b.goal.id));

  const items: BriefingItem[] = [];
  for (const { goal, horizonEnd } of overdue) {
    items.push(
      item(
        `Goal "${goal.content.title}" overdue since ${isoDate(goal.content.horizon.end)} (${goal.content.priority})`,
        [ref('goals', 'goal', goal.id)],
        {
          section: 'goal-drift',
          goalId: goal.id,
          version: goal.version,
          title: excerptText(goal.content.title, MAX_DETAIL_TEXT),
          priority: goal.content.priority,
          signal: 'overdue',
          changeKind: goal.lastChange.kind,
          horizonEnd: new Date(horizonEnd).toISOString(),
          changedAt: goal.lastChange.recordedAt,
        },
      ),
    );
  }
  for (const { goal } of revised) {
    items.push(
      item(
        `Goal "${goal.content.title}" revised (${goal.lastChange.kind}, v${goal.version})`,
        [ref('goals', 'goal', goal.id)],
        {
          section: 'goal-drift',
          goalId: goal.id,
          version: goal.version,
          title: excerptText(goal.content.title, MAX_DETAIL_TEXT),
          priority: goal.content.priority,
          signal: 'revised',
          changeKind: goal.lastChange.kind,
          horizonEnd: goal.content.horizon.end,
          changedAt: goal.lastChange.recordedAt,
        },
      ),
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// unknowns — the current unresolved unknowns (epistemics, W007)
// ---------------------------------------------------------------------------

/**
 * STATE section: every unknown the epistemics module reports OPEN at
 * generation time, newest recorded first (the contract's order). A
 * briefing's unknowns section is management's "what we still don't
 * know" situation view — the window does not filter it; only the item
 * cap bounds it.
 */
async function compileUnknowns(ctx: TenantContext, _window: SectionWindow): Promise<BriefingItem[]> {
  const unknowns: EpistemicUnknown[] = await listUnknowns(ctx, {
    status: 'open',
    limit: SECTION_SCAN_LIMITS.unknowns,
  });
  return unknowns.map((unknown) =>
    item(
      `Unknown: ${unknown.question}`,
      [ref('epistemics', 'unknown', unknown.id)],
      {
        section: 'unknowns',
        unknownId: unknown.id,
        question: excerptText(unknown.question, MAX_DETAIL_TEXT),
        consequence: excerptText(unknown.consequence, MAX_DETAIL_CONSEQUENCE),
        recordedAt: unknown.recordedAt,
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// risks / opportunities — findings on cognitive executions (W013)
// ---------------------------------------------------------------------------

interface CollectedFinding {
  executionId: string;
  recordedAt: string;
  finding: RecordedAnalysisFinding;
}

/**
 * WINDOW section: the risk (or opportunity) findings recorded on the
 * RISK-OPPORTUNITY-CAPABILITY-ANALYSIS stage of cognitive executions,
 * where that step was committed inside the section window. The findings
 * feed §22's risk/opportunity briefing summaries; the W015 opportunity
 * engine and future first-class risk objects integrate here through the
 * same cognition trace when they land. Every item links the execution
 * AND the evidence observations and affected goals the finding cites
 * (§22: findings link to the underlying evidence and executions).
 */
async function compileFindings(
  ctx: TenantContext,
  window: SectionWindow,
  findingKind: 'risk' | 'opportunity',
): Promise<BriefingItem[]> {
  const executions = await listExecutions(ctx, { limit: SECTION_SCAN_LIMITS.executions });
  const collected: CollectedFinding[] = [];
  for (const execution of executions) {
    const trace: CognitiveExecutionTrace = await getExecution(ctx, { executionId: execution.id });
    for (const step of trace.steps) {
      if (step.stage !== 'risk-opportunity-capability-analysis') continue;
      if (!inWindow(step.recordedAt, window)) continue;
      const result = step.result as {
        stage?: string;
        findings?: RecordedAnalysisFinding[];
      };
      if (result.stage !== 'risk-opportunity-capability-analysis') continue;
      for (const finding of result.findings ?? []) {
        if (finding.kind === findingKind) {
          collected.push({ executionId: execution.id, recordedAt: step.recordedAt, finding });
        }
      }
    }
  }
  collected.sort(
    (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || a.executionId.localeCompare(b.executionId),
  );
  const label = findingKind === 'risk' ? 'Risk' : 'Opportunity';
  const detailSection = findingKind === 'risk' ? 'risks' : 'opportunities';
  return collected.map(({ executionId, recordedAt, finding }) => {
    const refs: BriefingRef[] = [ref('cognition', 'execution', executionId)];
    for (const observationId of finding.evidenceObservationIds.slice(0, MAX_DETAIL_IDS)) {
      refs.push(ref('observations', 'observation', observationId));
    }
    for (const goalId of finding.affectedGoalIds.slice(0, MAX_DETAIL_IDS)) {
      refs.push(ref('goals', 'goal', goalId));
    }
    return item(`${label}: ${finding.statement}`, refs, {
      section: detailSection,
      executionId,
      findingKind,
      statement: excerptText(finding.statement, MAX_DETAIL_TEXT),
      evidenceObservationIds: finding.evidenceObservationIds.slice(0, MAX_DETAIL_IDS),
      affectedGoalIds: finding.affectedGoalIds.slice(0, MAX_DETAIL_IDS),
      recordedAt,
    });
  });
}

// ---------------------------------------------------------------------------
// capability-gaps — current uncovered/shortfall gaps (capabilities, W017)
// ---------------------------------------------------------------------------

/**
 * STATE section: the capability gaps the capabilities module's derived
 * analysis reports (every status except 'covered'), uncovered first
 * (GAP_STATUS_RANK), then by capability name. The gap view is derived
 * intelligence itself (W017: gaps are computed, never stored) — the
 * briefing snapshots it with deep links to the capability.
 */
async function compileCapabilityGaps(
  ctx: TenantContext,
  _window: SectionWindow,
): Promise<BriefingItem[]> {
  const gaps: GapResult[] = await analyzeGaps(ctx, { limit: SECTION_SCAN_LIMITS.gaps });
  const open = gaps.filter((gap) => gap.status !== 'covered');
  open.sort(
    (a, b) =>
      GAP_STATUS_RANK[a.status] - GAP_STATUS_RANK[b.status] ||
      a.capability.name.localeCompare(b.capability.name),
  );
  return open.map((gap) => {
    const unmetCount = gap.unmet.length;
    const statusLabel = gap.status.replaceAll('_', ' ');
    return item(
      `Capability gap: ${gap.capability.name} — ${statusLabel} (${unmetCount} unmet requirement${unmetCount === 1 ? '' : 's'})`,
      [ref('capabilities', 'capability', gap.capability.id)],
      {
        section: 'capability-gaps',
        capabilityId: gap.capability.id,
        name: excerptText(gap.capability.name, MAX_DETAIL_TEXT),
        // 'covered' was filtered out above — the CHECK-constrained narrow.
        gapStatus: gap.status as 'uncovered' | 'level_shortfall' | 'capacity_shortfall',
        unmetCount,
        bestActiveLevel: gap.bestActiveLevel,
        totalActiveCapacity: gap.totalActiveCapacity,
      },
    );
  });
}

// ---------------------------------------------------------------------------
// workforce-performance — per-agent rollups (agents, W021)
// ---------------------------------------------------------------------------

/**
 * WINDOW section over the ACTIVE agent workforce: one rollup item per
 * agent — executions submitted inside the section window, their
 * outcomes, and the cumulative cost (integer minor units). Active
 * agents with zero in-window executions are reported idle (utilization
 * visibility); ordering is most-active first, then slug. The
 * human-workforce compiler (W019) integrates into this section through
 * the same rollup shape when that module lands.
 */
async function compileWorkforcePerformance(
  ctx: TenantContext,
  window: SectionWindow,
): Promise<BriefingItem[]> {
  const agents: AgentDefinition[] = await listAgents(ctx, {
    status: 'active',
    limit: SECTION_SCAN_LIMITS.agents,
  });
  interface Rollup {
    agent: AgentDefinition;
    executions: AgentExecution[];
    costMinor: number;
  }
  const rollups: Rollup[] = [];
  for (const agent of agents) {
    const executions: AgentExecution[] = await listAgentExecutions(ctx, {
      agentId: agent.id,
      limit: SECTION_SCAN_LIMITS.agentExecutions,
    });
    const inWindowExecutions = executions.filter((execution) => inWindow(execution.submittedAt, window));
    rollups.push({
      agent,
      executions: inWindowExecutions,
      costMinor: inWindowExecutions.reduce((sum, execution) => sum + execution.costMinor, 0),
    });
  }
  rollups.sort(
    (a, b) => b.executions.length - a.executions.length || a.agent.slug.localeCompare(b.agent.slug),
  );
  return rollups.map(({ agent, executions, costMinor }) => {
    const succeeded = executions.filter((execution) => execution.status === 'succeeded').length;
    const failed = executions.filter((execution) => execution.status === 'failed').length;
    const refused = executions.filter((execution) => execution.status === 'refused').length;
    const cancelled = executions.filter((execution) => execution.status === 'cancelled').length;
    const awaiting = executions.filter(
      (execution) => execution.status === 'awaiting_approval' || execution.status === 'queued',
    ).length;
    return item(
      `Agent ${agent.slug}: ${executions.length} run(s), ${failed} failed, ${(costMinor / 100).toFixed(2)} USD`,
      [ref('agents', 'agent', agent.id)],
      {
        section: 'workforce-performance',
        agentId: agent.id,
        slug: agent.slug,
        displayName: agent.displayName ?? null,
        role: excerptText(agent.role, MAX_DETAIL_TEXT),
        provider: agent.provider,
        executions: executions.length,
        succeeded,
        failed,
        refused,
        cancelled,
        awaiting,
        costMinor,
      },
    );
  });
}

// ---------------------------------------------------------------------------
// approvals — decisions requiring management attention (actions, W009)
// ---------------------------------------------------------------------------

/**
 * STATE section: the authority-gate requests the actions module reports
 * PENDING at generation time — the decisions management must make.
 * Ordering is longest-waiting first (the contract lists newest first;
 * management attention inverts that deliberately). The window does not
 * filter a pending decision away.
 */
async function compileApprovals(ctx: TenantContext, _window: SectionWindow): Promise<BriefingItem[]> {
  const requests: ActionRequest[] = await listActionRequests(ctx, {
    status: 'pending',
    limit: SECTION_SCAN_LIMITS.approvals,
  });
  requests.sort(
    (a, b) =>
      Date.parse(a.requestedAt) - Date.parse(b.requestedAt) || a.id.localeCompare(b.id),
  );
  return requests.map((request) =>
    item(
      `Approval needed: ${request.actionKind} (${request.authorityLevel}), waiting since ${isoDate(request.requestedAt)}`,
      [ref('actions', 'action-request', request.id)],
      {
        section: 'approvals',
        requestId: request.id,
        actionKind: request.actionKind,
        authorityLevel: request.authorityLevel,
        requestedBy: request.requestedBy,
        requestedAt: request.requestedAt,
        justification:
          request.justification === null
            ? null
            : excerptText(request.justification, MAX_DETAIL_TEXT),
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// The compiler registry
// ---------------------------------------------------------------------------

/** One section compiler: read the contracts, return ordered candidates. */
export type SectionCompiler = (
  ctx: TenantContext,
  window: SectionWindow,
) => Promise<BriefingItem[]>;

/** The compilers, keyed by section kind (the closed W032 set). */
export const SECTION_COMPILERS: Record<BriefingSectionKind, SectionCompiler> = {
  changes: compileChanges,
  'goal-drift': compileGoalDrift,
  unknowns: compileUnknowns,
  risks: (ctx, window) => compileFindings(ctx, window, 'risk'),
  opportunities: (ctx, window) => compileFindings(ctx, window, 'opportunity'),
  'capability-gaps': compileCapabilityGaps,
  'workforce-performance': compileWorkforcePerformance,
  approvals: compileApprovals,
};

/** Compile one section's candidates (the registry entry point). */
export function compileSection(
  ctx: TenantContext,
  sectionKind: BriefingSectionKind,
  window: SectionWindow,
): Promise<BriefingItem[]> {
  return SECTION_COMPILERS[sectionKind](ctx, window);
}
