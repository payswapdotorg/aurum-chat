// ============================================================================
// mcp/tools/approvals — MCP tools over the actions contract (W039).
//
// ARCHITECTURE.md §23: MCP "may expose authorized operations such as ...
// proposing agent recruitment ... interacting with approval workflows".
// The actions module (W009) IS the approval workflow: the authority
// matrix and the deterministic approval gates.
//
//   list_action_requests / get_action_request — READ class (matrix
//   evaluation 'mcp.read' @ OBSERVE): the approvals feed and one
//   request with its append-only decision trail.
//
//   propose_action — GATED class: the generic consequential proposal.
//   Proposing agent recruitment / agent termination / extension
//   deployment / external communication / ... routes through
//   authorizeAction at PROPOSE for the canonical §20 kind. The matrix
//   decides: allowed → the request stands approved (a proposal the
//   tenant's policy does not gate — recorded, not executed); gated →
//   the request waits as 'pending' for a human; forbidden → refused.
//   NOTHING is executed by this tool — it records proposals for the
//   human approval workflow (the owning modules act on approved
//   requests through their own flows).
//
//   decide_approval — CLAIM class: the human decision on a pending
//   request. The actions module itself enforces the 'actions:approve'
//   claim (or the kind-scoped variant) and separation of duties (the
//   requesting principal can never decide its own request); the MCP
//   layer adds no second rule — the owning module's gate is the policy
//   check, surfaced to the client as a typed error when it trips.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import {
  CANONICAL_ACTION_KINDS,
  decideApproval,
  getActionRequest,
  listActionRequests,
  listApprovalDecisions,
} from '@/modules/actions/contract';
import type {
  ActionRequest,
  ActionRequestStatus,
  ApprovalDecisionKind,
  AuthorityLevel,
  CanonicalActionKind,
} from '@/modules/actions/contract';
import { MCP_WRITE_AUTHORITY_LEVEL } from '../policy';
import { McpToolError } from '../errors';
import type { ToolDefinition } from '../types';
import {
  optionalEnum,
  optionalIdempotencyKey,
  optionalListLimit,
  optionalTextOrNull,
  optionalUuid,
  requireArgsObject,
  requireEnum,
  requireUuid,
  rejectUnknownKeys,
} from '../validation';

const REQUEST_STATUS_VALUES = ['pending', 'approved', 'rejected'] as const;
const AUTHORITY_LEVEL_VALUES = ['OBSERVE', 'ANALYZE', 'RECOMMEND', 'ASK', 'PROPOSE', 'EXECUTE'] as const;
const DECISION_VALUES = ['approve', 'reject'] as const;

const LIST_REQUESTS_ARGS = [
  'actionKind',
  'authorityLevel',
  'status',
  'requestedBy',
  'limit',
] as const;
const GET_REQUEST_ARGS = ['requestId'] as const;
const PROPOSE_ACTION_ARGS = ['actionKind', 'payload', 'justification', 'idempotencyKey'] as const;
const DECIDE_ARGS = ['requestId', 'decision', 'note'] as const;

export function requestSummary(request: ActionRequest): {
  requestId: string;
  actionKind: string;
  status: string;
} {
  return { requestId: request.id, actionKind: request.actionKind, status: request.status };
}

export const approvalsTools: ToolDefinition[] = [
  {
    name: 'list_action_requests',
    title: 'List the approvals feed',
    description:
      "List the tenant's action requests routed through the authority matrix: kind, level, " +
      'payload, requester, evaluation snapshot and status (pending / approved / rejected). This ' +
      "is the approval queue humans act on. Read capability (action kind 'mcp.read').",
    inputSchema: {
      type: 'object',
      properties: {
        actionKind: { type: 'string', description: 'Filter by action kind.' },
        authorityLevel: {
          type: 'string',
          enum: [...AUTHORITY_LEVEL_VALUES],
          description: 'Filter by authority level.',
        },
        status: {
          type: 'string',
          enum: [...REQUEST_STATUS_VALUES],
          description: 'Filter by request status.',
        },
        requestedBy: {
          type: 'string',
          format: 'uuid',
          description: 'Filter by requesting principal.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 50).' },
      },
    },
    annotations: { title: 'List the approvals feed', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'list_action_requests';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, LIST_REQUESTS_ARGS, tool);
      const query: Record<string, unknown> = {};
      const actionKindRaw = args.actionKind;
      if (actionKindRaw !== undefined && actionKindRaw !== null) {
        if (typeof actionKindRaw !== 'string' || actionKindRaw.trim() === '') {
          throw new McpToolError(
            'invalid_arguments',
            `'${tool}' argument 'actionKind' must be a non-empty canonical action kind string`,
          );
        }
        query.actionKind = actionKindRaw.trim();
      }
      const authorityLevel = optionalEnum<AuthorityLevel>(
        args,
        'authorityLevel',
        AUTHORITY_LEVEL_VALUES,
        tool,
      );
      if (authorityLevel !== undefined) query.authorityLevel = authorityLevel;
      const status = optionalEnum<ActionRequestStatus>(args, 'status', REQUEST_STATUS_VALUES, tool);
      if (status !== undefined) query.status = status;
      const requestedBy = optionalUuid(args, 'requestedBy', tool);
      if (requestedBy !== undefined) query.requestedBy = requestedBy;
      const limit = optionalListLimit(args, 'limit', tool);
      if (limit !== undefined) query.limit = limit;
      return query;
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const requests = await listActionRequests(ctx, args);
      return { data: requests, summary: { count: requests.length } };
    },
  },
  {
    name: 'get_action_request',
    title: 'Inspect one approval request',
    description:
      'Retrieve one action request with its full evaluation snapshot (the policy row that ' +
      'decided, and how it was resolved) and the append-only decision trail (policy and human ' +
      'decisions in order). Read capability (action kind mcp.read).',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', format: 'uuid', description: 'The action request id.' },
      },
      required: ['requestId'],
    },
    annotations: { title: 'Inspect one approval request', readOnlyHint: true, openWorldHint: false },
    policy: { kind: 'read' },
    normalize: (raw) => {
      const tool = 'get_action_request';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, GET_REQUEST_ARGS, tool);
      return { requestId: requireUuid(args, 'requestId', tool) };
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const requestId = args.requestId as string;
      const request = await getActionRequest(ctx, { requestId });
      const decisions = await listApprovalDecisions(ctx, { requestId });
      return { data: { request, decisions }, summary: requestSummary(request) };
    },
  },
  {
    name: 'propose_action',
    title: 'Propose a consequential action (approval-gated)',
    description:
      `Propose a consequential action for the tenant's approval workflow — e.g. agent ` +
      `recruitment, agent termination, extension deployment, source access, data export or ` +
      `external communication. The proposal is recorded as an action request and routed ` +
      `deterministically through the tenant authority matrix at level ${MCP_WRITE_AUTHORITY_LEVEL}: ` +
      `allowed → the request stands approved; approval required → it waits as 'pending' for a ` +
      `human (decide_approval); forbidden → refused. This tool records proposals — it never ` +
      `executes the action itself. Re-invoking with the same idempotencyKey replays the original ` +
      `request instead of proposing twice.`,
    inputSchema: {
      type: 'object',
      properties: {
        actionKind: {
          type: 'string',
          enum: [...CANONICAL_ACTION_KINDS],
          description: 'The canonical §20 action kind of the proposal.',
        },
        payload: {
          type: 'object',
          description: 'The proposed action content (plain JSON; recorded on the request).',
        },
        justification: {
          type: 'string',
          maxLength: 2000,
          description: 'Why this action is proposed — shown to the approver.',
        },
        idempotencyKey: {
          type: 'string',
          maxLength: 200,
          description: 'Dedupe key: re-invoking with a recorded key replays the original request.',
        },
      },
      required: ['actionKind', 'payload'],
    },
    annotations: {
      title: 'Propose a consequential action (approval-gated)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    policy: { kind: 'gate' },
    normalize: (raw) => {
      const tool = 'propose_action';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, PROPOSE_ACTION_ARGS, tool);
      const actionKind = requireEnum<CanonicalActionKind>(
        args,
        'actionKind',
        CANONICAL_ACTION_KINDS,
        tool,
      );
      const payload = args.payload;
      if (payload === undefined || payload === null || typeof payload !== 'object') {
        throw new McpToolError(
          'invalid_arguments',
          `'${tool}' requires a JSON-serializable object 'payload'`,
        );
      }
      try {
        JSON.stringify(payload);
      } catch {
        throw new McpToolError(
          'invalid_arguments',
          `'${tool}' requires a JSON-serializable object 'payload'`,
        );
      }
      return {
        // The gate uses the PROPOSAL's own canonical kind — the policy
        // row the tenant configured for exactly this action.
        actionKind,
        payload,
        justification: optionalTextOrNull(args, 'justification', tool, 2000),
        idempotencyKey: optionalIdempotencyKey(args, tool),
      };
    },
    // The gate request IS the operation (this tool records proposals;
    // it executes nothing). `execute` runs only after the matrix
    // auto-allowed the request and simply returns it.
    execute: async (_ctx: TenantContext, _args, gate: unknown) => {
      const request = gate as ActionRequest;
      return { data: request, summary: requestSummary(request) };
    },
  },
  {
    name: 'decide_approval',
    title: 'Decide a pending approval request',
    description:
      "Approve or reject a pending action request — the human decision the authority matrix " +
      "asked for. Requires the 'actions:approve' authority claim (or the kind-scoped " +
      "'actions:approve:<kind>'); the principal that requested the action can never decide its " +
      'own request (separation of duties). First decision wins; approved/rejected are terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', format: 'uuid', description: 'The pending request id.' },
        decision: {
          type: 'string',
          enum: [...DECISION_VALUES],
          description: 'The human decision.',
        },
        note: { type: 'string', maxLength: 2000, description: 'Why — recorded on the decision.' },
      },
      required: ['requestId', 'decision'],
    },
    annotations: {
      title: 'Decide a pending approval request',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    policy: { kind: 'claim' },
    normalize: (raw) => {
      const tool = 'decide_approval';
      const args = requireArgsObject(raw, tool);
      rejectUnknownKeys(args, DECIDE_ARGS, tool);
      return {
        requestId: requireUuid(args, 'requestId', tool),
        decision: requireEnum<ApprovalDecisionKind>(args, 'decision', DECISION_VALUES, tool),
        note: optionalTextOrNull(args, 'note', tool, 2000),
      };
    },
    execute: async (ctx: TenantContext, args, _gate: unknown) => {
      const request = await decideApproval(ctx, {
        requestId: args.requestId as string,
        decision: args.decision as ApprovalDecisionKind,
        note: args.note as string | null,
      });
      return { data: request, summary: requestSummary(request) };
    },
  },
];
