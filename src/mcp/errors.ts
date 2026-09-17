// ============================================================================
// mcp — typed errors of the MCP surface (W039).
//
// The MCP server is a thin, capability-oriented adapter (ARCHITECTURE.md
// §23, ADR-0005): every tool call resolves a tenant/principal context,
// passes a policy check, executes ONE module-contract operation and is
// audited. Anything that goes wrong on that path is reported to the MCP
// client as a structured `{ ok: false, error: { code, message } }`
// envelope — never as a bare exception (LLM clients need actionable
// codes, and stack traces must not leak into transcripts).
//
// Codes:
//   invalid_config     — the server itself is misconfigured (missing or
//                        malformed tenant/principal environment), or the
//                        configured principal is not a member of the
//                        configured tenant. Surfaced when the context
//                        cannot be established at all.
//   invalid_arguments  — the tool arguments failed normalization (shape,
//                        types, bounds). The domain modules would reject
//                        them too; the MCP layer fails fast with the tool
//                        name and field.
//   policy_denied      — the tenant's authority matrix (W009) forbids the
//                        operation, or requires a human approval the
//                        caller has not obtained (for read tools), or a
//                        gated request was rejected by a human decision.
//   not_found          — the addressed record does not exist in this
//                        tenant (or exists in another tenant — uniformly
//                        indistinguishable, ADR-0001).
//   forbidden          — a claim-gated operation was attempted without
//                        the required authority claim (e.g. deciding an
//                        approval without 'actions:approve').
//   domain_error       — the owning module rejected the operation for a
//                        domain reason (validation, conflicts); the
//                        module's own error code is preserved in
//                        `details.domainCode`.
//   upstream_error     — an unexpected infrastructure failure; the message
//                        is generic, details are logged server-side only.
//
// `details` is always JSON-serializable (it is embedded verbatim in the
// tool result and in the audit event payload).
// ============================================================================

export type McpErrorCode =
  | 'invalid_config'
  | 'invalid_arguments'
  | 'policy_denied'
  | 'not_found'
  | 'forbidden'
  | 'domain_error'
  | 'upstream_error';

export class McpToolError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}
