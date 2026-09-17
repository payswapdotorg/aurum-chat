// Pure comparison/lifecycle logic of the agent-recruitment module
// (W022 — Agent Recruitment). No database, no context, no time —
// everything here is a total, deterministic function of its arguments
// (the capabilities module's gap.ts / the actions module's matrix.ts
// discipline), so downstream modules and tests can reason about the
// comparison without a database.
//
// Three concerns live here:
//
//  1. THE COMPARISON VOCABULARY — the six acquisition alternatives the
//     work item names verbatim (train/reassign/hire/automate/recruit/
//     install), their canonical order, and the deterministic extraction
//     of the recommendation (at most one alternative is `recommended`;
//     validation and a partial UNIQUE index keep it that way).
//
//  2. THE LIFECYCLE — the proposal status vocabulary, its terminal
//     partition, and the deterministic routing of a W009 gate outcome
//     onto the proposal lifecycle at submission time (the actions
//     module's `statusForOutcome` discipline):
//        allowed           → approved  (policy auto-approval — an explicit
//                                    tenant policy decision, recorded);
//        approval_required → awaiting_approval (a human decides; settle
//                                    resolves the linked request);
//        forbidden         → rejected  (policy refusal — evidence).
//
//  3. THE GATE DESCRIPTOR — the compact, bounded payload a submission
//     puts in front of the approver: what is being approved, for which
//     capability, which alternatives were compared and which one is
//     recommended (§24: the approval must be reconstructable from the
//     request alone).

// (No imports: this file is pure by design — see the header. The §20
// authority words appear only inside the gate descriptor's implied level,
// which the service derives through the agents contract.)

import type {
  RecruitmentAlternative,
  RecruitmentAlternativeKind,
  RecruitmentProposalStatus,
} from './types';

/** The six acquisition alternatives, in the work item's canonical order. */
export const RECRUITMENT_ALTERNATIVE_KINDS: readonly RecruitmentAlternativeKind[] = [
  'train',
  'reassign',
  'hire',
  'automate',
  'recruit',
  'install',
];

export function isRecruitmentAlternativeKind(
  value: unknown,
): value is RecruitmentAlternativeKind {
  return (
    typeof value === 'string' &&
    (RECRUITMENT_ALTERNATIVE_KINDS as readonly string[]).includes(value)
  );
}

/** Canonical order rank of one alternative kind (the work item's order). */
export function alternativeKindRank(kind: RecruitmentAlternativeKind): number {
  return RECRUITMENT_ALTERNATIVE_KINDS.indexOf(kind);
}

/** Deterministic comparison of two alternatives (canonical kind order). */
export function alternativeCompare(
  a: RecruitmentAlternative,
  b: RecruitmentAlternative,
): number {
  const rankA = alternativeKindRank(a.kind);
  const rankB = alternativeKindRank(b.kind);
  if (rankA !== rankB) return rankA - rankB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The alternatives of one proposal in canonical kind order (a copy). */
export function alternativesInCanonicalOrder(
  alternatives: RecruitmentAlternative[],
): RecruitmentAlternative[] {
  return [...alternatives].sort(alternativeCompare);
}

/**
 * The recommended alternative of a proposal, or null when none is.
 * Validation and the storage-level partial UNIQUE index guarantee at
 * most one `recommended` alternative exists; this function stays total
 * (and deterministic — canonical kind order breaks any tie) even for
 * hand-assembled inputs, taking the first in canonical order.
 */
export function recommendationOf(
  alternatives: readonly RecruitmentAlternative[],
): RecruitmentAlternative | null {
  let best: RecruitmentAlternative | null = null;
  for (const alternative of alternatives) {
    if (!alternative.recommended) continue;
    if (best === null || alternativeCompare(alternative, best) < 0) best = alternative;
  }
  return best;
}

/** The proposal lifecycle states. */
export const RECRUITMENT_PROPOSAL_STATUSES: readonly RecruitmentProposalStatus[] = [
  'proposed',
  'awaiting_approval',
  'approved',
  'rejected',
  'withdrawn',
];

export function isRecruitmentProposalStatus(
  value: unknown,
): value is RecruitmentProposalStatus {
  return (
    typeof value === 'string' &&
    (RECRUITMENT_PROPOSAL_STATUSES as readonly string[]).includes(value)
  );
}

/** The terminal proposal states — history from then on. */
export const RECRUITMENT_PROPOSAL_TERMINAL_STATUSES: readonly RecruitmentProposalStatus[] = [
  'approved',
  'rejected',
  'withdrawn',
];

export function isTerminalProposalStatus(status: RecruitmentProposalStatus): boolean {
  return (RECRUITMENT_PROPOSAL_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The proposal status a W009 gate outcome routes a submission onto (the
 * actions module's `statusForOutcome` discipline, applied to the
 * recruitment lifecycle):
 *  * 'allowed'           → 'approved'  — the tenant's policy explicitly
 *    allows EXECUTE of 'agent-recruitment'; the matrix records a POLICY
 *    approval decision, so the authorization is still explicit and
 *    auditable;
 *  * 'approval_required' → 'awaiting_approval' — the gate; a human
 *    decides through the actions module, `settleRecruitmentProposal`
 *    lands the decision;
 *  * 'forbidden'         → 'rejected' — the tenant's policy forbids the
 *    acquisition outright (recorded as evidence).
 */
export function statusForGateOutcome(
  outcome: 'allowed' | 'approval_required' | 'forbidden',
): RecruitmentProposalStatus {
  switch (outcome) {
    case 'allowed':
      return 'approved';
    case 'approval_required':
      return 'awaiting_approval';
    case 'forbidden':
      return 'rejected';
  }
}

/**
 * Who decided a gated request, derived from its frozen evaluation: the
 * matrix decided on its own exactly when the outcome was not
 * 'approval_required'; a gated request is always decided by a human
 * principal (the actions module records exactly one principal decision —
 * first decision wins).
 */
export function deciderForOutcome(
  outcome: 'allowed' | 'approval_required' | 'forbidden',
): 'policy' | 'principal' {
  return outcome === 'approval_required' ? 'principal' : 'policy';
}

/**
 * The compact gate payload a submission hands to `authorizeAction` (kind
 * 'agent-recruitment', level EXECUTE): everything an approver needs to
 * decide from the request alone (§24). Bounded fields only — the payload
 * stays far under the actions module's 1 MiB ceiling.
 */
export function gateDescriptor(input: {
  proposalId: string;
  title: string;
  capabilityId: string;
  capabilityName: string;
  /** The W017 gap classification snapshot; null when out of gap scope. */
  gapStatus: string | null;
  alternativeKinds: readonly RecruitmentAlternativeKind[];
  recommendation: {
    kind: RecruitmentAlternativeKind;
    summary: string;
    estimatedCostMinor: number | null;
    estimatedCostCurrency: string | null;
    estimatedWeeks: number | null;
  } | null;
}): Record<string, unknown> {
  return {
    subject: 'agent-recruitment-proposal',
    proposalId: input.proposalId,
    title: input.title,
    capabilityId: input.capabilityId,
    capabilityName: input.capabilityName,
    gapStatus: input.gapStatus,
    alternativeKinds: [...input.alternativeKinds],
    recommended: input.recommendation === null ? null : { ...input.recommendation },
  };
}
