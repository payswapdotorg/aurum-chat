// Public domain types of the processes module (W016 — Process Intelligence).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W016):
// "Reconstruct processes from events/observations; detect bottlenecks,
//  duplication, handoffs, manual effort and errors."
//
// ARCHITECTURE.md §13 (frozen): "Aurum reconstructs how work actually occurs
// from observed events and identifies bottlenecks, repeated work, duplicated
// entry, unnecessary handoffs, errors, approvals and manual effort."
//
// A reconstructed process is UNDERSTANDING, not reality (ARCHITECTURE.md §4:
// "Reality is immutable; understanding is mutable"). The immutable facts are
// the events (W003) and observations (W004) this module reads THROUGH their
// contracts; the reconstruction derived from them is versioned understanding
// in the missions/goals discipline: a process is an identity (uuid + name,
// unique per tenant) plus an append-only chain of full-snapshot
// `process_versions` — every reconstruction appends the next version and
// never rewrites history, so what Aurum believed about a process at any time
// stays reconstructable (§24 decision evidence).
//
// Each version carries:
//   * the EVIDENCE SCOPE it was derived from (which event types, which
//     observation kinds, which occurrence window, how observations map to
//     process cases) — the reconstruction is reproducible from the scope
//     because the underlying evidence is immutable;
//   * the reconstructed MODEL — steps (activity types with frequencies and
//     actor breakdown), edges (the directly-follows flow graph with wait
//     times), variants (observed activity sequences) and aggregate stats;
//   * the DETECTION OPTIONS in force (thresholds, error classifications) —
//     findings are deterministic functions of model + options;
//   * the audit quartet (who triggered it, when, what change kind, why).
//
// FINDINGS (process_findings) are the five inefficiency kinds the work item
// names, each evidence-linked to the exact events/observations that justify
// it and confidence-derived from support counts (never authoritative truth —
// lock 10 — and never employee assessments: workforce intelligence W019 owns
// those, with alternative explanations; a process finding is about HOW WORK
// FLOWS, not about a person's performance):
//   * bottleneck    — a directly-follows edge whose average wait time is at
//                     or above the bottleneck threshold (explicit, or twice
//                     the median edge wait);
//   * duplication   — an activity type repeated within a single case (rework
//                     / repeated entry);
//   * handoff       — a ping-pong actor pattern (A → B → A on consecutive
//                     steps): work leaves an actor and immediately returns;
//   * manual_effort — an activity type predominantly performed by humans
//                     (actor kind `person`) at or above the manual share;
//   * error         — occurrences of an error-classified activity type
//                     (`.failed` / `.error` / `.rejected` suffixes, plus
//                     caller-declared types).
//
// AutomationOpportunity (W018) is NOT built here: lock 19 says process
// intelligence "can create explicit AutomationOpportunity findings" — that
// downstream object and its `processes + capabilities → automation`
// dependency belong to the automation module; this module exposes the
// evidence-backed process findings it will consume through THIS contract.
//
// Provider neutrality (lock 16): the actor that triggers a reconstruction is
// a provider-neutral party reference (kind + opaque id and/or label), and
// activity actors come from the events/observations envelopes (already
// provider-neutral). `worldEntityId` is an opaque forward reference to a
// world-model (W005) `process` entity — the world module owns declared
// process entities; this module owns the observed flow. No cross-module
// foreign keys, no contract imports for it (the missions module's
// affected-goals precedent).

/** The five inefficiency kinds W016 detects (TEXT + CHECK in storage). */
export type ProcessFindingKind =
  | 'bottleneck'
  | 'duplication'
  | 'handoff'
  | 'manual_effort'
  | 'error';

/**
 * What kind of change one process version represents — service-minted,
 * never caller-supplied:
 *  * 'created'       — version 1 (the first reconstruction of this process);
 *  * 'reconstructed' — every later version (a re-reconstruction from the
 *    then-current evidence; the previous version stays as recorded).
 */
export type ProcessChangeKind = 'created' | 'reconstructed';

/**
 * Kinds of parties that can trigger a reconstruction (the audit actor).
 * Mirrors the events envelope's actor vocabulary minus `source` (a source
 * connector does not decide to reconstruct processes; the cognition loop,
 * a manager or a system does).
 */
export type ProcessPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned by
 * the respective module (people for `person`, world for `team`, agents for
 * `agent`), a human-readable `label`, or both. At least one must be present
 * — whoever triggers a reconstruction must be traceable.
 */
export interface ProcessParty {
  kind: ProcessPartyKind;
  id?: string | null;
  label?: string | null;
}

/**
 * The actor kinds that can perform an activity occurrence, unified across
 * the two evidence surfaces: the events envelope's actor kinds
 * (person | agent | system | external | source) and the observations
 * envelope's source kinds (source | person | agent | system | external) —
 * the same five values. `person` is manual effort; `agent`/`system` are
 * automated; `external`/`source` are neither (an external party or an
 * ingestion surface — neutral for manual-effort detection).
 */
export type ActivityActorKind = 'person' | 'agent' | 'system' | 'external' | 'source';

/**
 * One step of the reconstructed process: every occurrence of one activity
 * type (an event `type` or an observation `kind`), aggregated.
 */
export interface ProcessStep {
  /** Canonical activity classification (event type or observation kind). */
  activityType: string;
  /** Total occurrences across all cases. */
  instances: number;
  /** Cases containing at least one occurrence. */
  cases: number;
  /** Occurrences per actor kind (manual/automated breakdown). */
  actorCounts: Record<ActivityActorKind, number>;
  /** person occurrences / instances (0 when no occurrences). */
  manualShare: number;
  /** ISO 8601 — earliest occurrence of this activity in scope. */
  firstOccurredAt: string;
  /** ISO 8601 — latest occurrence of this activity in scope. */
  lastOccurredAt: string;
}

/**
 * One edge of the directly-follows flow graph: activity `fromActivity` was
 * immediately followed by `toActivity` within the same case `instances`
 * times. Wait time is the occurrence-time distance between the two
 * activities of an edge instance.
 */
export interface ProcessEdge {
  fromActivity: string;
  toActivity: string;
  instances: number;
  /** Mean wait across instances, seconds (rounded to milliseconds). */
  avgWaitSeconds: number;
  /** Longest observed wait, seconds (rounded to milliseconds). */
  maxWaitSeconds: number;
}

/** One observed variant: an activity sequence with its case count. */
export interface ProcessVariant {
  /** The activity sequence, in case order (at least one activity). */
  sequence: string[];
  /** Cases that followed exactly this sequence. */
  instances: number;
}

/** Aggregate statistics of one reconstruction. */
export interface ProcessStats {
  /** Distinct process cases (event correlation flows + observation case keys). */
  caseCount: number;
  /** Total activity occurrences (events + observations in scope). */
  occurrenceCount: number;
  /** Occurrences sourced from events. */
  eventCount: number;
  /** Occurrences sourced from observations. */
  observationCount: number;
  /** Distinct activity types. */
  distinctActivityTypes: number;
  /** Distinct directly-follows edges. */
  distinctEdges: number;
  /** Distinct variants observed (true count, before storage truncation). */
  variantCount: number;
  /** Variants stored on the version (top N by instances). */
  variantsStored: number;
  /** person occurrences / occurrenceCount (0 when no occurrences). */
  manualShare: number;
  /** Consecutive step pairs performed by different actors. */
  handoffCount: number;
  /** Occurrences of error-classified activity types. */
  errorCount: number;
  /** Mean first-to-last duration across cases with ≥ 2 occurrences, seconds. */
  avgCaseDurationSeconds: number | null;
  /** Shortest case duration, seconds (same population as the mean). */
  minCaseDurationSeconds: number | null;
  /** Longest case duration, seconds (same population as the mean). */
  maxCaseDurationSeconds: number | null;
  /**
   * True when at least one observation kind returned the list cap — the
   * observation window is then the latest N of that kind, not all of it
   * (the observations contract pages by recordedAt with no cursor; this is
   * the freshness module's documented bound precedent).
   */
  observationWindowTruncated: boolean;
}

/**
 * Detection options — the deterministic knobs findings are computed with.
 * Stored on every version so a version's findings are reproducible.
 */
export interface ReconstructionOptions {
  /**
   * Bottleneck threshold in seconds. `null` (default) derives it from the
   * model: twice the median average wait of the qualifying edges.
   */
  bottleneckThresholdSeconds: number | null;
  /** An edge qualifies for bottleneck detection at this many instances. */
  minEdgeInstances: number;
  /** A step is manual effort at or above this person share, in (0, 1]. */
  manualShareThreshold: number;
  /** Caller-declared error activity types (exact matches, beyond suffixes). */
  errorActivityTypes: string[];
  /** Maximum events read per reconstruction (evidence volume bound). */
  maxEvents: number;
}

/** Input shape of `ReconstructionOptions` (all fields optional). */
export interface ReconstructionOptionsInput {
  bottleneckThresholdSeconds?: number | null;
  minEdgeInstances?: number;
  manualShareThreshold?: number;
  errorActivityTypes?: string[];
  maxEvents?: number;
}

/**
 * The evidence scope of one reconstruction — which immutable evidence the
 * version was derived from. Both event types and observation kinds use the
 * canonical classification patterns of their modules; at least one must be
 * non-empty (a reconstruction declares its evidence, it never trawls the
 * whole log).
 */
export interface ProcessScope {
  /** Event types in scope (validated against the events module's pattern). */
  eventTypes: string[];
  /** Observation kinds in scope (validated against the observations module's pattern). */
  observationKinds: string[];
  /**
   * Payload keys that group observations into cases, in priority order: the
   * first key present on an observation payload (with a string/number
   * value) supplies the case id. Events never need this — their
   * correlationId IS the flow id (W003). Observations without a resolvable
   * case key form single-activity cases (they contribute to step, manual
   * and error statistics, never to flow edges).
   */
  caseKeyCandidates: string[];
  /** Inclusive lower bound on occurrence time (events: occurredAt; observations: observedAt). */
  occurredFrom: string | null;
  /** Inclusive upper bound on occurrence time. */
  occurredTo: string | null;
  /** Opaque forward reference to a world-model (W005) `process` entity. */
  worldEntityId: string | null;
}

/** Input shape of `ProcessScope` (eventTypes/observationKinds optional here; at least one required). */
export interface ProcessScopeInput {
  eventTypes?: string[];
  observationKinds?: string[];
  caseKeyCandidates?: string[];
  occurredFrom?: string;
  occurredTo?: string;
  worldEntityId?: string | null;
}

/** Input shape of `reconstructProcess`. */
export interface ReconstructProcessInput {
  /**
   * Process name — unique per tenant. Reconstructing an existing name
   * appends the next version of that process; a new name creates a new
   * process identity with version 1.
   */
  name: string;
  scope: ProcessScopeInput;
  /**
   * Optimistic concurrency: when set, the reconstruction must build on this
   * version number. A mismatch (stale reader or concurrent reconstruction)
   * fails with `process_conflict` — never a silent overwrite of expectations.
   */
  expectedVersion?: number;
  options?: ReconstructionOptionsInput;
  /** Who triggered the reconstruction (audit trail). */
  actor: ProcessPartyInput;
  /** Why this reconstruction was run — optional, recorded on the version. */
  rationale?: string | null;
}

/** Input shape of `ProcessParty`. */
export interface ProcessPartyInput {
  kind: ProcessPartyKind;
  id?: string | null;
  label?: string | null;
}

/**
 * One detected inefficiency — evidence-backed, deterministic given the
 * version's model + options, and never authoritative truth (lock 10): it is
 * an input for automation opportunities (W018) and management attention,
 * each finding citing the exact evidence that justifies it.
 */
export interface ProcessFinding {
  id: string;
  tenantId: string;
  processId: string;
  /** The process version this finding belongs to (findings belong to a reconstruction). */
  version: number;
  kind: ProcessFindingKind;
  /**
   * Deterministic subject key: `edge:{from}->{to}` (bottleneck),
   * `step:{activityType}` (duplication/manual_effort/error) or
   * `ping-pong:{from}->{mid}->{to}` (handoff).
   */
  subject: string;
  /** Human-readable one-line summary (deterministic). */
  summary: string;
  /** Kind-specific measurements (deterministic; see reconstruction docs). */
  metrics: Record<string, unknown>;
  /** Evidence: event ids cited by this finding (capped, most recent first). */
  evidenceEventIds: string[];
  /** Evidence: observation ids cited by this finding (capped, most recent first). */
  evidenceObservationIds: string[];
  /** Derived from support counts: min(0.9, 0.5 + 0.1 × support), in [0.5, 0.9]. */
  confidence: number;
  /** The authenticated TenantContext principal that committed the reconstruction. */
  detectedByPrincipal: string;
  /** ISO 8601 — when the finding was committed (with its version). */
  detectedAt: string;
}

/** One append-only version of a process — a full, self-contained reconstruction. */
export interface ProcessVersion {
  /** Version-row id (distinct from the process identity). */
  id: string;
  tenantId: string;
  processId: string;
  /** 1-based, strictly increasing per process; service-minted. */
  version: number;
  changeKind: ProcessChangeKind;
  name: string;
  scope: ProcessScope;
  steps: ProcessStep[];
  edges: ProcessEdge[];
  variants: ProcessVariant[];
  stats: ProcessStats;
  options: ReconstructionOptions;
  /** Who triggered this reconstruction (domain provenance). */
  actor: ProcessParty;
  /** The authenticated TenantContext principal that committed this version. */
  changedByPrincipal: string;
  /** Why this reconstruction was run, if stated. */
  rationale: string | null;
  /** ISO 8601 — when Aurum committed this version (service clock). */
  recordedAt: string;
}

/** Finding counts per kind of one process version. */
export interface ProcessFindingCounts {
  bottleneck: number;
  duplication: number;
  handoff: number;
  manualEffort: number;
  error: number;
}

/**
 * The current view of a process: identity + the current version's scope,
 * stats and options + audit summary + finding counts of the current version.
 * The full model (steps/edges/variants) lives on `getProcessVersion` /
 * `listProcessVersions`; the current view is the management summary.
 */
export interface Process {
  id: string;
  tenantId: string;
  name: string;
  /** Current version number. */
  version: number;
  scope: ProcessScope;
  stats: ProcessStats;
  options: ReconstructionOptions;
  /** Finding counts of the current version, by kind. */
  findingCounts: ProcessFindingCounts;
  /** ISO 8601 — when the process identity was created (version 1 commit). */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  updatedAt: string;
  /** Audit summary of the change that produced the current version. */
  lastChange: {
    kind: ProcessChangeKind;
    actor: ProcessParty;
    changedByPrincipal: string;
    rationale: string | null;
    recordedAt: string;
  };
}

/** Query shape of `getProcessVersion`. */
export interface GetProcessVersionQuery {
  processId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listProcessVersions`. */
export interface ListProcessVersionsQuery {
  processId: string;
}

/**
 * Query shape of `listProcessFindings`. `version` defaults to the process's
 * CURRENT version (the management view); an explicit version audits a past
 * reconstruction's findings.
 */
export interface ListProcessFindingsQuery {
  processId: string;
  version?: number;
  kind?: ProcessFindingKind;
  /** Only findings at or above this confidence, in [0, 1]. */
  minConfidence?: number;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getProcessFinding`. */
export interface GetProcessFindingQuery {
  findingId: string;
}

/** Query shape of `listProcesses` (over CURRENT versions only). */
export interface ListProcessesQuery {
  /** Exact name match. */
  name?: string;
  /** Case-insensitive substring on the name. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}
