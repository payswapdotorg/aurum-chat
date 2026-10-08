// ============================================================================
// info-strategy — the ONLY public surface of the info-strategy module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W134 — Goal/Context-conditioned Information Strategy
// (spec/MASTER-ROADMAP-2026-10-04.md W134 + WORK-ITEM-CATALOG.md W134):
// "Make information acquisition itself learnable and conditioned on a goal
//  and ContextFingerprint." Acceptance: "what to know, source choice,
//  freshness/confidence, cost and escalation are represented and
//  outcome-tunable; existing Unknown/LearningMission/KnowledgeAcquisition
//  authorities remain canonical."
//
//   defineStrategy — record ONE strategy scoped per (tenant, goal,
//      context fingerprint): what must be known (REFERENCES to existing
//      epistemics Unknowns — never a second unknown authority), preferred
//      information sources (opaque registry references), per-requirement
//      freshness/confidence targets, acquisition cost ceilings by scope
//      and escalation thresholds. Content is ALWAYS caller-supplied:
//      THE CONTEXTUAL RULE forbids any hardcoded per-industry or
//      per-task strategy, and this surface has no operation that could
//      generate one. One ACTIVE strategy per scope; the same goal under a
//      different fingerprint is a different (equally legitimate) strategy.
//   adjustStrategy — the LEARNING LOOP: append the next version carrying
//      content changes (omitted fields carry over; arrays replace
//      wholesale) and/or the OUTCOME EVIDENCE that justifies it. Version
//      numbers are system-minted, unique per (tenant, strategy);
//      historical versions are immutable (PostgreSQL triggers reject
//      UPDATE/DELETE/TRUNCATE outright).
//   retireStrategy — the one-way active → retired transition with a
//      required reason. Terminal: the returning need is a NEW definition
//      for the scope (history stays readable forever).
//   getStrategy / getStrategyVersion / listStrategyVersions /
//      listStrategies — tenant-scoped reads of current views, audit
//      records and history.
//
// Refs validated at write time: goal ACTIVE (goals contract), fingerprint
// readable (context contract), every tracked unknown readable (epistemics
// contract). Preferred sources and outcome evidence stay OPAQUE by
// design — prospective and historical references respectively (see
// types.ts for the rationale); the acquisition and outcome authorities
// stay canonical.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's strategies and
// versions are indistinguishable from missing ones — no existence leak.
//
// Cross-module reads: goals (W008), epistemics (W007), context (W134) and
// the coverage registry VOCABULARY (W125) — all through their public
// contracts. Error propagation policy: see errors.ts.
// ============================================================================

export {
  adjustStrategy,
  defineStrategy,
  getStrategy,
  getStrategyVersion,
  listStrategies,
  listStrategyVersions,
  retireStrategy,
} from './service';

export { InfoStrategyError } from './errors';
export type { InfoStrategyErrorCode } from './errors';

export {
  // vocabularies + guards
  COST_CEILING_SCOPES,
  ESCALATION_TRIGGERS,
  OUTCOME_EVIDENCE_KINDS,
  isCostCeilingScope,
  isEscalationTrigger,
  isOutcomeEvidenceKind,
  isPreferredSourceRegistry,
  isUuid,
  // limits
  DEFAULT_LIST_LIMIT,
  MAX_AMOUNT,
  MAX_ATTEMPTS,
  MAX_COST_CEILINGS,
  MAX_ESCALATION_THRESHOLDS,
  MAX_EVIDENCE_REFS,
  MAX_LIST_LIMIT,
  MAX_NOTE_CHARS,
  MAX_OBSERVED_CHARS,
  MAX_OUTCOME_EVIDENCE,
  MAX_PREFERRED_SOURCES,
  MAX_RATIONALE_CHARS,
  MAX_REQUIREMENTS,
} from './validation';

export type {
  ValidatedAdjustStrategyInput,
  ValidatedDefineStrategyInput,
  ValidatedGetStrategyQuery,
  ValidatedGetStrategyVersionQuery,
  ValidatedListStrategiesQuery,
  ValidatedListStrategyVersionsQuery,
  ValidatedRetireStrategyInput,
  ValidatedStrategyContent,
  ValidatedStrategyContentPatch,
} from './validation';

export type {
  AdjustStrategyInput,
  CostCeiling,
  CostCeilingInput,
  CostCeilingScope,
  DefineStrategyInput,
  EscalationThreshold,
  EscalationThresholdInput,
  EscalationTrigger,
  GetStrategyQuery,
  GetStrategyVersionQuery,
  InfoStrategy,
  InfoStrategyStatus,
  InfoStrategySummary,
  InfoStrategyVersion,
  KnowledgeRequirement,
  KnowledgeRequirementInput,
  ListStrategiesQuery,
  ListStrategyVersionsQuery,
  OutcomeEvidence,
  OutcomeEvidenceInput,
  OutcomeEvidenceKind,
  PreferredSource,
  PreferredSourceInput,
  RetireStrategyInput,
  StrategyContent,
  StrategyContentPatch,
} from './types';
