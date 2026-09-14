// Public domain types of the observations module (W004 — Observations and
// Provenance).
//
// An Observation is evidence encountered by Aurum, with full provenance:
// where it came from (source), through which conduit (channel), when it
// happened per the source's clock (observedAt) and when Aurum committed it
// (recordedAt — service-controlled), how it was produced (extraction
// lineage), which access constraints govern it (permissions) and how much
// Aurum trusts its content (confidence).
//
// An observation is EVIDENCE, never truth (ARCHITECTURE.md §4, lock 5/10):
// it is immutable (lock 5), contradictory observations are all retained
// (lock 12) and nothing in this module can promote an observation into an
// authoritative belief — claims/beliefs are the epistemics module's concepts
// (W007) built ON TOP of observations. Confidence therefore describes the
// reliability of the evidence, not its truth.

/** Where an observation's evidence originated (provider-neutral). */
export type ObservationSourceKind = 'source' | 'person' | 'agent' | 'system' | 'external';

/**
 * Provenance reference to the origin of an observation.
 *
 * `id` is an opaque reference to the record owned by the respective module
 * (sources module W036 for `source`, people module W002 for `person`, agents
 * module W021+ for `agent`); none of those modules exists yet at W004, so no
 * cross-module foreign keys are possible (MODULE-DEPENDENCY-MAP.md) and the
 * reference is deliberately unverified here. `label` carries a human-readable
 * origin when no registered record exists (`external`, `system`).
 * At least one of `id` / `label` must be present — provenance must be
 * traceable.
 */
export interface ObservationSource {
  kind: ObservationSourceKind;
  id?: string | null;
  label?: string | null;
}

/** How an observation came to exist. */
export type LineageMethod =
  | 'direct' // captured first-hand by Aurum itself
  | 'connector' // ingested by a source connector
  | 'extraction' // structured content extracted from parent observation(s)
  | 'transformation' // normalized/derived from parent observation(s)
  | 'inference'; // produced by a reasoning step over parent observation(s)

/**
 * Provider-neutral metadata about the extractor that produced a derived
 * observation (methods `extraction` / `inference`), e.g. the LLM behind a
 * gateway call. Lock 10/28: LLM output is evidence with lineage and never
 * authoritative merely because an LLM produced it — recording the extractor
 * is what keeps that auditable. Provider and model are neutral keys
 * supplied by the LLM gateway (W034); no provider SDK object crosses this
 * contract (lock 16).
 */
export interface ExtractorInfo {
  provider: string;
  model: string;
  notes?: string | null;
}

/** Extraction lineage of an observation. */
export interface ObservationLineage {
  method: LineageMethod;
  /** Ids of the observations this one was derived from (empty for `direct`/`connector`). */
  parents: string[];
  extractor: ExtractorInfo | null;
}

/** Who may read an observation (recorded access constraint). */
export type ObservationVisibility = 'tenant' | 'workspace' | 'principal';

/**
 * Permissions recorded on an observation.
 *
 * - `tenant`    — every member of the tenant (default);
 * - `workspace` — scoped to a workspace (opaque uuid; workspace-membership
 *   enforcement arrives with the policy layer W009 / Control Tower W033 —
 *   W004 records the constraint and enforces the tenant boundary);
 * - `principal` — scoped to one acting principal (enforced on read within
 *   this module: only that principal may retrieve the observation).
 *
 * `usage` carries usage-constraint tags (e.g. `no-llm`, `no-export`) for the
 * policy layer; W004 records them and keeps them immutable with the
 * observation.
 */
export interface ObservationPermissions {
  visibility: ObservationVisibility;
  workspaceId: string | null;
  principalId: string | null;
  usage: string[];
}

/** Calibrated confidence in an observation's content. */
export interface ObservationConfidence {
  /** Inclusive [0, 1]. Describes evidence reliability — never truth. */
  value: number;
  /** How the value was produced (vocabulary of the recording path, e.g. `source_trust`). */
  method: string;
  basis: string | null;
}

/** Input shape of `recordObservation` — `lineage` and `permissions` default. */
export interface RecordObservationInput {
  /** Canonical classification, e.g. `channel.message`, `document.note`, `metric.sample`. */
  kind: string;
  /** The observed content — any plain JSON value (must be JSON-serializable, non-null). */
  payload: unknown;
  /**
   * When the observed thing happened, per the source's clock — strict ISO
   * 8601 with explicit offset. Freshness/latency (W006) is derived from
   * `observedAt` vs the service-set `recordedAt`.
   */
  observedAt: string;
  source: ObservationSource;
  /** Provider-neutral channel key, e.g. `whatsapp`, `api`, `ingestion` (lock 16: keys, never provider objects). */
  channel: string;
  lineage?: ObservationLineageInput;
  permissions?: ObservationPermissionsInput;
  /** Required — evidence never enters the system without explicit confidence. */
  confidence: ObservationConfidenceInput;
}

export interface ObservationLineageInput {
  /** Defaults to `direct`. Deriving methods require `parents` and vice versa. */
  method?: LineageMethod;
  parents?: string[];
  extractor?: ExtractorInfo | null;
}

export interface ObservationPermissionsInput {
  /** Defaults to `tenant`. */
  visibility?: ObservationVisibility;
  workspaceId?: string | null;
  principalId?: string | null;
  usage?: string[];
}

export interface ObservationConfidenceInput {
  value: number;
  method: string;
  basis?: string | null;
}

/** Query shape of `listObservations`. */
export interface ListObservationsQuery {
  kind?: string;
  channel?: string;
  sourceKind?: ObservationSourceKind;
  /** Requires `sourceKind` (an id is meaningless without its kind). */
  sourceId?: string;
  /** Inclusive lower bound on `observedAt` — strict ISO 8601. */
  observedFrom?: string;
  /** Inclusive upper bound on `observedAt` — strict ISO 8601. */
  observedTo?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** One recorded observation — the persisted, immutable evidence record. */
export interface Observation {
  id: string;
  tenantId: string;
  kind: string;
  payload: unknown;
  /** ISO 8601 — when the observed thing happened (source clock). */
  observedAt: string;
  /** ISO 8601 — when Aurum committed the observation (service-controlled). */
  recordedAt: string;
  source: ObservationSource;
  channel: string;
  lineage: ObservationLineage;
  permissions: ObservationPermissions;
  confidence: ObservationConfidence;
}

/** A provenance edge: `observationId` was derived from `parentObservationId`. */
export interface ObservationLineageEdge {
  observationId: string;
  parentObservationId: string;
}

/**
 * Full extraction lineage of one observation: the observation itself, every
 * ancestor edge reachable from it, and the (deduplicated) ancestor
 * observations readable by the caller. Ancestors the caller may not read
 * are omitted together with their edges (a partial lineage view, never a
 * restricted-content leak).
 */
export interface ObservationLineageResult {
  observation: Observation;
  edges: ObservationLineageEdge[];
  ancestors: Observation[];
}
