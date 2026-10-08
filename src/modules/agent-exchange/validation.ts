// Pure validation of the agent-exchange module's inputs and queries (see
// contract.ts). No database, no clock, no TenantContext reads — the
// org-lab discipline: everything here is unit-testable without
// infrastructure.
//
// VOCABULARY MIRRORING (the house ruling): the cross-module vocabularies
// this file guards against (the org-lab §5 member-kind set, the agents
// module's execution-status union) are mirrored as local constants and
// compiler-pinned to the frozen unions with `satisfies` — drift in an
// owning module fails TYPECHECK here, never runtime. The type-only
// imports keep this file runtime-dependency-free (the services own
// every runtime import).

import type { TenantContext } from '@/infra/tenant';
import type { AgentExecutionStatus } from '@/modules/agents/contract';
import type { OrgNodeKind } from '@/modules/org-lab/contract';
import { AgentExchangeError } from './errors';
// Only the RETAINED shapes are imported: the validators take `unknown`
// and return the Validated* shapes (the org-lab discipline — the input
// interfaces live in types.ts and are re-exported through contract.ts).
import type {
  ContextPackage,
  ExecutionPlanStatus,
  ExchangeMemberKind,
} from './types';

// ---------------------------------------------------------------------------
// Limits (bounds every input field — the house discipline)
// ---------------------------------------------------------------------------

export const MAX_OBJECTIVE_CHARS = 2000;
export const MAX_NOTE_CHARS = 2000;
export const MAX_REASON_CHARS = 512;
export const MIN_TASKS = 1;
export const MAX_TASKS = 64;
export const MAX_TASK_TITLE_CHARS = 200;
export const MAX_TASK_DETAIL_CHARS = 2000;
export const MAX_DEPENDS_ON = 16;
export const MAX_MEMBERS = 32;
export const MAX_KEY_CHARS = 64;
export const MAX_ROLE_CHARS = 128;
export const MAX_REF_CHARS = 256;
export const MAX_LABEL_CHARS = 256;
export const MAX_EVIDENCE_REFS = 16;
export const MAX_EVIDENCE_REF_CHARS = 256;
export const MAX_CONTEXT_NOTE_CHARS = 512;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

// ---------------------------------------------------------------------------
// Vocabularies (mirrored + compiler-pinned; see the header note)
// ---------------------------------------------------------------------------

/** The org-lab §5 comparison set, mirrored (W136 composes W135). */
export const EXCHANGE_MEMBER_KINDS = [
  'agent-body',
  'tenant-agent',
  'marketplace-agent-package',
  'marketplace-extension-package',
  'human-capability',
  'external-specialist',
] as const satisfies readonly OrgNodeKind[];

export const EXECUTION_PLAN_STATUSES = [
  'active',
  'completed',
  'abandoned',
] as const satisfies readonly ExecutionPlanStatus[];

export const EXECUTION_PLAN_TERMINAL_STATUSES = [
  'completed',
  'abandoned',
] as const satisfies readonly ExecutionPlanStatus[];

/** The W021 execution-status union, mirrored for read-side filters. */
export const AGENT_EXECUTION_STATUSES = [
  'awaiting_approval',
  'queued',
  'succeeded',
  'failed',
  'refused',
  'cancelled',
] as const satisfies readonly AgentExecutionStatus[];

/** Member kinds whose `ref` is a REQUIRED registry id validated at write time. */
export const REF_REQUIRED_MEMBER_KINDS = [
  'agent-body',
  'tenant-agent',
  'marketplace-agent-package',
  'marketplace-extension-package',
] as const satisfies readonly ExchangeMemberKind[];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

export function isExchangeMemberKind(value: unknown): value is ExchangeMemberKind {
  return typeof value === 'string' && (EXCHANGE_MEMBER_KINDS as readonly string[]).includes(value);
}

export function isExecutionPlanStatus(value: unknown): value is ExecutionPlanStatus {
  return (
    typeof value === 'string' && (EXECUTION_PLAN_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalExecutionPlanStatus(value: unknown): value is ExecutionPlanStatus {
  return (
    typeof value === 'string' &&
    (EXECUTION_PLAN_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

export function isRefRequiredMemberKind(value: unknown): value is ExchangeMemberKind {
  return (
    typeof value === 'string' &&
    (REF_REQUIRED_MEMBER_KINDS as readonly string[]).includes(value)
  );
}

/** The explicit TenantContext is asserted, never ambient (ADR-0001). */
export function assertAgentExchangeTenantContext(ctx: TenantContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.tenantId !== 'string' ||
    ctx.tenantId.length === 0 ||
    typeof ctx.principalId !== 'string' ||
    ctx.principalId.length === 0 ||
    !Array.isArray(ctx.authority)
  ) {
    throw new AgentExchangeError(
      'invalid_context',
      'an explicit TenantContext with tenant and principal is required',
    );
  }
}

// ---------------------------------------------------------------------------
// The pure task-graph check (exported for verification — the single
// deterministic definition of a legal decomposition)
// ---------------------------------------------------------------------------

export interface TaskGraphInput {
  taskKey: string;
  dependsOn: string[];
}

/**
 * The task-graph law: distinct keys, dependencies reference OTHER tasks
 * of the SAME plan, no self-dependency, no duplicates in a dependency
 * list, and ACYCLIC (a plan whose tasks wait on each other in a cycle
 * can never execute). Returns the first problem found, or null when the
 * graph is legal.
 */
export function taskGraphProblem(tasks: readonly TaskGraphInput[]): string | null {
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.taskKey)) {
      return `task key '${task.taskKey}' appears more than once`;
    }
    keys.add(task.taskKey);
  }
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const dep of task.dependsOn) {
      if (dep === task.taskKey) {
        return `task '${task.taskKey}' depends on itself`;
      }
      if (seen.has(dep)) {
        return `task '${task.taskKey}' lists dependency '${dep}' more than once`;
      }
      seen.add(dep);
      if (!keys.has(dep)) {
        return `task '${task.taskKey}' depends on unknown task '${dep}'`;
      }
    }
  }
  // Cycle detection: iterative DFS over the key → dependencies map.
  const depsByKey = new Map(tasks.map((task) => [task.taskKey, task.dependsOn] as const));
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const stack: { key: string; depIndex: number }[] = [];
  for (const start of keys) {
    if (state.get(start) === DONE) continue;
    stack.push({ key: start, depIndex: 0 });
    state.set(start, VISITING);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const deps = depsByKey.get(top.key) ?? [];
      if (top.depIndex >= deps.length) {
        state.set(top.key, DONE);
        stack.pop();
        continue;
      }
      const dep = deps[top.depIndex]!;
      top.depIndex += 1;
      const depState = state.get(dep);
      if (depState === VISITING) {
        return `the task dependency graph carries a cycle through '${dep}'`;
      }
      if (depState === DONE) continue;
      state.set(dep, VISITING);
      stack.push({ key: dep, depIndex: 0 });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type InputCode =
  | 'invalid_plan_input'
  | 'invalid_transition_input'
  | 'invalid_handoff_input'
  | 'invalid_approval_input'
  | 'invalid_run_input'
  | 'invalid_query';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, min: number, max: number, code: InputCode): string {
  if (typeof value !== 'string') {
    throw new AgentExchangeError(code, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new AgentExchangeError(
      code,
      `${field} must be ${min}..${max} characters (after trim), got ${trimmed.length}`,
    );
  }
  return trimmed;
}

function optionalString(
  value: unknown,
  field: string,
  max: number,
  code: InputCode,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AgentExchangeError(code, `${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new AgentExchangeError(code, `${field} must be at most ${max} characters (after trim)`);
  }
  return trimmed;
}

function optionalUuid(value: unknown, field: string, code: InputCode): string | null {
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) {
    throw new AgentExchangeError(code, `${field} must be a uuid or null`);
  }
  return value;
}

function requireUuid(value: unknown, field: string, code: InputCode): string {
  if (!isUuid(value)) {
    throw new AgentExchangeError(code, `${field} must be a uuid`);
  }
  return value;
}

function requireKey(value: unknown, field: string, code: InputCode): string {
  if (!isKey(value)) {
    throw new AgentExchangeError(code, `${field} must match ^[a-z0-9][a-z0-9-]{0,63}$`);
  }
  return value;
}

function optionalKey(value: unknown, field: string, code: InputCode): string | null {
  if (value === undefined || value === null) return null;
  return requireKey(value, field, code);
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new AgentExchangeError(
      'invalid_query',
      `limit must be an integer in 1..${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

/** Distinct, bounded, non-empty string items (evidence refs, dependency lists). */
function stringItems(
  value: unknown,
  field: string,
  max: number,
  maxChars: number,
  code: InputCode,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AgentExchangeError(code, `${field} must be an array of strings`);
  }
  if (value.length > max) {
    throw new AgentExchangeError(code, `${field} may carry at most ${max} items`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxChars) {
      throw new AgentExchangeError(
        code,
        `${field} entries must be non-empty strings of at most ${maxChars} characters`,
      );
    }
    if (seen.has(item)) {
      throw new AgentExchangeError(code, `${field} entries must be distinct ('${item}' repeats)`);
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The minimal context package (acceptance law 2)
// ---------------------------------------------------------------------------

export interface ValidatedContextPackage {
  fingerprintId: string | null;
  evidenceRefs: string[];
  note: string | null;
}

export function validateContextPackage(
  value: unknown,
  field: string,
  code: InputCode,
): ValidatedContextPackage {
  if (value === undefined || value === null) {
    return { fingerprintId: null, evidenceRefs: [], note: null };
  }
  if (!isRecord(value)) {
    throw new AgentExchangeError(code, `${field} must be an object`);
  }
  return {
    fingerprintId: optionalUuid(value.fingerprintId, `${field}.fingerprintId`, code),
    evidenceRefs: stringItems(
      value.evidenceRefs,
      `${field}.evidenceRefs`,
      MAX_EVIDENCE_REFS,
      MAX_EVIDENCE_REF_CHARS,
      code,
    ),
    note: optionalString(value.note, `${field}.note`, MAX_CONTEXT_NOTE_CHARS, code),
  };
}

// ---------------------------------------------------------------------------
// createExecutionPlan
// ---------------------------------------------------------------------------

export interface ValidatedMember {
  memberKey: string;
  kind: ExchangeMemberKind;
  role: string;
  ref: string | null;
  label: string | null;
  recruitmentProposalId: string | null;
}

export interface ValidatedTask {
  taskKey: string;
  title: string;
  detail: string | null;
  dependsOn: string[];
  assigneeMemberKey: string | null;
}

export interface ValidatedCreateExecutionPlanInput {
  goalId: string;
  fingerprintId: string | null;
  strategyId: string | null;
  recommendationId: string | null;
  teamId: string | null;
  objective: string;
  note: string | null;
  tasks: ValidatedTask[];
  members: ValidatedMember[];
}

export function validateCreateExecutionPlanInput(input: unknown): ValidatedCreateExecutionPlanInput {
  if (!isRecord(input)) {
    throw new AgentExchangeError('invalid_plan_input', 'the plan input must be an object');
  }
  const goalId = requireUuid(input.goalId, 'goalId', 'invalid_plan_input');
  const objective = requireString(
    input.objective,
    'objective',
    1,
    MAX_OBJECTIVE_CHARS,
    'invalid_plan_input',
  );

  if (input.tasks === undefined || input.tasks === null || !Array.isArray(input.tasks)) {
    throw new AgentExchangeError('invalid_plan_input', 'tasks must be an array of task records');
  }
  if (input.tasks.length < MIN_TASKS || input.tasks.length > MAX_TASKS) {
    throw new AgentExchangeError(
      'invalid_plan_input',
      `tasks must carry ${MIN_TASKS}..${MAX_TASKS} records, got ${input.tasks.length}`,
    );
  }
  const tasks: ValidatedTask[] = input.tasks.map((raw: unknown, index: number): ValidatedTask => {
    if (!isRecord(raw)) {
      throw new AgentExchangeError('invalid_plan_input', `tasks[${index}] must be an object`);
    }
    return {
      taskKey: requireKey(raw.taskKey, `tasks[${index}].taskKey`, 'invalid_plan_input'),
      title: requireString(
        raw.title,
        `tasks[${index}].title`,
        1,
        MAX_TASK_TITLE_CHARS,
        'invalid_plan_input',
      ),
      detail: optionalString(raw.detail, `tasks[${index}].detail`, MAX_TASK_DETAIL_CHARS, 'invalid_plan_input'),
      dependsOn: stringItems(
        raw.dependsOn,
        `tasks[${index}].dependsOn`,
        MAX_DEPENDS_ON,
        MAX_KEY_CHARS,
        'invalid_plan_input',
      ),
      assigneeMemberKey: optionalKey(
        raw.assigneeMemberKey,
        `tasks[${index}].assigneeMemberKey`,
        'invalid_plan_input',
      ),
    };
  });

  const graphProblem = taskGraphProblem(tasks);
  if (graphProblem !== null) {
    throw new AgentExchangeError('invalid_plan_input', `the task decomposition is illegal: ${graphProblem}`);
  }

  if (input.members !== undefined && input.members !== null && !Array.isArray(input.members)) {
    throw new AgentExchangeError('invalid_plan_input', 'members must be an array of member records');
  }
  const rawMembers = input.members ?? [];
  if (rawMembers.length > MAX_MEMBERS) {
    throw new AgentExchangeError(
      'invalid_plan_input',
      `members may carry at most ${MAX_MEMBERS} records, got ${rawMembers.length}`,
    );
  }
  const members: ValidatedMember[] = rawMembers.map((raw: unknown, index: number): ValidatedMember => {
    if (!isRecord(raw)) {
      throw new AgentExchangeError('invalid_plan_input', `members[${index}] must be an object`);
    }
    if (!isExchangeMemberKind(raw.kind)) {
      throw new AgentExchangeError(
        'invalid_plan_input',
        `members[${index}].kind must be one of the §5 comparison-set kinds`,
      );
    }
    const kind: ExchangeMemberKind = raw.kind;
    const ref = optionalString(raw.ref, `members[${index}].ref`, MAX_REF_CHARS, 'invalid_plan_input');
    if (isRefRequiredMemberKind(kind) && ref === null) {
      throw new AgentExchangeError(
        'invalid_plan_input',
        `members[${index}].ref is required for the '${kind}' kind (the owning registry's id)`,
      );
    }
    if (kind === 'agent-body' && ref !== null && !isUuid(ref)) {
      throw new AgentExchangeError(
        'invalid_plan_input',
        `members[${index}].ref must be a body uuid for the 'agent-body' kind`,
      );
    }
    if (kind === 'tenant-agent' && ref !== null && !isUuid(ref)) {
      throw new AgentExchangeError(
        'invalid_plan_input',
        `members[${index}].ref must be an agent uuid for the 'tenant-agent' kind`,
      );
    }
    if (
      (kind === 'marketplace-agent-package' || kind === 'marketplace-extension-package') &&
      ref !== null &&
      !isUuid(ref)
    ) {
      throw new AgentExchangeError(
        'invalid_plan_input',
        `members[${index}].ref must be a package uuid for the '${kind}' kind`,
      );
    }
    return {
      memberKey: requireKey(raw.memberKey, `members[${index}].memberKey`, 'invalid_plan_input'),
      kind,
      role: requireString(raw.role, `members[${index}].role`, 1, MAX_ROLE_CHARS, 'invalid_plan_input'),
      ref,
      label: optionalString(raw.label, `members[${index}].label`, MAX_LABEL_CHARS, 'invalid_plan_input'),
      recruitmentProposalId: optionalUuid(
        raw.recruitmentProposalId,
        `members[${index}].recruitmentProposalId`,
        'invalid_plan_input',
      ),
    };
  });

  const memberKeys = new Set(members.map((member) => member.memberKey));
  for (const task of tasks) {
    if (
      task.assigneeMemberKey !== null &&
      !memberKeys.has(task.assigneeMemberKey)
    ) {
      throw new AgentExchangeError(
        'invalid_plan_input',
        `task '${task.taskKey}' is assigned to unknown member '${task.assigneeMemberKey}'`,
      );
    }
  }

  return {
    goalId,
    fingerprintId: optionalUuid(input.fingerprintId, 'fingerprintId', 'invalid_plan_input'),
    strategyId: optionalUuid(input.strategyId, 'strategyId', 'invalid_plan_input'),
    recommendationId: optionalUuid(input.recommendationId, 'recommendationId', 'invalid_plan_input'),
    teamId: optionalUuid(input.teamId, 'teamId', 'invalid_plan_input'),
    objective,
    note: optionalString(input.note, 'note', MAX_NOTE_CHARS, 'invalid_plan_input'),
    tasks,
    members,
  };
}

// ---------------------------------------------------------------------------
// completeExecutionPlan / abandonExecutionPlan
// ---------------------------------------------------------------------------

export interface ValidatedCompleteExecutionPlanInput {
  planId: string;
  note: string;
}

export function validateCompleteExecutionPlanInput(input: unknown): ValidatedCompleteExecutionPlanInput {
  if (!isRecord(input)) {
    throw new AgentExchangeError('invalid_transition_input', 'the completion input must be an object');
  }
  return {
    planId: requireUuid(input.planId, 'planId', 'invalid_transition_input'),
    note: requireString(input.note, 'note', 1, MAX_NOTE_CHARS, 'invalid_transition_input'),
  };
}

export interface ValidatedAbandonExecutionPlanInput {
  planId: string;
  reason: string;
}

export function validateAbandonExecutionPlanInput(input: unknown): ValidatedAbandonExecutionPlanInput {
  if (!isRecord(input)) {
    throw new AgentExchangeError('invalid_transition_input', 'the abandonment input must be an object');
  }
  return {
    planId: requireUuid(input.planId, 'planId', 'invalid_transition_input'),
    reason: requireString(input.reason, 'reason', 1, MAX_REASON_CHARS, 'invalid_transition_input'),
  };
}

// ---------------------------------------------------------------------------
// recordHandoff
// ---------------------------------------------------------------------------

export interface ValidatedRecordHandoffInput {
  planId: string;
  taskKey: string;
  fromMemberKey: string;
  toMemberKey: string;
  context: ValidatedContextPackage;
  note: string | null;
}

export function validateRecordHandoffInput(input: unknown): ValidatedRecordHandoffInput {
  if (!isRecord(input)) {
    throw new AgentExchangeError('invalid_handoff_input', 'the handoff input must be an object');
  }
  const fromMemberKey = requireString(
    input.fromMemberKey,
    'fromMemberKey',
    1,
    MAX_KEY_CHARS,
    'invalid_handoff_input',
  );
  const toMemberKey = requireString(
    input.toMemberKey,
    'toMemberKey',
    1,
    MAX_KEY_CHARS,
    'invalid_handoff_input',
  );
  if (fromMemberKey === toMemberKey) {
    throw new AgentExchangeError(
      'invalid_handoff_input',
      'a handoff must travel between two DIFFERENT members (fromMemberKey ≠ toMemberKey)',
    );
  }
  return {
    planId: requireUuid(input.planId, 'planId', 'invalid_handoff_input'),
    taskKey: requireKey(input.taskKey, 'taskKey', 'invalid_handoff_input'),
    fromMemberKey,
    toMemberKey,
    context: validateContextPackage(input.context, 'context', 'invalid_handoff_input'),
    note: optionalString(input.note, 'note', MAX_NOTE_CHARS, 'invalid_handoff_input'),
  };
}

// ---------------------------------------------------------------------------
// recordApproval
// ---------------------------------------------------------------------------

export interface ValidatedRecordApprovalInput {
  planId: string;
  taskKey: string | null;
  actionRequestId: string;
}

export function validateRecordApprovalInput(input: unknown): ValidatedRecordApprovalInput {
  if (!isRecord(input)) {
    throw new AgentExchangeError('invalid_approval_input', 'the approval input must be an object');
  }
  return {
    planId: requireUuid(input.planId, 'planId', 'invalid_approval_input'),
    taskKey: optionalKey(input.taskKey, 'taskKey', 'invalid_approval_input'),
    actionRequestId: requireUuid(
      input.actionRequestId,
      'actionRequestId',
      'invalid_approval_input',
    ),
  };
}

// ---------------------------------------------------------------------------
// recordExecutionRun
// ---------------------------------------------------------------------------

export interface ValidatedRecordExecutionRunInput {
  planId: string;
  taskKey: string;
  agentExecutionId: string;
  context: ValidatedContextPackage;
  outcomeId: string | null;
}

export function validateRecordExecutionRunInput(input: unknown): ValidatedRecordExecutionRunInput {
  if (!isRecord(input)) {
    throw new AgentExchangeError('invalid_run_input', 'the run input must be an object');
  }
  return {
    planId: requireUuid(input.planId, 'planId', 'invalid_run_input'),
    taskKey: requireKey(input.taskKey, 'taskKey', 'invalid_run_input'),
    agentExecutionId: requireUuid(
      input.agentExecutionId,
      'agentExecutionId',
      'invalid_run_input',
    ),
    context: validateContextPackage(input.context, 'context', 'invalid_run_input'),
    outcomeId: optionalUuid(input.outcomeId, 'outcomeId', 'invalid_run_input'),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ValidatedGetExecutionPlanQuery {
  planId: string;
}

export function validateGetExecutionPlanQuery(query: unknown): ValidatedGetExecutionPlanQuery {
  if (!isRecord(query)) {
    throw new AgentExchangeError('invalid_query', 'the plan query must be an object');
  }
  return { planId: requireUuid(query.planId, 'planId', 'invalid_query') };
}

export interface ValidatedListExecutionPlansQuery {
  goalId: string | null;
  status: ExecutionPlanStatus | null;
  recommendationId: string | null;
  limit: number;
}

export function validateListExecutionPlansQuery(
  query?: unknown,
): ValidatedListExecutionPlansQuery {
  if (query === undefined || query === null) {
    return { goalId: null, status: null, recommendationId: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isRecord(query)) {
    throw new AgentExchangeError('invalid_query', 'the plan-list query must be an object');
  }
  const status =
    query.status === undefined || query.status === null
      ? null
      : isExecutionPlanStatus(query.status)
        ? query.status
        : null;
  if (query.status !== undefined && query.status !== null && status === null) {
    throw new AgentExchangeError(
      'invalid_query',
      'status must be one of active | completed | abandoned',
    );
  }
  return {
    goalId: optionalUuid(query.goalId, 'goalId', 'invalid_query'),
    status,
    recommendationId: optionalUuid(query.recommendationId, 'recommendationId', 'invalid_query'),
    limit: requireLimit(query.limit),
  };
}

export interface ValidatedPlanScopedListQuery {
  planId: string;
  taskKey: string | null;
  limit: number;
}

function validatePlanScopedListQuery(
  query: unknown,
  what: string,
): ValidatedPlanScopedListQuery {
  if (!isRecord(query)) {
    throw new AgentExchangeError('invalid_query', `the ${what} query must be an object`);
  }
  return {
    planId: requireUuid(query.planId, 'planId', 'invalid_query'),
    taskKey: optionalKey(query.taskKey, 'taskKey', 'invalid_query'),
    limit: requireLimit(query.limit),
  };
}

export function validateListExecutionRunsQuery(query: unknown): ValidatedPlanScopedListQuery {
  return validatePlanScopedListQuery(query, 'run-list');
}

export function validateListHandoffsQuery(query: unknown): ValidatedPlanScopedListQuery {
  return validatePlanScopedListQuery(query, 'handoff-list');
}

export function validateListApprovalsQuery(query: unknown): ValidatedPlanScopedListQuery {
  return validatePlanScopedListQuery(query, 'approval-list');
}
