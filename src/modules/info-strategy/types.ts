// Public domain types of the info-strategy module (W134 —
// Goal/Context-conditioned Information Strategy).
//
// The work item (spec/MASTER-ROADMAP-2026-10-04.md W134 / WORK-ITEM-CATALOG
// .md W134): "Make information acquisition itself learnable and conditioned
// on a goal and ContextFingerprint." Acceptance: "what to know, source
// choice, freshness/confidence, cost and escalation are represented and
// outcome-tunable; existing Unknown/LearningMission/KnowledgeAcquisition
// authorities remain canonical."
//
// ARCHITECTURE.md companion (AGENT-BODY-LAB-CROSS-PLATFORM-ARCHITECTURE.md
// §3): "The Lab also learns what must be known, who or what should provide
// it, the required freshness/confidence, acquisition cost and escalation
// threshold. This integrates with existing Unknown, LearningMission,
// KnowledgeAcquisition, CompanyModel, Coverage and Goals authorities."
//
// THE CONTEXTUAL RULE (binding): an InfoStrategy is a CONTEXT-CONDITIONED
// HYPOTHESIS for experimentation and outcome learning. There is NO
// hardcoded per-industry or per-task strategy anywhere in this module —
// every field of every strategy is caller-supplied content. The same
// subject under materially different context fingerprints may legitimately
// yield different strategies; that divergence is DATA (two rows), never
// code. What this module owns is the RECORD: scoping, versioning,
// immutability of history and the outcome-evidence seam.
//
// AUTHORITY BOUNDARIES (§10): the strategy layer RECOMMENDS and LEARNS.
// It never becomes a second acquisition authority —
//   * knowledge requirements REFERENCE existing epistemics Unknowns
//     (W007) by opaque id, validated readable at write time; the Unknown
//     record remains the authority on the question and its consequence;
//   * preferred sources are opaque references into the real registries
//     (the coverage module's registry vocabulary); acquisition itself is
//     planned and executed by the missions/knowledge-acquisition
//     authorities, never here;
//   * outcome evidence is OPAQUE — the outcome/measurement authorities
//     (W040 and the acquisition-outcome records) stay the authority on
//     what actually happened; versions record references + what was
//     observed, nothing more;
//   * no operation in this module acquires, executes or self-certifies.
//
// VERSIONING: strategy adjustments are recorded as NEW VERSIONS with
// evidence links; historical versions are immutable (append-only at the
// storage level). Version numbering is UNIQUE per (tenant, strategy) —
// the schema-boundary sweep's per-tenant namespace rule.
//
// Tenancy (ADR-0001): every record is tenant-scoped at the SQL layer;
// another tenant's strategies and versions are indistinguishable from
// missing ones (uniform not-found, no existence leak).

import type { CoverageSourceRegistry } from '@/modules/coverage/contract';

// ---------------------------------------------------------------------------
// Strategy content (the versioned document)
// ---------------------------------------------------------------------------

/**
 * One knowledge requirement — WHAT must be known, expressed AGAINST the
 * existing Unknown authority: an opaque reference to an epistemics
 * Unknown (W007), validated readable at write time. The strategy layer
 * references unknowns; it never duplicates their question or consequence
 * and never records unknowns of its own.
 */
export interface KnowledgeRequirement {
  /** The epistemics Unknown this requirement tracks (opaque id). */
  unknownId: string;
  /**
   * The confidence the strategy aims to reach for this unknown, (0, 1] —
   * the freshness/confidence target vocabulary is per-requirement, so
   * the same strategy can demand 0.9 on safety-critical knowledge and
   * 0.6 on nice-to-have context.
   */
  targetConfidence: number;
  /**
   * Freshness target: the maximum evidence age in seconds this
   * requirement tolerates, when a freshness target applies. NULL = no
   * freshness target (the null-signal law: absence is stated, not
   * defaulted).
   */
  maxEvidenceAgeSeconds: number | null;
  /** Why this requirement is in the strategy (the hypothesis's reasoning). */
  rationale: string;
}

/** Input shape of `KnowledgeRequirement` (maxEvidenceAgeSeconds optional). */
export interface KnowledgeRequirementInput {
  unknownId: string;
  targetConfidence: number;
  maxEvidenceAgeSeconds?: number | null;
  rationale: string;
}

/**
 * One preferred information source — WHO or WHAT should provide the
 * knowledge: an opaque reference into one of the real registries (the
 * coverage module's source registries vocabulary), plus why it is
 * preferred UNDER THIS CONTEXT. Prospective by design: a strategy may
 * prefer a source that is not yet onboarded, so refs are deliberately
 * not cross-module-validated (the acquisition authorities validate
 * routes when they drive acquisition).
 */
export interface PreferredSource {
  /** Which existing registry `ref` points into (coverage vocabulary). */
  registry: CoverageSourceRegistry;
  /** Opaque registry id — never a credential. */
  ref: string;
  /** Why this source is preferred under this goal + context. */
  rationale: string;
}

/** Input shape of `PreferredSource`. */
export interface PreferredSourceInput {
  registry: CoverageSourceRegistry;
  ref: string;
  rationale: string;
}

/** What one acquisition-cost ceiling bounds. */
export type CostCeilingScope = 'per-requirement' | 'per-acquisition' | 'per-strategy';

/**
 * One acquisition cost ceiling — the spend the strategy tolerates for a
 * scope. Integer minor units + ISO currency (the attention module's
 * budget shape; the module never invents money, it records ceilings).
 */
export interface CostCeiling {
  scope: CostCeilingScope;
  amount: number;
  currency: string;
}

/** Input shape of `CostCeiling`. */
export interface CostCeilingInput {
  scope: CostCeilingScope;
  amount: number;
  currency: string;
}

/** What trips one escalation threshold. */
export type EscalationTrigger =
  | 'failed-attempts' // N acquisition attempts failed (afterAttempts required)
  | 'budget-exhausted' // a cost ceiling was exhausted
  | 'freshness-breach' // evidence aged past a freshness target
  | 'confidence-shortfall'; // a target confidence was not reached

/**
 * One escalation threshold — when acquisition under this strategy should
 * escalate instead of continue. The strategy records WHEN to escalate;
 * WHO receives the escalation and any consequential action stay with the
 * policy/attention authorities (§10).
 */
export interface EscalationThreshold {
  trigger: EscalationTrigger;
  /** For 'failed-attempts': after how many failed attempts. NULL otherwise. */
  afterAttempts: number | null;
  /** Human note on the intended escalation path (advisory, not authority). */
  note: string | null;
}

/** Input shape of `EscalationThreshold` (afterAttempts optional). */
export interface EscalationThresholdInput {
  trigger: EscalationTrigger;
  afterAttempts?: number | null;
  note?: string | null;
}

/**
 * The versioned strategy document — the full content of one strategy
 * version. Carried wholesale on every version row (self-contained
 * history: any version decodes alone).
 */
export interface StrategyContent {
  /** What must be known (references to existing Unknowns). */
  knowledgeRequirements: KnowledgeRequirement[];
  /** Who/what should provide it (opaque registry references). */
  preferredSources: PreferredSource[];
  /** Acquisition cost ceilings by scope. */
  costCeilings: CostCeiling[];
  /** When to escalate instead of continue. */
  escalationThresholds: EscalationThreshold[];
}

/** Patch shape of an adjustment — omitted fields carry over unchanged;
 * present fields replace (arrays wholesale), the missions/goals revision
 * precedent. */
export interface StrategyContentPatch {
  knowledgeRequirements?: KnowledgeRequirementInput[];
  preferredSources?: PreferredSourceInput[];
  costCeilings?: CostCeilingInput[];
  escalationThresholds?: EscalationThresholdInput[];
}

// ---------------------------------------------------------------------------
// Outcome evidence (the learning-loop seam)
// ---------------------------------------------------------------------------

/** The outcome-record kinds a version's evidence may reference. */
export const OUTCOME_EVIDENCE_KINDS = [
  'mission',
  'acquisition-plan',
  'intervention',
  'other',
] as const;

export type OutcomeEvidenceKind = (typeof OUTCOME_EVIDENCE_KINDS)[number];

/**
 * One outcome-evidence reference — what actually happened that justifies
 * (or informs) a strategy version. OPAQUE BY DESIGN: the outcome
 * authorities (missions' realized outcomes, the acquisition plans'
 * outcome records, the outcomes module's interventions) remain the
 * authority on what happened; this layer records the reference plus what
 * the outcome showed for THIS strategy's learning. Historical by nature —
 * a version's evidence cites records that may later evolve, exactly like
 * the audit-evidence precedent, so refs are not re-validated after write.
 */
export interface OutcomeEvidence {
  kind: OutcomeEvidenceKind;
  /** The outcome record's id in its owning module (opaque). */
  ref: string;
  /** What the outcome showed (the human-readable learning). */
  observed: string;
}

/** Input shape of `OutcomeEvidence`. */
export interface OutcomeEvidenceInput {
  kind: OutcomeEvidenceKind;
  ref: string;
  observed: string;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type InfoStrategyStatus = 'active' | 'retired';

// ---------------------------------------------------------------------------
// Operations: define / adjust / retire
// ---------------------------------------------------------------------------

/** Input shape of `defineStrategy`. */
export interface DefineStrategyInput {
  /** The goal this strategy is for (validated ACTIVE, goals contract). */
  goalId: string;
  /** The context fingerprint this strategy is conditioned on (validated
   * readable through the context contract — the strategy layer never
   * re-derives context). */
  fingerprintId: string;
  content: {
    knowledgeRequirements: KnowledgeRequirementInput[];
    preferredSources?: PreferredSourceInput[];
    costCeilings?: CostCeilingInput[];
    escalationThresholds?: EscalationThresholdInput[];
  };
  /** Why this strategy, under this context (version 1's note). */
  note?: string | null;
  /** Opaque evidence links for version 1. */
  derivedFrom?: string[];
}

/** Input shape of `adjustStrategy`. */
export interface AdjustStrategyInput {
  strategyId: string;
  /**
   * Content changes (omitted fields carry over from the current version;
   * present fields replace wholesale). An adjustment with NO changes and
   * NO outcome evidence is refused — a version must record something.
   */
  changes?: StrategyContentPatch;
  /**
   * The outcome evidence that justifies this adjustment — the learning
   * loop's input. Recorded on the new version, immutable from then on.
   */
  outcomeEvidence?: OutcomeEvidenceInput[];
  /** Why this adjustment (required — every version is auditable). */
  note: string;
  /** Opaque evidence links for the new version. */
  derivedFrom?: string[];
}

/** Input shape of `retireStrategy`. */
export interface RetireStrategyInput {
  strategyId: string;
  /** Why the strategy is being retired (required, retained). */
  reason: string;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** One version of a strategy — a self-contained immutable audit record. */
export interface InfoStrategyVersion {
  id: string;
  tenantId: string;
  strategyId: string;
  /** 1-based version number, unique per (tenant, strategy). */
  version: number;
  content: StrategyContent;
  /** The outcome evidence that justified this version. */
  outcomeEvidence: OutcomeEvidence[];
  /** The version's note (why this version exists). */
  note: string | null;
  /** Opaque evidence links. */
  derivedFrom: string[];
  /** The authenticated principal that recorded the version. */
  recordedBy: string;
  /** ISO 8601 — when the version was committed (service clock). */
  recordedAt: string;
}

/**
 * The current view of a strategy: identity + scope + lifecycle + the
 * current version's content. History is fetched separately
 * (`listStrategyVersions`) and never rewritten.
 */
export interface InfoStrategy {
  id: string;
  tenantId: string;
  goalId: string;
  fingerprintId: string;
  status: InfoStrategyStatus;
  /** The current version number. */
  currentVersion: number;
  /** The current version's content. */
  content: StrategyContent;
  /** The current version's note. */
  note: string | null;
  /** The outcome evidence that justified the current version. */
  outcomeEvidence: OutcomeEvidence[];
  /** Why the strategy was retired ('retired' only). */
  lifecycleNote: string | null;
  /** ISO 8601 — retirement time ('retired' only). */
  retiredAt: string | null;
  /** ISO 8601 — when version 1 was committed. */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  updatedAt: string;
}

/** `listStrategies` summary row (deep-link with `getStrategy`). */
export interface InfoStrategySummary {
  id: string;
  tenantId: string;
  goalId: string;
  fingerprintId: string;
  status: InfoStrategyStatus;
  currentVersion: number;
  /** How many versions exist (the strategy's adjustment history depth). */
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Query shape of `getStrategy`. */
export interface GetStrategyQuery {
  strategyId: string;
}

/** Query shape of `getStrategyVersion`. */
export interface GetStrategyVersionQuery {
  strategyId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listStrategyVersions`. */
export interface ListStrategyVersionsQuery {
  strategyId: string;
}

/** Query shape of `listStrategies`. All filters are optional and AND-combined. */
export interface ListStrategiesQuery {
  goalId?: string;
  fingerprintId?: string;
  status?: InfoStrategyStatus;
  limit?: number;
}
