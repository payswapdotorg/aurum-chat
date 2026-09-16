// ============================================================================
// cognition — the ONLY public surface of the cognition module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W013 — Cognitive Orchestrator:
// "Implement the canonical company intelligence loop as explicit
//  asynchronous/resumable executions with policy gates and outcome
//  recording."
//
// ARCHITECTURE.md §19 (frozen): "Cognitive orchestration connects
// perception, evidence, world model, goals, attention, unknowns, learning
// missions, investigation, learning, capability analysis, recommendations
// and action policy. Canonical execution:
// `observation → evidence/memory → world update → epistemic evaluation
//  → goal evaluation → unknown/mission evaluation → knowledge acquisition
//  → model update → risk/opportunity/capability analysis →
//  recommendation/ask/proposal/action → outcome → learning`.
// Cognitive executions are explicit, asynchronous, resumable and
// traceable. LLM calls are bounded reasoning capabilities, not workflow
// authority."
//
//   startExecution — record one explicit cycle of the canonical loop:
//      a trigger (what started it — an observation trigger is validated
//      readable through the observations contract), a focus (topics +
//      entity refs the cycle attends to), an actor, §25 correlation and
//      causation identities (an execution-caused execution inherits its
//      cause's correlation id; every root correlates to itself) and a
//      rationale. Does NO stage work — the loop is never implicit
//      control flow.
//   runNextStage    — the explicit worker pump (lock 36: asynchronous and
//      resumable; this module owns no background time — workers call
//      this repeatedly, one bounded canonical stage per call, in §19's
//      frozen order — the input's stage discriminator must equal the
//      execution's next stage; skipping/reordering is `stage_mismatch`):
//        * observation     — record new immutable observations (W004 —
//            "recording the OBSERVATION is the cognition path's job
//            (W013)" per the channels contract) and/or reference
//            already-recorded ones; a cycle always ingests ≥1;
//        * evidence-memory — retrieve evidence-backed knowledge and
//            transactive memory for the focus (W010);
//        * world-update    — apply ONE bounded world-model change (W005
//            create-entity / update-entity / create-relationship), or
//            none;
//        * epistemic-evaluation — record the claims derived from the
//            cycle's evidence (W007; claims cite readable observations);
//        * goal-evaluation — compare the focus with the tenant's active
//            goals (W008);
//        * unknown-mission-evaluation — record unknowns (W007) and
//            launch learning missions (W011; the execution's actor drives
//            them) — §2 "identify unknowns → launch learning missions";
//        * knowledge-acquisition — drive the W012 planner for ONE active
//            mission: derive the deterministic ADR-0018 signal vector
//            from transactive memory (signals.ts — the workflow-level
//            default W052 later replaces), plan the NEXT-BEST
//            acquisition, then SUSPEND ('awaiting_input') until the plan
//            carries its terminal outcome; on resume, raise the mission's
//            confidence from the answer's evidence through the missions
//            contract (reviseMission / completeMission — exactly the
//            orchestration W012 documents as W013's job), or record the
//            unavailable/failed acquisition;
//        * model-update    — form or revise the working understanding
//            (W007 beliefs — every version carries provenance);
//        * risk-opportunity-capability-analysis — record the cycle's
//            findings with evidence and affected goals (derived
//            intelligence on the trace; W015/W016/W017 formalize the
//            first-class objects);
//        * recommendation-ask-proposal-action — THE POLICY GATE: propose
//            ONE consequential action (any §20 authority level, any
//            canonical action kind) and route it through the actions
//            authority matrix (W009 authorizeAction) with the STABLE
//            idempotency key `cognition:<executionId>:action`:
//            'allowed' releases it; 'forbidden' refuses it;
//            'approval_required' SUSPENDS ('awaiting_approval') until a
//            human decides (W009 decideApproval between pumps releases
//            the suspension) — §2 "act when authorized";
//        * outcome         — record the cycle's outcome on the execution
//            (action-authorized / action-refused / no-action, derived
//            deterministically from the gate result) plus the caller's
//            summary (§24 reconstructability);
//        * learning        — capture the durable learning as
//            evidence-backed organizational memory (W010, kind
//            'insight', citing the cycle's observations), or record that
//            nothing durable was learned; this stage completes the
//            execution ('completed').
//   abandonExecution — the one-way live → abandoned transition with a
//      required reason. Terminal.
//   getExecution / getExecutionStep / listExecutions — the trace surface:
//      the execution with its full append-only step chain, one step
//      deep-linked by canonical stage, and the feed filtered by state /
//      trigger kind / §25 correlation id.
//
// There is deliberately NO operation to update or erase a step, rewrite a
// recorded outcome, un-abandon an execution or delete history: the trace
// is append-only evidence of how Aurum thought (PostgreSQL triggers
// reject UPDATE/DELETE/TRUNCATE on steps, and DELETE/TRUNCATE on
// executions — migration 001). Consequential cognition stays
// reconstructable end to end (§24). Derived CONTENT (claim propositions,
// unknown questions, mission definitions, findings, action payloads,
// learning summaries) is caller-supplied at the stage boundary — the
// bounded-reasoning seam of §19 — while ORDER, GATES, PERSISTENCE and
// TRACEABILITY are application-owned right here.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's executions and
// steps are indistinguishable from missing ones (`execution_not_found` /
// `step_not_found` — no existence leak), and stage-referenced records
// (observations, goals, missions, beliefs, action requests, acquisition
// plans) that are not readable in this tenant are uniformly
// `invalid_reference`.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md:
// W008 + W009 + W010 + W011 + W012 → W013; MODULE-DEPENDENCY-MAP.md:
// `world + goals + epistemics + missions → cognition`): this module
// imports ONLY module contracts — goals (W008), actions (W009 — the
// policy gate), memory (W010 — evidence retrieval + learning capture),
// missions (W011), knowledge-acquisition (W012 — the planner it
// orchestrates), observations (W004 — the loop's evidence intake, the
// step the channels module explicitly assigns to the cognition path),
// world (W005) and epistemics (W007). Nothing else.
// ============================================================================

export {
  abandonExecution,
  getExecution,
  getExecutionStep,
  listExecutions,
  runNextStage,
  startExecution,
} from './service';

export { CognitionError } from './errors';
export type { CognitionErrorCode } from './errors';

// The canonical §19 loop — pure vocabulary/order/derivation logic for
// downstream modules (W014–W019 drive cognition through this contract;
// W046/W049 reconstruct decisions from the trace) and unit testing.
export {
  ABANDONABLE_STATES,
  ADVANCEABLE_STATES,
  EXECUTION_CAUSATION_KINDS,
  EXECUTION_OUTCOME_KINDS,
  EXECUTION_STATES,
  EXECUTION_TRIGGER_KINDS,
  FINAL_STAGE_NUMBER,
  LOOP_STAGES,
  isExecutionCausationKind,
  isExecutionOutcomeKind,
  isExecutionState,
  isExecutionTriggerKind,
  isLoopStage,
  nextStageAfterCompleted,
  outcomeKindForActionGate,
  stageAtNumber,
  stageNumberOf,
} from './loop';
export type {
  ActionGateResult,
  ExecutionCausationKind,
  ExecutionOutcomeKind,
  ExecutionState,
  ExecutionTriggerKind,
  LoopStage,
} from './loop';

// The deterministic workflow-level acquisition-signal derivation (the
// ADR-0018 half W013 owns; W052 knowledge source ranking replaces it) —
// pure, reusable and unit-testable in isolation.
export {
  DEFAULT_INVESTIGATION_COST,
  NEUTRAL_SIGNAL,
  deriveAcquisitionSignals,
  personTopicCoverage,
} from './signals';
export type { SignalDerivationInput, TransactiveCoverageRow } from './signals';

export {
  ANALYSIS_FINDING_KINDS,
  DEFAULT_LIST_LIMIT,
  EXECUTION_ACTOR_KINDS,
  MAX_ALTERNATIVES,
  MAX_CHANNEL_LENGTH,
  MAX_CLAIMS_PER_STAGE,
  MAX_EVIDENCE_REFS,
  MAX_FINDINGS_PER_STAGE,
  MAX_FOCUS_ENTITIES,
  MAX_FOCUS_TOPICS,
  MAX_JUSTIFICATION_LENGTH,
  MAX_KIND_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LIST_LIMIT,
  MAX_METHOD_LENGTH,
  MAX_MISSIONS_PER_STAGE,
  MAX_NOTE_LENGTH,
  MAX_PROPOSITION_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_RECORDED_OBSERVATIONS,
  MAX_REFERENCED_OBSERVATIONS,
  MAX_RELATED_GOALS,
  MAX_STAGE_INPUT_BYTES,
  MAX_STATEMENT_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TOPIC_LENGTH,
  MAX_UNKNOWNS_PER_STAGE,
  isUuid,
} from './validation';

export type {
  ValidatedAbandonInput,
  ValidatedAdvance,
  ValidatedListQuery,
  ValidatedStartInput,
  ValidatedStepQuery,
} from './validation';

export type {
  AbandonExecutionInput,
  ActionProposalInput,
  AdvanceExecutionInput,
  AnalysisFindingInput,
  BeliefUpdateInput,
  ClaimDerivationInput,
  CognitiveExecution,
  CognitiveExecutionStep,
  CognitiveExecutionTrace,
  ExecutionActor,
  ExecutionCausation,
  ExecutionFocus,
  ExecutionOutcome,
  ExecutionTrigger,
  LearningCaptureInput,
  ListExecutionsQuery,
  MissionLaunchInput,
  ObservationIntakeInput,
  RecordedAnalysisFinding,
  StageResult,
  StartExecutionInput,
  UnknownDerivationInput,
  WorldModelUpdateInput,
  WorldUpdateResult,
} from './types';
