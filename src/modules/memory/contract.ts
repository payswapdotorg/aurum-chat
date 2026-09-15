// ============================================================================
// memory — the ONLY public surface of the memory module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W010 — Organizational Memory:
// "Provide retrieval/storage contracts for evidence-backed organizational
//  knowledge and transactive memory."
//
// Memory is the "remember" stage of the canonical company intelligence loop
// (ARCHITECTURE.md §2: `observe → remember → understand → …`) and sits
// between observations (W004, immutable evidence) and epistemics (W007,
// claims/beliefs/unknowns) in the module dependency map
// (`observations → memory → epistemics`).
//
// ORGANIZATIONAL KNOWLEDGE — evidence-backed, retrievable knowledge entries:
//   recordKnowledgeEntry     — append one knowledge entry (fact, procedure,
//      decision, preference, insight or context) with title, summary,
//      topic keys, optional opaque entity references and REQUIRED evidence:
//      at least one observation that exists in this tenant and is readable
//      by the recording principal (verified through the observations
//      contract; lock 11 — nothing enters memory without evidence).
//   getKnowledgeEntry        — tenant-scoped read of one entry.
//   listKnowledgeEntries     — filtered retrieval: kind, topics (ANY-of),
//      entity reference, citing observation (provenance tracing),
//      case-insensitive text over title/summary, recorded window, limit.
//   getKnowledgeEntryEvidence — resolve the supporting observations that
//      the calling principal may read (partial view, never a leak), ordered
//      by observedAt so callers can pair them with the freshness module's
//      classifiers (W006) to judge whether the knowledge is current, aging
//      or stale.
//
// TRANSACTIVE MEMORY (ARCHITECTURE.md §7: "who knows, owns, decides, has
// experience with, influences, or can perform a capability"):
//   recordTransactiveEntry   — append one evidence-backed assertion about
//      an organizational actor (person / agent / team — an opaque forward
//      reference, see types.ts), one §7 relation and a subject (label,
//      topics, optional entity references). "Who knows what" retrieval is
//      listTransactiveEntries({ topics }).
//   getTransactiveEntry      — tenant-scoped read of one entry.
//   listTransactiveEntries   — filtered retrieval: topics (ANY-of),
//      relation, actor (kind + id), citing observation, text over
//      subjectLabel/notes, recorded window, limit.
//   getTransactiveEntryEvidence — evidence resolution, same partial-view
//      semantics as the knowledge side.
//
// There is deliberately NO operation to update, delete, correct, supersede,
// verify, promote or otherwise mutate an entry: organizational memory is
// APPEND-ONLY history (the database enforces the same with triggers that
// reject UPDATE/DELETE/TRUNCATE — migrations/001 and /002). A contradiction
// is a NEW entry and both sides are retained (lock 12); currency is a
// freshness concern (W006) derived from the cited evidence; belief
// formation is the epistemics module's concern (W007). Entries carry no
// truth semantics of their own (lock 10) — not even LLM-produced summaries
// become authoritative by being remembered; they stay evidence-cited
// knowledge.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's
// organizational memory (including its evidence citations) is reported as
// `knowledge_entry_not_found` / `transactive_entry_not_found` — no
// existence leak. Evidence that is missing, foreign or restricted is
// uniformly `invalid_provenance`.
// ============================================================================

export {
  getKnowledgeEntry,
  getKnowledgeEntryEvidence,
  getTransactiveEntry,
  getTransactiveEntryEvidence,
  listKnowledgeEntries,
  listTransactiveEntries,
  recordKnowledgeEntry,
  recordTransactiveEntry,
} from './service';

export { MemoryError } from './errors';
export type { MemoryErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  KNOWLEDGE_ENTRY_KINDS,
  MAX_ENTITIES,
  MAX_EVIDENCE_OBSERVATIONS,
  MAX_LABEL_LENGTH,
  MAX_LIST_LIMIT,
  MAX_NOTES_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TEXT_QUERY_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TOPICS,
  TRANSACTIVE_ACTOR_KINDS,
  TRANSACTIVE_RELATIONS,
  isKnowledgeEntryKind,
  isTransactiveActorKind,
  isTransactiveRelation,
} from './validation';

export type {
  ValidatedKnowledgeInput,
  ValidatedKnowledgeListQuery,
  ValidatedTransactiveInput,
  ValidatedTransactiveListQuery,
} from './validation';

export type {
  KnowledgeEntry,
  KnowledgeEntryEvidence,
  KnowledgeEntryKind,
  ListKnowledgeEntriesQuery,
  ListTransactiveEntriesQuery,
  MemoryEntityRef,
  RecordKnowledgeEntryInput,
  RecordTransactiveEntryInput,
  TransactiveActorKind,
  TransactiveActorRef,
  TransactiveEntry,
  TransactiveEntryEvidence,
  TransactiveRelation,
} from './types';
