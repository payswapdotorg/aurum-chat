// Capability, workforce & agent interventions (W063) — the pure
// labeling/formatting vocabulary of the surface (the learning surface's
// labels.ts discipline). Server-rendered only: contract vocabularies are
// imported for the closed word lists (the client components take their
// option copy from lib/form.ts, which imports nothing).
//
// Color never carries meaning alone: every status renders a tone PAIRED
// with its human label (and an sr-only tone word from the shell's pill).
// The three always-visible policy notes at the bottom are the
// acceptance's honesty clauses in product copy:
//   * HUMAN_AUTHORIZED_NOTE  — "human employment decisions remain
//     human-authorized" (lock 20/21);
//   * UNCERTAINTY_NOTE       — "explicit uncertainty and evidence" (the
//     assessments' confidence, alternative explanations and evidence
//     citations are rendered, never summarized away);
//   * GATE_NOTE              — the authority gate's separation of duties
//     (the requester never decides their own request).

import type { PillTone } from '../../lib/states';
import { ALTERNATIVE_KINDS } from '@/modules/workforce/contract';
import type { RecruitmentProposalStatus } from '@/modules/agent-recruitment/contract';
import type { AutomationSolutionType, AutomationStatus } from '@/modules/automation/contract';
import type {
  RecommendationKind,
  WorkforceDecisionKind,
} from '@/modules/workforce/contract';
import type {
  AgentDecisionStatus,
  AgentLifecycleChange,
  AgentReplacementKind,
} from '@/modules/agent-evaluation/contract';
import type { AgentStatus } from '@/modules/agents/contract';
import type {
  OutcomeAssessment,
  TeamStatus,
  TeamTopology,
} from '@/modules/agent-teams/contract';
import type { GapStatus } from '@/modules/capabilities/contract';
import type {
  OutcomeAssessment as LearningAssessment,
  OutcomeStatus,
} from '@/modules/learning/contract';

/** The workforce alternative kind (derived from the contract's closed list). */
type WorkforceAlternativeKind = (typeof ALTERNATIVE_KINDS)[number];

// ---------------------------------------------------------------------------
// Formatting (shared with every row)
// ---------------------------------------------------------------------------

/** Integer minor units + ISO currency → calm money copy. */
export function moneyLabel(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

/** A [0, 1] fraction → whole-percent copy. */
export function percentLabel(value: number): string {
  return `${Math.round(value * 100).toFixed(0)}%`;
}

/** An ISO timestamp → quiet date copy (invalid values pass through). */
export function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Weeks-to-impact copy (null → the honest unknown). */
export function weeksLabel(weeks: number | null): string {
  return weeks === null ? 'unknown timeline' : `${weeks} week${weeks === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// The acquisition vocabulary (the acceptance's seven compared words)
// ---------------------------------------------------------------------------

/**
 * The seven acquisition alternatives the work item names verbatim —
 * "compare train/reassign/hire/automate/recruit/install/outsource".
 * Each word declares the module vocabularies that can carry it, so the
 * hub's comparison panel can say WHERE each alternative is currently
 * being compared (the frozen §13 chain's option layer, never a new
 * taxonomy).
 */
export interface VocabularyWord {
  word: 'train' | 'reassign' | 'hire' | 'automate' | 'recruit' | 'install' | 'outsource';
  label: string;
  /** The agent-recruitment alternative kinds mapping to this word. */
  recruitmentKinds: string[];
  /** The automation solution types mapping to this word. */
  solutionTypes: AutomationSolutionType[];
  /** The workforce assessment alternative kinds mapping to this word. */
  workforceKinds: string[];
}

export const ALTERNATIVE_VOCABULARY: readonly VocabularyWord[] = [
  {
    word: 'train',
    label: 'Train',
    recruitmentKinds: ['train'],
    solutionTypes: ['train_employee'],
    workforceKinds: ['train'],
  },
  {
    word: 'reassign',
    label: 'Reassign',
    recruitmentKinds: ['reassign'],
    solutionTypes: ['reassign_work'],
    workforceKinds: ['reassign', 'redistribute_work'],
  },
  {
    word: 'hire',
    label: 'Hire',
    recruitmentKinds: ['hire'],
    solutionTypes: ['hire_human'],
    workforceKinds: ['hire'],
  },
  {
    word: 'automate',
    label: 'Automate',
    recruitmentKinds: ['automate'],
    solutionTypes: [],
    workforceKinds: ['automation'],
  },
  {
    word: 'recruit',
    label: 'Recruit an agent',
    recruitmentKinds: ['recruit'],
    solutionTypes: ['recruit_agent', 'recruit_agent_team'],
    workforceKinds: ['recruit_agent'],
  },
  {
    word: 'install',
    label: 'Install',
    recruitmentKinds: ['install'],
    solutionTypes: ['install_extension'],
    workforceKinds: ['install_software'],
  },
  {
    word: 'outsource',
    label: 'Outsource',
    recruitmentKinds: [],
    solutionTypes: ['outsource'],
    workforceKinds: ['outsource'],
  },
];

/** Where the outsource word lives (the honest note for the one kind the
 *  recruitment comparison's closed vocabulary does not carry). */
export const OUTSOURCE_SOURCES_NOTE =
  'Outsourcing is compared where the architecture compares it — automation candidates and workforce alternatives carry the word; a recruitment proposal’s own comparison is the six channel kinds the agent-recruitment contract froze.';

// ---------------------------------------------------------------------------
// Recruitment proposals (W022)
// ---------------------------------------------------------------------------

export function proposalStatusTone(status: RecruitmentProposalStatus): PillTone {
  switch (status) {
    case 'awaiting_approval':
      return 'warning';
    case 'approved':
      return 'positive';
    case 'rejected':
      return 'error';
    case 'withdrawn':
      return 'neutral';
    case 'proposed':
      return 'info';
  }
}

export function proposalStatusLabel(status: RecruitmentProposalStatus): string {
  switch (status) {
    case 'proposed':
      return 'Draft — not yet requested';
    case 'awaiting_approval':
      return 'Waiting for a human decision';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'withdrawn':
      return 'Withdrawn';
  }
}

export function proposalStatusExplanation(status: RecruitmentProposalStatus): string {
  switch (status) {
    case 'proposed':
      return 'The comparison exists but nobody has submitted it to the approval gate yet — a draft carries no authority.';
    case 'awaiting_approval':
      return 'The authority gate holds this acquisition until an authorized human approves or rejects it.';
    case 'approved':
      return 'An authorized human approved the acquisition — activation may follow through the agents module or a team.';
    case 'rejected':
      return 'An authorized human (or the tenant’s explicit policy) rejected the acquisition; the comparison is retained as evidence.';
    case 'withdrawn':
      return 'The author withdrew the draft before submission; the comparison is retained as evidence.';
  }
}

/** The recruitment alternative kinds' labels (the closed six). */
export const RECRUITMENT_KIND_LABELS: Readonly<Record<string, string>> = {
  train: 'Train an employee',
  reassign: 'Reassign work',
  hire: 'Hire human capability',
  automate: 'Automate the work',
  recruit: 'Recruit an agent',
  install: 'Install a marketplace capability',
};

/** The label of one recruitment alternative kind (closed vocabulary). */
export function alternativeKindLabel(kind: string): string {
  return RECRUITMENT_KIND_LABELS[kind] ?? kind;
}

// ---------------------------------------------------------------------------
// Capability gaps (W017)
// ---------------------------------------------------------------------------

export function gapStatusTone(status: GapStatus): PillTone {
  switch (status) {
    case 'uncovered':
      return 'error';
    case 'level_shortfall':
      return 'warning';
    case 'capacity_shortfall':
      return 'warning';
    case 'covered':
      return 'positive';
  }
}

export function gapStatusLabel(status: GapStatus): string {
  switch (status) {
    case 'uncovered':
      return 'Uncovered';
    case 'level_shortfall':
      return 'Level shortfall';
    case 'capacity_shortfall':
      return 'Capacity shortfall';
    case 'covered':
      return 'Covered';
  }
}

export function gapStatusExplanation(status: GapStatus): string {
  switch (status) {
    case 'uncovered':
      return 'Active demand has no active supply at all — nothing currently provides this capability.';
    case 'level_shortfall':
      return 'The best active supply is weaker than a requirement demands.';
    case 'capacity_shortfall':
      return 'Declared supply capacity is smaller than a requirement demands.';
    case 'covered':
      return 'Every active requirement is met by active supply at the demanded level and capacity.';
  }
}

// ---------------------------------------------------------------------------
// Automation opportunities (W018)
// ---------------------------------------------------------------------------

export function automationStatusTone(status: AutomationStatus): PillTone {
  switch (status) {
    case 'candidate':
      return 'info';
    case 'accepted':
      return 'positive';
    case 'dismissed':
      return 'neutral';
  }
}

export function automationStatusLabel(status: AutomationStatus): string {
  switch (status) {
    case 'candidate':
      return 'Candidate';
    case 'accepted':
      return 'Accepted — prediction frozen';
    case 'dismissed':
      return 'Dismissed';
  }
}

/** The automation solution types' labels (the §13 vocabulary). */
export const SOLUTION_TYPE_LABELS: Readonly<Record<AutomationSolutionType, string>> = {
  train_employee: 'Train an employee',
  reassign_work: 'Reassign work',
  hire_human: 'Hire human capability',
  recruit_agent: 'Recruit an agent',
  recruit_agent_team: 'Recruit an agent team',
  install_extension: 'Install a marketplace extension',
  build_extension: 'Build a new extension',
  outsource: 'Outsource',
};

export function solutionTypeLabel(kind: AutomationSolutionType): string {
  return SOLUTION_TYPE_LABELS[kind];
}

// ---------------------------------------------------------------------------
// Workforce intelligence (W019) — with the lock-20/21 honesty
// ---------------------------------------------------------------------------

export function recommendationTone(kind: RecommendationKind): PillTone {
  switch (kind) {
    case 'termination':
    case 'performance_action':
      return 'error';
    case 'role_change':
      return 'warning';
    case 'training':
    case 'hire':
    case 'redistribute_work':
    case 'automation':
      return 'info';
    default:
      return 'neutral';
  }
}

export function recommendationLabel(kind: RecommendationKind): string {
  switch (kind) {
    case 'redistribute_work':
      return 'Redistribute work';
    case 'training':
      return 'Training';
    case 'hire':
      return 'Hire';
    case 'role_change':
      return 'Role change';
    case 'performance_action':
      return 'Performance action';
    case 'process_improvement':
      return 'Process improvement';
    case 'automation':
      return 'Automation';
    case 'monitor':
      return 'Monitor';
    case 'no_action':
      return 'No action';
    case 'termination':
      return 'Termination';
  }
}

/** The workforce alternatives' labels (the §13 acquisition options). */
export const WORKFORCE_ALTERNATIVE_LABELS: Readonly<Record<WorkforceAlternativeKind, string>> = {
  redistribute_work: 'Redistribute work',
  reassign: 'Reassign',
  train: 'Train',
  hire: 'Hire',
  recruit_agent: 'Recruit an agent',
  install_software: 'Install software',
  outsource: 'Outsource',
  process_improvement: 'Improve the process',
  investigate_further: 'Investigate further',
  no_change: 'No change',
};

export function workforceAlternativeLabel(kind: WorkforceAlternativeKind): string {
  return WORKFORCE_ALTERNATIVE_LABELS[kind];
}

export function workforceDecisionLabel(kind: WorkforceDecisionKind): string {
  switch (kind) {
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Rejected';
    case 'superseded':
      return 'Superseded';
    case 'more_information_needed':
      return 'More information requested';
  }
}

// ---------------------------------------------------------------------------
// Agent teams (W023)
// ---------------------------------------------------------------------------

export function teamStatusTone(status: TeamStatus): PillTone {
  switch (status) {
    case 'draft':
      return 'info';
    case 'active':
      return 'positive';
    case 'dissolved':
      return 'neutral';
  }
}

export function teamStatusLabel(status: TeamStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft — not activated';
    case 'active':
      return 'Active';
    case 'dissolved':
      return 'Dissolved';
  }
}

export function topologyLabel(topology: TeamTopology): string {
  return topology === 'flat' ? 'Flat — peers' : 'Hierarchical — reporting lines';
}

export function outcomeAssessmentTone(assessment: OutcomeAssessment): PillTone {
  switch (assessment) {
    case 'met':
      return 'positive';
    case 'partial':
      return 'warning';
    case 'missed':
      return 'error';
  }
}

export function outcomeAssessmentLabel(assessment: OutcomeAssessment): string {
  switch (assessment) {
    case 'met':
      return 'Met';
    case 'partial':
      return 'Partially met';
    case 'missed':
      return 'Missed';
  }
}

// ---------------------------------------------------------------------------
// Agent lifecycle (W021/W024)
// ---------------------------------------------------------------------------

export function agentStatusTone(status: AgentStatus): PillTone {
  return status === 'active' ? 'positive' : 'neutral';
}

export function agentStatusLabel(status: AgentStatus): string {
  return status === 'active' ? 'Active' : 'Disabled';
}

export function decisionStatusTone(status: AgentDecisionStatus): PillTone {
  switch (status) {
    case 'recorded':
      return 'positive';
    case 'awaiting_approval':
      return 'warning';
    case 'approved':
      return 'info';
    case 'applied':
      return 'positive';
    case 'refused':
      return 'error';
  }
}

export function decisionStatusLabel(status: AgentDecisionStatus): string {
  switch (status) {
    case 'recorded':
      return 'Recorded';
    case 'awaiting_approval':
      return 'Waiting for a human decision';
    case 'approved':
      return 'Approved — not yet applied';
    case 'applied':
      return 'Applied';
    case 'refused':
      return 'Refused';
  }
}

export function decisionStatusExplanation(status: AgentDecisionStatus): string {
  switch (status) {
    case 'recorded':
      return 'A retain or modify decision — recorded management evidence; the actual mutation flows through the agents module’s own claim-gated controls.';
    case 'awaiting_approval':
      return 'The termination sits at the authority gate — no agent is terminated without an explicit human decision (lock 23).';
    case 'approved':
      return 'The termination is authorized but not yet applied — the settle step applies it (the pump is idempotent and retryable).';
    case 'applied':
      return 'The termination was applied — the agent definition is disabled through the agents contract.';
    case 'refused':
      return 'The authority gate (policy or a human) refused the termination; the decision is retained as evidence.';
  }
}

export function lifecycleChangeLabel(change: AgentLifecycleChange): string {
  switch (change) {
    case 'retain':
      return 'Retain';
    case 'modify':
      return 'Modify';
    case 'terminate':
      return 'Terminate';
  }
}

/** The agent replacement kinds' labels (§13 + the three W024 postures). */
export const REPLACEMENT_KIND_LABELS: Readonly<Record<AgentReplacementKind, string>> = {
  retain: 'Retain the agent',
  modify: 'Modify the agent',
  train: 'Train a human',
  reassign: 'Reassign work',
  hire: 'Hire human capability',
  automate: 'Automate the work',
  recruit: 'Recruit another agent',
  install: 'Install a capability',
  eliminate: 'Eliminate the work',
};

export function replacementKindLabel(kind: AgentReplacementKind): string {
  return REPLACEMENT_KIND_LABELS[kind];
}

// ---------------------------------------------------------------------------
// Learning outcomes (W040)
// ---------------------------------------------------------------------------

export function outcomeStatusTone(status: OutcomeStatus): PillTone {
  switch (status) {
    case 'open':
      return 'info';
    case 'settled':
      return 'positive';
    case 'abandoned':
      return 'neutral';
  }
}

export function outcomeStatusLabel(status: OutcomeStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'settled':
      return 'Settled';
    case 'abandoned':
      return 'Abandoned';
  }
}

export function learningAssessmentLabel(assessment: LearningAssessment): string {
  switch (assessment) {
    case 'met':
      return 'Met';
    case 'exceeded':
      return 'Exceeded';
    case 'missed':
      return 'Missed';
  }
}

export function learningAssessmentTone(assessment: LearningAssessment): PillTone {
  switch (assessment) {
    case 'met':
    case 'exceeded':
      return 'positive';
    case 'missed':
      return 'error';
  }
}

// ---------------------------------------------------------------------------
// The always-visible policy notes (the acceptance's honesty clauses)
// ---------------------------------------------------------------------------

/** Lock 20/21 in product copy — the final acceptance clause. */
export const HUMAN_AUTHORIZED_NOTE =
  'Employment decisions stay human-authorized. Aurum surfaces evidence, alternative explanations and alternatives — it never autonomously terminates or disciplines a human employee, and every employment-impacting recommendation carries its uncertainty and its alternatives with it.';

/** The uncertainty/evidence clause (explicit, never summarized away). */
export const UNCERTAINTY_NOTE =
  'Every assessment on this surface carries its own uncertainty: the confidence it was computed with, the alternative explanations that remain open, and the evidence it cites. Compare alternatives with the numbers, not the colors.';

/** The authority gate's separation of duties, in product copy. */
export const GATE_NOTE =
  'The authority gate separates duties: whoever requested an intervention can never be the one who decides it. A pending request waits for a DIFFERENT authorized approver — the Approvals surface lists every open one.';
