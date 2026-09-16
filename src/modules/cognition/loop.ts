// Pure canonical-loop logic of the cognition module (W013 — Cognitive
// Orchestrator). No database, no context, no time: everything here is a
// total function of its arguments, so the loop's SHAPE is testable and
// auditable without touching storage.
//
// ARCHITECTURE.md §19 (frozen) defines the canonical execution of the
// company intelligence loop:
//
//   `observation → evidence/memory → world update → epistemic evaluation
//    → goal evaluation → unknown/mission evaluation → knowledge
//    acquisition → model update → risk/opportunity/capability analysis
//    → recommendation/ask/proposal/action → outcome → learning`
//
// and demands: "Cognitive executions are explicit, asynchronous, resumable
// and traceable." (lock 36). LOOP_STAGES below is that exact sequence,
// one slug per arrow target, in order — the orchestrator never lets a
// cycle skip, reorder or repeat a stage: each cycle of the loop runs the
// canonical sequence exactly once, appending one traceable step per stage.
//
// The stage slugs are kebab-case renderings of the §19 arrows:
//   observation, evidence-memory, world-update, epistemic-evaluation,
//   goal-evaluation, unknown-mission-evaluation, knowledge-acquisition,
//   model-update, risk-opportunity-capability-analysis,
//   recommendation-ask-proposal-action, outcome, learning.
//
// LLM calls are bounded reasoning capabilities, not workflow authority
// (§19): the loop's ORDER, its gates and its outcome derivation here are
// pure application-owned code; derived CONTENT (claims, unknowns,
// findings, proposed actions, learnings) enters through validated stage
// inputs and is recorded as evidence/versions by the owning modules.

// (No imports needed: this file is pure by design — see the header.)

/** The canonical §19 loop stages, in execution order. */
export const LOOP_STAGES = [
  'observation',
  'evidence-memory',
  'world-update',
  'epistemic-evaluation',
  'goal-evaluation',
  'unknown-mission-evaluation',
  'knowledge-acquisition',
  'model-update',
  'risk-opportunity-capability-analysis',
  'recommendation-ask-proposal-action',
  'outcome',
  'learning',
] as const;

export type LoopStage = (typeof LOOP_STAGES)[number];

/** 1-based number of the final canonical stage ('learning'). */
export const FINAL_STAGE_NUMBER: number = LOOP_STAGES.length;

/** Lifecycle states of a cognitive execution (lock 36 — async/resumable). */
export const EXECUTION_STATES = [
  'running',
  'awaiting_input',
  'awaiting_approval',
  'completed',
  'abandoned',
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** States a worker may pump forward with `runNextStage`. */
export const ADVANCEABLE_STATES = ['running', 'awaiting_input', 'awaiting_approval'] as const;

/** States from which an execution may still be abandoned. */
export const ABANDONABLE_STATES = ['running', 'awaiting_input', 'awaiting_approval'] as const;

/**
 * What the outcome stage records for the whole cycle — the loop's terminal
 * classification, derived deterministically from the action stage's gate
 * result (§2 "act when authorized"; §24 "…→ approval → execution → result
 * → outcome"):
 *   'action-authorized' — the policy gate released a consequential action;
 *   'action-refused'    — the policy gate refused/rejected the action;
 *   'no-action'         — the cycle proposed no consequential action.
 */
export const EXECUTION_OUTCOME_KINDS = [
  'action-authorized',
  'action-refused',
  'no-action',
] as const;

export type ExecutionOutcomeKind = (typeof EXECUTION_OUTCOME_KINDS)[number];

/** What may start a cognitive execution (provider-neutral trigger refs). */
export const EXECUTION_TRIGGER_KINDS = [
  'observation',
  'conversation',
  'mission',
  'management',
  'system',
  'schedule',
] as const;

export type ExecutionTriggerKind = (typeof EXECUTION_TRIGGER_KINDS)[number];

/** Kinds of records that may CAUSE an execution (§25 causation identity). */
export const EXECUTION_CAUSATION_KINDS = [
  'execution',
  'event',
  'conversation-message',
  'mission',
  'observation',
  'schedule',
] as const;

export type ExecutionCausationKind = (typeof EXECUTION_CAUSATION_KINDS)[number];

export function isLoopStage(value: unknown): value is LoopStage {
  return (
    typeof value === 'string' && (LOOP_STAGES as readonly string[]).includes(value)
  );
}

export function isExecutionState(value: unknown): value is ExecutionState {
  return (
    typeof value === 'string' && (EXECUTION_STATES as readonly string[]).includes(value)
  );
}

export function isExecutionTriggerKind(value: unknown): value is ExecutionTriggerKind {
  return (
    typeof value === 'string' &&
    (EXECUTION_TRIGGER_KINDS as readonly string[]).includes(value)
  );
}

export function isExecutionCausationKind(value: unknown): value is ExecutionCausationKind {
  return (
    typeof value === 'string' &&
    (EXECUTION_CAUSATION_KINDS as readonly string[]).includes(value)
  );
}

export function isExecutionOutcomeKind(value: unknown): value is ExecutionOutcomeKind {
  return (
    typeof value === 'string' &&
    (EXECUTION_OUTCOME_KINDS as readonly string[]).includes(value)
  );
}

/** 1-based canonical position of `stage` in LOOP_STAGES. */
export function stageNumberOf(stage: LoopStage): number {
  return LOOP_STAGES.indexOf(stage) + 1;
}

/** The canonical stage at 1-based `number`, or null when out of range. */
export function stageAtNumber(number: number): LoopStage | null {
  const index = number - 1;
  if (!Number.isInteger(number) || index < 0 || index >= LOOP_STAGES.length) return null;
  return LOOP_STAGES[index]!;
}

/**
 * The next stage to run for an execution that has completed `completed`
 * canonical stages: null once every stage has completed (the execution is
 * finishing — the service maps that to the terminal 'completed' state).
 */
export function nextStageAfterCompleted(completed: number): LoopStage | null {
  if (!Number.isInteger(completed) || completed < 0) return null;
  return stageAtNumber(completed + 1);
}

/** The gate result recorded by the action stage (§20 matrix outcomes + human resolution). */
export interface ActionGateResult {
  /** Null when the cycle proposed no action ('no-action'). */
  actionRequest: {
    id: string;
    actionKind: string;
    authorityLevel: string;
    status: string;
    outcome: string;
    resolvedVia: string;
  } | null;
  /** The matrix evaluation outcome at gate time: 'allowed' | 'forbidden' | 'approval_required', or null with no action. */
  gate: 'allowed' | 'forbidden' | 'approval_required' | null;
  /** The human decision that resolved an 'approval_required' gate, if any. */
  resolution: 'approved' | 'rejected' | null;
}

/**
 * Derive the cycle's outcome kind from the action stage's gate result —
 * the deterministic core of "outcome recording" (§24). Pure, total:
 * no action → 'no-action'; a released action → 'action-authorized';
 * a refused or rejected action → 'action-refused'.
 */
export function outcomeKindForActionGate(result: ActionGateResult): ExecutionOutcomeKind {
  if (result.actionRequest === null) return 'no-action';
  if (result.gate === 'allowed') return 'action-authorized';
  if (result.gate === 'forbidden') return 'action-refused';
  // approval_required: the human decision decides.
  return result.resolution === 'approved' ? 'action-authorized' : 'action-refused';
}
