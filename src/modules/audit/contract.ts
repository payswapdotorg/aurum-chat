// ============================================================================
// audit — the ONLY public surface of the audit module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W046 — Decision Evidence/Audit:
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
//   THE APPEND-ONLY TRAIL (§24's second sentence):
//     recordAudit / getAuditRecord / listAuditRecords
//        — system-minted, tenant-scoped records of consequential events.
//          Each carries WHERE it sits on the §24 chain (chainStage), WHAT
//          happened (event), the record it is about (subject kind+id),
//          the §25 correlation identity of the flow it belongs to, a
//          human summary and a structured (size-capped, plain-JSON)
//          detail snapshot. Any surface may append — the api/mcp modules
//          (§23 "Every API/MCP operation is tenant-scoped,
//          permission-checked and audited"; W038/W039 wire their
//          operations through here), the actions module's policy-change
//          history ("their change history belongs to audit, W046" —
//          recorded here by the surface that drives setAuthorityPolicy),
//          extension deployments, agent lifecycle events, ... — and
//          NOBODY rewrites: there is deliberately no update or delete
//          operation, and PostgreSQL triggers reject
//          UPDATE/DELETE/TRUNCATE outright (migrations/001).
//
//   THE RECONSTRUCTION (§24's first sentence — the acceptance core):
//     reconstructDecision
//        — assemble the full §24 decision-evidence chain for ONE
//          consequential decision, anchored on
//             · a cognitive execution id (the canonical case — W013's
//               trace already records the cycle end to end),
//             · an action request id (the approval-centric case — W009's
//               request carries the policy snapshot and decision trail;
//               the driving execution is resolved through the cognition
//               contract's documented stable key
//               `cognition:<executionId>:action` when present, else the
//               direct-authorization view), or
//             · a §25 correlation id (a whole logical flow — every
//               execution of the flow, each a chain of its own, with the
//               flow's terminal action request as the recommendation).
//          Every link is deep-linked to the REAL records of the owning
//          modules — read ONLY through their public contracts — so the
//          document is evidence, not prose (lock 41). Links the calling
//          principal may not read are reported as unreadable in place (a
//          partial view, the observations module's lineage precedent);
//          the reconstruction fails only when the anchor itself is
//          absent (uniform not-found, no existence leak). A per-link
//          completeness report states what is absent — a mid-flight
//          decision (an execution suspended awaiting approval)
//          reconstructs honestly with its later links empty and marked
//          absent, never silently missing.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's audit records,
// cognitive executions and action requests are indistinguishable from
// missing ones (`audit_record_not_found` / `execution_not_found` /
// `action_request_not_found` — no existence leak).
//
// Cross-module reads: cognition (W013 — the executions and their
// append-only step traces), actions (W009 — policy snapshot, requests,
// approval decisions), epistemics (W007 — claims, beliefs, unknowns),
// memory (W010 — knowledge/transactive entries and learning capture),
// missions (W011 — mission content) and observations (W004 — the input
// and evidence observations, with their provider/model extraction
// lineage). Nothing else. The declared W046 dependency world (W005) is
// verified present but deliberately not imported: the §24 chain carries
// model updates as claims/beliefs (epistemics) and the world model is
// not a chain link — the learning module's documented precedent for a
// verified-but-not-imported declared dependency. Error propagation
// policy: see errors.ts.
// ============================================================================

export {
  getAuditRecord,
  listAuditRecords,
  recordAudit,
  reconstructDecision,
} from './service';

export { AuditError } from './errors';
export type { AuditErrorCode } from './errors';

export {
  AUDIT_SUBJECT_ACTION_REQUEST,
  AUDIT_SUBJECT_AUTHORITY_POLICY,
  AUDIT_SUBJECT_COGNITIVE_EXECUTION,
  CHAIN_STAGES,
  DEFAULT_LIST_LIMIT,
  MAX_DETAIL_BYTES,
  MAX_EVENT_CHARS,
  MAX_LIST_LIMIT,
  MAX_SUBJECT_KIND_CHARS,
  MAX_SUMMARY_CHARS,
  chainCompleteness,
  deriveExtractors,
  executionIdFromIdempotencyKey,
  isChainStage,
  isUuid,
} from './validation';

export type {
  ValidatedGetAuditRecordQuery,
  ValidatedListAuditRecordsQuery,
  ValidatedRecordAuditInput,
  ValidatedReconstructDecisionQuery,
} from './validation';

export type {
  AuditRecord,
  ChainApproval,
  ChainClaimsBeliefs,
  ChainEvidence,
  ChainExecution,
  ChainInput,
  ChainLearning,
  ChainLinkReport,
  ChainModelProvider,
  ChainOutcome,
  ChainPolicy,
  ChainRecommendation,
  ChainResult,
  ChainStage,
  ChainUnknownMission,
  DecisionAnchor,
  DecisionChain,
  DecisionEvidence,
  DecisionExecution,
  EvidenceObservation,
  GetAuditRecordQuery,
  ListAuditRecordsQuery,
  RecordAuditInput,
  ReconstructDecisionQuery,
} from './types';
