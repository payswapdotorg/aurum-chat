// ============================================================================
// mcp — shared types of the MCP tool surface (W039).
//
// A ToolDefinition is ONE capability (ARCHITECTURE.md §23: "provider-
// independent Aurum capabilities, never raw database operations"): a
// named MCP tool whose handler performs exactly one module-contract
// operation, behind a declared policy class. The definitions are pure
// metadata + closures — no database, no transport — so the registry,
// the protocol adapters and the tests all compose them differently.
//
// Policy classes (policy.ts owns the semantics):
//   read  — matrix evaluation ('mcp.read' @ OBSERVE) before the call;
//   gate  — the W009 approval gate (authorizeAction @ PROPOSE) before
//           consequential operations; execution only on auto-approval,
//           a pending request id otherwise;
//   claim — the owning module enforces its own claim gate.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import type { ActionRequest } from '@/modules/actions/contract';
import type { McpErrorCode } from './errors';

/** A JSON Schema (draft subset) describing one tool's input. */
export interface ToolInputSchema {
  [key: string]: unknown;
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

/** MCP tool annotations (hints, per the MCP spec). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolPolicy =
  | { kind: 'read' }
  | { kind: 'gate'; actionKind?: string }
  | { kind: 'claim' };

/** What a tool's executor returns to the registry. */
export interface ToolExecutionResult {
  /** The domain result, serialized verbatim to the MCP client. */
  data: unknown;
  /** Compact summary recorded in the audit event (ids/counts). */
  summary?: unknown;
}

export interface ToolDefinition {
  /** MCP tool name (snake_case, stable — clients code against it). */
  name: string;
  /** Human/LLM-facing one-liner shown in tools/list. */
  title: string;
  /** What the tool does, which capabilities it exposes, and its policy posture. */
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: ToolInputSchema;
  annotations: ToolAnnotations;
  policy: ToolPolicy;
  /**
   * Pure validation/normalization of raw MCP arguments. Throws
   * McpToolError('invalid_arguments') on shape/type problems; the
   * output must be JSON-safe (it is embedded in the audit event).
   */
  normalize: (raw: unknown) => Record<string, unknown>;
  /**
   * The ONE module-contract operation, already policy-cleared by the
   * registry. Receives the explicit TenantContext, the normalized
   * arguments and — for gated tools — the approval-gate ActionRequest
   * whose 'approved' status authorized this execution.
   */
  execute: (
    ctx: TenantContext,
    args: Record<string, unknown>,
    gate: ActionRequest | null,
  ) => Promise<ToolExecutionResult>;
}

/** Success envelope returned to the MCP client. */
export interface ToolCallSuccess {
  ok: true;
  tool: string;
  data: unknown;
}

/** Failure envelope returned to the MCP client. */
export interface ToolCallFailure {
  ok: false;
  tool: string;
  error: {
    code: McpErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ToolCallResult = ToolCallSuccess | ToolCallFailure;

/** A gated tool's reserved arguments (the registry consumes both). */
export interface GatedToolArgs {
  /**
   * The action kind of the gate when the tool's policy does not fix one
   * (propose_action): taken from the normalized arguments.
   */
  actionKind?: string;
  /**
   * Dedupe key for the whole proposal→approval→execution flow: the
   * actions module replays the recorded request, and the audit event
   * `mcp:<tool>:<key>` dedupes the execution. Re-invoking the same
   * tool with the same key after the approval completes the flow.
   */
  idempotencyKey: string | null;
  /** Why the consequential action is proposed (recorded on the request). */
  justification: string | null;
}
