// Aurum chat (W060) — the deterministic answer composer.
//
// THE HONEST CORE OF THE CHAT WORKFLOW: every Aurum reply is composed from
// LIVE tenant state read through module contracts (lock 31/32 — the app
// layer composes contracts; product surfaces are never a second source of
// truth). The eight canonical discovery starters (plan §3) each map to a
// deterministic intent whose answer is a function of real records:
//
//   attention   → pending approvals + urgent unknowns/missions + risk findings
//   changed     → the most recent observations (the evidence feed)
//   unknowns    → open epistemic unknowns with their consequences
//   goals       → active goals with horizons
//   inefficiency→ capability gaps with unmet demand + loop findings
//   improve     → pending recommendations (the routed action feed)
//   why         → the evidence/reconstruction trail (observations + retained
//                 contradictions — lock 12: conflicting evidence is kept)
//   learning    → captured knowledge entries + active missions
//   open        → free text: a composite state summary + an honest note
//
// The composed payload (headline/bullets/cards/citations) is what the
// workflow stores on the outbound turn; the TEXT rendering can optionally
// be naturalized through the LLM gateway (W034, workflow.ts) — but the
// cards and citations always come from HERE, from contracts. LLM output is
// never authoritative (lock 10).
//
// Every contract read degrades QUIETLY and independently (the shell-state
// discipline): a failing family yields fewer cards plus an explicit
// degraded note — the answer never pretends missing data is empty data.

import type { TenantContext } from '@/infra/tenant';
import { listGoals } from '@/modules/goals/contract';
import type { Goal } from '@/modules/goals/contract';
import {
  listContradictions,
  listUnknowns,
} from '@/modules/epistemics/contract';
import type { Contradiction, Unknown } from '@/modules/epistemics/contract';
import { listMissions } from '@/modules/missions/contract';
import type { Mission } from '@/modules/missions/contract';
import { listActionRequests } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import { analyzeGaps } from '@/modules/capabilities/contract';
import type { CapabilityGap } from '@/modules/capabilities/contract';
import { listObservations } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import { listKnowledgeEntries } from '@/modules/memory/contract';
import type { KnowledgeEntry } from '@/modules/memory/contract';
import { getExecution, listExecutions } from '@/modules/cognition/contract';
import type {
  CognitiveExecution,
  RecordedAnalysisFinding,
} from '@/modules/cognition/contract';
import type { PillTone } from '../../lib/states';
import type {
  ChatCard,
  ChatCardContext,
  ChatCitation,
  ChatIntent,
} from './chat-types';
import { CARD_HREFS } from './chat-types';

// ---------------------------------------------------------------------------
// Intent classification (pure — the starters, then free-text keywords)
// ---------------------------------------------------------------------------

/** The canonical starter ids (plan §3) that carry a direct intent. */
const STARTER_INTENTS: Record<string, ChatIntent> = {
  attention: 'attention',
  changed: 'changed',
  unknowns: 'unknowns',
  goals: 'goals',
  inefficiency: 'inefficiency',
  improve: 'improve',
  why: 'why',
  learning: 'learning',
};

interface KeywordRule {
  intent: ChatIntent;
  pattern: RegExp;
}

/**
 * Free-text keyword rules, most specific first (a question mentioning
 * "evidence" is a why-question even if it also says "changed").
 */
const KEYWORD_RULES: readonly KeywordRule[] = [
  { intent: 'why', pattern: /\bwhy\b|\bevidence\b|\bexplain\b|\breason(?:ing)?\b|\bsources?\b|\bcited?\b/i },
  { intent: 'unknowns', pattern: /don['’]t (we )?know|dont know|\bunknown\b|\buncertain(?:ty)?\b|\bblind spot\b|\bgaps?\b/i },
  { intent: 'inefficiency', pattern: /inefficien|\bwast(?:e|ful)?\b|\bbottleneck\b|\bduplicat|\bprocess(?:es|ing)?\b|\bmanual\b|\bslow(?:er|down)?\b|efficiency/i },
  { intent: 'goals', pattern: /\bgoals?\b|\btargets?\b|\bobjectives?\b|\bhorizons?\b|\bkpis?\b|progress|direction/i },
  { intent: 'improve', pattern: /improve|recommend|suggest|should we|what would you|next steps?/i },
  { intent: 'learning', pattern: /\blearn(?:ing)?\b|company model|insights?/i },
  { intent: 'attention', pattern: /attention|urgent|important|priorit|\bnow\b|\btoday\b/i },
  { intent: 'changed', pattern: /chang(?:e|ed|es)?\b|\bnew(?:est)?\b|latest|update|recent|since/i },
];

/** Classify a turn into a chat intent (starter id wins, then keywords). */
export function classifyIntent(
  question: string,
  starterId: string | null,
): ChatIntent {
  if (starterId !== null && starterId in STARTER_INTENTS) {
    return STARTER_INTENTS[starterId]!;
  }
  const text = question.trim();
  if (text !== '') {
    for (const rule of KEYWORD_RULES) {
      if (rule.pattern.test(text)) return rule.intent;
    }
  }
  return 'open';
}

/**
 * Derive the cognition execution's focus topics from the question (W013
 * startExecution requires 1..16 lowercase slugs). Deterministic: the
 * starter id (when present) plus up to four distinctive words.
 */
export function deriveTopics(question: string, starterId: string | null): string[] {
  const topics = new Set<string>();
  if (starterId !== null && starterId.trim() !== '') topics.add(starterId);
  const STOP = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'we', 'our', 'us', 'i',
    'you', 'your', 'it', 'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by',
    'and', 'or', 'but', 'do', 'does', 'did', 'can', 'could', 'should',
    'would', 'will', 'shall', 'me', 'my', 'what', 'which', 'who', 'when',
    'where', 'why', 'how', 'this', 'that', 'these', 'those', 'about',
    'from', 'has', 'have', 'had', 'be', 'been', 'being', 'there', 'their',
  ]);
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && word.length <= 24 && !STOP.has(word));
  for (const word of words) {
    if (topics.size >= 5) break;
    topics.add(word);
  }
  if (topics.size === 0) topics.add('chat');
  return [...topics].sort();
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Humanize a canonical action-kind slug ('employee-messaging' → 'Employee messaging'). */
export function humanizeActionKind(actionKind: string): string {
  const words = actionKind
    .split(/[-_.]+/)
    .filter((word) => word !== '');
  if (words.length === 0) return actionKind;
  const first = words[0]!;
  const rest = words.slice(1).join(' ');
  const head = first.charAt(0).toUpperCase() + first.slice(1);
  return rest === '' ? head : `${head} ${rest}`;
}

function plural(count: number, singularWord: string, pluralWord?: string): string {
  return `${count} ${count === 1 ? singularWord : (pluralWord ?? `${singularWord}s`)}`;
}

function context(sections: ChatCardContext['sections'], subtitle: string | null): ChatCardContext {
  return { subtitle, sections };
}

// ---------------------------------------------------------------------------
// Card builders (pure — one per consequential kind, W060 acceptance)
// ---------------------------------------------------------------------------

export function goalCard(goal: Goal): ChatCard {
  const content = goal.content;
  const metricLines = content.metrics.slice(0, 3).map((metric) => {
    const bound =
      metric.direction === 'at_least'
        ? `≥ ${metric.threshold ?? '?'}`
        : metric.direction === 'at_most'
          ? `≤ ${metric.threshold ?? '?'}`
          : `${metric.lowerBound ?? '?'}…${metric.upperBound ?? '?'}`;
    return `${metric.name}: ${bound}${metric.unit === null ? '' : ` ${metric.unit}`}`;
  });
  return {
    kind: 'goal',
    id: goal.id,
    title: clip(content.title, 120),
    statusLabel: 'Active',
    tone: 'positive',
    meta: [
      clip(content.objective, 140),
      `Horizon ends ${dateLabel(content.horizon.end)}`,
      `Priority: ${content.priority}`,
      ...metricLines,
    ].slice(0, 5),
    href: CARD_HREFS.goal,
    decision: null,
    context: context(
      [
        {
          kind: 'summary',
          title: 'Objective',
          lines: [clip(content.objective, 400), `Desired state: ${clip(content.desiredState, 400)}`],
          links: [],
        },
        {
          kind: 'detail',
          title: 'Success criteria',
          lines: [clip(content.successCriteria, 400), ...metricLines],
          links: [],
        },
      ],
      'Goal (W008 record — management defines direction; Aurum evaluates progress)',
    ),
  };
}

export function unknownCard(unknown: Unknown): ChatCard {
  return {
    kind: 'unknown',
    id: unknown.id,
    title: clip(unknown.question, 140),
    statusLabel: 'Open',
    tone: 'warning',
    meta: [`Why it matters: ${clip(unknown.consequence, 160)}`],
    href: CARD_HREFS.unknown,
    decision: null,
    context: context(
      [
        {
          kind: 'why',
          title: 'Why this matters',
          lines: [clip(unknown.consequence, 400)],
          links: [],
        },
        {
          kind: 'evidence',
          title: 'Bounding evidence',
          lines: [
            `${unknown.relatedObservationIds.length} related observation(s)`,
            `${unknown.relatedClaimIds.length} related claim(s)`,
            `${unknown.relatedBeliefIds.length} related belief(s)`,
          ],
          links: [{ label: 'Open the Evidence surface', href: '/evidence' }],
        },
      ],
      'First-class unknown (W007) — a consequential question, not a TODO',
    ),
  };
}

export function missionCard(mission: Mission): ChatCard {
  const content = mission.content;
  const tone: PillTone =
    content.urgency === 'critical' || content.urgency === 'high' ? 'warning' : 'info';
  const affectedGoalLines = content.affectedGoals
    .slice(0, 3)
    .map((ref) => `Goal: ${ref.label ?? ref.goalId}`);
  return {
    kind: 'mission',
    id: mission.id,
    title: clip(content.title, 120),
    statusLabel: content.status === 'active' ? 'Active' : content.status,
    tone,
    meta: [
      clip(content.knowledgeObjective, 140),
      `Confidence ${(content.currentConfidence * 100).toFixed(0)}% → ${(content.targetConfidence * 100).toFixed(0)}%`,
      `Urgency: ${content.urgency}`,
      ...affectedGoalLines,
    ].slice(0, 5),
    href: CARD_HREFS.mission,
    decision: null,
    context: context(
      [
        {
          kind: 'mission',
          title: 'Knowledge objective',
          lines: [clip(content.knowledgeObjective, 400)],
          links: [],
        },
        {
          kind: 'detail',
          title: 'Completion criteria',
          lines: [clip(content.completionCriteria, 400)],
          links: [],
        },
      ],
      'Learning mission (W011) — goal-driven, budget-bounded',
    ),
  };
}

export function riskContradictionCard(contradiction: Contradiction): ChatCard {
  return {
    kind: 'risk',
    id: contradiction.id,
    title: clip(contradiction.note, 140),
    statusLabel: 'Conflicting evidence',
    tone: 'warning',
    meta: [
      `Detected ${dateLabel(contradiction.detectedAt)}`,
      'Two pieces of evidence disagree — both are retained (lock 12)',
    ],
    href: CARD_HREFS.risk,
    decision: null,
    context: context(
      [
        {
          kind: 'why',
          title: 'Why this matters',
          lines: [clip(contradiction.note, 400)],
          links: [],
        },
        {
          kind: 'evidence',
          title: 'The conflicting evidence',
          lines: [
            `A: ${contradiction.evidenceA.kind} (${clip(contradiction.evidenceA.id, 120)})`,
            `B: ${contradiction.evidenceB.kind} (${clip(contradiction.evidenceB.id, 120)})`,
          ],
          links: [{ label: 'Open the Evidence surface', href: '/evidence' }],
        },
      ],
      'Retained contradiction (W007) — conflicting evidence is never discarded',
    ),
  };
}

export function riskGapCard(gap: CapabilityGap): ChatCard {
  const statusLabel =
    gap.status === 'uncovered'
      ? 'No active supply'
      : gap.status === 'level_shortfall'
        ? 'Level shortfall'
        : gap.status === 'capacity_shortfall'
          ? 'Capacity shortfall'
          : 'Covered';
  return {
    kind: 'risk',
    id: gap.capability.id,
    title: `Capability gap — ${gap.capability.name}`,
    statusLabel,
    tone: 'warning',
    meta: [
      `${plural(gap.unmet.length, 'unmet requirement')}`,
      `${plural(gap.activeSupplyCount, 'active supply')} today`,
    ],
    href: CARD_HREFS.risk,
    decision: null,
    context: context(
      [
        {
          kind: 'why',
          title: 'Why this matters',
          lines: [
            `${gap.activeRequirementCount} active requirement(s) need this capability; ${gap.unmet.length} are currently unmet.`,
          ],
          links: [],
        },
        {
          kind: 'detail',
          title: 'Alternatives exist',
          lines: ['Train, reassign, hire, automate, recruit, install or outsource — compare them in the Capabilities surface.'],
          links: [
            { label: 'Open Capabilities', href: '/capabilities' },
            { label: 'Open Workforce', href: '/workforce' },
          ],
        },
      ],
      'Capability gap (W017) — supply and demand, with alternatives',
    ),
  };
}

/** One loop-recorded analysis finding, located on its trace. */
export interface TraceFindingLite {
  kind: RecordedAnalysisFinding['kind'];
  statement: string;
  executionId: string;
  detectedAt: string;
  evidenceObservationIds: string[];
  affectedGoalIds: string[];
}

export function traceFindingCard(finding: TraceFindingLite): ChatCard {
  const isRisk = finding.kind !== 'opportunity';
  return {
    kind: isRisk ? 'risk' : 'opportunity',
    id: finding.executionId,
    title: clip(finding.statement, 140),
    statusLabel: isRisk ? 'Risk finding' : 'Opportunity finding',
    tone: isRisk ? 'warning' : 'positive',
    meta: [
      `Detected ${dateLabel(finding.detectedAt)}`,
      `${plural(finding.evidenceObservationIds.length, 'evidence reference')}`,
    ],
    href: isRisk ? CARD_HREFS.risk : CARD_HREFS.opportunity,
    decision: null,
    context: context(
      [
        {
          kind: 'why',
          title: 'Why this matters',
          lines: [clip(finding.statement, 400)],
          links: [],
        },
        {
          kind: 'evidence',
          title: 'Evidence',
          lines: [
            `${finding.evidenceObservationIds.length} observation(s) underpin this finding`,
            `${finding.affectedGoalIds.length} affected goal(s)`,
          ],
          links: [
            { label: 'Open the Evidence surface', href: '/evidence' },
            { label: 'Open Goals', href: '/goals' },
          ],
        },
      ],
      'Analysis finding recorded on a cognition trace (W013) — derived intelligence',
    ),
  };
}

export function recommendationCard(request: ActionRequest): ChatCard {
  return {
    kind: 'recommendation',
    id: request.id,
    title: humanizeActionKind(request.actionKind),
    statusLabel: request.status === 'pending' ? 'Awaiting decision' : request.status,
    tone: 'info',
    meta: [
      `Authority: ${request.authorityLevel}`,
      request.justification === null ? null : clip(request.justification, 160),
      `Proposed ${dateLabel(request.requestedAt)}`,
    ].filter((line): line is string => line !== null),
    href: CARD_HREFS.recommendation,
    decision: null,
    context: context(
      [
        {
          kind: 'summary',
          title: 'The proposal',
          lines: [
            request.justification === null
              ? 'No justification was recorded.'
              : clip(request.justification, 400),
          ],
          links: [],
        },
        {
          kind: 'policy',
          title: 'Policy evaluation',
          lines: [
            `Gate outcome: ${request.evaluation.outcome} (via ${request.evaluation.resolvedVia})`,
            `Status: ${request.status}`,
          ],
          links: [{ label: 'Open Recommendations', href: '/recommendations' }],
        },
      ],
      'Routed action request (W009) — consequential actions pass the human gate',
    ),
  };
}

export function approvalCard(request: ActionRequest): ChatCard {
  const pending = request.status === 'pending';
  return {
    kind: 'approval',
    id: request.id,
    title: humanizeActionKind(request.actionKind),
    statusLabel: pending ? 'Needs your decision' : request.status,
    tone: pending ? 'warning' : request.status === 'approved' ? 'positive' : 'neutral',
    meta: [
      `Authority: ${request.authorityLevel}`,
      request.justification === null ? null : clip(request.justification, 160),
    ].filter((line): line is string => line !== null),
    href: CARD_HREFS.approval,
    decision: {
      requestId: request.id,
      status: pending ? 'pending' : (request.status as 'approved' | 'rejected'),
    },
    context: context(
      [
        {
          kind: 'approval',
          title: 'What is being asked',
          lines: [
            request.justification === null
              ? 'No justification was recorded.'
              : clip(request.justification, 400),
          ],
          links: [],
        },
        {
          kind: 'policy',
          title: 'Policy evaluation',
          lines: [
            `Gate outcome: ${request.evaluation.outcome} (via ${request.evaluation.resolvedVia})`,
            'Aurum proposes; the authority matrix disposes. Humans decide.',
          ],
          links: [{ label: 'Open Approvals (management mode)', href: '/approvals' }],
        },
      ],
      'Pending action request (W009) — the human authority gate',
    ),
  };
}

export function observationCitation(observation: Observation): ChatCitation {
  const sourceLabel =
    observation.source.label ??
    (observation.source.id
      ? `${observation.source.kind} ${observation.source.id.slice(0, 8)}`
      : observation.source.kind);
  return {
    kind: 'observation',
    id: observation.id,
    label: clip(`${observation.kind} · ${sourceLabel}`, 120),
    detail: `Observed ${dateLabel(observation.observedAt)} via ${observation.channel}`,
    href: '/evidence',
  };
}

// ---------------------------------------------------------------------------
// The composed answer parts (pure — the unit-test seam)
// ---------------------------------------------------------------------------

/** Everything the composer reads (loaded per intent by loadAnswerData). */
export interface AnswerData {
  goals: Goal[];
  unknowns: Unknown[];
  missions: Mission[];
  pendingRequests: ActionRequest[];
  contradictions: Contradiction[];
  gaps: CapabilityGap[];
  traceFindings: TraceFindingLite[];
  observations: Observation[];
  knowledge: KnowledgeEntry[];
  /** Families whose contract read failed (rendered as an explicit note). */
  degraded: string[];
}

/** The pure output of composition (before text rendering). */
export interface ComposedAnswerParts {
  intent: ChatIntent;
  headline: string;
  bullets: string[];
  note: string | null;
  cards: ChatCard[];
  citations: ChatCitation[];
  relatedGoalIds: string[];
}

function urgentUnknowns(unknowns: Unknown[]): Unknown[] {
  // Unknowns carry no severity of their own; the consequence text plus the
  // missions that close them carry urgency. Keep it honest: order by
  // recordedAt (newest first, the contract's order) and let the count speak.
  return unknowns;
}

/** Compose the answer parts for one intent from loaded data (pure). */
export function composeAnswerParts(
  intent: ChatIntent,
  data: AnswerData,
): ComposedAnswerParts {
  const degradedNote =
    data.degraded.length === 0
      ? null
      : `Some reads were unavailable just now (${data.degraded.join(', ')}) — this answer may be incomplete.`;

  switch (intent) {
    case 'attention': {
      const urgentMissions = data.missions.filter(
        (mission) =>
          mission.content.urgency === 'critical' || mission.content.urgency === 'high',
      );
      const riskFindings = data.traceFindings.filter((finding) => finding.kind !== 'opportunity');
      const empty =
        data.pendingRequests.length === 0 &&
        data.unknowns.length === 0 &&
        urgentMissions.length === 0 &&
        riskFindings.length === 0;
      const headline = empty
        ? 'Nothing needs your attention right now.'
        : 'Here’s what needs your attention right now.';
      const bullets = empty
        ? [
            'No approvals are waiting for a human decision.',
            'No open unknowns, no urgent learning missions, no new risk findings.',
          ]
        : [
            `${plural(data.pendingRequests.length, 'approval')} waiting for a human decision.`,
            `${plural(data.unknowns.length, 'open unknown')} with recorded consequences.`,
            `${plural(urgentMissions.length, 'learning mission')} at critical/high urgency.`,
            `${plural(riskFindings.length, 'risk finding')} on recent analysis traces.`,
          ];
      return {
        intent,
        headline,
        bullets,
        note: degradedNote,
        cards: [
          ...data.pendingRequests.slice(0, 4).map(approvalCard),
          ...urgentUnknowns(data.unknowns).slice(0, 4).map(unknownCard),
          ...urgentMissions.slice(0, 3).map(missionCard),
          ...riskFindings.slice(0, 2).map(traceFindingCard),
        ],
        citations: [],
        relatedGoalIds: data.goals.slice(0, 16).map((goal) => goal.id),
      };
    }
    case 'changed': {
      const bullets = data.observations
        .slice(0, 5)
        .map((observation) => {
          const source =
            observation.source.label ?? observation.source.kind;
          return `${clip(observation.kind, 60)} from ${clip(source, 60)} — ${dateLabel(observation.observedAt)}`;
        });
      return {
        intent,
        headline:
          data.observations.length === 0
            ? 'No observations have been recorded yet.'
            : `Your ${data.observations.length} most recent observation(s), newest first:`,
        bullets:
          bullets.length === 0
            ? ['Once channels and sources are connected, what they observe lands here.']
            : bullets,
        note: degradedNote,
        cards: [],
        citations: data.observations.slice(0, 6).map(observationCitation),
        relatedGoalIds: [],
      };
    }
    case 'unknowns': {
      return {
        intent,
        headline:
          data.unknowns.length === 0
            ? 'No open unknowns — everything consequential is currently bounded by evidence.'
            : `You have ${plural(data.unknowns.length, 'open unknown')}.`,
        bullets: data.unknowns
          .slice(0, 3)
          .map((unknown) => clip(unknown.consequence, 160)),
        note: degradedNote,
        cards: data.unknowns.slice(0, 8).map(unknownCard),
        citations: [],
        relatedGoalIds: [],
      };
    }
    case 'goals': {
      return {
        intent,
        headline:
          data.goals.length === 0
            ? 'No active goals are defined yet.'
            : `You have ${plural(data.goals.length, 'active goal')}.`,
        bullets: data.goals
          .slice(0, 5)
          .map((goal) => `${clip(goal.content.title, 80)} — horizon ends ${dateLabel(goal.content.horizon.end)}`),
        note: degradedNote,
        cards: data.goals.slice(0, 8).map(goalCard),
        citations: [],
        relatedGoalIds: data.goals.slice(0, 16).map((goal) => goal.id),
      };
    }
    case 'inefficiency': {
      const openGaps = data.gaps.filter((gap) => gap.status !== 'covered');
      const efficiencyFindings = data.traceFindings.filter(
        (finding) => finding.kind !== 'opportunity',
      );
      return {
        intent,
        headline:
          openGaps.length === 0 && efficiencyFindings.length === 0
            ? 'No efficiency drag is currently visible.'
            : 'Where demand outstrips supply today:',
        bullets: [
          `${plural(openGaps.length, 'capability gap')} with unmet active requirements.`,
          `${plural(efficiencyFindings.length, 'efficiency-related finding')} on recent analysis traces.`,
          ...openGaps
            .slice(0, 3)
            .map((gap) => `${gap.capability.name}: ${plural(gap.unmet.length, 'unmet requirement')}`),
        ],
        note: degradedNote,
        cards: [
          ...openGaps.slice(0, 5).map(riskGapCard),
          ...efficiencyFindings.slice(0, 4).map(traceFindingCard),
        ],
        citations: [],
        relatedGoalIds: data.goals.slice(0, 16).map((goal) => goal.id),
      };
    }
    case 'improve': {
      const pending = data.pendingRequests;
      return {
        intent,
        headline:
          pending.length === 0
            ? 'No recommendations are waiting right now.'
            : `${plural(pending.length, 'recommendation')} currently on the table:`,
        bullets: pending.slice(0, 4).map((request) => {
          const why =
            request.justification === null
              ? 'no justification recorded'
              : clip(request.justification, 120);
          return `${humanizeActionKind(request.actionKind)} — ${why}`;
        }),
        note: degradedNote,
        cards: pending.slice(0, 6).map(recommendationCard),
        citations: [],
        relatedGoalIds: data.goals.slice(0, 16).map((goal) => goal.id),
      };
    }
    case 'why': {
      return {
        intent,
        headline: 'Here’s the evidence behind Aurum’s answers.',
        bullets: [
          'Every consequential answer runs a recorded cognition execution: observation → evidence → analysis → recommendation → approval → outcome → learning.',
          `${plural(data.observations.length, 'recent observation')} — the immutable evidence feed.`,
          `${plural(data.contradictions.length, 'retained contradiction')} — conflicting evidence is kept, never discarded (lock 12).`,
          'Ask “Show me why” about any card to open its context: evidence, related goals, policy.',
        ],
        note: degradedNote,
        cards: data.contradictions.slice(0, 3).map(riskContradictionCard),
        citations: data.observations.slice(0, 6).map(observationCitation),
        relatedGoalIds: [],
      };
    }
    case 'learning': {
      return {
        intent,
        headline:
          data.knowledge.length === 0 && data.missions.length === 0
            ? 'Aurum hasn’t captured durable company knowledge yet.'
            : 'What Aurum currently knows about your company:',
        bullets: data.knowledge
          .slice(0, 5)
          .map((entry) => `${clip(entry.title, 80)} — ${clip(entry.summary, 140)}`),
        note: degradedNote,
        cards: data.missions.slice(0, 4).map(missionCard),
        citations: data.observations.slice(0, 3).map(observationCitation),
        relatedGoalIds: [],
      };
    }
    case 'open':
    default: {
      return {
        intent: 'open',
        headline: 'Here’s where the company stands right now.',
        bullets: [
          `${plural(data.goals.length, 'active goal')} steering direction.`,
          `${plural(data.unknowns.length, 'open unknown')} with recorded consequences.`,
          `${plural(data.missions.length, 'active learning mission')}.`,
          `${plural(data.pendingRequests.length, 'action')} waiting at the human gate.`,
          `${plural(data.observations.length, 'recent observation')} in the evidence feed.`,
        ],
        note:
          'I answer structurally from live company state — every claim traces to records. For open-ended conversation, connect an AI provider in Connections; both modes stay evidence-backed.' +
          (degradedNote === null ? '' : ` ${degradedNote}`),
        cards: [
          ...data.pendingRequests.slice(0, 2).map(approvalCard),
          ...data.unknowns.slice(0, 2).map(unknownCard),
          ...data.missions.slice(0, 2).map(missionCard),
        ],
        citations: data.observations.slice(0, 3).map(observationCitation),
        relatedGoalIds: data.goals.slice(0, 16).map((goal) => goal.id),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Data loading (contract reads, per intent, quietly degrading)
// ---------------------------------------------------------------------------

async function safeRead<T>(
  family: string,
  data: AnswerData,
  read: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await read();
  } catch {
    data.degraded.push(family);
    return [];
  }
}

/** How many recent executions the composer scans for analysis findings. */
export const FINDING_SCAN = 8;

/**
 * Collect the loop's recorded analysis findings from the newest
 * executions (the tower's findings derivation, scan-bounded for chat).
 */
export async function collectTraceFindings(
  ctx: TenantContext,
  scan: number = FINDING_SCAN,
): Promise<TraceFindingLite[]> {
  const executions: CognitiveExecution[] = await listExecutions(ctx, { limit: scan });
  const findings: TraceFindingLite[] = [];
  for (const execution of executions) {
    const trace = await getExecution(ctx, { executionId: execution.id });
    for (const step of trace.steps) {
      const result = step.result;
      if (result.stage !== 'risk-opportunity-capability-analysis') continue;
      for (const finding of result.findings) {
        findings.push({
          kind: finding.kind,
          statement: finding.statement,
          executionId: execution.id,
          detectedAt: step.recordedAt,
          evidenceObservationIds: [...finding.evidenceObservationIds],
          affectedGoalIds: [...finding.affectedGoalIds],
        });
      }
    }
  }
  return findings;
}

/** Which families an intent needs (load only what the answer reads). */
function familiesForIntent(intent: ChatIntent): Set<string> {
  switch (intent) {
    case 'attention':
      return new Set(['goals', 'unknowns', 'missions', 'approvals', 'findings']);
    case 'changed':
      return new Set(['observations']);
    case 'unknowns':
      return new Set(['unknowns']);
    case 'goals':
      return new Set(['goals']);
    case 'inefficiency':
      return new Set(['gaps', 'findings', 'goals']);
    case 'improve':
      return new Set(['approvals', 'goals']);
    case 'why':
      return new Set(['observations', 'contradictions']);
    case 'learning':
      return new Set(['knowledge', 'missions', 'observations']);
    case 'open':
    default:
      return new Set([
        'goals',
        'unknowns',
        'missions',
        'approvals',
        'observations',
      ]);
  }
}

/** Load the answer data for one intent (only the families it needs). */
export async function loadAnswerData(
  ctx: TenantContext,
  intent: ChatIntent,
): Promise<AnswerData> {
  const families = familiesForIntent(intent);
  const data: AnswerData = {
    goals: [],
    unknowns: [],
    missions: [],
    pendingRequests: [],
    contradictions: [],
    gaps: [],
    traceFindings: [],
    observations: [],
    knowledge: [],
    degraded: [],
  };
  const jobs: Promise<void>[] = [];
  if (families.has('goals')) {
    jobs.push(
      safeRead('goals', data, () => listGoals(ctx, { status: 'active', limit: 30 })).then(
        (goals) => {
          data.goals = goals;
        },
      ),
    );
  }
  if (families.has('unknowns')) {
    jobs.push(
      safeRead('unknowns', data, () => listUnknowns(ctx, { status: 'open', limit: 30 })).then(
        (unknowns) => {
          data.unknowns = unknowns;
        },
      ),
    );
  }
  if (families.has('missions')) {
    jobs.push(
      safeRead('missions', data, () => listMissions(ctx, { status: 'active', limit: 30 })).then(
        (missions) => {
          data.missions = missions;
        },
      ),
    );
  }
  if (families.has('approvals')) {
    jobs.push(
      safeRead('approvals', data, () =>
        listActionRequests(ctx, { status: 'pending', limit: 30 }),
      ).then((requests) => {
        data.pendingRequests = requests;
      }),
    );
  }
  if (families.has('contradictions')) {
    jobs.push(
      safeRead('contradictions', data, () =>
        listContradictions(ctx, { status: 'open', limit: 20 }),
      ).then((contradictions) => {
        data.contradictions = contradictions;
      }),
    );
  }
  if (families.has('gaps')) {
    jobs.push(
      safeRead('gaps', data, () => analyzeGaps(ctx, { limit: 30 })).then((gaps) => {
        data.gaps = gaps;
      }),
    );
  }
  if (families.has('findings')) {
    jobs.push(
      safeRead('findings', data, () => collectTraceFindings(ctx)).then((findings) => {
        data.traceFindings = findings;
      }),
    );
  }
  if (families.has('observations')) {
    jobs.push(
      safeRead('observations', data, () => listObservations(ctx, { limit: 10 })).then(
        (observations) => {
          data.observations = observations;
        },
      ),
    );
  }
  if (families.has('knowledge')) {
    jobs.push(
      safeRead('knowledge', data, () => listKnowledgeEntries(ctx, { limit: 10 })).then(
        (knowledge) => {
          data.knowledge = knowledge;
        },
      ),
    );
  }
  await Promise.all(jobs);
  return data;
}

// ---------------------------------------------------------------------------
// Text rendering (deterministic + the LLM prompt)
// ---------------------------------------------------------------------------

/** Render the deterministic reply text (the always-available mode). */
export function renderDeterministicText(parts: ComposedAnswerParts): string {
  const lines: string[] = [parts.headline];
  for (const bullet of parts.bullets) lines.push(`• ${bullet}`);
  if (parts.note !== null) lines.push('', parts.note);
  return lines.join('\n');
}

/** The chat system prompt (bounded reasoning, never authority — lock 10). */
export const AURUM_CHAT_SYSTEM_PROMPT = [
  'You are Aurum, an organizational intelligence employee embedded in a company.',
  'You answer the user in a short, warm, direct chat message (WhatsApp-like density: 2-6 sentences or a few short bullets).',
  'Rules:',
  '- Ground every claim in the structured company context you are given; never invent records, numbers or ids.',
  '- Do not restate the context verbatim — summarize what matters for the question.',
  '- Refer to the attached cards/evidence by their titles when useful ("the Wholesale freshness goal", "the pending Employee messaging approval").',
  '- Consequential actions are human-approved; invite decisions instead of promising execution.',
  '- No markdown headers; plain sentences and hyphen bullets only.',
].join('\n');

/** Build the user prompt: the question + the deterministic digest. */
export function buildLlmUserPrompt(
  question: string,
  parts: ComposedAnswerParts,
): string {
  const digest: string[] = [
    `Question: ${question}`,
    `Answer basis (deterministic, from live tenant records):`,
    parts.headline,
    ...parts.bullets.map((bullet) => `- ${bullet}`),
  ];
  if (parts.cards.length > 0) {
    digest.push('Attached cards:');
    for (const card of parts.cards.slice(0, 8)) {
      digest.push(
        `- [${card.kind}] ${card.title} (${card.statusLabel})${card.meta.length > 0 ? ` — ${card.meta[0]}` : ''}`,
      );
    }
  }
  if (parts.citations.length > 0) {
    digest.push('Cited evidence:');
    for (const citation of parts.citations.slice(0, 6)) {
      digest.push(`- ${citation.label} (${citation.detail ?? 'observation'})`);
    }
  }
  return digest.join('\n');
}

// ---------------------------------------------------------------------------
// The composed answer (what the workflow stores on the outbound turn)
// ---------------------------------------------------------------------------

/** Everything the workflow needs to render and record one reply. */
export interface ComposedAnswer extends ComposedAnswerParts {
  llmContext: { system: string; user: string };
}

/** Compose the full answer for one turn (reads contracts per intent). */
export async function composeAnswer(
  ctx: TenantContext,
  question: string,
  starterId: string | null,
): Promise<ComposedAnswer> {
  const intent = classifyIntent(question, starterId);
  const data = await loadAnswerData(ctx, intent);
  const parts = composeAnswerParts(intent, data);
  return {
    ...parts,
    llmContext: {
      system: AURUM_CHAT_SYSTEM_PROMPT,
      user: buildLlmUserPrompt(question, parts),
    },
  };
}
