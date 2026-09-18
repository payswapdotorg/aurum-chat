// Public domain types of the audit module (W046 — Decision Evidence/Audit).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W046):
// "End-to-end reconstruction of input→evidence→belief/mission→policy→
//  recommendation→approval→execution→outcome→learning."
//
// ARCHITECTURE.md §24 (frozen) defines the reconstruction contract:
//
//   "Consequential cognition/actions are reconstructable:
//    `input → evidence → claims/beliefs → unknown/mission → policy →
//     model/provider → recommendation → approval → execution → result →
//     outcome → learning`.
//    Audit records are append-only from the domain perspective."
//
// This module therefore owns two things:
//
//  1. THE APPEND-ONLY AUDIT TRAIL (`audit_records`, migrations/001):
//     system-minted, tenant-scoped records of consequential events —
//     WHERE they sit on the §24 chain, WHAT happened, the §25 correlation
//     identity of the flow they belong to, a human summary and a
//     structured detail snapshot. Any surface may append (the api/mcp
//     modules' "every operation is audited" duty, the actions module's
//     "policy change history belongs to audit" duty); nobody rewrites —
//     PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE.
//
//  2. THE RECONSTRUCTION (`reconstructDecision`): a READ-ONLY assembly of
//     the full §24 chain for one consequential decision, anchored on
//         * a cognitive execution id (the canonical case — W013's trace
//       already records the cycle end to end),
//     * an action request id (the approval-centric case — W009's request
//       carries the policy snapshot and the decision trail), or
//     * a §25 correlation id (a whole logical flow, possibly several
//       executions).
//     Every link is deep-linked to the REAL records of the owning
//     modules — read ONLY through their public contracts — so the
//     document is evidence, not prose (lock 41). Links the calling
//     principal may not read are reported as unreadable in place (the
//     observations module's partial-lineage precedent); a reconstruction
//     never fails because one link is restricted — only because the
//     anchor itself is absent (uniform not-found, no existence leak).
//
// The DecisionEvidence document deliberately mirrors the §24 chain one
// field per link, plus a per-link completeness report: what is absent is
// stated, never silently omitted (a mid-flight decision — an execution
// suspended awaiting approval — reconstructs honestly with its outcome
// and learning links empty and marked absent).

import type { ExecutionState } from '@/modules/cognition/contract';

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

/** One append-only audit record — consequential-event evidence (§24). */
export interface AuditRecord {
  id: string;
  tenantId: string;
  /** What kind of record the event is about ('actions.policy', 'cognition.execution', ...). */
  subject: { kind: string; id: string | null };
  /** What happened ('policy-changed', 'authorized', 'approval-decided', ...). */
  event: string;
  /** WHERE on the §24 chain the event sits. */
  chainStage: ChainStage;
  /** §25 correlation identity of the logical flow, when known. */
  correlationId: string | null;
  /** Human-readable summary (1..2048 chars). */
  summary: string;
  /** Structured evidence snapshot — a plain JSON object (never credentials). */
  detail: Record<string, unknown>;
  /** The TenantContext principal that recorded the event. */
  principalId: string;
  /** ISO 8601 — when Aurum committed the record (service clock). */
  recordedAt: string;
}

/** Input shape of `recordAudit`. */
export interface RecordAuditInput {
  /** The audited record's kind (canonical slug grammar, 1..128 chars). */
  subjectKind: string;
  /** The audited record's uuid; null/omitted for tenant-wide subjects. */
  subjectId?: string | null;
  /** What happened (canonical slug grammar, 1..64 chars). */
  event: string;
  /** WHERE on the §24 chain the event sits (required — audit is the chain). */
  chainStage: ChainStage;
  /** §25 correlation identity of the flow this event belongs to. */
  correlationId?: string | null;
  /** Human summary, 1..2048 chars (required — audit records say what happened). */
  summary: string;
  /** Structured snapshot: a plain JSON object, ≤ 32 KiB serialized. */
  detail?: Record<string, unknown> | null;
}

/** Query shape of `getAuditRecord`. */
export interface GetAuditRecordQuery {
  recordId: string;
}

/** Query shape of `listAuditRecords`. All filters are optional and AND-combined. */
export interface ListAuditRecordsQuery {
  /** Exact subject kind ('actions.policy', ...). */
  subjectKind?: string;
  /** Requires `subjectKind` — narrows to one record. */
  subjectId?: string | null;
  /** Every record of one logical flow (§25 correlation). */
  correlationId?: string;
  /** Only events at this §24 chain stage. */
  chainStage?: ChainStage;
  /** Only this event kind. */
  event?: string;
  /** Inclusive lower bound on `recordedAt` — strict ISO 8601. */
  recordedFrom?: string;
  /** Inclusive upper bound on `recordedAt` — strict ISO 8601. */
  recordedTo?: string;
  /** 1..500, default 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// The reconstruction
// ---------------------------------------------------------------------------

/** The §24 chain stages — the frozen vocabulary of decision evidence. */
export const CHAIN_STAGES = [
  'input',
  'evidence',
  'claims-beliefs',
  'unknown-mission',
  'policy',
  'model-provider',
  'recommendation',
  'approval',
  'execution',
  'result',
  'outcome',
  'learning',
] as const;

export type ChainStage = (typeof CHAIN_STAGES)[number];

/** How the decision was anchored for reconstruction. */
export type DecisionAnchor =
  | { kind: 'execution'; id: string }
  | { kind: 'action-request'; id: string }
  | { kind: 'correlation'; id: string };

/** Query shape of `reconstructDecision` — exactly one anchor. */
export interface ReconstructDecisionQuery {
  /** Reconstruct the decision carried by one cognitive execution. */
  executionId?: string;
  /** Reconstruct the decision behind one action request (W009). */
  actionRequestId?: string;
  /** Reconstruct a whole §25-correlated flow. */
  correlationId?: string;
}

/**
 * One cognitive execution of the decision — the §24 `execution` link's
 * driving record (lock 36: explicit, asynchronous, resumable, traceable).
 */
export interface DecisionExecution {
  id: string;
  trigger: { kind: string; id: string | null; label: string | null };
  focus: { topics: string[]; entities: { kind: string; id?: string | null; label?: string | null }[] };
  actor: { kind: string; id: string | null; label: string | null };
  correlationId: string;
  causation: { kind: string; id: string } | null;
  state: ExecutionState;
  completedStages: number;
  outcome: { kind: string; summary: string; actionRequestId: string | null; recordedAt: string } | null;
  abandonment: { reason: string; abandonedAt: string } | null;
  rationale: string | null;
  startedByPrincipal: string;
  createdAt: string;
  completedAt: string | null;
}

/** The §24 `input` link — what started the decision. */
export interface ChainInput {
  /** The first execution's trigger (what began the flow). */
  trigger: { kind: string; id: string | null; label: string | null } | null;
  /**
   * The triggering observation's content when the trigger is an
   * observation and the calling principal may read it; otherwise an
   * unreadable marker (a partial view, never a leak).
   */
  observation: EvidenceObservation | null;
}

/** One observation of the decision's evidence base — or an unreadable marker. */
export type EvidenceObservation =
  | {
      id: string;
      unreadable: false;
      kind: string;
      observedAt: string;
      recordedAt: string;
      channel: string;
      sourceLabel: string | null;
      confidenceValue: number;
      payload: unknown;
      /** The extraction lineage's provider/model, when recorded (§24 model/provider). */
      extractor: { provider: string; model: string } | null;
    }
  | { id: string; unreadable: true };

/** The §24 `evidence` link — what the decision rests on. */
export interface ChainEvidence {
  /**
   * The observations the decision ingested, referenced, cited as claim
   * evidence or cited as learning provenance (deduplicated). Unreadable
   * observations appear as id-only markers.
   */
  observations: EvidenceObservation[];
  /** Organizational knowledge retrieved at the evidence-memory stage (W010). */
  knowledge: { id: string; kind: string; title: string; summary: string; evidenceObservationIds: string[] }[];
  /** Transactive memory retrieved at the evidence-memory stage (W010). */
  transactive: { id: string; relation: string; subjectLabel: string; actor: { kind: string; id: string | null; label: string | null } }[];
}

/** The §24 `claims/beliefs` link — what was derived and concluded. */
export interface ChainClaimsBeliefs {
  /** Claims derived at the epistemic-evaluation stage (W007). */
  claims: { id: string; proposition: string; confidenceValue: number; evidenceObservationIds: string[] }[];
  /** Belief versions formed/revised at the model-update stage (W007). */
  beliefs: {
    id: string;
    version: number;
    proposition: string;
    confidenceValue: number;
    alternatives: string[];
    status: string;
    validFrom: string;
  }[];
}

/** The §24 `unknown/mission` link — what was not known and what was done about it. */
export interface ChainUnknownMission {
  /** Unknowns identified at the unknown-mission-evaluation stage (W007). */
  unknowns: { id: string; question: string; consequence: string; status: string }[];
  /** Missions launched at that stage (W011) and driven at the acquisition stage (W012). */
  missions: {
    id: string;
    title: string;
    knowledgeObjective: string;
    status: string;
    /** The live content view's confidence (the definition-side number). */
    currentConfidence: number;
    targetConfidence: number;
    /** The confidence the completion froze, when the mission completed (W011 completion record). */
    achievedConfidence: number | null;
    /** The acquisition the cycle drove for this mission, when it did (W012). */
    acquisition: {
      outcomeKind: string | null;
      confidence: { from: number; to: number } | null;
      completed: boolean;
    } | null;
  }[];
}

/** The §24 `policy` link — which rules governed the decision. */
export interface ChainPolicy {
  /**
   * The deterministic authority-matrix evaluation recorded on the gated
   * action request at gate time (W009): the outcome, where the deciding
   * policy came from, and the policy row itself when a tenant row
   * decided. Null when the decision proposed no action.
   */
  authorityEvaluation: {
    actionKind: string;
    authorityLevel: string;
    outcome: string;
    resolvedVia: string;
    policyNote: string | null;
  } | null;
  /** Audit-trail events recorded at the `policy` chain stage for this decision. */
  events: AuditRecord[];
}

/** The §24 `model/provider` link — which models/providers produced the evidence. */
export interface ChainModelProvider {
  /**
   * Provider/model extractors found in the decision's observation
   * lineages (deduplicated by provider+model, with the observations
   * they extracted). LLM gateway executions are provider-neutral
   * evidence but are not yet correlated to cognitive executions at
   * this repository state — their attribution travels through recorded
   * audit `detail` snapshots (see `events`).
   */
  extractors: { provider: string; model: string; observationIds: string[] }[];
  /** Audit-trail events recorded at the `model-provider` chain stage. */
  events: AuditRecord[];
}

/** The §24 `recommendation` link — what was proposed. */
export interface ChainRecommendation {
  /**
   * The consequential action proposed at the
   * recommendation-ask-proposal-action stage and routed through the
   * authority gate (W009). Null when the decision proposed nothing.
   */
  actionRequest: {
    id: string;
    actionKind: string;
    authorityLevel: string;
    payload: unknown;
    justification: string | null;
    requestedBy: string;
    requestedAt: string;
    idempotencyKey: string | null;
    status: string;
  } | null;
}

/** The §24 `approval` link — who decided, when, and how. */
export interface ChainApproval {
  /**
   * The append-only decision trail of the flow's gated action requests
   * (policy auto-decisions and human decisions, each attributed to its
   * request). An empty trail means nothing was ever gated: either no
   * action was proposed, or policy allowed it without a human decision.
   */
  decisions: {
    id: string;
    requestId: string;
    decision: string;
    decidedBy: string;
    principalId: string | null;
    note: string | null;
    decidedAt: string;
  }[];
}

/** The §24 `execution` link — what actually executed. */
export interface ChainExecution {
  /** The cognitive executions that carried the decision (empty for direct authorizations). */
  executions: DecisionExecution[];
  /** True when the action request was authorized directly, outside any cognitive execution. */
  directAuthorization: boolean;
}

/** The §24 `result` link — what the gate produced. */
export interface ChainResult {
  /** The authority gate's outcome, or null with no proposed action. */
  gate: 'allowed' | 'forbidden' | 'approval_required' | null;
  /** The human decision that resolved an approval_required gate, when one did. */
  resolution: 'approved' | 'rejected' | null;
  /** The action request's current terminal-or-not status. */
  requestStatus: string | null;
  /** When the deciding decision landed; null exactly while pending. */
  decidedAt: string | null;
}

/** The §24 `outcome` link — what the cycle recorded as its result. */
export interface ChainOutcome {
  /** The recorded outcome of each execution that reached the outcome stage. */
  outcomes: { executionId: string; kind: string; summary: string; actionRequestId: string | null; recordedAt: string | null }[];
}

/** The §24 `learning` link — what was durably learned. */
export interface ChainLearning {
  /** Evidence-backed knowledge captured at the learning stage (W010). */
  knowledge: { id: string; kind: string; title: string; summary: string; topics: string[]; evidenceObservationIds: string[] }[];
}

/** The assembled §24 chain — one field per link, in chain order. */
export interface DecisionChain {
  input: ChainInput;
  evidence: ChainEvidence;
  claimsBeliefs: ChainClaimsBeliefs;
  unknownMission: ChainUnknownMission;
  policy: ChainPolicy;
  modelProvider: ChainModelProvider;
  recommendation: ChainRecommendation;
  approval: ChainApproval;
  execution: ChainExecution;
  result: ChainResult;
  outcome: ChainOutcome;
  learning: ChainLearning;
}

/** One §24 link's completeness report — what is absent is stated, never silent. */
export interface ChainLinkReport {
  stage: ChainStage;
  /** True when the link carries any content for this decision. */
  present: boolean;
  /** How many items support the link (0 when absent). */
  itemCount: number;
}

/** The end-to-end decision-evidence document (§24). */
export interface DecisionEvidence {
  tenantId: string;
  anchor: DecisionAnchor;
  /** The §25 correlation identity of the reconstructed flow, when known. */
  correlationId: string | null;
  /** ISO 8601 — service clock; a reconstruction is a derived, repeatable read. */
  reconstructedAt: string;
  chain: DecisionChain;
  /** Per-link completeness, in §24 chain order. */
  completeness: ChainLinkReport[];
  /**
   * The recorded audit history for this decision: records about the
   * driving executions, the action request, or the flow's correlation
   * identity, in chronological order.
   */
  auditRecords: AuditRecord[];
}
