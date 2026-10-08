// ============================================================================
// agent-body — the ONLY public surface of the agent-body module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W133 — Aurum Agent Body + Model Binding (spec/work-items/
// WORK-ITEM-CATALOG.md §W133; AGENT-BODY-LAB-CROSS-PLATFORM-ARCHITECTURE
// §1 body/binding separation, §10 authority boundaries):
//
//   The body side (persistent, model-agnostic — §1 "The body owns role,
//   communication behavior, information acquisition behavior, company
//   context access, memory policy, permitted capabilities, escalation
//   behavior, evidence hooks and learning hooks"):
//   createAgentBody — register a tenant-scoped body. The role is the
//      tenant-unique IMMUTABLE identity; the five §1 policy descriptors
//      are recorded as honest plain-JSON-or-null (null = "not stated",
//      never "permissive"); capabilities are KEYS, hooks are opaque
//      (registry, ref) forward references. The principal is
//      system-captured from the explicit TenantContext.
//   getAgentBody / listAgentBodies — tenant-scoped reads with the uniform
//      not-found discipline (a foreign id is indistinguishable from a
//      missing one). listAgentBodies takes a QUERY OBJECT (status, limit).
//   updateAgentBody — the mutable management controls (label,
//      description, the five §1 descriptors, capabilities, hooks) with
//      partial semantics: undefined = unchanged, null/[] = cleared.
//      There is DELIBERATELY NO `role` key — identity is immutable, and a
//      caller that tries is rejected (the schema's trigger guards it in
//      depth).
//   retireAgentBody — the one-way body lifecycle (active → retired,
//      stamped once). Retiring deliberately leaves the binding attachment
//      history untouched: attachments are append-only evidence about what
//      POSSESSED the body, and retirement is recorded on the body.
//
//   The binding side (§1 "a separately selected Model Binding" — the
//   append-only possession attachments):
//   attachModelBinding — THE SWAP PATH: append a new active attachment
//      referencing an OPAQUE provider-fabric binding id for a purpose,
//      carrying the VERBATIM policy-check payload, and supersede the prior
//      active attachment (same purpose) IN THE SAME TRANSACTION under a
//      FOR UPDATE row lock on the body. The agent_bodies row is not part
//      of the transaction's writes — a model swap preserves the body
//      byte-for-byte, INCLUDING updatedAt (test-locked: a swap must not
//      even look like a body edit). Only a 'compatible' policy verdict may
//      activate: 'incompatible' and 'unknown' both refuse the attachment
//      outright with typed `policy_check_failed` and NOTHING appended (a
//      recorded ruling — this layer records verdicts verbatim, never
//      fabricates one, and never activates a binding it cannot vouch
//      for; reversible at TL discretion).
//   detachModelBinding — the one-way active → detached transition for the
//      ACTIVE attachment of a purpose, with a required recorded reason.
//      Works on retired bodies too (completing audit history is not a
//      body edit); a retired body merely never accepts NEW attachments.
//   getBodyBindings — the full append-only history of a body's
//      attachments, deterministically ordered by the monotonic per-body
//      position; filterable by purpose/status. A foreign body id throws
//      the uniform `body_not_found`.
//   getActiveBinding — the currently possessing attachment for a purpose,
//      or null when none is active.
//
// OPAQUE-SEAM DESIGN (the recorded TL ruling): `bindingId` is stored
// VERBATIM and never validated for existence at the STORAGE layer —
// attachments are append-only audit evidence that must survive fabric-side
// supersession, and a historical attachment referencing a since-superseded
// fabric binding is exactly the evidence the audit must retain. The WB3
// composition wiring (delivered) adds the SERVICE-boundary existence gate:
// a FRESH attachment's `bindingId` must exist in the tenant's
// provider-fabric registry, checked through the W132 operational read API
// (`listModelBindings`, imported from '@/modules/provider-fabric/contract'
// — the only legal cross-module import) on the base connection BEFORE the
// append transaction, refusing with the typed `fabric_binding_not_found`.
// The gate is EXISTENCE, not activity (superseded fabric bindings qualify)
// and never re-validates historical rows. W141's certification still owns
// the live-swap proof. The runtime purpose list is mirrored in
// validation.ts because the frozen W132 contract exports types only.
//
// The body NEVER invokes models: the LLM Gateway stays the execution
// authority (§10). No app-layer UX and no authority-claim gating ship on
// this surface (both deferred to app composition — see WORK-NOTES.md).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's bodies and binding
// attachments are indistinguishable from missing ones — no existence leak.
// ============================================================================

export {
  // The body side
  createAgentBody,
  getAgentBody,
  listAgentBodies,
  retireAgentBody,
  updateAgentBody,
  // The binding side
  attachModelBinding,
  detachModelBinding,
  getActiveBinding,
  getBodyBindings,
} from './service';

export { AgentBodyError } from './errors';
export type { AgentBodyErrorCode } from './errors';

// Guards + limits (pure; unit-testable without a database).
export {
  AGENT_BODY_STATUSES,
  BODY_BINDING_STATUSES,
  DEFAULT_LIST_LIMIT,
  MAX_BASIS_CHARS,
  MAX_BINDING_ID_CHARS,
  MAX_CAPABILITIES,
  MAX_CAPABILITY_CHARS,
  MAX_CHECKED_BY_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_HOOKS,
  MAX_HOOK_REF_CHARS,
  MAX_LABEL_CHARS,
  MAX_LIST_LIMIT,
  MAX_POLICY_DESCRIPTOR_BYTES,
  MAX_POLICY_DESCRIPTOR_DEPTH,
  MAX_REASON_CHARS,
  MODEL_BINDING_PURPOSES,
  POLICY_CHECK_OUTCOMES,
  assertAgentBodyTenantContext,
  isAgentBodyStatus,
  isAttachablePolicyOutcome,
  isBodyBindingStatus,
  isModelBindingPurpose,
  isPolicyCheckOutcome,
  isUuid,
  validateAttachModelBindingInput,
  validateCreateAgentBodyInput,
  validateDetachModelBindingInput,
  validateGetActiveBindingQuery,
  validateGetAgentBodyQuery,
  validateGetBodyBindingsQuery,
  validateListAgentBodiesQuery,
  validatePolicyCheckPayload,
  validateRetireAgentBodyInput,
  validateUpdateAgentBodyInput,
} from './validation';
export type {
  ValidatedAttachModelBindingInput,
  ValidatedCreateAgentBodyInput,
  ValidatedDetachModelBindingInput,
  ValidatedGetActiveBindingQuery,
  ValidatedGetAgentBodyQuery,
  ValidatedGetBodyBindingsQuery,
  ValidatedListAgentBodiesQuery,
  ValidatedRetireAgentBodyInput,
  ValidatedUpdateAgentBodyInput,
} from './validation';

// The domain vocabularies (types.ts is their single home; the frozen
// status/outcome arrays are re-exported above through validation.ts).
export type {
  AgentBody,
  AgentBodyHookRef,
  AgentBodyStatus,
  AttachModelBindingInput,
  BodyBindingStatus,
  BodyModelBinding,
  CreateAgentBodyInput,
  DetachModelBindingInput,
  GetActiveBindingQuery,
  GetAgentBodyQuery,
  GetBodyBindingsQuery,
  ListAgentBodiesQuery,
  PolicyCheckOutcome,
  PolicyCheckPayload,
  RetireAgentBodyInput,
  UpdateAgentBodyInput,
} from './types';

// The frozen W132 seam, re-exported so consumers of the body/binding
// surface never need to know where the purpose vocabulary was frozen.
// Imported through '@/modules/provider-fabric/contract' — the single
// legal cross-module import (enforced by the architecture gate); since
// the WB3 composition wiring that import is a VALUE import too (the
// operational binding-registry read the existence gate uses).
export type { ModelBindingPurpose } from '@/modules/provider-fabric/contract';
