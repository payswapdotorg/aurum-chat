// Typed errors of the execution-fabric module. Consumers catch
// `ExecutionFabricError` and branch on `code`; messages are for
// humans/logs, never for control flow — the same discipline every
// module applies.
//
// Error vocabulary (29 codes):
//   invalid_context       — a caller forgot/malformed the explicit
//                           TenantContext (ADR-0001: the context is
//                           asserted, never ambient);
//   invalid_definition_input — malformed registerEnvironmentDefinition
//                           input (kind/isolation/persistence shapes,
//                           capability domains, bounds);
//   invalid_lease_input   — malformed acquireFabricLease input;
//   invalid_lifecycle_input — malformed prepare/takeover/handback/
//                           heartbeat/lost/recover/cancel/release/fail
//                           input;
//   invalid_artifact_input — malformed recordArtifactHandoff input;
//   invalid_evidence_input — malformed recordLeaseEvidence input;
//   invalid_checkpoint_input — malformed recordLeaseCheckpoint input;
//   invalid_query         — malformed get/list query (validation);
//   definition_not_found  — uniform not-found for a missing OR foreign
//                           definition id (ADR-0001: cross-tenant access
//                           is indistinguishable from missing — no
//                           existence leak);
//   definition_key_taken  — the defKey is already registered in this
//                           tenant (a changed definition is a NEW
//                           definition under a NEW key);
//   definition_retired    — acquiring on a retired definition (existing
//                           leases continue; new ones refuse);
//   definition_already_retired — retiring a definition whose lifecycle
//                           already ended (one-way, terminal);
//   exchange_plan_not_found — the W136 execution plan is missing,
//                           foreign or not ACTIVE (the fabric serves
//                           in-flight orchestration only);
//   execution_run_not_found — the W136 execution run is missing from
//                           the plan or foreign (uniform, no leak);
//   adapter_unavailable   — no REGISTERED adapter serves the
//                           definition's kind (nothing is wired by
//                           default — the run fails explicitly rather
//                           than faking success, the driver_unavailable
//                           discipline);
//   adapter_capability_unsupported — a serving adapter declares
//                           supported:false for a capability domain the
//                           definition REQUIRES (the honest-descriptor
//                           law: the fabric surfaces the declaration,
//                           it never fabricates the capability);
//   adapter_not_registered — the lease's named adapter is no longer
//                           registered (prepare/recover refuse; the
//                           vendor was removed — reads still serve);
//   adapter_open_failed   — the adapter's open() threw during prepare
//                           (the lease is stamped failed with the
//                           detail — actionable evidence, then the
//                           typed refusal);
//   adapter_resume_failed — the adapter's resume() threw during
//                           recovery (the lease is stamped failed with
//                           the detail);
//   lease_not_found       — uniform not-found for a missing OR foreign
//                           lease id (no existence leak);
//   lease_already_terminal — operating on a released/cancelled/failed
//                           lease (the lifecycle is one-way past
//                           terminal);
//   lease_not_preparing   — prepare on a lease that is not 'preparing';
//   lease_not_live        — an operation requiring the run lease
//                           (takeover/heartbeat/checkpoint) on a lease
//                           that is not 'live';
//   lease_not_suspended   — handback on a lease that is not 'suspended';
//   lease_not_lost        — recover on a lease that is not 'lost';
//   lease_suspended       — release on a lease a human holds (the
//                           explicit-handback-only law: hand control
//                           back first, or cancel);
//   checkpoint_required   — recovering a durable-checkpoint lease with
//                           no recorded checkpoint (persistence where
//                           required: the resume truth must exist
//                           before a fresh session may replay from it);
//   invalid_transition    — a lifecycle move the state machine refuses
//                           (e.g. recording artifacts/evidence on a
//                           terminal lease; the single legality
//                           definition lives in validation.ts).

export type ExecutionFabricErrorCode =
  | 'invalid_context'
  | 'invalid_definition_input'
  | 'invalid_lease_input'
  | 'invalid_lifecycle_input'
  | 'invalid_artifact_input'
  | 'invalid_evidence_input'
  | 'invalid_checkpoint_input'
  | 'invalid_query'
  | 'definition_not_found'
  | 'definition_key_taken'
  | 'definition_retired'
  | 'definition_already_retired'
  | 'exchange_plan_not_found'
  | 'execution_run_not_found'
  | 'adapter_unavailable'
  | 'adapter_capability_unsupported'
  | 'adapter_not_registered'
  | 'adapter_open_failed'
  | 'adapter_resume_failed'
  | 'lease_not_found'
  | 'lease_already_terminal'
  | 'lease_not_preparing'
  | 'lease_not_live'
  | 'lease_not_suspended'
  | 'lease_not_lost'
  | 'lease_suspended'
  | 'checkpoint_required'
  | 'invalid_transition';

export class ExecutionFabricError extends Error {
  constructor(
    public readonly code: ExecutionFabricErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionFabricError';
  }
}
