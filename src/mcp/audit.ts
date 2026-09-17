// ============================================================================
// mcp — audit events for every MCP tool invocation (W039).
//
// ARCHITECTURE-LOCK 32: "API/MCP operations are tenant-scoped,
// permission-checked and audited." The dedicated audit module (W046)
// is not delivered at this base, so the MCP surface records its audit
// trail where immutable, tenant-scoped, provenance-bearing history
// already lives: the events module (W003) — "Downstream modules
// (process intelligence W016, audit, the API surface) derive everything
// from the append-only event log" (src/modules/events/types.ts).
//
// Every tool invocation — executed, denied by policy, parked in the
// approval gate, refused by claims or failed — appends exactly one
// immutable `mcp.tool_invoked` event:
//   * tenant-scoped by construction (appendEvent pins ctx.tenantId);
//   * provenance: actor = the acting principal (opaque id, the
//     events-module precedent — unverified references to the future
//     auth/people modules), source = { kind: 'api', label: 'mcp' } —
//     the surface the operation entered through;
//   * payload: tool name, normalized arguments, the policy evaluation
//     snapshot, the outcome, the domain error and a result summary —
//     enough to reconstruct WHAT was asked, WHICH policy decided and
//     WHAT happened (ARCHITECTURE.md §24);
//   * idempotency: gated tool calls with a caller-supplied key use
//     `mcp:<tool>:<key>` as the event's dedupe key, so retried
//     executions cannot duplicate audit history (and registry.ts uses
//     the same key to dedupe the EXECUTION itself).
//
// Audit appends are best-effort AFTER the fact: a successful domain
// operation is reported as successful even if its audit write fails
// (misreporting an executed consequential action as failed would be
// worse); the failure is logged to stderr for operators. This is the
// documented tradeoff — W046 owns the hardened cross-cutting pipeline.
// ============================================================================

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { appendEvent, listEvents } from '@/modules/events/contract';
import type { Event } from '@/modules/events/contract';

/** Canonical event type of one MCP tool invocation (versioned payload contract). */
export const MCP_AUDIT_EVENT_TYPE = 'mcp.tool_invoked';
export const MCP_AUDIT_EVENT_TYPE_VERSION = 1;

/** Canonical outcome classification of one tool invocation. */
export type ToolInvocationOutcome =
  | 'executed'
  | 'denied_by_policy'
  | 'approval_required'
  | 'forbidden'
  | 'error';

/** The policy snapshot embedded in the audit payload (W009 evaluation). */
export interface AuditPolicySnapshot {
  actionKind: string;
  authorityLevel: string;
  outcome: string;
  resolvedVia: string;
}

/** What one `mcp.tool_invoked` event records (plain JSON only). */
export interface ToolInvocationAuditRecord {
  tool: string;
  outcome: ToolInvocationOutcome;
  /** The normalized tool arguments (JSON-safe; reconstructs WHAT was asked). */
  args: unknown;
  policy?: AuditPolicySnapshot | null;
  /** The actions-module request id for gated tools. */
  requestId?: string | null;
  error?: { code: string; message: string } | null;
  /** Compact summary of the domain result (ids/counts, never full dumps). */
  resultSummary?: unknown;
}

/** Provenance: the delivery surface (MCP over the public-API family). */
export const MCP_EVENT_SOURCE = { kind: 'api', label: 'mcp' } as const;

/**
 * Assemble the audit event payload of one tool invocation (pure —
 * unit-tested without a database). Null fragments collapse so payloads
 * stay small and predictable.
 */
export function buildToolInvocationPayload(
  record: ToolInvocationAuditRecord,
): Record<string, unknown> {
  return {
    tool: record.tool,
    outcome: record.outcome,
    args: record.args,
    policy: record.policy ?? null,
    requestId: record.requestId ?? null,
    error: record.error ?? null,
    resultSummary: record.resultSummary ?? null,
  };
}

/**
 * Append one immutable audit event for a tool invocation. Never throws:
 * returns the recorded event, or null when the append failed (logged to
 * stderr — see the header for the tradeoff).
 *
 * `auditKey`, when provided, is the event's idempotency key
 * (`mcp:<tool>:<caller key>`) so retried gated executions replay the
 * original audit record instead of duplicating history.
 */
export async function recordToolInvocation(
  ctx: TenantContext,
  record: ToolInvocationAuditRecord,
  auditKey?: string,
): Promise<Event | null> {
  try {
    return await appendEvent(ctx, {
      type: MCP_AUDIT_EVENT_TYPE,
      typeVersion: MCP_AUDIT_EVENT_TYPE_VERSION,
      payload: buildToolInvocationPayload(record),
      occurredAt: now().toISOString(),
      actor: { kind: 'person', id: ctx.principalId },
      source: MCP_EVENT_SOURCE,
      idempotencyKey: auditKey ?? null,
    });
  } catch (error) {
    process.stderr.write(
      `aurum-mcp: audit append failed for tool '${record.tool}' (outcome '${record.outcome}'): ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
}

/**
 * Locate a previously recorded tool-invocation audit event by its dedupe
 * key (`mcp:<tool>:<caller key>`) — the read side of the gated-tool
 * execution dedupe (registry.ts). Returns null when no such event exists
 * in this tenant.
 */
export async function findInvocationAuditEvent(
  ctx: TenantContext,
  auditKey: string,
): Promise<Event | null> {
  const found = await listEvents(ctx, { idempotencyKey: auditKey, limit: 1 });
  return found[0] ?? null;
}
