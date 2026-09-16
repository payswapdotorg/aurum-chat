// Public domain types of the cognition module (W013 — Cognitive
// Orchestrator).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W013):
// "Implement the canonical company intelligence loop as explicit
//  asynchronous/resumable executions with policy gates and outcome
//  recording."
//
// ARCHITECTURE.md §19 (frozen) defines what a cognitive execution IS:
//
//   "Cognitive orchestration connects perception, evidence, world model,
//    goals, attention, unknowns, learning missions, investigation,
//    learning, capability analysis, recommendations and action policy.
//    Canonical execution:
//    `observation → evidence/memory → world update → epistemic evaluation
//     → goal evaluation → unknown/mission evaluation → knowledge
//     acquisition → model update → risk/opportunity/capability analysis
//     → recommendation/ask/proposal/action → outcome → learning`.
//    Cognitive executions are explicit, asynchronous, resumable and
//    traceable. LLM calls are bounded reasoning capabilities, not
//    workflow authority."
//
// A CognitiveExecution is therefore an EXPLICIT, DURABLE record of one
// cycle of that loop (lock 36): an identity, a trigger with correlation
// and causation identities (§25 — "Executions carry correlation and
// causation identities"), a focus (what the cycle attends to), a
// lifecycle state machine with first-class SUSPENSIONS, and — once the
// outcome stage has run — the cycle's recorded outcome. The trace of the
// cycle is the append-only step chain (`cognitive_execution_steps`):
// exactly one step per canonical stage, in canonical order, each carrying
// the validated stage input snapshot and the structured stage result.
//
// Asynchronous/resumable means, concretely:
//   * `startExecution` records the execution and does NO stage work;
//   * `runNextStage` is the explicit worker pump — each call advances ONE
//     canonical stage (bounded work, no background time owned here — the
//     notifications-module precedent), and is SAFE to re-call:
//   * `awaiting_input` suspends the knowledge-acquisition stage until the
//     planned acquisition carries its terminal outcome (a question asked
//     to an employee is answered in the world, not in a transaction);
//   * `awaiting_approval` suspends the recommendation/ask/proposal/action
//     stage while the actions authority matrix (W009) holds the proposed
//     action for a human decision — THE POLICY GATE of the loop (§20);
//     a human approve/reject between pumps releases the suspension;
//   * 'completed' is terminal after the learning stage, carrying the
//     outcome recorded by the outcome stage; 'abandoned' is the other
//     terminal (a required reason — terminal transitions record their
//     why, the missions-module discipline).
//
// What each stage DOES through the sibling contracts (all imports are
// contract-only — MODULE-DEPENDENCY-MAP.md sanctions `world + goals +
// epistemics + missions → cognition`, the work-item DAG adds W009
// actions, W010 memory and W012 knowledge-acquisition, and W004
// observations is the loop's evidence intake the channels module
// explicitly assigns to the cognition path):
//
//   observation     — ingest the cycle's evidence: record new immutable
//                     observations (W004 recordObservation — "recording
//                     the OBSERVATION is the cognition path's job (W013)"
//                     per the channels contract) and/or reference
//                     already-recorded ones (validated readable). At
//                     least one observation per cycle.
//   evidence-memory — retrieve the evidence-backed knowledge and
//                     transactive memory relevant to the focus (W010
//                     reads; the "remember" of §2).
//   world-update    — apply the cycle's world-model update (W005:
//                     create entity / update entity / create
//                     relationship — one bounded update per cycle;
//                     understanding is mutable, §4).
//   epistemic-evaluation — record the claims derived from the cycle's
//                     evidence (W007 recordClaim — claims cite ≥1
//                     readable observation; conflicting derivations
//                     coexist, lock 12).
//   goal-evaluation — compare the focus with the tenant's direction:
//                     the related active goals (W008 getGoal/listGoals).
//   unknown-mission-evaluation — identify unknowns and launch learning
//                     missions (W007 recordUnknown, W011 createMission —
//                     §2 "identify unknowns → launch learning missions";
//                     the mission's actor is the execution's actor).
//   knowledge-acquisition — drive the W012 planner for ONE active
//                     mission: derive the deterministic ADR-0018 signal
//                     vector (signals.ts — from transactive memory),
//                     plan the next-best acquisition, then SUSPEND until
//                     the plan's terminal outcome lands; on resume,
//                     update the mission's confidence from the answer's
//                     evidence (reviseMission / completeMission through
//                     the missions contract — exactly the orchestration
//                     the W012 contract documents as W013's job), or
//                     record an unavailable/failed acquisition.
//   model-update    — update the working understanding: form or revise a
//                     belief (W007 formBelief/reviseBelief — every
//                     version carries provenance, lock 11).
//   risk-opportunity-capability-analysis — record the cycle's findings
//                     (risks, opportunities, capability gaps) with their
//                     evidence and affected goals, as DERIVED
//                     intelligence on the trace (the W015/W016/W017
//                     modules formalize the first-class objects; findings
//                     link to evidence, like briefings §22 they are never
//                     authoritative state).
//   recommendation-ask-proposal-action — THE POLICY GATE: propose ONE
//                     consequential action (any §20 authority level,
//                     any canonical action kind) and route it through
//                     the actions authority matrix (W009 authorizeAction)
//                     with a stable idempotency key per execution;
//                     'allowed' releases it, 'forbidden' refuses it,
//                     'approval_required' suspends the execution until a
//                     human decides (§2 "act when authorized").
//   outcome         — record the cycle's outcome on the execution:
//                     action-authorized / action-refused / no-action,
//                     derived deterministically from the gate result
//                     (loop.ts) plus the caller's summary (§24
//                     reconstructability).
//   learning        — capture what the cycle learned as evidence-backed
//                     organizational memory (W010 recordKnowledgeEntry,
//                     kind 'insight', citing the cycle's observations),
//                     or record that nothing durable was learned.
//
// Derived CONTENT (claim propositions, unknown questions, mission
// definitions, findings, action payloads, learning summaries) is
// CALLER-SUPPLIED at the stage boundary: that is the bounded-reasoning
// seam of §19 ("LLM calls are bounded reasoning capabilities, not
// workflow authority") — the loop owns order, gates, persistence and
// traceability; reasoning products enter as validated inputs and are
// recorded by the owning modules under their own invariants.

import type {
  AcquisitionActionKind,
  AcquisitionOutcomeKind,
  CandidateSignals,
} from '@/modules/knowledge-acquisition/contract';
import type { MissionCandidate } from '@/modules/missions/contract';
import type { AuthorityLevel } from '@/modules/actions/contract';
import type {
  ActionGateResult,
  ExecutionCausationKind,
  ExecutionOutcomeKind,
  ExecutionState,
  ExecutionTriggerKind,
  LoopStage,
} from './loop';

// ---------------------------------------------------------------------------
// Execution identity and inputs
// ---------------------------------------------------------------------------

/** The party driving the cognitive loop (provider-neutral, lock 16). */
export interface ExecutionActor {
  kind: 'person' | 'team' | 'agent' | 'system' | 'external';
  id: string | null;
  label: string | null;
}

/** What started the cycle. */
export interface ExecutionTrigger {
  kind: ExecutionTriggerKind;
  /**
   * The triggering record (observation/conversation/mission id). Required
   * for `observation` (validated readable through the observations
   * contract at start); otherwise an opaque forward reference owned by
   * the respective module.
   */
  id: string | null;
  label: string | null;
}

/** What the cycle attends to (the loop's attention focus). */
export interface ExecutionFocus {
  /** 1..16 lowercase retrieval topics (memory/evidence retrieval keys). */
  topics: string[];
  /** 0..16 opaque entity references the focus is about. */
  entities: { kind: string; id?: string | null; label?: string | null }[];
}

/** What caused this execution (§25 causation identity), or null for roots. */
export interface ExecutionCausation {
  kind: ExecutionCausationKind;
  id: string;
}

/** Input shape of `startExecution`. */
export interface StartExecutionInput {
  /** What started the cycle (id required for `observation` triggers). */
  trigger: {
    kind: ExecutionTriggerKind;
    id?: string | null;
    label?: string | null;
  };
  focus: ExecutionFocus;
  /** Who/what is driving the loop (recorded on the execution; drives mission creation). */
  actor: { kind: ExecutionActor['kind']; id?: string | null; label?: string | null };
  /**
   * Explicit correlation id for the flow this execution belongs to
   * (§25). When omitted, an execution caused by another execution
   * inherits its cause's correlation id; every other execution
   * correlates to itself (minted).
   */
  correlationId?: string | null;
  causation?: ExecutionCausation | null;
  /** Why the cycle was started — optional, recorded on the execution. */
  rationale?: string | null;
}

// ---------------------------------------------------------------------------
// Stage inputs (the bounded-reasoning seam — validated per stage)
// ---------------------------------------------------------------------------

/**
 * One immutable observation to record as the cycle's evidence (W004
 * recordObservation shape; the observations module validates the content
 * itself — the loop only carries it).
 */
export interface ObservationIntakeInput {
  kind: string;
  payload: unknown;
  observedAt: string;
  source: { kind: string; id?: string | null; label?: string | null };
  channel: string;
  lineage?:
    | { method: string; parents?: string[]; extractor?: { provider: string; model: string; notes?: string | null } | null }
    | null;
  permissions?:
    | {
        visibility?: string;
        workspaceId?: string | null;
        principalId?: string | null;
        usage?: string[];
      }
    | null;
  confidence: { value: number; method: string; basis?: string | null };
}

/** One claim derived from the cycle's evidence (W007 recordClaim shape). */
export interface ClaimDerivationInput {
  proposition: string;
  subject?: { kind: string; id: string } | null;
  confidence: { value: number; method: string; basis?: string | null };
  /** 1..16 supporting observation uuids (readable in this tenant). */
  evidenceObservationIds: string[];
  rationale?: string | null;
}

/** One unknown identified by the cycle (W007 recordUnknown shape). */
export interface UnknownDerivationInput {
  question: string;
  consequence: string;
  subject?: { kind: string; id: string } | null;
  relatedObservationIds?: string[];
  relatedClaimIds?: string[];
  relatedBeliefIds?: string[];
  note?: string | null;
}

/**
 * One learning mission launched by the cycle (W011 createMission shape
 * minus the actor — the execution's actor drives it — and with an
 * optional per-mission rationale defaulting to the execution).
 */
export interface MissionLaunchInput {
  title: string;
  knowledgeObjective: string;
  affectedGoals?: { goalId: string; label?: string | null }[];
  unknownIds?: string[];
  informationValue: number;
  urgency: 'critical' | 'high' | 'medium' | 'low';
  currentConfidence?: number;
  targetConfidence: number;
  investigationBudget: { amount: number; currency: string };
  rewardBudget: { amount: number; currency: string };
  rewardTerms?: string | null;
  candidateSources?: MissionCandidate[];
  completionCriteria: string;
  rationale?: string | null;
}

/** The world-model update of one cycle (W005; one bounded update). */
export type WorldModelUpdateInput =
  | { kind: 'create-entity'; entity: { kind: string; name: string; description?: string | null; attributes?: unknown; externalRef?: { module: string; id: string } | null } }
  | { kind: 'update-entity'; entityId: string; name?: string; description?: string | null; attributes?: unknown }
  | { kind: 'create-relationship'; relationship: { type: string; fromEntityId: string; toEntityId: string; attributes?: unknown } };

/** The working-understanding update of one cycle (W007 belief). */
export interface BeliefUpdateInput {
  /** Present → revise the existing belief; absent → form a new one. */
  beliefId?: string | null;
  proposition: string;
  confidence: { value: number; method: string; basis?: string | null };
  /** 1..16 supporting observation uuids (every version carries provenance). */
  supportingObservationIds: string[];
  supportingClaimIds?: string[];
  alternatives?: string[];
  disconfirmation?: string | null;
  subject?: { kind: string; id: string } | null;
  /** Valid-time start — strictly increasing per belief (W006 discipline). */
  validFrom: string;
  rationale?: string | null;
}

/** One analysis finding recorded on the trace (derived intelligence). */
export interface AnalysisFindingInput {
  kind: 'risk' | 'opportunity' | 'capability-gap';
  statement: string;
  /** Observations the finding rests on (validated readable). */
  evidenceObservationIds?: string[];
  /** Goals the finding affects (validated readable). */
  affectedGoalIds?: string[];
}

/** The consequential action proposed by the cycle (§20 vocabulary). */
export interface ActionProposalInput {
  /** Canonical action-kind slug, e.g. 'employee-messaging' (§20 enumeration is open). */
  actionKind: string;
  authorityLevel: AuthorityLevel;
  /** The proposed action's content — plain JSON (non-null, size-capped). */
  payload: unknown;
  justification?: string | null;
}

/** The durable learning captured at the end of a cycle (W010 shape). */
export interface LearningCaptureInput {
  title: string;
  summary: string;
  topics: string[];
}

// ---------------------------------------------------------------------------
// The advance input (one discriminated union per canonical stage)
// ---------------------------------------------------------------------------

/**
 * Input shape of `runNextStage` — a per-stage discriminated union. The
 * `stage` field must equal the execution's next canonical stage (or its
 * suspended stage when resuming); a mismatch is `stage_mismatch`. Payload
 * keys are per-stage: supplying another stage's payload is rejected.
 */
export type AdvanceExecutionInput =
  | {
      executionId: string;
      stage: 'observation';
      /** New observations to record as the cycle's evidence (0..8). */
      record?: ObservationIntakeInput[];
      /** Already-recorded observation uuids to ingest (0..16). */
      reference?: string[];
    }
  | { executionId: string; stage: 'evidence-memory' }
  | {
      executionId: string;
      stage: 'world-update';
      /** One bounded world-model update, or null for a read-only cycle. */
      update?: WorldModelUpdateInput | null;
    }
  | {
      executionId: string;
      stage: 'epistemic-evaluation';
      /** Claims derived from the cycle's evidence (0..8). */
      claims?: ClaimDerivationInput[];
    }
  | {
      executionId: string;
      stage: 'goal-evaluation';
      /** Active goals the focus relates to (0..16, validated readable + active). */
      relatedGoalIds?: string[];
    }
  | {
      executionId: string;
      stage: 'unknown-mission-evaluation';
      /** Unknowns identified by the cycle (0..8). */
      unknowns?: UnknownDerivationInput[];
      /** Learning missions to launch (0..4). */
      missions?: MissionLaunchInput[];
    }
  | {
      executionId: string;
      stage: 'knowledge-acquisition';
      /** The active mission to acquire for; null/omitted = no acquisition this cycle. */
      missionId?: string | null;
    }
  | {
      executionId: string;
      stage: 'model-update';
      /** The belief update, or null when the cycle revises no understanding. */
      belief?: BeliefUpdateInput | null;
    }
  | {
      executionId: string;
      stage: 'risk-opportunity-capability-analysis';
      /** The cycle's findings (0..16). */
      findings?: AnalysisFindingInput[];
    }
  | {
      executionId: string;
      stage: 'recommendation-ask-proposal-action';
      /** The proposed consequential action, or null when the cycle proposes none. */
      action?: ActionProposalInput | null;
    }
  | {
      executionId: string;
      stage: 'outcome';
      /** The cycle's outcome summary (required — outcomes are recorded, never silent). */
      summary: string;
    }
  | {
      executionId: string;
      stage: 'learning';
      /** The durable learning to capture, or null when nothing durable was learned. */
      knowledge?: LearningCaptureInput | null;
    };

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** One append-only step of the canonical trace. */
export interface CognitiveExecutionStep {
  id: string;
  tenantId: string;
  executionId: string;
  /** 1-based canonical position (§19 order). */
  stageNumber: number;
  stage: LoopStage;
  /** The validated stage input snapshot (audit: what the driver supplied). */
  input: unknown;
  /** The structured stage outcome (typed below per stage). */
  result: StageResult;
  /** The authenticated TenantContext principal that advanced the stage. */
  advancedByPrincipal: string;
  /** ISO 8601 — when the step was committed (service clock). */
  recordedAt: string;
}

/** The result the world-update stage recorded. */
export type WorldUpdateResult =
  | { kind: 'create-entity'; entityId: string }
  | { kind: 'update-entity'; entityId: string }
  | { kind: 'create-relationship'; relationshipId: string; fromEntityId: string; toEntityId: string };

/** One analysis finding as recorded on the trace. */
export interface RecordedAnalysisFinding {
  kind: 'risk' | 'opportunity' | 'capability-gap';
  statement: string;
  evidenceObservationIds: string[];
  affectedGoalIds: string[];
}

/** The structured outcome of one canonical stage (discriminated by `stage`). */
export type StageResult =
  | { stage: 'observation'; observationIds: string[]; recordedObservationIds: string[] }
  | { stage: 'evidence-memory'; knowledgeEntryIds: string[]; transactiveEntryIds: string[] }
  | { stage: 'world-update'; update: WorldUpdateResult | null }
  | { stage: 'epistemic-evaluation'; claimIds: string[] }
  | { stage: 'goal-evaluation'; goalIds: string[]; activeGoalCount: number }
  | { stage: 'unknown-mission-evaluation'; unknownIds: string[]; missionIds: string[] }
  | {
      stage: 'knowledge-acquisition';
      /** The mission acquired for, or null when the cycle had none. */
      missionId: string | null;
      decision: 'no-mission' | 'no_candidate' | 'selected';
      planId: string | null;
      chosen: { kind: string; id: string | null; label: string | null } | null;
      action: AcquisitionActionKind | null;
      /** The plan's terminal outcome, once recorded (W012 first-outcome-wins). */
      outcome: { kind: AcquisitionOutcomeKind; note: string | null; evidenceObservationId: string | null } | null;
      /** The mission confidence update the answer produced, if any. */
      missionConfidence: { from: number; to: number } | null;
      /** True when the answer closed the mission's confidence gap (completeMission). */
      missionCompleted: boolean;
    }
  | { stage: 'model-update'; beliefId: string | null; beliefVersion: number | null }
  | { stage: 'risk-opportunity-capability-analysis'; findings: RecordedAnalysisFinding[] }
  | {
      stage: 'recommendation-ask-proposal-action';
      actionRequest: ActionGateResult['actionRequest'];
      gate: ActionGateResult['gate'];
      resolution: ActionGateResult['resolution'];
    }
  | { stage: 'outcome'; kind: ExecutionOutcomeKind; summary: string; actionRequestId: string | null }
  | { stage: 'learning'; knowledgeEntryId: string | null };

/** The cycle's recorded outcome (written by the outcome stage). */
export interface ExecutionOutcome {
  kind: ExecutionOutcomeKind;
  summary: string;
  /** The gated action request this outcome is about, when one was proposed. */
  actionRequestId: string | null;
  /** ISO 8601 — when the outcome stage recorded it. */
  recordedAt: string;
}

/** The current view of a cognitive execution (identity + lifecycle). */
export interface CognitiveExecution {
  id: string;
  tenantId: string;
  trigger: ExecutionTrigger;
  focus: ExecutionFocus;
  actor: ExecutionActor;
  /** §25 correlation identity — groups the events/records of one logical flow. */
  correlationId: string;
  /** §25 causation identity — what caused this execution, or null for roots. */
  causation: ExecutionCausation | null;
  state: ExecutionState;
  /** How many canonical stages have completed (0..12). */
  completedStages: number;
  /** The next canonical stage to run; null once terminal. */
  nextStage: LoopStage | null;
  /** What a suspended execution is waiting on (null unless suspended). */
  pending: { planId: string | null; requestId: string | null };
  outcome: ExecutionOutcome | null;
  abandonment: { reason: string; abandonedAt: string } | null;
  rationale: string | null;
  /** The authenticated principal that started the execution. */
  startedByPrincipal: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** The full trace: the execution plus its append-only step chain. */
export interface CognitiveExecutionTrace extends CognitiveExecution {
  /** All completed steps, ascending by canonical stage number. */
  steps: CognitiveExecutionStep[];
}

/** Query shape of `getExecutionStep`. */
export interface GetExecutionStepQuery {
  executionId: string;
  stage: LoopStage;
}

/** Query shape of `listExecutions`. */
export interface ListExecutionsQuery {
  state?: ExecutionState;
  triggerKind?: ExecutionTriggerKind;
  /** Every execution of one logical flow (§25 correlation). */
  correlationId?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Input shape of `abandonExecution`. */
export interface AbandonExecutionInput {
  executionId: string;
  /** Required — terminal transitions record their why. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Exported pure-policy integration points (documented for downstream
// modules and tests; the values are the loop's deterministic defaults).
// ---------------------------------------------------------------------------

export type {
  AcquisitionActionKind,
  AcquisitionOutcomeKind,
  AuthorityLevel,
  CandidateSignals,
  ExecutionCausationKind,
  ExecutionOutcomeKind,
  ExecutionState,
  ExecutionTriggerKind,
  LoopStage,
  MissionCandidate,
};
