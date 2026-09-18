// ============================================================================
// mcp/registry — the tool registry and the invocation pipeline (W039).
//
// Every MCP tool call runs the SAME deterministic pipeline, which is what
// makes the surface auditable and policy-checked by construction
// (ARCHITECTURE-LOCK 32: "API/MCP operations are tenant-scoped,
// permission-checked and audited"):
//
//   1. NORMALIZE — pure argument validation (invalid → invalid_arguments).
//   2. POLICY    — read tools: matrix evaluation; gated tools: the W009
//                  approval gate; claim tools: the owning module's claim
//                  check inside the domain call.
//   3. EXECUTE   — exactly one module-contract operation, with the
//                  EXPLICIT TenantContext (no ambient global).
//   4. AUDIT     — one immutable `mcp.tool_invoked` event per invocation
//                  (policy snapshot, outcome, error, result summary).
//
// Gated-tool idempotency: a caller-supplied idempotencyKey dedupes the
// WHOLE flow — authorizeAction replays the recorded request (first write
// wins), and the execution itself is deduplicated by locating the prior
// `mcp:<tool>:<key>` audit event and replaying its recorded result. After
// a human approves, re-invoking with the same key executes the operation
// exactly once (the replayed request now stands approved).
//
// Error mapping: module errors (GoalsError, MissionsError, ActionsError,
// EventsError, …) are typed errors with a string `code` field; they
// surface to the client as structured envelopes — '*_not_found' →
// 'not_found' (uniform, no existence leaks), 'forbidden' → 'forbidden',
// everything else → 'domain_error' with the module's code preserved.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import type { ActionRequest } from '@/modules/actions/contract';
import { findInvocationAuditEvent, recordToolInvocation } from './audit';
import type { AuditPolicySnapshot, ToolInvocationOutcome } from './audit';
import { McpToolError } from './errors';
import type { McpErrorCode } from './errors';
import { checkReadPolicy, gateToolAction } from './policy';
import type { ToolCallResult, ToolDefinition } from './types';
import { agentsTools } from './tools/agents';
import { approvalsTools } from './tools/approvals';
import { epistemicsTools } from './tools/epistemics';
import { goalsTools } from './tools/goals';
import { missionsTools } from './tools/missions';
import { observationsTools } from './tools/observations';

/** The complete MCP capability surface (order = tools/list order). */
export const AURUM_MCP_TOOLS: readonly ToolDefinition[] = [
  ...goalsTools,
  ...epistemicsTools,
  ...observationsTools,
  ...missionsTools,
  ...agentsTools,
  ...approvalsTools,
];

/** Look up one tool by name (the MCP protocol addressing key). */
export function findTool(name: string): ToolDefinition | undefined {
  return AURUM_MCP_TOOLS.find((tool) => tool.name === name);
}

interface CodedError {
  code: unknown;
  message: string;
}

function isCodedError(error: unknown): error is CodedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

/** The client-facing error envelope of any failure. */
interface ErrorEnvelope {
  code: McpErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Map any thrown value to the MCP envelope. The Aurum module convention:
 * typed errors carry a stable string `code` (GoalsError, MissionsError,
 * ActionsError, EventsError, ...). Unknown failures become
 * 'upstream_error' with a generic message (details stay server-side).
 */
export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof McpToolError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (isCodedError(error)) {
    const domainCode = error.code as string;
    if (domainCode.endsWith('_not_found')) {
      return { code: 'not_found', message: error.message, details: { domainCode } };
    }
    if (domainCode === 'forbidden') {
      return { code: 'forbidden', message: error.message, details: { domainCode } };
    }
    return { code: 'domain_error', message: error.message, details: { domainCode } };
  }
  return {
    code: 'upstream_error',
    message: 'an unexpected infrastructure failure occurred — see the server logs',
  };
}

/** The gated flow's reserved arguments, validated by each tool's normalize. */
interface GateArgs {
  actionKind: string;
  idempotencyKey: string | null;
  justification: string | null;
}

function resolveGateArgs(tool: ToolDefinition, args: Record<string, unknown>): GateArgs {
  const fixedKind = tool.policy.kind === 'gate' ? tool.policy.actionKind : undefined;
  let actionKind = fixedKind;
  if (actionKind === undefined) {
    const dynamicKind = args.actionKind;
    if (typeof dynamicKind !== 'string' || dynamicKind.trim() === '') {
      // Every gated tool's normalize guarantees this; the guard keeps the
      // pipeline total regardless of future tool additions.
      throw new McpToolError('invalid_arguments', `'${tool.name}' must provide its gate action kind`);
    }
    actionKind = dynamicKind;
  }
  return {
    actionKind,
    idempotencyKey:
      args.idempotencyKey === undefined || args.idempotencyKey === null
        ? null
        : (args.idempotencyKey as string),
    justification:
      args.justification === undefined || args.justification === null
        ? null
        : (args.justification as string),
  };
}

function auditKeyFor(tool: ToolDefinition, idempotencyKey: string | null): string | null {
  return idempotencyKey === null ? null : `mcp:${tool.name}:${idempotencyKey}`;
}

function policySnapshot(request: ActionRequest): AuditPolicySnapshot {
  return {
    actionKind: request.actionKind,
    authorityLevel: request.authorityLevel,
    outcome: request.evaluation.outcome,
    resolvedVia: request.evaluation.resolvedVia,
  };
}

/**
 * Run one tool invocation end-to-end. NEVER throws: every failure mode
 * (bad arguments, policy denial, domain error, upstream failure) is
 * returned as a structured failure envelope, and every terminal state
 * appends exactly one audit event first.
 */
export async function runTool(
  tool: ToolDefinition,
  ctx: TenantContext,
  rawArgs: unknown,
): Promise<ToolCallResult> {
  // --- 1. normalize ---------------------------------------------------------
  let args: Record<string, unknown>;
  try {
    args = tool.normalize(rawArgs);
  } catch (error) {
    return await finishError(tool, ctx, { unnormalized: true }, 'error', error, null);
  }

  // --- 2..4 per policy class ------------------------------------------------
  if (tool.policy.kind === 'read') {
    return await runReadTool(tool, ctx, args);
  }
  return await runGatedOrClaimTool(tool, ctx, args);
}

async function runReadTool(
  tool: ToolDefinition,
  ctx: TenantContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  // --- 2. policy: matrix evaluation for reads -------------------------------
  let evaluation;
  try {
    evaluation = await checkReadPolicy(ctx);
  } catch (error) {
    if (error instanceof McpToolError && error.code === 'policy_denied') {
      // Denied by the tenant's matrix — audited as a denial.
      const policy = error.details?.policy as AuditPolicySnapshot | undefined;
      await recordToolInvocation(ctx, {
        tool: tool.name,
        outcome: 'denied_by_policy',
        args,
        policy: policy ?? null,
        error: { code: error.code, message: error.message },
      });
      return { ok: false, tool: tool.name, error: envelope(error) };
    }
    return await finishError(tool, ctx, args, 'error', error, null);
  }

  // --- 3. execute + 4. audit -------------------------------------------------
  try {
    const { data, summary } = await tool.execute(ctx, args, null);
    await recordToolInvocation(ctx, {
      tool: tool.name,
      outcome: 'executed',
      args,
      policy: {
        actionKind: evaluation.actionKind,
        authorityLevel: evaluation.authorityLevel,
        outcome: evaluation.outcome,
        resolvedVia: evaluation.resolvedVia,
      },
      resultSummary: summary ?? null,
    });
    return { ok: true, tool: tool.name, data };
  } catch (error) {
    return await finishError(tool, ctx, args, 'error', error, null);
  }
}

async function runGatedOrClaimTool(
  tool: ToolDefinition,
  ctx: TenantContext,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (tool.policy.kind === 'claim') {
    // The owning module enforces its claim gate inside the domain call;
    // a claim failure surfaces (and audits) as 'forbidden'.
    try {
      const { data, summary } = await tool.execute(ctx, args, null);
      await recordToolInvocation(ctx, {
        tool: tool.name,
        outcome: 'executed',
        args,
        policy: null,
        resultSummary: summary ?? null,
      });
      return { ok: true, tool: tool.name, data };
    } catch (error) {
      const outcome: ToolInvocationOutcome =
        errorEnvelope(error).code === 'forbidden' ? 'forbidden' : 'error';
      return await finishError(tool, ctx, args, outcome, error, null);
    }
  }

  // GATED flow: proposal → matrix → (human decision) → execution.
  const gate = resolveGateArgs(tool, args);
  const auditKey = auditKeyFor(tool, gate.idempotencyKey);

  // End-to-end dedupe: a recorded audit event for this key means the
  // (approved) execution already happened — replay its result summary.
  if (auditKey !== null) {
    try {
      const prior = await findInvocationAuditEvent(ctx, auditKey);
      if (prior !== null) {
        const payload = prior.payload as
          | { outcome?: string; requestId?: string | null; resultSummary?: unknown }
          | null;
        if (payload !== null && payload.outcome === 'executed') {
          return {
            ok: true,
            tool: tool.name,
            data: {
              status: 'executed',
              replayed: true,
              requestId: payload.requestId ?? null,
              result: payload.resultSummary ?? null,
            },
          };
        }
      }
    } catch {
      // The dedupe lookup is an optimization over first-write-wins
      // semantics; a failed lookup falls through to the normal flow,
      // where the actions module and the audit append still dedupe.
    }
  }

  // --- 2. policy: the approval gate itself ----------------------------------
  let request: ActionRequest;
  try {
    request = await gateToolAction(ctx, {
      actionKind: gate.actionKind,
      payload: args,
      justification: gate.justification,
      idempotencyKey: gate.idempotencyKey,
    });
  } catch (error) {
    return await finishError(tool, ctx, args, 'error', error, null);
  }

  const snapshot = policySnapshot(request);

  if (request.status === 'rejected') {
    // The tenant's matrix forbids this proposal outright.
    await recordToolInvocation(ctx, {
      tool: tool.name,
      outcome: 'denied_by_policy',
      args,
      policy: snapshot,
      requestId: request.id,
      error: {
        code: 'policy_denied',
        message: `tenant policy forbids this action (matrix outcome '${request.evaluation.outcome}')`,
      },
    });
    return {
      ok: false,
      tool: tool.name,
      error: {
        code: 'policy_denied',
        message: `tenant policy forbids this action (action kind '${gate.actionKind}', matrix outcome '${request.evaluation.outcome}')`,
        details: { requestId: request.id, policy: snapshot },
      },
    };
  }

  if (request.status === 'pending') {
    // The gate is waiting for a human decision — the operation does NOT run.
    // Audited WITHOUT the dedupe key: every invocation that observes the
    // pending request is its own invocation record; the key is reserved
    // for the EXECUTION audit (see below), so a later execution is
    // recorded as a new event rather than replaying this one.
    await recordToolInvocation(ctx, {
      tool: tool.name,
      outcome: 'approval_required',
      args,
      policy: snapshot,
      requestId: request.id,
      resultSummary: null,
    });
    return {
      ok: true,
      tool: tool.name,
      data: {
        status: 'approval_required',
        message:
          'the tenant authority matrix requires a human decision for this action — the proposal ' +
          'waits as a pending request; nothing has been executed',
        requestId: request.id,
        actionKind: request.actionKind,
        requestedAt: request.requestedAt,
      },
    };
  }

  // status === 'approved': policy auto-approval (or a replayed request a
  // human has since approved) — execute the domain operation exactly once.
  try {
    const { data, summary } = await tool.execute(ctx, args, request);
    await recordToolInvocation(
      ctx,
      {
        tool: tool.name,
        outcome: 'executed',
        args,
        policy: snapshot,
        requestId: request.id,
        resultSummary: summary ?? null,
      },
      auditKey ?? undefined,
    );
    return { ok: true, tool: tool.name, data };
  } catch (error) {
    return await finishError(tool, ctx, args, 'error', error, request.id);
  }
}

/** Uniform terminal failure: audit first (best-effort), then the envelope. */
async function finishError(
  tool: ToolDefinition,
  ctx: TenantContext,
  args: Record<string, unknown>,
  outcome: ToolInvocationOutcome,
  error: unknown,
  requestId: string | null,
): Promise<ToolCallResult> {
  const envelope = errorEnvelope(error);
  // Audited WITHOUT the dedupe key: only 'executed' events carry it (an
  // error event under the key would replay instead of the later,
  // successful execution's audit record).
  await recordToolInvocation(ctx, {
    tool: tool.name,
    outcome: outcome === 'forbidden' ? 'forbidden' : outcome,
    args,
    policy: null,
    requestId,
    error: { code: envelope.code, message: envelope.message },
  });
  return { ok: false, tool: tool.name, error: envelope };
}

function envelope(error: McpToolError): ErrorEnvelope {
  return { code: error.code, message: error.message, details: error.details };
}
