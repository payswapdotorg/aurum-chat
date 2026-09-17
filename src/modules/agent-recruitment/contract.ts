// ============================================================================
// agent-recruitment — the ONLY public surface of the agent-recruitment
// module (IMPLEMENTATION-STACK §2; cross-module imports of anything else
// are architecture violations detected by scripts/check-architecture.ts).
//
// W022 — Agent Recruitment:
// "Create AgentRecruitmentProposal comparing train/reassign/hire/
//  automate/recruit/install alternatives. Approval is explicit."
//
// ARCHITECTURE.md §15 (frozen): "AgentRecruitmentProposal compares
// existing capability, training, human hiring, automation, marketplace
// capabilities and agent alternatives before requesting approval."
//
//   The proposal (the comparison):
//   createRecruitmentProposal — record one proposal for ONE capability
//      (verified through the capabilities contract, W017), snapshotting
//      the existing capability (name, status, W017 gap classification
//      and numbers) as decision-time evidence, and comparing 2..6
//      acquisition alternatives with DISTINCT kinds — the six channels
//      the work item names verbatim: train an existing employee,
//      reassign existing work, hire human capability, automate the work,
//      recruit an agent, install a marketplace capability. Every
//      alternative is assessed on the same dimensions (summary, note,
//      integer-minor-unit cost + ISO currency, weeks to impact, expected
//      capability level/capacity contribution); at most ONE is
//      `recommended`; a 'recruit' alternative may carry the permission
//      scopes the proposed agent would be granted (the agents module's
//      closed vocabulary, W021 — the future grant is visible at approval
//      time, with its implied §20 authority level derived on read).
//   getRecruitmentProposal / listRecruitmentProposals — tenant-scoped
//      reads with the uniform not-found discipline (ADR-0001), filtered
//      by status, capability and recommended kind.
//
//   The explicit approval (§20/lock 23 — "Agent recruitment and
//   termination obey policy/approval"):
//   requestRecruitmentApproval — submit a draft through the W009
//      authority matrix: kind 'agent-recruitment' (a
//      CANONICAL_ACTION_KIND) at level EXECUTE, because what is approved
//      is the consequential acquisition, not the advisory comparison.
//      The built-in default matrix gates EXECUTE behind a human
//      decision, so approval is EXPLICIT out of the box; a tenant may
//      explicitly allow (a recorded POLICY approval) or forbid (a
//      terminal POLICY rejection) through setAuthorityPolicy. The gate
//      idempotency key is derived from the proposal id, so an
//      interrupted submission replays the SAME request on retry.
//   settleRecruitmentProposal — land the decision on the proposal (the
//      W021 pump precedent): an approver decides the pending request
//      through the actions module (separation of duties enforced there —
//      the requesting principal can never decide its own proposal), and
//      the settle call moves awaiting_approval → approved/rejected with
//      the deciding principal and time from the append-only decision
//      trail. Idempotent: settling a draft or a terminal proposal is a
//      read; settling an still-pending gate is a no-op.
//   withdrawRecruitmentProposal — the author (or an agent-workforce
//      administrator, the agents module's 'agents:administer' claim)
//      withdraws a DRAFT with a required reason; a submitted proposal is
//      decided through the gate, never un-requested (a changed proposal
//      is a NEW proposal — the actions module's discipline).
//
// There is deliberately NO operation to update or delete a proposal or
// its alternatives, and NO way to rewrite a comparison, a gate snapshot
// or a decision: the substantive content is immutable history the
// moment it is recorded, and PostgreSQL itself rejects UPDATE/DELETE/
// TRUNCATE on the alternatives and substantive UPDATEs, DELETE and
// TRUNCATE on the proposals via migration 001 triggers. The
// post-approval §15 agent lifecycle (RECRUITED → ACTIVE → EVALUATED →
// RETAIN/MODIFY/TERMINATE) belongs to the agents module and W023/W024;
// this module owns the proposal and its explicit authorization, nothing
// further.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's proposals,
// alternatives and gate links are indistinguishable from missing ones —
// no existence leak — and a foreign-tenant capability id reads the same
// as a missing one through the capabilities contract.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W017 + W018 + W021
// → W022; MODULE-DEPENDENCY-MAP.md: `actions + llm → agents`): this
// module imports ONLY the actions contract (the W009 authority gate —
// §20 "applies uniformly" to agent recruitment), the capabilities
// contract (the W017 capability link and gap snapshot) and the agents
// contract (the permission-scope vocabulary and its pure §20 level
// mapping — offered for exactly this reuse by the agents module's
// policy). The automation module (W018) is not yet delivered at this
// base; nothing here depends on it — the 'automate' alternative is one
// of the six compared channels, assessed like the others.
// ============================================================================

export {
  // The proposal (the comparison)
  createRecruitmentProposal,
  getRecruitmentProposal,
  listRecruitmentProposals,
  // The explicit approval
  requestRecruitmentApproval,
  settleRecruitmentProposal,
  withdrawRecruitmentProposal,
} from './service';

// Module-owned constants.
export {
  AGENT_RECRUITMENT_ACTION_KIND,
  AGENT_RECRUITMENT_AUTHORITY_LEVEL,
} from './service';

export { AgentRecruitmentError } from './errors';
export type { AgentRecruitmentErrorCode } from './errors';

// Pure vocabulary, lifecycle routing and the gate descriptor (no
// TenantContext needed — the capabilities module's gap.ts / the actions
// module's matrix.ts discipline).
export {
  RECRUITMENT_ALTERNATIVE_KINDS,
  RECRUITMENT_PROPOSAL_STATUSES,
  RECRUITMENT_PROPOSAL_TERMINAL_STATUSES,
  alternativeCompare,
  alternativeKindRank,
  alternativesInCanonicalOrder,
  deciderForOutcome,
  gateDescriptor,
  isRecruitmentAlternativeKind,
  isRecruitmentProposalStatus,
  isTerminalProposalStatus,
  recommendationOf,
  statusForGateOutcome,
} from './comparison';

export {
  DEFAULT_LIST_LIMIT,
  MAX_ALTERNATIVES,
  MAX_CAPACITY,
  MAX_COST_MINOR,
  MAX_EVIDENCE_REFS,
  MAX_JUSTIFICATION_CHARS,
  MAX_LIST_LIMIT,
  MAX_PERMISSIONS,
  MAX_REASON_CHARS,
  MAX_REF_CHARS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_WEEKS,
  MIN_ALTERNATIVES,
  assertAgentRecruitmentTenantContext,
  isUuid,
  validateCreateRecruitmentProposalInput,
  validateGetRecruitmentProposalQuery,
  validateListRecruitmentProposalsQuery,
  validateRequestRecruitmentApprovalInput,
  validateSettleRecruitmentProposalInput,
  validateWithdrawRecruitmentProposalInput,
} from './validation';

export type {
  ValidatedAlternative,
  ValidatedCreateInput,
  ValidatedGetQuery,
  ValidatedListQuery,
  ValidatedRequestApprovalInput,
  ValidatedSettleInput,
  ValidatedWithdrawInput,
} from './validation';

export type {
  AgentRecruitmentProposal,
  CreateRecruitmentProposalInput,
  GetRecruitmentProposalQuery,
  ListRecruitmentProposalsQuery,
  RecruitmentAlternative,
  RecruitmentAlternativeInput,
  RecruitmentAlternativeKind,
  RecruitmentApprovalSnapshot,
  RecruitmentCapabilitySnapshot,
  RecruitmentProposalStatus,
  RequestRecruitmentApprovalInput,
  SettleRecruitmentProposalInput,
  WithdrawRecruitmentProposalInput,
} from './types';
