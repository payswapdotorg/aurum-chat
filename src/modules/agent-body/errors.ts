// Typed errors of the agent-body module. Consumers catch `AgentBodyError`
// and branch on `code`; messages are for humans/logs, never for control
// flow — the same discipline every module applies.
//
// Error vocabulary (11 codes):
//   invalid_context    — a caller forgot/malformed the explicit
//                        TenantContext (ADR-0001: the context is asserted,
//                        never ambient);
//   invalid_body_input — malformed create/update body input (validation),
//                        INCLUDING an update that tries to change `role`
//                        (identity is immutable) or carries no field at all;
//   invalid_query      — malformed get/list query (validation);
//   invalid_binding_input — malformed attach/detach input, including a
//                        re-attachment of the binding that is ALREADY the
//                        active attachment for the purpose (a no-op swap
//                        would only pollute the audit history);
//   body_not_found     — uniform not-found for a missing OR foreign body id
//                        (ADR-0001: cross-tenant access is indistinguishable
//                        from missing — no existence leak);
//   body_role_taken    — the tenant-unique role is already in use
//                        (UNIQUE(tenant_id, role) mapped to the typed code);
//   body_retired       — a mutation (update/attach) on a retired body: the
//                        lifecycle is one-way;
//   binding_not_found  — no binding attachment exists for the addressed
//                        (body, purpose) at all;
//   binding_inactive   — attachments exist for the (body, purpose) but
//                        none is active (superseded/detached history only);
//   fabric_binding_not_found — the bindingId a FRESH attachment references
//                        does not exist in the tenant's provider-fabric
//                        registry (the WB3 composition wiring: the
//                        existence gate at the service boundary, checked
//                        through the W132 operational read API on the base
//                        connection BEFORE the append transaction).
//                        EXISTENCE, not activity: a since-superseded fabric
//                        binding passes the gate — and historical
//                        attachments already in the audit log are never
//                        re-validated (the recorded opacity ruling);
//   policy_check_failed— the attachment's verbatim policy-check verdict is
//                        not 'compatible' (incompatible OR unknown): the
//                        attachment is REFUSED and NOTHING is appended —
//                        this layer never activates a binding it cannot
//                        vouch for (recorded ruling, reversible at TL
//                        discretion; see WORK-NOTES.md).

export type AgentBodyErrorCode =
  | 'invalid_context'
  | 'invalid_body_input'
  | 'invalid_query'
  | 'invalid_binding_input'
  | 'body_not_found'
  | 'body_role_taken'
  | 'body_retired'
  | 'binding_not_found'
  | 'binding_inactive'
  | 'fabric_binding_not_found'
  | 'policy_check_failed';

export class AgentBodyError extends Error {
  constructor(
    public readonly code: AgentBodyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentBodyError';
  }
}
