// Public domain types of the agent-body module (W133 — Aurum Agent Body +
// Model Binding).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md §W133; dependencies
// W021, W034, W063, W132): "Separate persistent Aurum Agent Body from the
// LLM that possesses it. Body owns role, information behavior,
// communication, permissions, evidence and learning hooks; model owns
// provider/model runtime characteristics." Acceptance: "model swap
// preserves tenant/company/evidence/memory identity; bindings are
// explicit, auditable and policy compatible."
//
// AGENT-BODY-LAB-CROSS-PLATFORM-ARCHITECTURE.md §1 is the source of this
// vocabulary:
//
//   "Aurum is a persistent model-agnostic Agent Body plus a separately
//    selected Model Binding. The body owns role, communication behavior,
//    information acquisition behavior, company context access, memory
//    policy, permitted capabilities, escalation behavior, evidence hooks
//    and learning hooks. The selected model owns provider, model id,
//    modalities, tool support and runtime characteristics. Changing the
//    model does not replace the body and does not reset company
//    understanding or learning history."
//
// That separation is carved into the two shapes below:
//
//   AgentBody        — the persistent, model-agnostic side: role, the five
//                      §1 policy descriptors (communication behavior,
//                      information acquisition behavior, company context
//                      access, memory policy, escalation behavior),
//                      permitted capabilities, opaque evidence/learning
//                      hook references and the one-way active/retired
//                      lifecycle. NOTHING about a provider, model or
//                      runtime lives here.
//   BodyModelBinding — the attachment that POSSESSES the body with a
//                      model: an append-only, auditable record referencing
//                      an OPAQUE provider-fabric binding id for a purpose,
//                      carrying the VERBATIM policy-check payload that
//                      authorized the attachment. Swapping the model is
//                      appending a new attachment and superseding the old
//                      one IN THE SAME TRANSACTION — the body row is never
//                      touched, so company understanding, evidence hooks
//                      and learning history survive byte-for-byte.
//
// HONESTY OF THE POLICY DESCRIPTORS (§1's "honest plain-JSON-or-null"
// discipline): this module is the STORAGE layer for what a body's policies
// SAY. The five §1 descriptors are recorded as plain JSON objects exactly
// as the caller (composition layer) asserts them, or null when the body
// has no policy statement for that dimension yet. This layer neither
// invents a default communication behavior nor interprets one — a null
// descriptor reads as "not stated", never as "permissive".
//
// OPAQUE REFERENCES BY DESIGN:
//   * `bindingId` (BodyModelBinding) is an opaque provider-fabric
//     reference, stored VERBATIM. Attachments are append-only audit
//     evidence that must survive fabric-side supersession — a historical
//     attachment referencing a since-superseded fabric binding is exactly
//     the evidence the audit must retain. Cross-module existence
//     validation lands at TL integration / composition, not here.
//   * evidence/learning hooks are opaque (registry, ref) forward
//     references into the modules that own the evidence (the coverage
//     module's CoverageSource discipline): no domain object is copied into
//     body state.
//   * permitted capabilities are capability KEYS, not grants: authority
//     gating on body management and capability enforcement are owned by
//     the app composition layer and the capability-grants/actions
//     authorities (deferred deliberately — see WORK-NOTES.md).
//
// The body NEVER invokes models (§10: "LLM Gateway: model execution and
// provider routing"). This module records WHICH binding possesses a body
// for a purpose; the LLM Gateway stays the execution authority.
//
// Tenancy (ADR-0001): every record is tenant-scoped at the SQL layer;
// another tenant's bodies and binding attachments are indistinguishable
// from missing ones (uniform not-found, no existence leak).

// ModelBindingPurpose is imported TYPE-ONLY through the frozen W132 seam
// ('@/modules/provider-fabric/contract' — the single legal cross-module
// import, IMPLEMENTATION-STACK §2, enforced by
// scripts/check-architecture.ts) and RE-EXPORTED from this module's
// contract so consumers never need to know where it was frozen. The
// runtime purpose LIST is mirrored in validation.ts because the frozen
// contract exports types only (a recorded design decision).
import type { ModelBindingPurpose } from '@/modules/provider-fabric/contract';

export type { ModelBindingPurpose };

// ---------------------------------------------------------------------------
// Lifecycles (both one-way, test-locked)
// ---------------------------------------------------------------------------

/** Body lifecycle — one-way: active → retired. A retired body stays readable. */
export const AGENT_BODY_STATUSES = ['active', 'retired'] as const;
export type AgentBodyStatus = (typeof AGENT_BODY_STATUSES)[number];

/**
 * Attachment lifecycle — one-way append-only history:
 *
 *   active    — the attachment currently possesses the body for its purpose
 *               (at most ONE active attachment per (tenant, body, purpose);
 *               partial unique index + service transaction);
 *   superseded— replaced by a newer attachment for the same purpose
 *               (stamped the moment its successor is appended);
 *   detached  — explicitly detached with a reason (the body no longer uses
 *               ANY binding for that purpose until a new attachment).
 *
 * There is deliberately no active → active edit, no superseded → active
 * revival and no detach-then-resume: the history is the audit.
 */
export const BODY_BINDING_STATUSES = ['active', 'superseded', 'detached'] as const;
export type BodyBindingStatus = (typeof BODY_BINDING_STATUSES)[number];

// ---------------------------------------------------------------------------
// The policy-check payload (recorded VERBATIM)
// ---------------------------------------------------------------------------

/**
 * The verdict vocabulary of a policy check. This layer records verdicts
 * verbatim and NEVER fabricates one — but it also never ACTIVATES an
 * attachment whose verdict it cannot vouch for:
 *
 *   compatible   — the check passed; the attachment may become active;
 *   incompatible — the check failed; the attachment is REFUSED outright
 *                  (typed `policy_check_failed`, nothing appended — a
 *                  recorded ruling, reversible at TL discretion);
 *   unknown      — the check could not decide; treated exactly as
 *                  incompatible (an unverified compatibility cannot
 *                  activate; honesty over availability).
 */
export const POLICY_CHECK_OUTCOMES = ['compatible', 'incompatible', 'unknown'] as const;
export type PolicyCheckOutcome = (typeof POLICY_CHECK_OUTCOMES)[number];

/**
 * The verbatim policy-check payload that authorized (or refused) an
 * attachment. Supplied by the composition layer (whoever ran the check —
 * tenant policy, the LLM Gateway's policy gate or a future fabric-side
 * checker), recorded EXACTLY as supplied, never re-derived here.
 */
export interface PolicyCheckPayload {
  /** The verdict (see PolicyCheckOutcome). */
  readonly outcome: PolicyCheckOutcome;
  /**
   * Machine/human-readable basis of the verdict — WHAT was checked
   * (e.g. "tenant provider policy v3: openai, anthropic allowed for
   * purpose cognition"). 1..2048 chars.
   */
  readonly basis: string;
  /**
   * WHO performed the check — an opaque principal id or a system
   * component label (e.g. "system:policy-engine"). 1..256 chars.
   */
  readonly checkedBy: string;
  /** WHEN the check ran — caller-supplied strict ISO 8601 instant. */
  readonly checkedAt: string;
}

// ---------------------------------------------------------------------------
// Opaque hook references
// ---------------------------------------------------------------------------

/**
 * An opaque forward reference into a module that owns evidence or
 * learning state (the coverage module's CoverageSource discipline: the
 * registry names WHICH module's records `ref` points into; the ref is the
 * id that registry already mints). No domain object is copied into body
 * state and no credential ever appears here.
 */
export interface AgentBodyHookRef {
  /** Which registry `ref` points into (e.g. 'observation', 'epistemics', 'audit'). */
  readonly registry: string;
  /** Opaque registry id — never a credential. */
  readonly ref: string;
}

// ---------------------------------------------------------------------------
// AgentBody — the persistent, model-agnostic side
// ---------------------------------------------------------------------------

/**
 * A persistent Aurum Agent Body (§1). The role is the tenant-unique
 * identity and is IMMUTABLE after creation (the update surface has no role
 * key); the five §1 policy descriptors, permitted capabilities and hook
 * references are the mutable management surface; the lifecycle is one-way
 * active → retired. Nothing provider-, model- or runtime-shaped lives
 * here — possession is expressed exclusively through BodyModelBinding
 * attachments.
 */
export interface AgentBody {
  readonly id: string;
  readonly tenantId: string;
  /** Tenant-unique immutable role slug (identity — never updatable). */
  readonly role: string;
  /** Human label (mutable management control). */
  readonly label: string;
  readonly description: string | null;
  /** §1 communication behavior — honest plain JSON exactly as asserted, or null (not stated). */
  readonly communicationBehavior: Record<string, unknown> | null;
  /** §1 information acquisition behavior — honest plain JSON or null. */
  readonly informationAcquisitionBehavior: Record<string, unknown> | null;
  /** §1 company context access — honest plain JSON or null. */
  readonly companyContextAccess: Record<string, unknown> | null;
  /** §1 memory policy — honest plain JSON or null. */
  readonly memoryPolicy: Record<string, unknown> | null;
  /** §1 escalation behavior — honest plain JSON or null. */
  readonly escalationBehavior: Record<string, unknown> | null;
  /** Declared capability KEYS (no grants — enforcement is composition's). */
  readonly permittedCapabilities: string[];
  /** Opaque evidence hook references (see AgentBodyHookRef). */
  readonly evidenceHooks: AgentBodyHookRef[];
  /** Opaque learning hook references (see AgentBodyHookRef). */
  readonly learningHooks: AgentBodyHookRef[];
  /** One-way lifecycle (AGENT_BODY_STATUSES). */
  readonly status: AgentBodyStatus;
  /** The principal whose context created the body (system-captured). */
  readonly createdBy: string;
  /** ISO 8601 — creation time (service clock). */
  readonly createdAt: string;
  /** ISO 8601 — last body edit (service clock). A model swap NEVER bumps this. */
  readonly updatedAt: string;
  /** ISO 8601 — set by the one-way retire transition; null while active. */
  readonly retiredAt: string | null;
}

/** Input shape of `createAgentBody`. */
export interface CreateAgentBodyInput {
  role: string;
  label: string;
  description?: string | null;
  communicationBehavior?: Record<string, unknown> | null;
  informationAcquisitionBehavior?: Record<string, unknown> | null;
  companyContextAccess?: Record<string, unknown> | null;
  memoryPolicy?: Record<string, unknown> | null;
  escalationBehavior?: Record<string, unknown> | null;
  permittedCapabilities?: string[];
  evidenceHooks?: AgentBodyHookRef[];
  learningHooks?: AgentBodyHookRef[];
}

/**
 * Input shape of `updateAgentBody` — PARTIAL semantics: a field that is
 * `undefined` stays unchanged; a descriptor/hook field explicitly set to
 * `null` (or `[]`) clears it. There is DELIBERATELY NO `role` key: the
 * role is the immutable identity (a caller that tries is rejected with
 * `invalid_body_input`, and the schema's trigger guards it in depth).
 */
export interface UpdateAgentBodyInput {
  bodyId: string;
  label?: string;
  description?: string | null;
  communicationBehavior?: Record<string, unknown> | null;
  informationAcquisitionBehavior?: Record<string, unknown> | null;
  companyContextAccess?: Record<string, unknown> | null;
  memoryPolicy?: Record<string, unknown> | null;
  escalationBehavior?: Record<string, unknown> | null;
  permittedCapabilities?: string[];
  evidenceHooks?: AgentBodyHookRef[];
  learningHooks?: AgentBodyHookRef[];
}

/** Input shape of `retireAgentBody` (the one-way body lifecycle). */
export interface RetireAgentBodyInput {
  bodyId: string;
}

/** Query shape of `getAgentBody`. */
export interface GetAgentBodyQuery {
  bodyId: string;
}

/** Query shape of `listAgentBodies`. All filters are optional and AND-combined. */
export interface ListAgentBodiesQuery {
  status?: AgentBodyStatus;
  limit?: number;
}

// ---------------------------------------------------------------------------
// BodyModelBinding — the append-only possession attachment
// ---------------------------------------------------------------------------

/**
 * The attachment that possesses an AgentBody with a model binding for a
 * purpose (§1: "a separately selected Model Binding"). Append-only audit
 * evidence: the row is INSERTED once, may transition one-way to
 * 'superseded' or 'detached' (and nothing else — a database trigger
 * rejects every other UPDATE, plus DELETE/TRUNCATE), and its `bindingId`
 * stays OPAQUE so fabric-side supersession never orphans the audit.
 *
 * THE SWAP INVARIANT (test-locked): attaching a new binding for a purpose
 * appends the new attachment and supersedes the prior active one in ONE
 * transaction WITHOUT touching the body row — the body, its company
 * context access, evidence hooks and learning history are byte-identical
 * (including `updatedAt`) before and after the swap.
 */
export interface BodyModelBinding {
  readonly id: string;
  readonly tenantId: string;
  /** The possessed body. */
  readonly bodyId: string;
  /**
   * OPAQUE provider-fabric binding reference (the ModelBinding.bindingId
   * the fabric mints), stored VERBATIM. Never parsed, never re-minted,
   * never validated for existence at this layer (see WORK-NOTES.md).
   */
  readonly bindingId: string;
  /** What the possessing binding is used for (frozen W132 seam). */
  readonly purpose: ModelBindingPurpose;
  /** The verbatim policy-check payload recorded with the attachment. */
  readonly policyCheck: PolicyCheckPayload;
  /** One-way attachment lifecycle (BODY_BINDING_STATUSES). */
  readonly status: BodyBindingStatus;
  /** Monotonic per-body attachment ordinal (1, 2, 3, …) — deterministic history order. */
  readonly position: number;
  /** The principal whose context attached the binding (system-captured). */
  readonly attachedBy: string;
  /** ISO 8601 — attachment time (service clock). */
  readonly attachedAt: string;
  /** ISO 8601 — stamped by the one-way supersede transition; null until then. */
  readonly supersededAt: string | null;
  /** ISO 8601 — stamped by the one-way detach transition; null until then. */
  readonly detachedAt: string | null;
  /** Required human reason recorded by the detach transition; null otherwise. */
  readonly detachReason: string | null;
}

/** Input shape of `attachModelBinding` (THE SWAP PATH). */
export interface AttachModelBindingInput {
  bodyId: string;
  /** Opaque provider-fabric binding reference, stored verbatim. */
  bindingId: string;
  purpose: ModelBindingPurpose;
  /** The policy-check payload recorded verbatim with the attachment. */
  policyCheck: PolicyCheckPayload;
}

/** Input shape of `detachModelBinding` (detach the ACTIVE purpose attachment). */
export interface DetachModelBindingInput {
  bodyId: string;
  purpose: ModelBindingPurpose;
  /** Required reason (1..2048 chars) — why the detachment happened. */
  reason: string;
}

/** Query shape of `getBodyBindings` (the full append-only history). */
export interface GetBodyBindingsQuery {
  bodyId: string;
  purpose?: ModelBindingPurpose;
  status?: BodyBindingStatus;
  limit?: number;
}

/** Query shape of `getActiveBinding` (the currently possessing attachment). */
export interface GetActiveBindingQuery {
  bodyId: string;
  purpose: ModelBindingPurpose;
}
