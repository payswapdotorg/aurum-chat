// ============================================================================
// mcp — policy checks over the W009 authority matrix (W039).
//
// ARCHITECTURE-LOCK 32: "API/MCP operations are tenant-scoped,
// permission-checked and audited." The permission machinery is OWNED by
// the actions module (W009) and is consumed here exactly as its contract
// anticipates ("evaluateActionAuthority — the read-only evaluation of one
// (kind, level): ... Records nothing; consequential paths use
// authorizeAction"). The MCP layer adds no policy semantics of its own:
//
//   READ tools (level OBSERVE, action kind 'mcp.read'):
//     checkReadPolicy → evaluateActionAuthority. Outcome 'allowed' →
//     the tool executes. Outcome 'forbidden' → the call is denied
//     (policy_denied). Outcome 'approval_required' → also denied: a
//     tenant that gates MCP OBSERVE behind human approval has decided
//     this server may not read that surface without a decision — reads
//     do not auto-create approval requests (that would flood the
//     approvals feed); the denial names the deciding policy.
//
//   GATED tools (level PROPOSE, per-tool action kind):
//     gateToolAction → authorizeAction — the deterministic approval
//     gate itself. 'allowed' → status approved → the operation executes
//     immediately (policy auto-approval, recorded as such). 'forbidden'
//     → status rejected → denied. 'approval_required' → status pending:
//     the operation does NOT run; the tool returns the pending request
//     id and a human decides it (MCP decide_approval tool, the future
//     control tower, ...). Re-invoking the same tool with the same
//     idempotencyKey after the decision replays the request — now
//     approved/rejected — and executes or denies accordingly
//     (first-write-wins, the actions module's replay semantics).
//
//   CLAIM tools (decide_approval):
//     no matrix check here — the actions module itself enforces the
//     'actions:approve' claim and separation of duties on
//     decideApproval. The owning module's rule is the policy check;
//     duplicating it in the adapter would be re-implementation, not
//     defense in depth (the matrix "applies uniformly", §20 — the claim
//     vocabulary is the tenant-wide model those checks fold into).
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import {
  authorizeAction,
  evaluateActionAuthority,
} from '@/modules/actions/contract';
import type {
  ActionRequest,
  AuthorityEvaluation,
} from '@/modules/actions/contract';
import { McpToolError } from './errors';

/** The action kind every read tool is evaluated under (tenant-gateable as one switch). */
export const MCP_READ_ACTION_KIND = 'mcp.read';
/** Read tools operate at the lowest §20 authority level. */
export const MCP_READ_AUTHORITY_LEVEL = 'OBSERVE' as const;
/** Gated (consequential) MCP tools propose — a human executes/approves. */
export const MCP_WRITE_AUTHORITY_LEVEL = 'PROPOSE' as const;

/**
 * Policy check for one read tool invocation. Throws McpToolError
 * ('policy_denied') when the tenant's matrix does not flatly allow
 * OBSERVE for 'mcp.read'; returns the evaluation snapshot otherwise
 * (embedded in the tool result and the audit event).
 */
export async function checkReadPolicy(ctx: TenantContext): Promise<AuthorityEvaluation> {
  const evaluation = await evaluateActionAuthority(ctx, {
    actionKind: MCP_READ_ACTION_KIND,
    authorityLevel: MCP_READ_AUTHORITY_LEVEL,
  });
  if (evaluation.outcome !== 'allowed') {
    throw new McpToolError(
      'policy_denied',
      `tenant policy denies this MCP read (matrix outcome '${evaluation.outcome}', resolved via ${evaluation.resolvedVia})`,
      {
        policy: {
          actionKind: evaluation.actionKind,
          authorityLevel: evaluation.authorityLevel,
          outcome: evaluation.outcome,
          resolvedVia: evaluation.resolvedVia,
        },
      },
    );
  }
  return evaluation;
}

/**
 * The approval gate for one consequential tool invocation: record the
 * action request and route it deterministically through the matrix.
 * Returns the request (its status decides whether the operation may
 * run now, waits for a human, or is refused).
 */
export async function gateToolAction(
  ctx: TenantContext,
  input: {
    actionKind: string;
    payload: unknown;
    justification?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<ActionRequest> {
  return authorizeAction(ctx, {
    actionKind: input.actionKind,
    authorityLevel: MCP_WRITE_AUTHORITY_LEVEL,
    payload: input.payload,
    justification: input.justification ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  });
}
