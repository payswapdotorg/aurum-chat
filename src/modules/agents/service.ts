// Implementation of the agents module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and
// are never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`agent_not_found` / `execution_not_found`).
//
// W021 acceptance — "Provider-independent execution contract with
// permissions, async execution, idempotency, retries, normalized
// results, evidence and cost" — is carried by these deliberate
// properties, all tested:
//   1. PROVIDER INDEPENDENCE: every runtime interaction happens ONLY
//      through this gateway — canonical tasks in, canonical results out;
//      provider-native bodies and payloads exist only inside `adapters/`
//      and never cross the module boundary (lock 24). Five reference
//      runtimes (openai-assistants, langgraph, crewai, autogen,
//      semantic-kernel) normalize through ONE canonical contract, so
//      swapping runtimes never touches a domain contract (the W035/W048
//      foundation);
//   2. PERMISSIONS: every submission requests permission scopes and is
//      admitted only when fully covered by the agent's grant (the pure
//      `missingPermissionScope`); uncovered requests fail BEFORE
//      anything is recorded — the runtime never sees them and no action
//      request exists. The requested scopes also route the submission
//      through the W009 authority matrix (kind 'agent-execution') at the
//      HIGHEST §20 level they imply, so tenant policy governs agent
//      execution exactly as it governs every other consequential action
//      (§20 "applies uniformly");
//   3. ASYNC EXECUTION: `submitAgentExecution` records the work and
//      returns immediately; `runAgentExecution` is the explicit worker
//      pump (lock 36) that performs exactly ONE bounded dispatch attempt
//      per call — resumable, serialized per execution by a PostgreSQL
//      advisory transaction lock (the cognition module's pump
//      discipline), with the W009 approval gate as a first-class live
//      state ('awaiting_approval') resolved by re-reading the linked
//      action request between pumps;
//   4. IDEMPOTENCY: an emitter-supplied key replays the original
//      execution — first write wins (the actions/llm replay semantics);
//      the gate shares the same key, so a gated submission approved by a
//      human resumes on retry without minting a second request;
//   5. RETRIES: transient runtime failures ('dispatch_failed') retry
//      while attempts remain under the ceiling (max_attempts, 1..5);
//      provider refusals and unnormalizable results are permanent —
//      the deterministic `classifyAttemptFailure` / 
//      `statusAfterFailedAttempt`;
//   6. NORMALIZED RESULTS: only canonical, adapter-parsed results
//      ({ output, summary }) are persisted; a payload that cannot be
//      normalized is a LOUD 'result_invalid' failure, never a silent
//      substitute value (the llm adapter discipline);
//   7. EVIDENCE: executions and attempts are append-only evidence —
//      storage-level triggers reject DELETE/TRUNCATE on both and freeze
//      every substantive submission field (§24 reconstructability);
//   8. COST: each attempt records its deterministic integer-minor-unit
//      cost (adapter pricing over provider-reported usage) and the
//      execution accumulates it (the house money convention).
//
// Claim-gated writes: registering and updating agent definitions
// requires 'agents:administer' — minting organizational actors with
// permissions is a management action (the llm module's account
// discipline). Any tenant member may submit executions; the W009 matrix
// alone decides whether they run.

import { createHash } from 'node:crypto';
import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { authorizeAction, getActionRequest } from '@/modules/actions/contract';
import { ActionsError } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import { getAgentRuntimeAdapter } from './adapters';
import type { WireTaskResult } from './adapters/types';
import { AgentsError } from './errors';
import {
  AGENTS_AUTHORITY_ADMINISTER,
  authorityLevelForScopes,
  canAdministerAgents,
  classifyAttemptFailure,
  isTerminalExecutionStatus,
  missingPermissionScope,
  statusAfterFailedAttempt,
} from './policy';
import type { AgentPermissionScopeWord } from './policy';
import {
  assertAgentsTenantContext,
  validateCancelAgentExecutionInput,
  validateListAgentExecutionAttemptsQuery,
  validateListAgentExecutionsQuery,
  validateListAgentsQuery,
  validateRegisterAgentInput,
  validateRunAgentExecutionInput,
  validateSubmitAgentExecutionInput,
  validateUpdateAgentInput,
  type ValidatedCancelInput,
  type ValidatedListAgentsQuery,
  type ValidatedListExecutionsQuery,
  type ValidatedRegisterAgentInput,
  type ValidatedRunInput,
  type ValidatedSubmitInput,
  type ValidatedUpdateAgentInput,
} from './validation';
import type {
  AgentDefinition,
  AgentExecution,
  AgentExecutionAttempt,
  AgentExecutionPolicySnapshot,
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
  AgentTaskResult,
  AgentUsage,
  CancelAgentExecutionInput,
  GetAgentExecutionQuery,
  GetAgentQuery,
  ListAgentExecutionAttemptsQuery,
  ListAgentExecutionsQuery,
  ListAgentsQuery,
  RegisterAgentInput,
  RegisterAgentResult,
  RunAgentExecutionInput,
  SubmitAgentExecutionInput,
  UpdateAgentInput,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned constants (re-exported through the contract)
// ---------------------------------------------------------------------------

/** Authority claim that manages the tenant's agent definitions. */
export const AGENTS_AUTHORITY_ADMINISTER_CLAIM = AGENTS_AUTHORITY_ADMINISTER;

/** The W009 action kind every agent execution passes through. */
export const AGENT_ACTION_KIND = 'agent-execution';

// ---------------------------------------------------------------------------
// Transport wiring (infrastructure; no default — dispatch fails loudly)
// ---------------------------------------------------------------------------

let agentTransport: AgentRuntimeTransport | null = null;

/** Wire (or unwire) the provider-neutral runtime transport. */
export function setAgentTransport(transport: AgentRuntimeTransport | null): void {
  agentTransport = transport;
}

/** The wired transport, or null. */
export function getAgentTransport(): AgentRuntimeTransport | null {
  return agentTransport;
}

function requireTransport(): AgentRuntimeTransport {
  if (agentTransport === null) {
    throw new AgentsError(
      'provider_unavailable',
      'no agent runtime transport is wired — set one via setAgentTransport before dispatching (agent runtimes are external; none is wired by default)',
    );
  }
  return agentTransport;
}

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface AgentRow extends DbRow {
  id: string;
  tenant_id: string;
  slug: string;
  display_name: string | null;
  role: string;
  description: string | null;
  provider: string;
  instructions: string;
  runtime_config: unknown;
  permissions: AgentPermissionScopeWord[];
  status: 'active' | 'disabled';
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ExecutionRow extends DbRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  provider: string;
  task: unknown;
  requested_permissions: AgentPermissionScopeWord[];
  authority_level: AgentExecution['authorityLevel'];
  idempotency_key: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  status: AgentExecution['status'];
  action_request_id: string | null;
  policy_outcome: AgentExecutionPolicySnapshot['outcome'];
  policy_resolved_via: AgentExecutionPolicySnapshot['resolvedVia'];
  max_attempts: number;
  attempts_count: number;
  result: unknown;
  error_code: string | null;
  error_detail: string | null;
  cost_minor: string | number;
  submitted_by: string;
  submitted_at: Date | string;
  completed_at: Date | string | null;
  updated_at: Date | string;
}

interface AttemptRow extends DbRow {
  id: string;
  tenant_id: string;
  execution_id: string;
  attempt_number: number;
  provider: string;
  status: 'completed' | 'failed';
  retryable: boolean;
  error_code: string | null;
  error_detail: string | null;
  result: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  operations: number | null;
  cost_minor: string | number;
  provider_task_id: string | null;
  latency_ms: number;
  dispatched_at: Date | string;
  finished_at: Date | string;
  dispatched_by: string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toCount(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function mapAgent(row: AgentRow): AgentDefinition {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    displayName: row.display_name,
    role: row.role,
    description: row.description,
    provider: row.provider as AgentDefinition['provider'],
    instructions: row.instructions,
    runtimeConfig: row.runtime_config,
    permissions: [...(row.permissions ?? [])],
    status: row.status,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapExecution(row: ExecutionRow): AgentExecution {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    provider: row.provider as AgentExecution['provider'],
    task: row.task,
    requestedPermissions: [...(row.requested_permissions ?? [])],
    authorityLevel: row.authority_level,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    status: row.status,
    policy: {
      actionRequestId: row.action_request_id!,
      outcome: row.policy_outcome,
      resolvedVia: row.policy_resolved_via,
    },
    maxAttempts: Number(row.max_attempts),
    attemptsCount: Number(row.attempts_count),
    result: row.result === null ? null : (row.result as AgentTaskResult),
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    costMinor: toCount(row.cost_minor),
    costCurrency: 'USD',
    submittedBy: row.submitted_by,
    submittedAt: toIso(row.submitted_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapUsage(row: {
  input_tokens: number | null;
  output_tokens: number | null;
  operations: number | null;
}): AgentUsage {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    operations: row.operations,
  };
}

function mapAttempt(row: AttemptRow): AgentExecutionAttempt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    attemptNumber: Number(row.attempt_number),
    provider: row.provider as AgentExecution['provider'],
    status: row.status,
    retryable: row.retryable,
    errorCode: row.error_code as AgentExecutionAttempt['errorCode'],
    errorDetail: row.error_detail,
    result: row.result === null ? null : (row.result as AgentTaskResult),
    usage: mapUsage(row),
    costMinor: toCount(row.cost_minor),
    costCurrency: 'USD' as const,
    providerTaskId: row.provider_task_id,
    latencyMs: Number(row.latency_ms),
    dispatchedAt: toIso(row.dispatched_at),
    finishedAt: toIso(row.finished_at),
    dispatchedBy: row.dispatched_by,
  };
}

/** True when `error` is a PostgreSQL unique violation on `table`'s constraints. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

// ---------------------------------------------------------------------------
// Agent definitions (the persistent side of the §16 separation)
// ---------------------------------------------------------------------------

async function findAgentRow(
  db: Queryable,
  ctx: TenantContext,
  agentId: string,
): Promise<AgentRow | null> {
  const rows = await db.query<AgentRow>(
    `SELECT * FROM agent_definitions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, agentId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

export async function registerAgent(
  ctx: TenantContext,
  input: RegisterAgentInput,
): Promise<RegisterAgentResult> {
  assertAgentsTenantContext(ctx);
  // Minting organizational actors with permissions is a management
  // action (authorization before parsing — unauthorized callers learn
  // nothing about shapes).
  if (!canAdministerAgents(ctx.authority)) {
    throw new AgentsError(
      'forbidden',
      `this operation requires the '${AGENTS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid: ValidatedRegisterAgentInput = validateRegisterAgentInput(input);
  const timestamp = now();

  const existing = await getDb().query<AgentRow>(
    `SELECT * FROM agent_definitions WHERE tenant_id = $1 AND slug = $2`,
    [ctx.tenantId, valid.slug],
  );
  if (existing.rows[0] !== undefined) {
    // First registration wins (the llm module's idempotent BYOA discipline).
    return { agent: mapAgent(existing.rows[0]), created: false };
  }

  let inserted: { rows: AgentRow[] };
  try {
    inserted = await getDb().query<AgentRow>(
      `INSERT INTO agent_definitions (
         tenant_id, slug, display_name, role, description, provider,
         instructions, runtime_config, permissions, status, created_by,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, 'active', $10, $11, $11)
       RETURNING *`,
      [
        ctx.tenantId,
        valid.slug,
        valid.displayName,
        valid.role,
        valid.description,
        valid.provider,
        valid.instructions,
        JSON.stringify(valid.runtimeConfig ?? {}),
        JSON.stringify(valid.permissions),
        ctx.principalId,
        timestamp,
      ],
    );
  } catch (error) {
    if (isDuplicateKeyOn(error, 'agent_definitions')) {
      // A concurrent registration of the same slug won: replay it.
      const winner = await getDb().query<AgentRow>(
        `SELECT * FROM agent_definitions WHERE tenant_id = $1 AND slug = $2`,
        [ctx.tenantId, valid.slug],
      );
      if (winner.rows[0] !== undefined) return { agent: mapAgent(winner.rows[0]), created: false };
    }
    throw error;
  }
  return { agent: mapAgent(inserted.rows[0]!), created: true };
}

export async function getAgent(
  ctx: TenantContext,
  query: GetAgentQuery,
): Promise<AgentDefinition> {
  assertAgentsTenantContext(ctx);
  const agentId = requireUuidParam(
    query,
    'agentId',
    (id) => new AgentsError('agent_not_found', `no agent '${id}' exists in this tenant`),
  );
  const row = await findAgentRow(getDb(), ctx, agentId);
  if (row === null) {
    throw new AgentsError(
      'agent_not_found',
      `no agent '${agentId}' exists in this tenant`,
    );
  }
  return mapAgent(row);
}

function requireUuidParam(
  query: object,
  field: string,
  notFound: (id: string) => AgentsError,
): string {
  const value = (query as Record<string, unknown>)[field];
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    // Malformed ids are uniformly not-found (the house discipline —
    // no shape information leaks to foreign callers).
    throw notFound(String(value));
  }
  return value.toLowerCase();
}

export async function listAgents(
  ctx: TenantContext,
  query: ListAgentsQuery,
): Promise<AgentDefinition[]> {
  assertAgentsTenantContext(ctx);
  const valid: ValidatedListAgentsQuery = validateListAgentsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.provider !== null) {
    params.push(valid.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<AgentRow>(
    `SELECT * FROM agent_definitions WHERE ${conditions.join(' AND ')}
       ORDER BY slug ASC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapAgent);
}

export async function updateAgent(ctx: TenantContext, input: UpdateAgentInput): Promise<AgentDefinition> {
  assertAgentsTenantContext(ctx);
  if (!canAdministerAgents(ctx.authority)) {
    throw new AgentsError(
      'forbidden',
      `this operation requires the '${AGENTS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid: ValidatedUpdateAgentInput = validateUpdateAgentInput(input);

  const existing = await findAgentRow(getDb(), ctx, valid.agentId);
  if (existing === null) {
    throw new AgentsError('agent_not_found', `no agent '${valid.agentId}' exists in this tenant`);
  }

  const sets: string[] = ['updated_at = $2'];
  const params: unknown[] = [ctx.tenantId, now()];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    sets.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.displayName !== undefined) add('display_name = $#', valid.displayName);
  if (valid.role !== undefined) add('role = $#', valid.role);
  if (valid.description !== undefined) add('description = $#', valid.description);
  if (valid.instructions !== undefined) add('instructions = $#', valid.instructions);
  if (valid.runtimeConfigSet) add('runtime_config = $#::jsonb', JSON.stringify(valid.runtimeConfig ?? {}));
  if (valid.permissions !== undefined) add('permissions = $#::jsonb', JSON.stringify(valid.permissions));
  if (valid.status !== undefined) add('status = $#', valid.status);
  params.push(valid.agentId);

  const updated = await getDb().query<AgentRow>(
    `UPDATE agent_definitions SET ${sets.join(', ')}
       WHERE tenant_id = $1 AND id = $${params.length}
       RETURNING *`,
    params,
  );
  return mapAgent(updated.rows[0]!);
}

// ---------------------------------------------------------------------------
// The W009 authority gate
// ---------------------------------------------------------------------------

/**
 * Routes one submission through the tenant's authority matrix (kind
 * 'agent-execution', at the level the requested scopes imply) via the
 * actions module's consequential path — the decision is recorded and
 * auditable, and a caller-supplied idempotency key makes a gated
 * submission replay the SAME request after a human approval. The payload
 * names what is being approved; the task itself stays on the execution
 * (its digest travels with the request).
 */
async function authorizeSubmission(
  ctx: TenantContext,
  descriptor: Record<string, unknown>,
  authorityLevel: AgentExecution['authorityLevel'],
  idempotencyKey: string | null,
): Promise<ActionRequest> {
  let request: ActionRequest;
  try {
    request = await authorizeAction(ctx, {
      actionKind: AGENT_ACTION_KIND,
      authorityLevel,
      payload: descriptor,
      idempotencyKey: idempotencyKey ?? `agents:${newId()}`,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      if (error.code === 'invalid_context') {
        throw new AgentsError('invalid_context', error.message);
      }
      if (error.code === 'invalid_action_input') {
        throw new AgentsError('invalid_agent_input', error.message);
      }
      throw new Error(
        `the authority gate rejected a pre-validated agent execution submission (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  return request;
}

// ---------------------------------------------------------------------------
// Execution submission (idempotent, permission-scoped, gated, async)
// ---------------------------------------------------------------------------

async function findExecutionRow(
  db: Queryable,
  ctx: TenantContext,
  executionId: string,
): Promise<ExecutionRow | null> {
  const rows = await db.query<ExecutionRow>(
    `SELECT * FROM agent_executions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, executionId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

async function findExecutionRowByIdempotencyKey(
  db: Queryable,
  ctx: TenantContext,
  idempotencyKey: string,
): Promise<ExecutionRow | null> {
  const rows = await db.query<ExecutionRow>(
    `SELECT * FROM agent_executions WHERE tenant_id = $1 AND idempotency_key = $2`,
    [ctx.tenantId, idempotencyKey],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

export async function submitAgentExecution(
  ctx: TenantContext,
  input: SubmitAgentExecutionInput,
): Promise<AgentExecution> {
  assertAgentsTenantContext(ctx);
  const valid: ValidatedSubmitInput = validateSubmitAgentExecutionInput(input);

  // Idempotent fast path: a recorded key replays the original execution —
  // first write wins, so resubmissions from asynchronous callers (lock
  // 36) never duplicate work.
  if (valid.idempotencyKey !== null) {
    const existing = await findExecutionRowByIdempotencyKey(getDb(), ctx, valid.idempotencyKey);
    if (existing !== null) return mapExecution(existing);
  }

  // The target definition (uniform not-found: a foreign agent is
  // indistinguishable from a missing one).
  const agent = await findAgentRow(getDb(), ctx, valid.agentId);
  if (agent === null) {
    throw new AgentsError('agent_not_found', `no agent '${valid.agentId}' exists in this tenant`);
  }
  if (agent.status !== 'active') {
    throw new AgentsError(
      'agent_disabled',
      `agent '${agent.slug}' (${agent.id}) is disabled — disabled agents accept no executions`,
    );
  }

  // PERMISSION SCOPING (the heart of "with permissions"): the request
  // must be fully covered by the grant. Uncovered requests fail BEFORE
  // anything is recorded — no execution, no action request, no dispatch.
  const missing = missingPermissionScope(agent.permissions, valid.requestedPermissions);
  if (missing !== null) {
    throw new AgentsError(
      'permission_not_granted',
      `agent '${agent.slug}' is not granted the '${missing}' permission scope — the execution requests scopes beyond the agent's grant`,
    );
  }

  // The §20 level this submission is authorized at: the highest level
  // its scopes imply (the matrix applies uniformly, §20).
  const authorityLevel = authorityLevelForScopes(valid.requestedPermissions);
  const taskDigest = createHash('sha256').update(JSON.stringify(valid.task)).digest('hex');

  const request = await authorizeSubmission(
    ctx,
    {
      agentId: agent.id,
      agentSlug: agent.slug,
      provider: agent.provider,
      requestedPermissions: valid.requestedPermissions,
      authorityLevel,
      maxAttempts: valid.maxAttempts,
      correlationId: valid.correlationId,
      taskDigest,
    },
    authorityLevel,
    valid.idempotencyKey,
  );

  const submittedAt = now();
  // The deterministic routing of the gate outcome onto the lifecycle:
  //   allowed           → queued (policy auto-approval);
  //   approval_required → awaiting_approval (a human decides; the pump
  //                       resolves the linked request between calls);
  //   forbidden         → refused (terminal, recorded as evidence).
  const status: AgentExecution['status'] =
    request.status === 'approved'
      ? 'queued'
      : request.status === 'pending'
        ? 'awaiting_approval'
        : 'refused';
  const completedAt = status === 'refused' ? submittedAt : null;
  const errorCode = status === 'refused' ? 'execution_forbidden' : null;
  const errorDetail =
    status === 'refused'
      ? `the tenant authority policy forbids ${authorityLevel} of '${AGENT_ACTION_KIND}' (decided via ${request.evaluation.resolvedVia})`
      : null;

  const inserted = await getDb().query<ExecutionRow>(
    `INSERT INTO agent_executions (
       tenant_id, agent_id, provider, task, requested_permissions,
       authority_level, idempotency_key, correlation_id, causation_id,
       status, action_request_id, policy_outcome, policy_resolved_via,
       max_attempts, attempts_count, result, error_code, error_detail,
       cost_minor, submitted_by, submitted_at, completed_at, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, NULL, $15, $16, 0, $17, $18, $19, $18)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      ctx.tenantId,
      agent.id,
      agent.provider,
      JSON.stringify(valid.task),
      JSON.stringify(valid.requestedPermissions),
      authorityLevel,
      valid.idempotencyKey,
      valid.correlationId,
      valid.causationId,
      status,
      request.id,
      request.evaluation.outcome,
      request.evaluation.resolvedVia,
      valid.maxAttempts,
      errorCode,
      errorDetail,
      ctx.principalId,
      submittedAt,
      completedAt,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    // ON CONFLICT swallowed the insert: a concurrent submission of the
    // same key won the race. Replay its execution.
    if (valid.idempotencyKey !== null) {
      const winner = await findExecutionRowByIdempotencyKey(getDb(), ctx, valid.idempotencyKey);
      if (winner !== null) return mapExecution(winner);
    }
    throw new Error(
      'agent execution insert returned no row without an idempotency conflict (internal invariant violation)',
    );
  }
  return mapExecution(row);
}

// ---------------------------------------------------------------------------
// The worker pump (ONE bounded dispatch attempt per call — lock 36)
// ---------------------------------------------------------------------------

export async function runAgentExecution(
  ctx: TenantContext,
  input: RunAgentExecutionInput,
): Promise<AgentExecution> {
  assertAgentsTenantContext(ctx);
  const valid: ValidatedRunInput = validateRunAgentExecutionInput(input);

  let row = await findExecutionRow(getDb(), ctx, valid.executionId);
  if (row === null) {
    throw new AgentsError(
      'execution_not_found',
      `no agent execution '${valid.executionId}' exists in this tenant`,
    );
  }
  if (isTerminalExecutionStatus(row.status)) {
    throw notRunnable(row);
  }

  // --- resumption: the W009 approval gate as a live state ---
  if (row.status === 'awaiting_approval') {
    const request = await readLinkedActionRequest(ctx, row);
    if (request.status === 'pending') {
      // Still gated — the submission waits for a human decision; the
      // caller re-pumps after decideApproval (the cognition module's
      // stillAwaiting discipline).
      return mapExecution(row);
    }
    if (request.status === 'rejected') {
      const finishedAt = now();
      const refused = await getDb().query<ExecutionRow>(
        `UPDATE agent_executions
           SET status = 'refused', error_code = 'approval_rejected',
               error_detail = $3, completed_at = $4, updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'
         RETURNING *`,
        [
          ctx.tenantId,
          row.id,
          `the gated submission was rejected by a human decision (action request '${request.id}')`,
          finishedAt,
        ],
      );
      if (refused.rows[0] !== undefined) return mapExecution(refused.rows[0]);
      row = (await findExecutionRow(getDb(), ctx, valid.executionId))!;
      if (isTerminalExecutionStatus(row.status)) throw notRunnable(row);
      // The request was REJECTED, so nothing may dispatch this execution —
      // any other live state here is an inconsistency, never a dispatch.
      throw new AgentsError(
        'execution_conflict',
        `agent execution '${row.id}' moved while its rejection was being recorded (now '${row.status}')`,
      );
    }
    // request.status === 'approved': fall through to dispatch — the
    // dispatch transaction performs the awaiting_approval → queued move
    // under the advisory lock.
  }

  // --- the dispatch: one attempt, serialized per execution ---
  return getDb().transaction(async (tx) => {
    // Serialize pumps per execution (the cognition module's advisory
    // transaction lock): a racing pump waits here, then observes the
    // moved state and stands down.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `agents:execution:${ctx.tenantId}:${valid.executionId}`,
    ]);

    let current = await findExecutionRow(tx, ctx, valid.executionId);
    if (current === null) {
      throw new AgentsError(
        'execution_not_found',
        `no agent execution '${valid.executionId}' exists in this tenant`,
      );
    }

    // Resolve an approved gate inside the lock. The linked action
    // request was read BEFORE this transaction (a base-connection read
    // inside an open transaction would starve the embedded database's
    // single connection) and its decision is terminal — an approved
    // request can never revert to pending — so a row still sitting in
    // 'awaiting_approval' here means this pump owns the move to 'queued'
    // (first pump wins; the others see 'queued' and proceed).
    if (current.status === 'awaiting_approval') {
      const moved = await tx.query<ExecutionRow>(
        `UPDATE agent_executions
           SET status = 'queued', updated_at = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'
         RETURNING *`,
        [ctx.tenantId, current.id, now()],
      );
      current = moved.rows[0] ?? (await findExecutionRow(tx, ctx, valid.executionId))!;
    }

    if (isTerminalExecutionStatus(current.status)) throw notRunnable(current);
    if (current.status !== 'queued') {
      throw new AgentsError(
        'execution_conflict',
        `agent execution '${current.id}' is '${current.status}' — unexpected live state for a dispatch`,
      );
    }

    const agent = await findAgentRow(tx, ctx, current.agent_id);
    if (agent === null) {
      throw new Error(
        `execution '${current.id}' references agent '${current.agent_id}' that no longer exists (internal invariant violation)`,
      );
    }
    if (agent.status !== 'active') {
      throw new AgentsError(
        'agent_disabled',
        `agent '${agent.slug}' (${agent.id}) is disabled — disabled agents are not dispatched (the execution stays queued)`,
      );
    }

    const attemptNumber = Number(current.attempts_count) + 1;
    if (attemptNumber > Number(current.max_attempts)) {
      throw new AgentsError(
        'not_runnable',
        `agent execution '${current.id}' has exhausted its ${current.max_attempts} attempt(s)`,
      );
    }

    // Provider isolation: the adapter is the only place the runtime's
    // native shapes exist; the transport delivers the opaque body.
    const adapter = getAgentRuntimeAdapter(current.provider);
    const runtimeAgentRef = adapter.resolveRuntimeAgentRef(agent.runtime_config);
    const transport = requireTransport();
    const body = adapter.buildTaskRequest({
      runtimeAgentRef,
      instructions: agent.instructions,
      task: current.task,
      requestedPermissions: current.requested_permissions,
    });

    const request: AgentRuntimeTransportRequest = {
      provider: current.provider as AgentRuntimeTransportRequest['provider'],
      agentId: agent.id,
      runtimeAgentRef,
      body,
    };
    const startedAt = now();
    const receipt: AgentRuntimeTransportReceipt = await transport.send(request);
    const finishedAt = now();
    const latencyMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    // Classify + normalize (deliberately total: every dispatch yields
    // either a canonical result or a canonical failure).
    let parsed: WireTaskResult | null = null;
    let failureKind: 'transport_failed' | 'transport_rejected' | 'result_invalid' | null = null;
    let failureDetail: string | null = null;
    if (receipt.status === 'delivered') {
      try {
        parsed = adapter.parseTaskResult(receipt.payload);
      } catch (error) {
        if (error instanceof AgentsError && error.code === 'provider_malformed_response') {
          failureKind = 'result_invalid';
          failureDetail = error.message;
        } else {
          throw error;
        }
      }
    } else if (receipt.status === 'rejected') {
      failureKind = 'transport_rejected';
      failureDetail = receipt.detail ?? `the ${current.provider} runtime refused the task`;
    } else {
      failureKind = 'transport_failed';
      failureDetail = receipt.detail ?? `the ${current.provider} runtime failed (transient)`;
    }

    const completed = failureKind === null;
    const failure = failureKind === null ? null : classifyAttemptFailure(failureKind);
    const usage = parsed?.usage ?? { inputTokens: null, outputTokens: null, operations: null };
    const costMinor = completed ? adapter.costForUsage(usage) : 0;
    const canonicalResult: AgentTaskResult | null = parsed === null ? null : {
      output: parsed.output,
      summary: parsed.summary,
    };

    // Append-only attempt evidence (migration 003 rejects any later
    // UPDATE/DELETE at the storage level).
    await tx.query(
      `INSERT INTO agent_execution_attempts (
         tenant_id, execution_id, attempt_number, provider, status,
         retryable, error_code, error_detail, result, input_tokens,
         output_tokens, operations, cost_minor, cost_currency,
         provider_task_id, latency_ms, dispatched_at, finished_at,
         dispatched_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, 'USD', $14, $15, $16, $17, $18)`,
      [
        ctx.tenantId,
        current.id,
        attemptNumber,
        current.provider,
        completed ? 'completed' : 'failed',
        failure?.retryable ?? false,
        failure?.errorCode ?? null,
        failureDetail,
        canonicalResult === null ? null : JSON.stringify(canonicalResult),
        usage.inputTokens,
        usage.outputTokens,
        usage.operations,
        costMinor,
        parsed?.providerTaskId ?? receipt.providerTaskId,
        latencyMs,
        startedAt,
        finishedAt,
        ctx.principalId,
      ],
    );

    // The live-state move (guarded: only from the exact pre-attempt
    // state, so a racing cancel/decision can never be overwritten).
    let nextStatus: AgentExecution['status'];
    let errorCode: string | null = null;
    let errorDetail: string | null = null;
    if (completed) {
      nextStatus = 'succeeded';
    } else {
      nextStatus = statusAfterFailedAttempt(attemptNumber, Number(current.max_attempts), failure!.retryable);
      errorCode = failure!.errorCode;
      errorDetail = failureDetail;
    }
    const terminal = isTerminalExecutionStatus(nextStatus);
    const updated = await tx.query<ExecutionRow>(
      `UPDATE agent_executions
         SET status = $3, attempts_count = $4, result = $5::jsonb,
             error_code = $6, error_detail = $7,
             cost_minor = cost_minor + $8,
             completed_at = $9, updated_at = $10
       WHERE tenant_id = $1 AND id = $2 AND status = 'queued' AND attempts_count = $11
       RETURNING *`,
      [
        ctx.tenantId,
        current.id,
        nextStatus,
        attemptNumber,
        canonicalResult === null ? null : JSON.stringify(canonicalResult),
        errorCode,
        errorDetail,
        costMinor,
        terminal ? finishedAt : null,
        finishedAt,
        attemptNumber - 1,
      ],
    );
    if (updated.rows[0] === undefined) {
      throw new AgentsError(
        'execution_conflict',
        `agent execution '${current.id}' moved while the attempt was in flight — the attempt is rolled back and the current state stands`,
      );
    }
    return mapExecution(updated.rows[0]);
  });
}

function notRunnable(row: ExecutionRow): AgentsError {
  return new AgentsError(
    'not_runnable',
    `agent execution '${row.id}' is ${row.status} — terminal executions cannot dispatch; submit a new execution instead`,
  );
}

/** The linked action request (internal invariant: it exists — W009 never deletes). */
async function readLinkedActionRequest(
  ctx: TenantContext,
  row: ExecutionRow,
): Promise<ActionRequest> {
  const requestId = row.action_request_id;
  if (requestId === null) {
    throw new Error(
      `execution '${row.id}' carries no linked action request (internal invariant violation)`,
    );
  }
  try {
    return await getActionRequest(ctx, { requestId });
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'action_request_not_found') {
      throw new Error(
        `execution '${row.id}' links action request '${requestId}' that is not readable in this tenant (internal invariant violation)`,
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cancellation (one-way, live executions only)
// ---------------------------------------------------------------------------

export async function cancelAgentExecution(
  ctx: TenantContext,
  input: CancelAgentExecutionInput,
): Promise<AgentExecution> {
  assertAgentsTenantContext(ctx);
  const valid: ValidatedCancelInput = validateCancelAgentExecutionInput(input);

  return getDb().transaction(async (tx) => {
    // Serialize with an in-flight dispatch (the same advisory lock), so
    // a cancellation either lands before the attempt or after it — never
    // tears one.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `agents:execution:${ctx.tenantId}:${valid.executionId}`,
    ]);
    const row = await findExecutionRow(tx, ctx, valid.executionId);
    if (row === null) {
      throw new AgentsError(
        'execution_not_found',
        `no agent execution '${valid.executionId}' exists in this tenant`,
      );
    }
    if (isTerminalExecutionStatus(row.status)) {
      throw new AgentsError(
        'not_cancellable',
        `agent execution '${row.id}' is ${row.status} — only live executions can be cancelled`,
      );
    }
    const finishedAt = now();
    const cancelled = await tx.query<ExecutionRow>(
      `UPDATE agent_executions
         SET status = 'cancelled', error_code = 'cancelled', error_detail = $3,
             completed_at = $4, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status IN ('awaiting_approval', 'queued')
       RETURNING *`,
      [ctx.tenantId, valid.executionId, valid.reason, finishedAt],
    );
    if (cancelled.rows[0] === undefined) {
      const current = await findExecutionRow(tx, ctx, valid.executionId);
      throw new AgentsError(
        'not_cancellable',
        `agent execution '${valid.executionId}' is ${current?.status ?? 'no longer live'} — only live executions can be cancelled`,
      );
    }
    return mapExecution(cancelled.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAgentExecution(
  ctx: TenantContext,
  query: GetAgentExecutionQuery,
): Promise<AgentExecution> {
  assertAgentsTenantContext(ctx);
  const executionId = requireUuidParam(
    query,
    'executionId',
    (id) => new AgentsError('execution_not_found', `no agent execution '${id}' exists in this tenant`),
  );
  const row = await findExecutionRow(getDb(), ctx, executionId);
  if (row === null) {
    throw new AgentsError(
      'execution_not_found',
      `no agent execution '${executionId}' exists in this tenant`,
    );
  }
  return mapExecution(row);
}

export async function listAgentExecutions(
  ctx: TenantContext,
  query: ListAgentExecutionsQuery,
): Promise<AgentExecution[]> {
  assertAgentsTenantContext(ctx);
  const valid: ValidatedListExecutionsQuery = validateListAgentExecutionsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.agentId !== null) add('agent_id = $#', valid.agentId);
  if (valid.provider !== null) add('provider = $#', valid.provider);
  if (valid.status !== null) add('status = $#', valid.status);
  if (valid.correlationId !== null) add('correlation_id = $#', valid.correlationId);

  params.push(valid.limit);
  const rows = await getDb().query<ExecutionRow>(
    `SELECT * FROM agent_executions WHERE ${conditions.join(' AND ')}
       ORDER BY submitted_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapExecution);
}

export async function listAgentExecutionAttempts(
  ctx: TenantContext,
  query: ListAgentExecutionAttemptsQuery,
): Promise<AgentExecutionAttempt[]> {
  assertAgentsTenantContext(ctx);
  const valid = validateListAgentExecutionAttemptsQuery(query);

  // The execution must exist in this tenant — its attempt evidence is
  // tenant-scoped with it (cross-tenant: uniform not_found, no leak).
  const execution = await findExecutionRow(getDb(), ctx, valid.executionId);
  if (execution === null) {
    throw new AgentsError(
      'execution_not_found',
      `no agent execution '${valid.executionId}' exists in this tenant`,
    );
  }

  const rows = await getDb().query<AttemptRow>(
    `SELECT * FROM agent_execution_attempts
       WHERE tenant_id = $1 AND execution_id = $2
       ORDER BY attempt_number ASC`,
    [ctx.tenantId, valid.executionId],
  );
  return rows.rows.map(mapAttempt);
}
