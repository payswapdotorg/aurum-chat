// Unit tests for the agent-exchange module's pure layer (validation.ts)
// — no database, no clock, no TenantContext reads. Covers the W136
// input-surface laws:
//
//   * the task-graph legality definition (taskGraphProblem) — distinct
//     keys, no self-dependency, no unknown dependency, no duplicates,
//     ACYCLIC (the single deterministic definition, exported for
//     verification);
//   * createExecutionPlan input validation — bounds, slug grammar,
//     per-kind member ref rules (ref REQUIRED + uuid for agent-body /
//     tenant-agent / marketplace kinds, optional for human/external),
//     assignee keys must name declared members, recruitment provenance
//     must be a uuid-or-null;
//   * the minimal context package — evidence refs distinct and bounded,
//     fingerprint uuid-or-null, note bounds;
//   * the handoff law — a handoff travels between two DIFFERENT members;
//   * query validation — limit bounds, status vocabulary, plan-scoped
//     list shapes;
//   * the mirrored vocabularies and their guards.

import { describe, expect, it } from 'vitest';
import {
  AGENT_EXECUTION_STATUSES,
  EXECUTION_PLAN_STATUSES,
  EXECUTION_PLAN_TERMINAL_STATUSES,
  EXCHANGE_MEMBER_KINDS,
  MAX_EVIDENCE_REFS,
  MAX_MEMBERS,
  MAX_TASKS,
  REF_REQUIRED_MEMBER_KINDS,
  assertAgentExchangeTenantContext,
  isExecutionPlanStatus,
  isExchangeMemberKind,
  isRefRequiredMemberKind,
  isTerminalExecutionPlanStatus,
  isUuid,
  taskGraphProblem,
  validateAbandonExecutionPlanInput,
  validateCompleteExecutionPlanInput,
  validateCreateExecutionPlanInput,
  validateGetExecutionPlanQuery,
  validateListExecutionPlansQuery,
  validateListExecutionRunsQuery,
  validateRecordApprovalInput,
  validateRecordExecutionRunInput,
  validateRecordHandoffInput,
} from '../validation';
import { AgentExchangeError } from '../errors';

function expectCode(code: AgentExchangeError['code'], fn: () => unknown): AgentExchangeError {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentExchangeError);
    const typed = error as AgentExchangeError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const UUID2 = '12345678-1234-4123-8123-123456789abc';

function validPlanInput(): unknown {
  return {
    goalId: UUID,
    objective: 'Dispatch the spring ride window',
    tasks: [
      { taskKey: 'survey', title: 'Survey the site' },
      { taskKey: 'dispatch', title: 'Dispatch crews', dependsOn: ['survey'], assigneeMemberKey: 'lead' },
      { taskKey: 'report', title: 'Report outcomes', dependsOn: ['dispatch'] },
    ],
    members: [
      { memberKey: 'lead', kind: 'tenant-agent', role: 'Dispatch lead', ref: UUID2 },
      { memberKey: 'auditor', kind: 'external-specialist', role: 'Compliance auditor' },
    ],
  };
}

describe('vocabularies and guards', () => {
  it('mirrors the org-lab §5 comparison set and the W021 status union', () => {
    expect(EXCHANGE_MEMBER_KINDS).toEqual([
      'agent-body',
      'tenant-agent',
      'marketplace-agent-package',
      'marketplace-extension-package',
      'human-capability',
      'external-specialist',
    ]);
    expect(AGENT_EXECUTION_STATUSES).toEqual([
      'awaiting_approval',
      'queued',
      'succeeded',
      'failed',
      'refused',
      'cancelled',
    ]);
    expect(EXECUTION_PLAN_STATUSES).toEqual(['active', 'completed', 'abandoned']);
    expect(EXECUTION_PLAN_TERMINAL_STATUSES).toEqual(['completed', 'abandoned']);
    expect(REF_REQUIRED_MEMBER_KINDS).toEqual([
      'agent-body',
      'tenant-agent',
      'marketplace-agent-package',
      'marketplace-extension-package',
    ]);
  });

  it('guards the vocabulary values', () => {
    expect(isExchangeMemberKind('agent-body')).toBe(true);
    expect(isExchangeMemberKind('agent')).toBe(false);
    expect(isRefRequiredMemberKind('human-capability')).toBe(false);
    expect(isRefRequiredMemberKind('tenant-agent')).toBe(true);
    expect(isExecutionPlanStatus('active')).toBe(true);
    expect(isExecutionPlanStatus('draft')).toBe(false);
    expect(isTerminalExecutionPlanStatus('completed')).toBe(true);
    expect(isTerminalExecutionPlanStatus('active')).toBe(false);
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });

  it('asserts the explicit TenantContext (ADR-0001)', () => {
    expect(() => assertAgentExchangeTenantContext({ tenantId: 't', principalId: 'p', authority: [] })).not.toThrow();
    expectCode('invalid_context', () => assertAgentExchangeTenantContext({} as never));
    expectCode('invalid_context', () =>
      assertAgentExchangeTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertAgentExchangeTenantContext({ tenantId: 't', principalId: 'p', authority: 'nope' as never }),
    );
  });
});

describe('taskGraphProblem — the decomposition legality definition', () => {
  it('accepts a legal DAG', () => {
    expect(
      taskGraphProblem([
        { taskKey: 'a', dependsOn: [] },
        { taskKey: 'b', dependsOn: ['a'] },
        { taskKey: 'c', dependsOn: ['a', 'b'] },
      ]),
    ).toBeNull();
  });

  it('refuses duplicate keys', () => {
    expect(
      taskGraphProblem([
        { taskKey: 'a', dependsOn: [] },
        { taskKey: 'a', dependsOn: [] },
      ]),
    ).toMatch(/appears more than once/);
  });

  it('refuses self-dependency', () => {
    expect(taskGraphProblem([{ taskKey: 'a', dependsOn: ['a'] }])).toMatch(/depends on itself/);
  });

  it('refuses unknown dependencies', () => {
    expect(taskGraphProblem([{ taskKey: 'a', dependsOn: ['ghost'] }])).toMatch(
      /depends on unknown task 'ghost'/,
    );
  });

  it('refuses duplicate dependencies', () => {
    expect(
      taskGraphProblem([
        { taskKey: 'a', dependsOn: [] },
        { taskKey: 'b', dependsOn: ['a', 'a'] },
      ]),
    ).toMatch(/lists dependency 'a' more than once/);
  });

  it('refuses cycles, direct and indirect', () => {
    expect(
      taskGraphProblem([
        { taskKey: 'a', dependsOn: ['b'] },
        { taskKey: 'b', dependsOn: ['a'] },
      ]),
    ).toMatch(/cycle/);
    expect(
      taskGraphProblem([
        { taskKey: 'a', dependsOn: [] },
        { taskKey: 'b', dependsOn: ['c'] },
        { taskKey: 'c', dependsOn: ['b'] },
      ]),
    ).toMatch(/cycle/);
    expect(
      taskGraphProblem([
        { taskKey: 'a', dependsOn: ['d'] },
        { taskKey: 'b', dependsOn: ['a'] },
        { taskKey: 'c', dependsOn: ['b'] },
        { taskKey: 'd', dependsOn: ['c'] },
      ]),
    ).toMatch(/cycle/);
  });
});

describe('validateCreateExecutionPlanInput', () => {
  it('accepts the legal shape and normalizes optional fields', () => {
    const valid = validateCreateExecutionPlanInput(validPlanInput());
    expect(valid.goalId).toBe(UUID);
    expect(valid.fingerprintId).toBeNull();
    expect(valid.tasks).toHaveLength(3);
    expect(valid.tasks[1]!.dependsOn).toEqual(['survey']);
    expect(valid.tasks[1]!.assigneeMemberKey).toBe('lead');
    expect(valid.members).toHaveLength(2);
    expect(valid.members[1]!.ref).toBeNull();
    expect(valid.members[1]!.recruitmentProposalId).toBeNull();
  });

  it('requires a goal uuid and a bounded objective', () => {
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({ ...validPlanInput(), goalId: 'nope' }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({ ...validPlanInput(), objective: '' }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({ ...validPlanInput(), objective: 'x'.repeat(2001) }),
    );
  });

  it('bounds the decomposition size and the key grammar', () => {
    const many = Array.from({ length: MAX_TASKS + 1 }, (_, i) => ({
      taskKey: `t-${i}`,
      title: 'T',
    }));
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({ ...validPlanInput(), tasks: many }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        tasks: [{ taskKey: 'BAD_KEY', title: 'T' }],
      }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({ ...validPlanInput(), tasks: [] }),
    );
  });

  it('rejects an illegal dependency graph at the plan level', () => {
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        tasks: [
          { taskKey: 'a', title: 'A', dependsOn: ['b'] },
          { taskKey: 'b', title: 'B', dependsOn: ['a'] },
        ],
      }),
    );
  });

  it('enforces the per-kind member ref rules', () => {
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        members: [{ memberKey: 'lead', kind: 'tenant-agent', role: 'Lead' }],
      }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        members: [{ memberKey: 'lead', kind: 'tenant-agent', role: 'Lead', ref: 'not-a-uuid' }],
      }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        members: [
          { memberKey: 'body', kind: 'agent-body', role: 'Body', ref: 'not-a-uuid' },
        ],
      }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        members: [
          { memberKey: 'pkg', kind: 'marketplace-agent-package', role: 'Pack' },
        ],
      }),
    );
    // Human/external members may omit the ref (opaque).
    expect(() =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        members: [
          { memberKey: 'lead', kind: 'human-capability', role: 'Steward' },
        ],
      }),
    ).not.toThrow();
  });

  it('bounds the member list and requires distinct keys', () => {
    const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => ({
      memberKey: `m-${i}`,
      kind: 'human-capability' as const,
      role: 'R',
    }));
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({ ...validPlanInput(), members: many }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        members: [
          { memberKey: 'lead', kind: 'human-capability', role: 'R' },
          { memberKey: 'lead', kind: 'human-capability', role: 'R2' },
        ],
      }),
    );
  });

  it('requires assignees to name declared members and provenance to be uuids', () => {
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        tasks: [{ taskKey: 'survey', title: 'S', assigneeMemberKey: 'ghost' }],
      }),
    );
    expectCode('invalid_plan_input', () =>
      validateCreateExecutionPlanInput({
        ...validPlanInput(),
        members: [
          {
            memberKey: 'lead',
            kind: 'tenant-agent',
            role: 'Lead',
            ref: UUID2,
            recruitmentProposalId: 'nope',
          },
        ],
      }),
    );
  });
});

describe('the minimal context package', () => {
  it('bounds and dedupes evidence refs, takes a uuid-or-null fingerprint', () => {
    const many = Array.from({ length: MAX_EVIDENCE_REFS + 1 }, (_, i) => `ev-${i}`);
    expectCode('invalid_run_input', () =>
      validateRecordExecutionRunInput({
        planId: UUID,
        taskKey: 'survey',
        agentExecutionId: UUID2,
        context: { evidenceRefs: many },
      }),
    );
    expectCode('invalid_run_input', () =>
      validateRecordExecutionRunInput({
        planId: UUID,
        taskKey: 'survey',
        agentExecutionId: UUID2,
        context: { evidenceRefs: ['ev-1', 'ev-1'] },
      }),
    );
    expectCode('invalid_run_input', () =>
      validateRecordExecutionRunInput({
        planId: UUID,
        taskKey: 'survey',
        agentExecutionId: UUID2,
        context: { fingerprintId: 'nope' },
      }),
    );
    const valid = validateRecordExecutionRunInput({
      planId: UUID,
      taskKey: 'survey',
      agentExecutionId: UUID2,
      context: { fingerprintId: UUID, evidenceRefs: ['ev-1'], note: 'site survey digest' },
    });
    expect(valid.context).toEqual({
      fingerprintId: UUID,
      evidenceRefs: ['ev-1'],
      note: 'site survey digest',
    });
  });
});

describe('validateRecordHandoffInput', () => {
  it('requires two DIFFERENT members', () => {
    expectCode('invalid_handoff_input', () =>
      validateRecordHandoffInput({
        planId: UUID,
        taskKey: 'survey',
        fromMemberKey: 'lead',
        toMemberKey: 'lead',
      }),
    );
    const valid = validateRecordHandoffInput({
      planId: UUID,
      taskKey: 'survey',
      fromMemberKey: 'lead',
      toMemberKey: 'auditor',
    });
    expect(valid.context).toEqual({ fingerprintId: null, evidenceRefs: [], note: null });
  });
});

describe('transition, approval and query validators', () => {
  it('validates complete/abandon inputs', () => {
    expect(validateCompleteExecutionPlanInput({ planId: UUID, note: 'done' }).note).toBe('done');
    expectCode('invalid_transition_input', () =>
      validateCompleteExecutionPlanInput({ planId: UUID, note: '' }),
    );
    expectCode('invalid_transition_input', () =>
      validateAbandonExecutionPlanInput({ planId: 'x', reason: 'why' }),
    );
  });

  it('validates approval inputs (task optional, request required)', () => {
    const valid = validateRecordApprovalInput({
      planId: UUID,
      actionRequestId: UUID2,
    });
    expect(valid.taskKey).toBeNull();
    expectCode('invalid_approval_input', () =>
      validateRecordApprovalInput({ planId: UUID, actionRequestId: 'nope' }),
    );
  });

  it('validates get/list queries (limit bounds, status vocabulary)', () => {
    expect(validateGetExecutionPlanQuery({ planId: UUID }).planId).toBe(UUID);
    expectCode('invalid_query', () => validateGetExecutionPlanQuery({ planId: 'x' }));
    expectCode('invalid_query', () =>
      validateListExecutionPlansQuery({ status: 'draft' as never }),
    );
    expectCode('invalid_query', () => validateListExecutionPlansQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListExecutionPlansQuery({ limit: 501 }));
    expect(validateListExecutionPlansQuery({ goalId: UUID, limit: 10 }).limit).toBe(10);
    expect(validateListExecutionPlansQuery().limit).toBe(50);
    expectCode('invalid_query', () => validateListExecutionRunsQuery({ taskKey: 'x' }));
    const scoped = validateListExecutionRunsQuery({ planId: UUID, taskKey: 'survey' });
    expect(scoped).toEqual({ planId: UUID, taskKey: 'survey', limit: 50 });
  });
});
