// Public domain types of the memory module (W010 — Organizational Memory).
//
// Memory is the "remember" stage of the canonical company intelligence loop
// (ARCHITECTURE.md §2: `observe → remember → understand → …`): observations
// (W004) are immutable EVIDENCE; the memory module stores and retrieves the
// organization's EVIDENCE-BACKED KNOWLEDGE — the retrievable index of what
// the organization knows, each entry citing the observations that back it —
// and the TRANSACTIVE MEMORY (ARCHITECTURE.md §7): who knows, owns, decides,
// has experience with, influences, or can perform a capability.
//
// Memory is deliberately NOT epistemics (W007): entries carry no truth
// status, no confidence of their own and no promotion path. Truth-weighing
// (claims, beliefs, hypotheses, unknowns) is derived ON TOP of memory by
// the epistemics module. What memory guarantees instead is provenance
// (lock 11): every entry cites at least one observation that exists in the
// tenant and is readable by the recording principal, and contradictory
// entries coexist untouched (lock 12) — recording a contradiction is a NEW
// entry, never an edit.
//
// Actor and entity references are opaque forward references, exactly like
// the observations module's source references: the people (W002) and world
// (W005) modules are not declared dependencies of memory
// (MODULE-DEPENDENCY-MAP.md: `observations → memory → epistemics`), so ids
// are shape-validated uuids owned by their modules, never foreign keys.

import type { Observation } from '@/modules/observations/contract';

/** Canonical classification of an organizational knowledge entry. */
export type KnowledgeEntryKind =
  | 'fact' // a recorded organizational fact
  | 'procedure' // how something is (or was) done
  | 'decision' // a decision that was made and is worth remembering
  | 'preference' // a stated preference, policy or working agreement
  | 'insight' // a derived insight worth remembering, with its evidence cited
  | 'context'; // background knowledge about the organization or its environment

/** The kind of actor a transactive-memory assertion is about. */
export type TransactiveActorKind = 'person' | 'agent' | 'team';

/**
 * The transactive-memory relation vocabulary — ARCHITECTURE.md §7 verbatim:
 * "who knows, owns, decides, has experience with, influences, or can
 * perform a capability."
 */
export type TransactiveRelation =
  | 'knows'
  | 'owns'
  | 'decides'
  | 'has_experience_with'
  | 'influences'
  | 'can_perform';

/**
 * Opaque, provider-neutral reference to a world-model entity an entry is
 * about (e.g. a customer, process, product or capability). `kind` is a
 * canonical classification slug (the world module's entity kinds, W005, or
 * any later module's vocabulary); `id` is an opaque uuid owned by that
 * module — deliberately unverified here (memory's only declared upstream is
 * the observations module). At least one of `id` / `label` must be present
 * so the reference is always traceable.
 */
export interface MemoryEntityRef {
  kind: string;
  id?: string | null;
  label?: string | null;
}

/**
 * Opaque reference to the organizational actor a transactive-memory
 * assertion is about. `person` ids belong to the people module (W002),
 * `agent` ids to the agents module (W021+), `team` ids to the world module's
 * team entities (W005) — all deliberately unverified forward references
 * (same discipline as the observations module's source references). At
 * least one of `id` / `label` must be present.
 */
export interface TransactiveActorRef {
  kind: TransactiveActorKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `recordKnowledgeEntry`. */
export interface RecordKnowledgeEntryInput {
  kind: KnowledgeEntryKind;
  /** Retrieval headline (trimmed, 1..200 chars). */
  title: string;
  /** The knowledge itself, provider-neutral (trimmed, 1..4000 chars). */
  summary: string;
  /** Retrieval keys — at least one, at most sixteen lowercase slugs. */
  topics: string[];
  /** What the entry is about (0..16 opaque entity references). */
  entities?: MemoryEntityRef[];
  /**
   * The observations backing this knowledge — REQUIRED (lock 11): at least
   * one, at most sixteen uuids, each existing in this tenant and readable
   * by the recording principal (verified through the observations module's
   * contract). Sorted + deduplicated on storage.
   */
  evidenceObservationIds: string[];
  /** Optional free-form context (trimmed, at most 2000 chars). */
  notes?: string | null;
}

/** One stored organizational knowledge entry — append-only, evidence-backed. */
export interface KnowledgeEntry {
  id: string;
  tenantId: string;
  kind: KnowledgeEntryKind;
  title: string;
  summary: string;
  /** Sorted, deduplicated. */
  topics: string[];
  /** Canonically sorted, deduplicated. */
  entities: MemoryEntityRef[];
  /** Sorted, deduplicated observation uuids. */
  evidenceObservationIds: string[];
  notes: string | null;
  /** ISO 8601 — when Aurum committed the entry (service-controlled). */
  recordedAt: string;
}

/** Query shape of `listKnowledgeEntries`. All filters are optional and AND-combined. */
export interface ListKnowledgeEntriesQuery {
  kind?: KnowledgeEntryKind;
  /** ANY-of semantics: entries carrying at least one of these topics. */
  topics?: string[];
  /** Filter by entries about entities of this kind (optionally narrowed by `entityId`). */
  entityKind?: string;
  /** Requires `entityKind` — an entity id is meaningless without its kind. */
  entityId?: string;
  /** Entries citing this observation as evidence (provenance tracing). */
  evidenceObservationId?: string;
  /** Case-insensitive substring over `title` and `summary` (1..200 chars). */
  text?: string;
  /** Inclusive lower bound on `recordedAt` — strict ISO 8601. */
  recordedFrom?: string;
  /** Inclusive upper bound on `recordedAt` — strict ISO 8601. */
  recordedTo?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Input shape of `recordTransactiveEntry`. */
export interface RecordTransactiveEntryInput {
  /** Who the assertion is about (person, agent or team). */
  actor: TransactiveActorRef;
  /** The ARCHITECTURE.md §7 relation. */
  relation: TransactiveRelation;
  /** Human-readable subject, e.g. "HVAC maintenance contracts" (1..200 chars). */
  subjectLabel: string;
  /** Retrieval keys — at least one, at most sixteen lowercase slugs. */
  topics: string[];
  /** Optional opaque references to the entities the subject is about (0..16). */
  entities?: MemoryEntityRef[];
  /**
   * The observations backing the assertion — REQUIRED: at least one, at
   * most sixteen uuids, each existing in this tenant and readable by the
   * recording principal. Sorted + deduplicated on storage.
   */
  evidenceObservationIds: string[];
  /** Optional free-form context (trimmed, at most 2000 chars). */
  notes?: string | null;
}

/** One stored transactive-memory entry — append-only, evidence-backed. */
export interface TransactiveEntry {
  id: string;
  tenantId: string;
  actor: TransactiveActorRef;
  relation: TransactiveRelation;
  subjectLabel: string;
  /** Sorted, deduplicated. */
  topics: string[];
  /** Canonically sorted, deduplicated. */
  entities: MemoryEntityRef[];
  /** Sorted, deduplicated observation uuids. */
  evidenceObservationIds: string[];
  notes: string | null;
  /** ISO 8601 — when Aurum committed the entry (service-controlled). */
  recordedAt: string;
}

/** Query shape of `listTransactiveEntries`. All filters are optional and AND-combined. */
export interface ListTransactiveEntriesQuery {
  /** ANY-of semantics: entries carrying at least one of these topics. */
  topics?: string[];
  relation?: TransactiveRelation;
  actorKind?: TransactiveActorKind;
  /** Requires `actorKind` — an actor id is meaningless without its kind. */
  actorId?: string;
  /** Entries citing this observation as evidence (provenance tracing). */
  evidenceObservationId?: string;
  /** Case-insensitive substring over `subjectLabel` and `notes` (1..200 chars). */
  text?: string;
  /** Inclusive lower bound on `recordedAt` — strict ISO 8601. */
  recordedFrom?: string;
  /** Inclusive upper bound on `recordedAt` — strict ISO 8601. */
  recordedTo?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * The evidence resolution of one knowledge entry: the entry plus the
 * supporting observations READABLE by the calling principal. Evidence the
 * caller may not read (principal-scoped observations) is omitted — a
 * partial view, never a restricted-content leak (the entry itself still
 * lists the full evidence id set). Readable evidence is ordered by
 * `observedAt`, then id, so callers can pair it directly with the freshness
 * module's classifiers (W006) to judge whether the knowledge is current,
 * aging or stale.
 */
export interface KnowledgeEntryEvidence {
  entry: KnowledgeEntry;
  evidence: Observation[];
}

/** The evidence resolution of one transactive-memory entry (same semantics). */
export interface TransactiveEntryEvidence {
  entry: TransactiveEntry;
  evidence: Observation[];
}
