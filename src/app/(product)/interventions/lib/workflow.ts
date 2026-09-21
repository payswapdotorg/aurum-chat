// Capability, workforce & agent interventions (W063) — the write
// workflows of the surface: the human decisions and activations plan §2
// Journey I requires ("proposal → approval → activation", "team
// topology/budget", "retain/modify/terminate agent lifecycle").
//
// Every flow is a THIN, honest composition of the frozen domain
// contracts — no second source of truth is created anywhere (lock
// 31/32; this module records through contracts only):
//
//   decideProposalGate — THE HUMAN AUTHORITY GATE on a recruitment
//     proposal: the approver decides the linked action request through
//     the actions module's decideApproval (separation of duties is
//     enforced THERE — the requesting principal can never decide its
//     own proposal), then settleRecruitmentProposal lands the decision
//     on the proposal (the W021 pump precedent, idempotent). A request
//     another approver already decided (a re-click) is not an error:
//     the settle still lands, first-write-wins.
//   activateRecruitedAgent — the ACTIVATION of an approved recruit
//     alternative: registering the agent through the agents module's
//     claim-gated contract ('agents:administer') with the permission
//     scopes the approved comparison proposed — the future grant the
//     proposal made visible at approval time becomes the actual grant.
//     Registering is idempotent per (tenant, slug): a retry replays the
//     same agent instead of failing.
//   composeTeam — authoring one draft team (topology, roster, shared
//     objective, budget envelope) through the agent-teams contract's
//     claim-gated createTeam. A draft carries no authority until the
//     gated activation applies.
//   driveTeamLifecycle — activation/dissolution of a team through the
//     contract's gated transitions. The idempotency key is DERIVED from
//     the team id (`team-activate:<id>` / `team-dissolve:<id>`), so a
//     re-invocation after the human decision replays the SAME gate
//     request and applies — the surface's "apply" affordance is the
//     same call as its "request" affordance (the module's own design).
//   decideAgentLifecycleFromForm — recording one RETAIN / MODIFY /
//     TERMINATE decision through the agent-evaluation contract
//     ('agents:administer'; the decision always follows a measured
//     evaluation — no decision without evidence). Retain/modify are
//     recorded evidence; TERMINATE routes through the W009 authority
//     matrix (kind 'agent-termination', EXECUTE — lock 23: no agent is
//     terminated without an explicit human decision). A
//     matrix-allowed termination is settled (applied) in the same flow;
//     a gated one returns its pending request id for the Approvals
//     surface.
//   settleAgentTermination — the idempotent pump that resolves a gated
//     termination after its human decision and applies it (the agent
//     definition is disabled through the agents contract).
//
// Human employment decisions stay human-authorized (lock 20/21): this
// module offers NO workforce write path at all — workforce
// assessments' human decisions are recorded by authorized humans
// through the workforce module's own 'workforce:decide' gate, and this
// surface renders that trail read-only.

import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { ActionsError, decideApproval } from '@/modules/actions/contract';
import {
  getRecruitmentProposal,
  settleRecruitmentProposal,
} from '@/modules/agent-recruitment/contract';
import type { AgentRecruitmentProposal } from '@/modules/agent-recruitment/contract';
import { registerAgent } from '@/modules/agents/contract';
import type { AgentDefinition } from '@/modules/agents/contract';
import { createTeam, dissolveTeam, activateTeam } from '@/modules/agent-teams/contract';
import type { Team, TeamTransitionResult } from '@/modules/agent-teams/contract';
import {
  decideAgentLifecycle,
  settleAgentLifecycleDecision,
} from '@/modules/agent-evaluation/contract';
import type { AgentLifecycleDecision } from '@/modules/agent-evaluation/contract';
import type {
  ValidatedActivationInput,
  ValidatedAgentDecisionInput,
  ValidatedProposalDecisionInput,
  ValidatedTeamComposeInput,
  ValidatedTeamLifecycleInput,
} from './form';

// Re-exported for the API layer and the tests (the single definitions).
export {
  AGENT_LIFECYCLE_CHANGES,
  AGENT_PERMISSIONS,
  AGENT_PROVIDER_OPTIONS,
  AGENT_PROVIDERS,
  InterventionInputError,
  PROPOSAL_DECISIONS,
  TEAM_LIFECYCLE_ACTIONS,
  TEAM_TOPOLOGIES,
  isAgentLifecycleChange,
  isAgentPermission,
  isAgentProvider,
  isProposalDecision,
  isTeamLifecycleAction,
  isTeamTopology,
  validateActivationInput,
  validateAgentDecisionInput,
  validateProposalDecisionInput,
  validateTeamComposeInput,
  validateTeamLifecycleInput,
} from './form';
export type {
  AgentLifecycleOption,
  AgentPermissionOption,
  AgentProviderOption,
  ProposalDecisionOption,
  TeamLifecycleOption,
  TeamTopologyOption,
  ValidatedActivationInput as FormActivationInput,
  ValidatedAgentDecisionInput as FormAgentDecisionInput,
  ValidatedProposalDecisionInput as FormProposalDecisionInput,
  ValidatedTeamComposeInput as FormTeamComposeInput,
  ValidatedTeamLifecycleInput as FormTeamLifecycleInput,
} from './form';

// ---------------------------------------------------------------------------
// The state error (maps to 409)
// ---------------------------------------------------------------------------

/**
 * Why a workflow was refused by RECORD STATE (maps to 409): the
 * proposal is not at the gate, the activation has no approved recruit
 * alternative to activate, or the team transition is not available.
 * The domain's own conflict codes (`invalid_transition`,
 * `team_conflict`, `forbidden_by_policy` …) arrive directly from the
 * contracts and are mapped the same way by the API layer.
 */
export class InterventionStateError extends Error {
  readonly code: 'intervention_state';
  constructor(message: string) {
    super(message);
    this.code = 'intervention_state';
  }
}

// ---------------------------------------------------------------------------
// decideProposalGate — the human authority decision
// ---------------------------------------------------------------------------

/** What one proposal decision produced. */
export interface ProposalDecisionOutcome {
  proposalId: string;
  /** The settled proposal (the decision has landed on it). */
  status: AgentRecruitmentProposal['status'];
  /** Whether THIS call cast the deciding vote (false = already decided). */
  decidedHere: boolean;
  /** The linked authority-gate request. */
  actionRequestId: string;
  decidedBy: string | null;
  decidedByPrincipal: string | null;
  decidedAt: string | null;
}

/**
 * Decide one awaiting recruitment proposal: cast the human decision on
 * the linked action request, then settle it onto the proposal. A
 * request that another approver already decided (a re-click) settles
 * without error — first-write-wins is the domain's own discipline.
 */
export async function decideProposalGate(
  ctx: TenantContext,
  proposalId: string,
  input: ValidatedProposalDecisionInput,
): Promise<ProposalDecisionOutcome> {
  const proposal = await getRecruitmentProposal(ctx, { proposalId });
  if (proposal.status !== 'awaiting_approval') {
    throw new InterventionStateError(
      `this proposal is ${proposal.status} — only a proposal waiting at the approval gate can be decided here`,
    );
  }
  const requestId = proposal.approval.actionRequestId;
  if (requestId === null) {
    throw new InterventionStateError(
      'this proposal carries no authority-gate request — it cannot be decided here',
    );
  }

  let decidedHere = true;
  try {
    await decideApproval(ctx, {
      requestId,
      decision: input.decision,
      note: input.note,
    });
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'not_pending') {
      // Another approver (or a policy row) already decided this request;
      // the settle below lands the recorded decision — idempotent.
      decidedHere = false;
    } else {
      throw error;
    }
  }

  const settled = await settleRecruitmentProposal(ctx, { proposalId });
  return {
    proposalId,
    status: settled.status,
    decidedHere,
    actionRequestId: requestId,
    decidedBy: settled.approval.decidedBy,
    decidedByPrincipal: settled.approval.decidedByPrincipal,
    decidedAt: settled.approval.decidedAt,
  };
}

// ---------------------------------------------------------------------------
// activateRecruitedAgent — the activation of an approved acquisition
// ---------------------------------------------------------------------------

/** What one activation produced. */
export interface AgentActivationOutcome {
  proposalId: string;
  agent: AgentDefinition;
  /** False when an agent with this slug already stood (idempotent replay). */
  created: boolean;
}

/**
 * Activate an APPROVED proposal's recruit alternative: register the
 * agent through the agents module with the permission scopes the
 * comparison proposed. The calling principal must hold the agents
 * module's 'agents:administer' claim (the contract enforces it).
 */
export async function activateRecruitedAgent(
  ctx: TenantContext,
  proposalId: string,
  input: ValidatedActivationInput,
): Promise<AgentActivationOutcome> {
  const proposal = await getRecruitmentProposal(ctx, { proposalId });
  if (proposal.status !== 'approved') {
    throw new InterventionStateError(
      `this proposal is ${proposal.status} — activation follows an approved proposal`,
    );
  }
  const recruit = proposal.alternatives.find(
    (alternative) => alternative.kind === 'recruit',
  );
  if (recruit === undefined) {
    throw new InterventionStateError(
      'this proposal compares no agent recruitment — its approved alternative activates elsewhere (training, hiring, automation or an install)',
    );
  }

  const registered = await registerAgent(ctx, {
    slug: input.slug,
    displayName: input.displayName,
    role: input.role,
    description: input.description,
    provider: input.provider,
    instructions: input.instructions,
    permissions: input.permissions,
  });
  return { proposalId, agent: registered.agent, created: registered.created };
}

// ---------------------------------------------------------------------------
// composeTeam — authoring a draft team (topology/budget)
// ---------------------------------------------------------------------------

/** What one team composition produced. */
export interface TeamComposeOutcome {
  team: Team;
  created: boolean;
}

/**
 * Compose one draft team from the form's choices. The team slug is
 * derived from the display name plus a short random suffix (a stable
 * identity the roster then keys on); createTeam enforces the
 * 'agents:administer' claim and validates every member agent readable
 * through the agents contract at write time.
 */
export async function composeTeam(
  ctx: TenantContext,
  input: ValidatedTeamComposeInput,
): Promise<TeamComposeOutcome> {
  const base = input.displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const slug = `${base === '' ? 'team' : base}-${newId().slice(0, 4)}`;
  const created = await createTeam(ctx, {
    slug,
    displayName: input.displayName,
    description: input.description,
    topology: input.topology,
    members: input.members.map((member) => ({ agentId: member.agentId, role: member.role })),
    objectives: [
      {
        key: 'objective',
        objective: input.objective,
        ...(input.successCriteria === null ? {} : { successCriteria: input.successCriteria }),
      },
    ],
    budget: { amountMinor: input.budgetAmountMinor, currency: input.budgetCurrency },
    ...(input.ownerPrincipal === null ? {} : { ownerPrincipal: input.ownerPrincipal }),
  });
  return created;
}

// ---------------------------------------------------------------------------
// driveTeamLifecycle — gated activation / dissolution
// ---------------------------------------------------------------------------

/** What one team lifecycle call produced. */
export interface TeamLifecycleOutcome {
  teamId: string;
  action: 'activate' | 'dissolve';
  team: Team;
  /** False exactly when the authority gate holds the transition. */
  applied: boolean;
  gate: { actionRequestId: string; status: string };
}

/**
 * Drive one team's gated lifecycle. The idempotency key is derived from
 * the team id, so re-invoking after the human decision replays the same
 * gate request and applies — the "request" and "apply" affordances are
 * the same call. Activation requires every member agent to be ACTIVE
 * (the module's compose-time liveness invariant); dissolution requires
 * a reason.
 */
export async function driveTeamLifecycle(
  ctx: TenantContext,
  teamId: string,
  input: ValidatedTeamLifecycleInput,
): Promise<TeamLifecycleOutcome> {
  let result: TeamTransitionResult;
  if (input.action === 'activate') {
    result = await activateTeam(ctx, { teamId, idempotencyKey: `team-activate:${teamId}` });
  } else {
    result = await dissolveTeam(ctx, {
      teamId,
      reason: input.reason ?? '',
      idempotencyKey: `team-dissolve:${teamId}`,
    });
  }
  return {
    teamId,
    action: input.action,
    team: result.team,
    applied: result.applied,
    gate: { actionRequestId: result.gate.actionRequestId, status: result.gate.status },
  };
}

// ---------------------------------------------------------------------------
// decideAgentLifecycleFromForm — retain / modify / terminate
// ---------------------------------------------------------------------------

/** What one agent lifecycle decision produced. */
export interface AgentDecisionOutcome {
  decision: AgentLifecycleDecision;
  /**
   * True when the termination was applied in this flow; false when the
   * authority gate holds it; null for recorded retain/modify decisions
   * (evidence — nothing to apply through this surface).
   */
  applied: boolean | null;
  /** The pending authority-gate request (terminations at the gate). */
  gateRequestId: string | null;
}

/**
 * Record one retain/modify/terminate decision following a measured
 * evaluation, settling (applying) a termination the matrix allowed.
 * Contract errors propagate (`evaluation_not_found`,
 * `invalid_replacement_option`, `forbidden` without the administer
 * claim …).
 */
export async function decideAgentLifecycleFromForm(
  ctx: TenantContext,
  evaluationId: string,
  input: ValidatedAgentDecisionInput,
): Promise<AgentDecisionOutcome> {
  const decision = await decideAgentLifecycle(ctx, {
    evaluationId,
    change: input.change,
    rationale: input.rationale,
    note: input.note,
    modificationSummary: input.modificationSummary,
    replacementOptionId: input.replacementOptionId,
  });

  if (decision.status === 'awaiting_approval') {
    return {
      decision,
      applied: false,
      gateRequestId: decision.policy === null ? null : decision.policy.actionRequestId,
    };
  }
  if (decision.status === 'approved') {
    // The matrix allowed the termination outright — the pump applies it.
    const settled = await settleAgentLifecycleDecision(ctx, { decisionId: decision.id });
    return { decision: settled, applied: true, gateRequestId: null };
  }
  return { decision, applied: null, gateRequestId: null };
}

// ---------------------------------------------------------------------------
// settleAgentTermination — the idempotent pump
// ---------------------------------------------------------------------------

/**
 * Resolve and apply one gated termination after its human decision:
 * reads the linked action request, applies an approved termination
 * through the agents contract (the definition is disabled), and moves
 * the decision to its terminal 'applied' state. Settling a terminal
 * decision is a read — the pump is idempotent and retryable.
 */
export async function settleAgentTermination(
  ctx: TenantContext,
  decisionId: string,
): Promise<AgentLifecycleDecision> {
  return settleAgentLifecycleDecision(ctx, { decisionId });
}
