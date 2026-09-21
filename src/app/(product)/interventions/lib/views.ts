// Capability, workforce & agent interventions (W063) — the view builders.
//
// Server-side composition of EXISTING module contracts only (lock 31/32:
// contracts, never persistence — no second source of organizational
// truth). The surface composes plan §2 Journey I end to end:
//
//   buildInterventionsHomeView — the Interventions hub: the capability
//     gaps with their available alternatives (W017), the recruitment
//     proposals comparing acquisition alternatives (W022), the agent
//     teams with topology/budget (W023), the agent workforce (W021),
//     the workforce assessments with uncertainty and alternatives
//     (W019), the automation candidates (W018 — the outsource side of
//     the vocabulary), and the outcome tracking rollup (W040), plus the
//     derived seven-word comparison coverage (train/reassign/hire/
//     automate/recruit/install/outsource).
//   buildProposalView    — one proposal's full comparison, approval
//     trail and activation affordance.
//   buildTeamView        — one team's topology, budget, escalation,
//     version audit and outcome timeline.
//   buildAgentView       — one agent's evaluation (the six measured
//     dimensions), lifecycle decisions (retain/modify/terminate) and
//     tied outcomes.
//
// Honesty rules (the learning surface's discipline):
//   * a FAILING read renders an empty section plus a `degraded` note —
//     never fake emptiness, never a crash;
//   * a MISSING record throws the owning contract's not-found error for
//     the page to render its honest not-found state;
//   * nothing here is persisted (lock 34) — views are derived, the
//     contracts own the truth; uncertainty (confidence, alternative
//     explanations, evidence citations) is carried INTO the rows, never
//     summarized away.
//
// Tenancy (ADR-0001): every builder takes the EXPLICIT TenantContext;
// another tenant's records read as missing (the contracts' own
// `*_not_found` — no existence leak, no scope parameter in any URL).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { analyzeGaps } from '@/modules/capabilities/contract';
import type { CapabilityGap, GapStatus } from '@/modules/capabilities/contract';
import {
  alternativesInCanonicalOrder,
  getRecruitmentProposal,
  listRecruitmentProposals,
} from '@/modules/agent-recruitment/contract';
import type {
  AgentRecruitmentProposal,
  RecruitmentAlternative,
  RecruitmentProposalStatus,
} from '@/modules/agent-recruitment/contract';
import {
  getTeam,
  listTeamOutcomes,
  listTeams,
  listTeamVersions,
} from '@/modules/agent-teams/contract';
import type {
  OutcomeAssessment,
  Team,
  TeamOutcome,
  TeamStatus,
  TeamTopology,
  TeamVersion,
} from '@/modules/agent-teams/contract';
import { getAgent, listAgents } from '@/modules/agents/contract';
import type { AgentDefinition, AgentStatus } from '@/modules/agents/contract';
import {
  listAgentEvaluations,
  listAgentLifecycleDecisions,
} from '@/modules/agent-evaluation/contract';
import type {
  AgentDecisionStatus,
  AgentEvaluation,
  AgentLifecycleChange,
  AgentLifecycleDecision,
  AgentReplacementKind,
} from '@/modules/agent-evaluation/contract';
import { ALTERNATIVE_KINDS, listAssessments } from '@/modules/workforce/contract';
import type { RecommendationKind, WorkforceAssessment } from '@/modules/workforce/contract';
import { listOpportunities } from '@/modules/automation/contract';
import type {
  AutomationOpportunity,
  AutomationSolutionType,
  AutomationStatus,
} from '@/modules/automation/contract';
import { listOutcomes, summarizeRealization } from '@/modules/learning/contract';
import type {
  Outcome,
  OutcomeAssessment as LearningAssessmentWord,
  OutcomeStatus,
  RealizationBucket,
} from '@/modules/learning/contract';
import { ALTERNATIVE_VOCABULARY } from './labels';
import type { VocabularyWord } from './labels';

/** The workforce alternative kind (derived from the contract's closed list). */
type WorkforceAlternativeKind = (typeof ALTERNATIVE_KINDS)[number];

// ---------------------------------------------------------------------------
// Row shapes (serialized server → page; labels resolved at render)
// ---------------------------------------------------------------------------

/** How many rows each hub list carries (the surface stays calm). */
export const HOME_ROW_LIMIT = 8;

/** One capability gap with its available alternatives. */
export interface GapRow {
  capabilityId: string;
  name: string;
  status: GapStatus;
  unmetCount: number;
  activeRequirementCount: number;
  activeSupplyCount: number;
  bestActiveLevel: number | null;
  totalActiveCapacity: number;
  /** Active supplies per supplier kind (the six supply channels). */
  activeByKind: Record<string, number>;
}

/** One recruitment proposal (the comparison summary). */
export interface ProposalRow {
  id: string;
  title: string;
  status: RecruitmentProposalStatus;
  recommendedKind: string | null;
  capabilityName: string;
  /** The compared alternative kinds, canonical order. */
  alternativeKinds: string[];
  awaitingDecision: boolean;
  createdBy: string;
  updatedAt: string;
}

/** One agent team (the topology/budget summary). */
export interface TeamRow {
  id: string;
  slug: string;
  displayName: string | null;
  status: TeamStatus;
  topology: TeamTopology;
  memberCount: number;
  objectiveCount: number;
  budget: { amountMinor: number; currency: string };
  version: number;
  updatedAt: string;
}

/** One agent of the workforce. */
export interface AgentRow {
  id: string;
  slug: string;
  displayName: string | null;
  role: string;
  status: string;
  provider: string;
  permissions: string[];
}

/** One workforce assessment (uncertainty carried, never summarized away). */
export interface AssessmentRow {
  id: string;
  employeeLabel: string | null;
  version: number;
  recommendationKind: RecommendationKind;
  recommendationText: string;
  employmentImpacting: boolean;
  /** The assessment's own confidence in [0, 1]. */
  confidence: number;
  /** The alternative explanations that remain open. */
  alternativeExplanations: string[];
  /** The alternatives (each: kind + description). */
  alternatives: { kind: WorkforceAlternativeKind; description: string }[];
  evidenceObservationIds: string[];
  decision: { kind: string; decidedAt: string } | null;
  decisionCount: number;
  updatedAt: string;
}

/** One automation opportunity (the outsource-bearing vocabulary). */
export interface AutomationRow {
  id: string;
  name: string;
  status: AutomationStatus;
  processName: string;
  solutionTypes: AutomationSolutionType[];
  expectedNetBenefitMinor: number;
  currency: string;
  measurementCount: number;
  targetMet: boolean | null;
}

/** One tracked outcome (expected versus realized). */
export interface OutcomeRow {
  id: string;
  metricName: string;
  metricUnit: string;
  status: OutcomeStatus;
  expected: number;
  realized: number | null;
  assessment: LearningAssessmentWord | null;
  subjectLabel: string | null;
  createdAt: string;
}

/** One word of the acquisition vocabulary with its comparison coverage. */
export interface VocabularyCoverageRow {
  word: string;
  label: string;
  proposalCount: number;
  automationCount: number;
  workforceCount: number;
  total: number;
}

/** The hub view (the /interventions page's props). */
export interface InterventionsHomeView {
  generatedAt: string;
  gaps: GapRow[];
  proposals: ProposalRow[];
  teams: TeamRow[];
  agents: AgentRow[];
  assessments: AssessmentRow[];
  opportunities: AutomationRow[];
  outcomes: OutcomeRow[];
  /** The expected-versus-realized rollup over agent-subject outcomes. */
  outcomeSummary: RealizationBucket | null;
  vocabulary: VocabularyCoverageRow[];
  degraded: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One bounded failed read → an empty section + a degraded note. */
async function safe<T>(
  family: string,
  degraded: string[],
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

function clip(text: string, bound: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= bound ? flat : `${flat.slice(0, bound - 1)}…`;
}

// ---------------------------------------------------------------------------
// The seven-word comparison coverage (pure — the unit-test seam)
// ---------------------------------------------------------------------------

/**
 * Where each of the seven acquisition words (train/reassign/hire/
 * automate/recruit/install/outsource) is currently being compared:
 * proposals comparing the kind, automation candidates naming the
 * solution type, workforce assessments listing the alternative. The
 * counts are over the row sets the hub already loaded — derived, never
 * persisted, recomputed on every read (lock 10).
 */
export function vocabularyCoverage(
  proposals: readonly { alternatives: readonly { kind: string }[] }[],
  opportunities: readonly { solutionTypes: readonly string[] }[],
  assessments: readonly { content: { alternatives: readonly { kind: string }[] } }[],
): VocabularyCoverageRow[] {
  return ALTERNATIVE_VOCABULARY.map((entry: VocabularyWord) => {
    const proposalCount = proposals.filter((proposal) =>
      proposal.alternatives.some((alternative) =>
        entry.recruitmentKinds.includes(alternative.kind),
      ),
    ).length;
    const automationCount = opportunities.filter((opportunity) =>
      opportunity.solutionTypes.some((kind) => entry.solutionTypes.includes(kind as never)),
    ).length;
    const workforceCount = assessments.filter((assessment) =>
      assessment.content.alternatives.some((alternative) =>
        entry.workforceKinds.includes(alternative.kind),
      ),
    ).length;
    return {
      word: entry.word,
      label: entry.label,
      proposalCount,
      automationCount,
      workforceCount,
      total: proposalCount + automationCount + workforceCount,
    };
  });
}

// ---------------------------------------------------------------------------
// Row mappers (pure — the unit-test seam)
// ---------------------------------------------------------------------------

function toGapRow(gap: CapabilityGap): GapRow {
  return {
    capabilityId: gap.capability.id,
    name: gap.capability.name,
    status: gap.status,
    unmetCount: gap.unmet.length,
    activeRequirementCount: gap.activeRequirementCount,
    activeSupplyCount: gap.activeSupplyCount,
    bestActiveLevel: gap.bestActiveLevel,
    totalActiveCapacity: gap.totalActiveCapacity,
    activeByKind: gap.alternatives.activeByKind,
  };
}

function toProposalRow(proposal: AgentRecruitmentProposal): ProposalRow {
  return {
    id: proposal.id,
    title: clip(proposal.title, 160),
    status: proposal.status,
    recommendedKind: proposal.recommendation?.kind ?? null,
    capabilityName: proposal.capability.capabilityName,
    alternativeKinds: alternativesInCanonicalOrder(proposal.alternatives).map(
      (alternative) => alternative.kind,
    ),
    awaitingDecision: proposal.status === 'awaiting_approval',
    createdBy: proposal.createdBy,
    updatedAt: proposal.updatedAt,
  };
}

function toTeamRow(team: Team): TeamRow {
  return {
    id: team.id,
    slug: team.slug,
    displayName: team.content.displayName,
    status: team.status,
    topology: team.content.topology,
    memberCount: team.content.members.length,
    objectiveCount: team.content.objectives.length,
    budget: { amountMinor: team.content.budget.amountMinor, currency: team.content.budget.currency },
    version: team.version,
    updatedAt: team.updatedAt,
  };
}

function toAgentRow(agent: AgentDefinition): AgentRow {
  return {
    id: agent.id,
    slug: agent.slug,
    displayName: agent.displayName,
    role: agent.role,
    status: agent.status,
    provider: agent.provider,
    permissions: agent.permissions,
  };
}

function toAssessmentRow(assessment: WorkforceAssessment): AssessmentRow {
  const content = assessment.content;
  return {
    id: assessment.id,
    employeeLabel: assessment.employee.label,
    version: assessment.version,
    recommendationKind: content.recommendation.kind,
    recommendationText: clip(content.recommendation.text, 320),
    employmentImpacting: content.recommendation.employmentImpacting,
    confidence: content.confidence,
    alternativeExplanations: content.alternativeExplanations.map((explanation) =>
      clip(explanation.text, 240),
    ),
    alternatives: content.alternatives.map((alternative) => ({
      kind: alternative.kind,
      description: clip(alternative.description, 240),
    })),
    evidenceObservationIds: content.evidenceObservationIds,
    decision:
      assessment.decision === null
        ? null
        : { kind: assessment.decision.decision, decidedAt: assessment.decision.decidedAt },
    decisionCount: assessment.decisionCount,
    updatedAt: assessment.updatedAt,
  };
}

function toAutomationRow(opportunity: AutomationOpportunity): AutomationRow {
  return {
    id: opportunity.id,
    name: opportunity.name,
    status: opportunity.status,
    processName: opportunity.process.name,
    solutionTypes: opportunity.solutionTypes,
    expectedNetBenefitMinor: opportunity.expectedRoi.expectedNetBenefitMinor,
    currency: opportunity.currency,
    measurementCount: opportunity.outcomeMeasurements.measurementCount,
    targetMet:
      opportunity.outcomeMeasurements.progress === null
        ? null
        : opportunity.outcomeMeasurements.progress.targetMet,
  };
}

function toOutcomeRow(outcome: Outcome, subjectLabel: string | null): OutcomeRow {
  return {
    id: outcome.id,
    metricName: outcome.metricName,
    metricUnit: outcome.metricUnit,
    status: outcome.status,
    expected: outcome.expected,
    realized: outcome.realization === null ? null : outcome.realization.realizedValue,
    assessment: outcome.realization === null ? null : outcome.realization.assessment,
    subjectLabel,
    createdAt: outcome.createdAt,
  };
}

// ---------------------------------------------------------------------------
// buildInterventionsHomeView
// ---------------------------------------------------------------------------

/** Build the Interventions hub view. */
export async function buildInterventionsHomeView(ctx: TenantContext): Promise<InterventionsHomeView> {
  const degraded: string[] = [];

  const [gaps, proposals, teams, agents, assessments, opportunities, outcomes, outcomeSummaryRead] =
    await Promise.all([
      safe('capabilities', degraded, () => analyzeGaps(ctx, { limit: 100 })),
      safe('agent-recruitment', degraded, () => listRecruitmentProposals(ctx, { limit: 24 })),
      safe('agent-teams', degraded, () => listTeams(ctx, {})),
      safe('agents', degraded, () => listAgents(ctx, {})),
      safe('workforce', degraded, () => listAssessments(ctx, { limit: 24 })),
      safe('automation', degraded, () => listOpportunities(ctx, { limit: 24 })),
      safe('outcomes', degraded, () => listOutcomes(ctx, { subjectKind: 'agent', limit: 24 })),
      safe('outcomes', degraded, () => summarizeRealization(ctx, { subjectKind: 'agent' })),
    ]);

  const gapRows = (gaps ?? []).map(toGapRow);
  // The uncovered and shortfall gaps first — the intervention surface's
  // own honest ordering (never persisted, recomputed per read).
  gapRows.sort((left, right) => {
    const rank: Record<string, number> = {
      uncovered: 0,
      level_shortfall: 1,
      capacity_shortfall: 2,
      covered: 3,
    };
    return (rank[left.status] ?? 9) - (rank[right.status] ?? 9) || left.name.localeCompare(right.name);
  });

  const agentRows = (agents ?? []).map(toAgentRow);
  const slugById = new Map(agentRows.map((agent) => [agent.id, agent.slug]));

  const outcomeRows = (outcomes ?? []).map((outcome) =>
    toOutcomeRow(outcome, slugById.get(outcome.subject.id) ?? outcome.subject.label ?? null),
  );

  return {
    generatedAt: now().toISOString(),
    gaps: gapRows.slice(0, HOME_ROW_LIMIT),
    proposals: (proposals ?? []).map(toProposalRow).slice(0, HOME_ROW_LIMIT),
    teams: (teams ?? []).map(toTeamRow).slice(0, HOME_ROW_LIMIT),
    agents: agentRows.slice(0, HOME_ROW_LIMIT),
    assessments: (assessments ?? []).map(toAssessmentRow).slice(0, HOME_ROW_LIMIT),
    opportunities: (opportunities ?? []).map(toAutomationRow).slice(0, HOME_ROW_LIMIT),
    outcomes: outcomeRows.slice(0, HOME_ROW_LIMIT),
    outcomeSummary:
      outcomeSummaryRead === null
        ? null
        : outcomeSummaryRead.bySubjectKind.agent ?? outcomeSummaryRead.overall,
    vocabulary: vocabularyCoverage(proposals ?? [], opportunities ?? [], assessments ?? []),
    degraded: [...new Set(degraded)],
  };
}

// ---------------------------------------------------------------------------
// buildProposalView
// ---------------------------------------------------------------------------

/** One compared alternative (the proposal detail's row). */
export interface ProposalAlternativeRow {
  id: string;
  kind: string;
  summary: string;
  note: string | null;
  estimatedCostMinor: number | null;
  estimatedCostCurrency: string | null;
  estimatedWeeks: number | null;
  expectedLevel: number | null;
  expectedCapacity: number | null;
  recommended: boolean;
  agentPermissions: string[] | null;
  impliedAuthorityLevel: string | null;
}

/** The proposal detail view (the comparison + approval + activation). */
export interface ProposalView {
  generatedAt: string;
  proposal: {
    id: string;
    title: string;
    status: RecruitmentProposalStatus;
    rationale: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    capability: {
      id: string;
      name: string;
      status: string;
      gapStatus: string | null;
      bestActiveLevel: number | null;
      totalActiveCapacity: number | null;
    };
    evidenceObservationIds: string[];
    approval: {
      actionRequestId: string | null;
      policyOutcome: string | null;
      policyResolvedVia: string | null;
      submittedBy: string | null;
      submittedAt: string | null;
      decidedBy: string | null;
      decidedByPrincipal: string | null;
      decidedAt: string | null;
    };
    withdrawnAt: string | null;
    withdrawalReason: string | null;
  };
  alternatives: ProposalAlternativeRow[];
  /** Whether the activation affordance is available, and why/why not. */
  activation: {
    available: boolean;
    reason: string;
    recruitKindPresent: boolean;
    defaultPermissions: string[];
    suggestedSlug: string;
    suggestedRole: string;
    suggestedInstructions: string;
  };
}

function toAlternativeRow(alternative: RecruitmentAlternative): ProposalAlternativeRow {
  return {
    id: alternative.id,
    kind: alternative.kind,
    summary: clip(alternative.summary, 400),
    note: alternative.note === null ? null : clip(alternative.note, 300),
    estimatedCostMinor: alternative.estimatedCostMinor,
    estimatedCostCurrency: alternative.estimatedCostCurrency,
    estimatedWeeks: alternative.estimatedWeeks,
    expectedLevel: alternative.expectedLevel,
    expectedCapacity: alternative.expectedCapacity,
    recommended: alternative.recommended,
    agentPermissions: alternative.agentPermissions,
    impliedAuthorityLevel: alternative.impliedAuthorityLevel,
  };
}

/** Derive the activation affordance's suggested slug from a title. */
export function suggestedSlugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug === '' ? 'recruited-agent' : slug;
}

/** Build one proposal's full view (the owning read throws not-found). */
export async function buildProposalView(
  ctx: TenantContext,
  proposalId: string,
): Promise<ProposalView> {
  const proposal = await getRecruitmentProposal(ctx, { proposalId });
  const alternatives = alternativesInCanonicalOrder(proposal.alternatives);
  const recruit = alternatives.find((alternative) => alternative.kind === 'recruit') ?? null;

  let activationReason: string;
  if (proposal.status !== 'approved') {
    activationReason =
      proposal.status === 'awaiting_approval'
        ? 'the proposal waits at the approval gate — decide it first'
        : 'activation follows an approved proposal; this one is not approved';
  } else if (recruit === null) {
    activationReason =
      'this proposal compares no agent recruitment — its approved alternative activates elsewhere (training, hiring, automation or an install)';
  } else {
    activationReason =
      'the approved comparison carries a recruit alternative — activate it by registering the agent';
  }

  return {
    generatedAt: now().toISOString(),
    proposal: {
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      rationale: clip(proposal.rationale, 2000),
      createdBy: proposal.createdBy,
      createdAt: proposal.createdAt,
      updatedAt: proposal.updatedAt,
      capability: {
        id: proposal.capability.capabilityId,
        name: proposal.capability.capabilityName,
        status: proposal.capability.capabilityStatus,
        gapStatus: proposal.capability.gapStatus,
        bestActiveLevel: proposal.capability.bestActiveLevel,
        totalActiveCapacity: proposal.capability.totalActiveCapacity,
      },
      evidenceObservationIds: proposal.evidenceObservationIds,
      approval: {
        actionRequestId: proposal.approval.actionRequestId,
        policyOutcome: proposal.approval.policyOutcome,
        policyResolvedVia: proposal.approval.policyResolvedVia,
        submittedBy: proposal.approval.submittedBy,
        submittedAt: proposal.approval.submittedAt,
        decidedBy: proposal.approval.decidedBy,
        decidedByPrincipal: proposal.approval.decidedByPrincipal,
        decidedAt: proposal.approval.decidedAt,
      },
      withdrawnAt: proposal.withdrawnAt,
      withdrawalReason: proposal.withdrawalReason,
    },
    alternatives: alternatives.map(toAlternativeRow),
    activation: {
      available: proposal.status === 'approved' && recruit !== null,
      reason: activationReason,
      recruitKindPresent: recruit !== null,
      defaultPermissions: recruit?.agentPermissions ?? [],
      suggestedSlug: suggestedSlugOf(proposal.title),
      suggestedRole: clip(
        recruit === null ? proposal.title : recruit.summary,
        120,
      ),
      suggestedInstructions: `Act on the approved recruitment proposal '${proposal.title}': ${clip(
        proposal.rationale,
        1200,
      )}`,
    },
  };
}

// ---------------------------------------------------------------------------
// buildTeamView
// ---------------------------------------------------------------------------

/** One roster member with its agent resolved. */
export interface TeamMemberRow {
  agentId: string;
  agentSlug: string | null;
  agentStatus: AgentStatus | null;
  role: string;
  reportsTo: string | null;
}

/** One team-level outcome (the outcome tracking timeline's row). */
export interface TeamOutcomeRow {
  id: string;
  headline: string;
  detail: string | null;
  assessment: OutcomeAssessment;
  objectiveKey: string | null;
  evidenceCount: number;
  recordedByPrincipal: string;
  recordedAt: string;
}

/** One version of the team's audit chain. */
export interface TeamVersionRow {
  id: string;
  version: number;
  changeKind: string;
  status: TeamStatus;
  rationale: string | null;
  actionRequestId: string | null;
  recordedAt: string;
}

/** The team detail view (topology/budget + lifecycle + outcomes). */
export interface TeamView {
  generatedAt: string;
  team: {
    id: string;
    slug: string;
    displayName: string | null;
    description: string | null;
    status: TeamStatus;
    topology: TeamTopology;
    version: number;
    createdAt: string;
    updatedAt: string;
    lastChangeKind: string;
    lastChangeRequestId: string | null;
    ownerPrincipal: string | null;
  };
  members: TeamMemberRow[];
  objectives: { key: string; objective: string; successCriteria: string | null }[];
  budget: { amountMinor: number; currency: string };
  escalationRules: { trigger: string; threshold: number | null; route: string }[];
  outcomes: TeamOutcomeRow[];
  versions: TeamVersionRow[];
  degraded: string[];
}

function toTeamOutcomeRow(outcome: TeamOutcome): TeamOutcomeRow {
  return {
    id: outcome.id,
    headline: clip(outcome.headline, 240),
    detail: outcome.detail === null ? null : clip(outcome.detail, 400),
    assessment: outcome.assessment,
    objectiveKey: outcome.objectiveKey,
    evidenceCount: outcome.evidence.length,
    recordedByPrincipal: outcome.recordedByPrincipal,
    recordedAt: outcome.recordedAt,
  };
}

function toTeamVersionRow(version: TeamVersion): TeamVersionRow {
  return {
    id: version.id,
    version: version.version,
    changeKind: version.changeKind,
    status: version.status,
    rationale: version.rationale === null ? null : clip(version.rationale, 240),
    actionRequestId: version.actionRequestId,
    recordedAt: version.recordedAt,
  };
}

/** Build one team's full view (the owning read throws not-found). */
export async function buildTeamView(ctx: TenantContext, teamId: string): Promise<TeamView> {
  const degraded: string[] = [];
  const team = await getTeam(ctx, { teamId });

  const [agents, outcomes, versions] = await Promise.all([
    safe('agents', degraded, () => listAgents(ctx, {})),
    safe('agent-teams', degraded, () => listTeamOutcomes(ctx, { teamId })),
    safe('agent-teams', degraded, () => listTeamVersions(ctx, { teamId })),
  ]);

  const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  const members: TeamMemberRow[] = team.content.members.map((member) => {
    const agent = agentById.get(member.agentId) ?? null;
    return {
      agentId: member.agentId,
      agentSlug: agent?.slug ?? null,
      agentStatus: agent?.status ?? null,
      role: clip(member.role, 128),
      reportsTo: member.reportsTo,
    };
  });

  return {
    generatedAt: now().toISOString(),
    team: {
      id: team.id,
      slug: team.slug,
      displayName: team.content.displayName,
      description:
        team.content.description === null ? null : clip(team.content.description, 600),
      status: team.status,
      topology: team.content.topology,
      version: team.version,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      lastChangeKind: team.lastChange.kind,
      lastChangeRequestId: team.lastChange.actionRequestId,
      ownerPrincipal: team.content.ownerPrincipal,
    },
    members,
    objectives: team.content.objectives.map((objective) => ({
      key: objective.key,
      objective: clip(objective.objective, 400),
      successCriteria:
        objective.successCriteria === null ? null : clip(objective.successCriteria, 400),
    })),
    budget: { amountMinor: team.content.budget.amountMinor, currency: team.content.budget.currency },
    escalationRules: team.content.escalationRules.map((rule) => ({
      trigger: rule.trigger,
      threshold: rule.threshold,
      route: rule.route,
    })),
    outcomes: (outcomes ?? []).map(toTeamOutcomeRow),
    versions: (versions ?? []).map(toTeamVersionRow),
    degraded: [...new Set(degraded)],
  };
}

// ---------------------------------------------------------------------------
// buildAgentView
// ---------------------------------------------------------------------------

/** The six measured dimensions of one evaluation (the honest numbers). */
export interface EvaluationRow {
  id: string;
  recordedAt: string;
  windowFrom: string;
  windowTo: string;
  agentSnapshot: { slug: string; role: string; provider: string; status: string };
  outcome: {
    outcomesTotal: number;
    open: number;
    settled: number;
    abandoned: number;
    met: number;
    exceeded: number;
    missed: number;
    netVarianceVsExpected: number;
  };
  cost: {
    executionsIncluded: number;
    executionsTruncated: boolean;
    totalCostMinor: number;
    costCurrency: string;
    costPerSucceededMinor: number | null;
    attemptsIncluded: number;
  };
  quality: {
    succeeded: number;
    failed: number;
    refused: number;
    cancelled: number;
    successRate: number | null;
    averageLatencyMs: number | null;
  };
  utilization: {
    submissions: number;
    live: number;
    distinctPrincipals: number;
    distinctActiveDays: number;
    submissionsPerDay: number;
  };
  security: {
    grantedPermissions: string[];
    overGrantedScopes: string[];
    approvalGated: number;
    policyRefusals: number;
    findingsCount: number;
  };
  replacementOptions: {
    id: string;
    kind: AgentReplacementKind;
    summary: string;
    estimatedCostMinor: number | null;
    estimatedCostCurrency: string | null;
    estimatedWeeks: number | null;
    recommended: boolean;
    costDeltaMinor: number | null;
  }[];
}

/** One lifecycle decision (retain/modify/terminate) on the agent. */
export interface AgentDecisionRow {
  id: string;
  change: AgentLifecycleChange;
  rationale: string;
  note: string | null;
  modificationSummary: string | null;
  status: AgentDecisionStatus;
  actionRequestId: string | null;
  appliedAt: string | null;
  recordedAt: string;
}

/** The agent detail view (evaluation + lifecycle + outcomes). */
export interface AgentView {
  generatedAt: string;
  agent: AgentRow;
  evaluation: EvaluationRow | null;
  decisions: AgentDecisionRow[];
  outcomes: OutcomeRow[];
  degraded: string[];
}

function toEvaluationRow(evaluation: AgentEvaluation): EvaluationRow {
  return {
    id: evaluation.id,
    recordedAt: evaluation.recordedAt,
    windowFrom: evaluation.windowFrom,
    windowTo: evaluation.windowTo,
    agentSnapshot: {
      slug: evaluation.agent.slug,
      role: evaluation.agent.role,
      provider: evaluation.agent.provider,
      status: evaluation.agent.status,
    },
    outcome: {
      outcomesTotal: evaluation.outcome.outcomesTotal,
      open: evaluation.outcome.open,
      settled: evaluation.outcome.settled,
      abandoned: evaluation.outcome.abandoned,
      met: evaluation.outcome.met,
      exceeded: evaluation.outcome.exceeded,
      missed: evaluation.outcome.missed,
      netVarianceVsExpected: evaluation.outcome.netVarianceVsExpected,
    },
    cost: {
      executionsIncluded: evaluation.cost.executionsIncluded,
      executionsTruncated: evaluation.cost.executionsTruncated,
      totalCostMinor: evaluation.cost.totalCostMinor,
      costCurrency: evaluation.cost.costCurrency,
      costPerSucceededMinor: evaluation.cost.costPerSucceededMinor,
      attemptsIncluded: evaluation.cost.attemptsIncluded,
    },
    quality: {
      succeeded: evaluation.quality.succeeded,
      failed: evaluation.quality.failed,
      refused: evaluation.quality.refused,
      cancelled: evaluation.quality.cancelled,
      successRate: evaluation.quality.successRate,
      averageLatencyMs: evaluation.quality.averageLatencyMs,
    },
    utilization: {
      submissions: evaluation.utilization.submissions,
      live: evaluation.utilization.live,
      distinctPrincipals: evaluation.utilization.distinctPrincipals,
      distinctActiveDays: evaluation.utilization.distinctActiveDays,
      submissionsPerDay: evaluation.utilization.submissionsPerDay,
    },
    security: {
      grantedPermissions: evaluation.security.grantedPermissions,
      overGrantedScopes: evaluation.security.overGrantedScopes,
      approvalGated: evaluation.security.approvalGated,
      policyRefusals: evaluation.security.policyRefusals,
      findingsCount: evaluation.security.findings.length,
    },
    replacementOptions: evaluation.replacementOptions.map((option) => ({
      id: option.id,
      kind: option.kind,
      summary: clip(option.summary, 240),
      estimatedCostMinor: option.estimatedCostMinor,
      estimatedCostCurrency: option.estimatedCostCurrency,
      estimatedWeeks: option.estimatedWeeks,
      recommended: option.recommended,
      costDeltaMinor: option.costDeltaMinor,
    })),
  };
}

function toAgentDecisionRow(decision: AgentLifecycleDecision): AgentDecisionRow {
  return {
    id: decision.id,
    change: decision.change,
    rationale: clip(decision.rationale, 400),
    note: decision.note === null ? null : clip(decision.note, 300),
    modificationSummary:
      decision.modificationSummary === null ? null : clip(decision.modificationSummary, 300),
    status: decision.status,
    actionRequestId: decision.policy === null ? null : decision.policy.actionRequestId,
    appliedAt: decision.appliedAt,
    recordedAt: decision.recordedAt,
  };
}

/** Build one agent's full view (the owning read throws not-found). */
export async function buildAgentView(ctx: TenantContext, agentId: string): Promise<AgentView> {
  const degraded: string[] = [];
  const agent = await getAgent(ctx, { agentId });

  const [evaluations, decisions, outcomes] = await Promise.all([
    safe('agent-evaluation', degraded, () => listAgentEvaluations(ctx, { agentId, limit: 3 })),
    safe('agent-evaluation', degraded, () =>
      listAgentLifecycleDecisions(ctx, { agentId, limit: 12 }),
    ),
    safe('outcomes', degraded, () =>
      listOutcomes(ctx, { subjectKind: 'agent', subjectId: agentId, limit: 12 }),
    ),
  ]);

  const evaluationRows = (evaluations ?? []).map(toEvaluationRow);
  const slug = agent.slug;

  return {
    generatedAt: now().toISOString(),
    agent: toAgentRow(agent),
    evaluation: evaluationRows.length === 0 ? null : evaluationRows[0]!,
    decisions: (decisions ?? []).map(toAgentDecisionRow),
    outcomes: (outcomes ?? []).map((outcome) => toOutcomeRow(outcome, slug)),
    degraded: [...new Set(degraded)],
  };
}
