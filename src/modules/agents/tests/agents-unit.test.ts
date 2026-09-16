// Unit tests for the agents module's pure logic (no database): the
// runtime-provider / permission-scope / execution-status vocabularies,
// the scope↔level mapping and highest-level derivation, the permission
// subset enforcement, the deterministic retry classification and
// next-state derivation, the administer-claim rule, the TenantContext
// shape, the full validation/normalization surface (definitions,
// submissions, cancellation, queries), and the five runtime adapters
// (wire-shape building, canonical parsing, malformed-response loudness,
// runtime-config resolution and deterministic cost). Storage-level
// guarantees (append-only attempts, immutable submissions, tenant
// scoping, gate integration) are covered by agents-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  AGENT_EXECUTION_STATUSES,
  AGENT_EXECUTION_TERMINAL_STATUSES,
  AGENT_PERMISSION_SCOPES,
  AGENT_RUNTIME_PROVIDERS,
  AGENT_STATUSES,
  AUTHORITY_LEVELS,
  authorityLevelForScope,
  authorityLevelForScopes,
  canAdministerAgents,
  classifyAttemptFailure,
  isAgentExecutionStatus,
  isAgentPermissionScope,
  isAgentRuntimeProvider,
  isAgentStatus,
  isAuthorityLevelWord,
  isTerminalExecutionStatus,
  missingPermissionScope,
  scopeForAuthorityLevel,
  statusAfterFailedAttempt,
} from '../policy';
import { AgentsError } from '../errors';
import {
  assertAgentsTenantContext,
  DEFAULT_MAX_ATTEMPTS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  MAX_TASK_BYTES,
  validateCancelAgentExecutionInput,
  validateListAgentExecutionAttemptsQuery,
  validateListAgentExecutionsQuery,
  validateListAgentsQuery,
  validateRegisterAgentInput,
  validateRunAgentExecutionInput,
  validateSubmitAgentExecutionInput,
  validateUpdateAgentInput,
} from '../validation';
import { allAgentRuntimeAdapters, getAgentRuntimeAdapter } from '../adapters';
import type { AgentRuntimeAdapter } from '../adapters/types';
import type {
  CancelAgentExecutionInput,
  RegisterAgentInput,
  SubmitAgentExecutionInput,
  UpdateAgentInput,
} from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';

function expectCode(code: AgentsError['code'], fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentsError);
    expect((error as AgentsError).code).toBe(code);
  }
}

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return { tenantId: newId(), principalId: newId(), authority: [], ...overrides };
}

/** A minimal, fully valid agent registration. */
function validAgent(): RegisterAgentInput {
  return {
    slug: 'support-triage',
    role: 'support agent',
    provider: 'openai-assistants',
    instructions: 'Triage inbound support conversations and propose replies.',
    permissions: ['observe', 'analyze', 'recommend'],
    runtimeConfig: { assistantId: 'asst_123' },
  };
}

/** A minimal, fully valid execution submission. */
function validSubmission(): SubmitAgentExecutionInput {
  return {
    agentId: UUID_A,
    task: { conversationId: 'c-1', goal: 'draft a reply' },
    requestedPermissions: ['observe', 'analyze'],
  };
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

describe('vocabularies (§16/§20)', () => {
  it('declares the runtime providers — at least two, unique, all with adapters', () => {
    expect(AGENT_RUNTIME_PROVIDERS.length).toBeGreaterThanOrEqual(2);
    expect(new Set(AGENT_RUNTIME_PROVIDERS).size).toBe(AGENT_RUNTIME_PROVIDERS.length);
    for (const provider of AGENT_RUNTIME_PROVIDERS) {
      expect(isAgentRuntimeProvider(provider)).toBe(true);
    }
    expect(isAgentRuntimeProvider('openai')).toBe(false); // llm provider, not a runtime
    expect(isAgentRuntimeProvider('')).toBe(false);
    const adapters = allAgentRuntimeAdapters();
    expect(adapters.map((adapter) => adapter.provider)).toEqual([...AGENT_RUNTIME_PROVIDERS]);
    for (const adapter of adapters) {
      expect(getAgentRuntimeAdapter(adapter.provider)).toBe(adapter);
    }
    expectCode('unsupported_provider', () => getAgentRuntimeAdapter('nope'));
  });

  it('declares the six permission scopes as the lowercase §20 levels, ordered', () => {
    expect([...AGENT_PERMISSION_SCOPES]).toEqual([
      'observe',
      'analyze',
      'recommend',
      'ask',
      'propose',
      'execute',
    ]);
    expect(new Set(AGENT_PERMISSION_SCOPES).size).toBe(6);
    for (const scope of AGENT_PERMISSION_SCOPES) {
      expect(isAgentPermissionScope(scope)).toBe(true);
    }
    expect(isAgentPermissionScope('OBSERVE')).toBe(false); // levels are uppercase
    expect(isAgentPermissionScope('execute-world')).toBe(false);
  });

  it('declares the execution statuses and their terminal partition', () => {
    expect([...AGENT_EXECUTION_STATUSES]).toEqual([
      'awaiting_approval',
      'queued',
      'succeeded',
      'failed',
      'refused',
      'cancelled',
    ]);
    for (const status of AGENT_EXECUTION_STATUSES) {
      expect(isAgentExecutionStatus(status)).toBe(true);
      expect(isTerminalExecutionStatus(status)).toBe(
        (AGENT_EXECUTION_TERMINAL_STATUSES as readonly string[]).includes(status),
      );
    }
    expect(isTerminalExecutionStatus('queued')).toBe(false);
    expect(isTerminalExecutionStatus('awaiting_approval')).toBe(false);
    expect(isTerminalExecutionStatus('succeeded')).toBe(true);
    expect(isAgentExecutionStatus('running')).toBe(false); // no implicit running state
  });

  it('declares the agent-definition statuses', () => {
    expect([...AGENT_STATUSES]).toEqual(['active', 'disabled']);
    expect(isAgentStatus('active')).toBe(true);
    expect(isAgentStatus('paused')).toBe(false);
  });

  it('mirrors the six §20 authority levels', () => {
    expect([...AUTHORITY_LEVELS]).toEqual([
      'OBSERVE',
      'ANALYZE',
      'RECOMMEND',
      'ASK',
      'PROPOSE',
      'EXECUTE',
    ]);
    expect(isAuthorityLevelWord('EXECUTE')).toBe(true);
    expect(isAuthorityLevelWord('execute')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The scope↔level mapping and permission subset enforcement
// ---------------------------------------------------------------------------

describe('permissions (permission-scoped execution)', () => {
  it('scope↔level is a bijection over the six §20 levels', () => {
    for (const level of AUTHORITY_LEVELS) {
      expect(authorityLevelForScope(scopeForAuthorityLevel(level))).toBe(level);
    }
    for (const scope of AGENT_PERMISSION_SCOPES) {
      expect(scopeForAuthorityLevel(authorityLevelForScope(scope))).toBe(scope);
    }
  });

  it('the gate level is the HIGHEST level the requested scopes imply', () => {
    expect(authorityLevelForScopes(['observe'])).toBe('OBSERVE');
    expect(authorityLevelForScopes(['observe', 'analyze'])).toBe('ANALYZE');
    expect(authorityLevelForScopes(['analyze', 'recommend', 'observe'])).toBe('RECOMMEND');
    expect(authorityLevelForScopes(['ask'])).toBe('ASK');
    expect(authorityLevelForScopes(['propose', 'observe'])).toBe('PROPOSE');
    expect(authorityLevelForScopes(['observe', 'execute'])).toBe('EXECUTE');
    expect(authorityLevelForScopes(['execute', 'observe', 'analyze'])).toBe('EXECUTE');
  });

  it('an empty scope request evaluates to the least consequential level (total)', () => {
    expect(authorityLevelForScopes([])).toBe('OBSERVE');
  });

  it('subset enforcement: covered requests pass, uncovered ones name the first gap', () => {
    const granted = ['observe', 'analyze', 'recommend'] as const;
    expect(missingPermissionScope(granted, ['observe'])).toBeNull();
    expect(missingPermissionScope(granted, ['observe', 'analyze', 'recommend'])).toBeNull();
    expect(missingPermissionScope(granted, ['observe', 'ask'])).toBe('ask');
    expect(missingPermissionScope(granted, ['execute'])).toBe('execute');
    expect(missingPermissionScope([], ['observe'])).toBe('observe');
    expect(missingPermissionScope(granted, [])).toBeNull();
  });

  it('the administer claim gates definition management', () => {
    expect(canAdministerAgents([])).toBe(false);
    expect(canAdministerAgents(['actions:approve'])).toBe(false);
    expect(canAdministerAgents(['agents:administer'])).toBe(true);
    expect(canAdministerAgents(['other', 'agents:administer'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retry classification and next-state derivation
// ---------------------------------------------------------------------------

describe('retries (deterministic classification)', () => {
  it('transient transport failures are retryable; refusals and bad results are permanent', () => {
    expect(classifyAttemptFailure('transport_failed')).toEqual({
      errorCode: 'dispatch_failed',
      retryable: true,
    });
    expect(classifyAttemptFailure('transport_rejected')).toEqual({
      errorCode: 'dispatch_rejected',
      retryable: false,
    });
    expect(classifyAttemptFailure('result_invalid')).toEqual({
      errorCode: 'result_invalid',
      retryable: false,
    });
  });

  it('a retryable failure re-queues while attempts remain, then fails terminally', () => {
    expect(statusAfterFailedAttempt(1, 3, true)).toBe('queued');
    expect(statusAfterFailedAttempt(2, 3, true)).toBe('queued');
    expect(statusAfterFailedAttempt(3, 3, true)).toBe('failed');
    expect(statusAfterFailedAttempt(1, 1, true)).toBe('failed');
  });

  it('a permanent failure never re-queues', () => {
    expect(statusAfterFailedAttempt(1, 5, false)).toBe('failed');
    expect(statusAfterFailedAttempt(4, 5, false)).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// TenantContext shape
// ---------------------------------------------------------------------------

describe('TenantContext shape', () => {
  it('accepts a well-formed context and rejects malformed ones', () => {
    expect(() => assertAgentsTenantContext(context())).not.toThrow();
    expectCode('invalid_context', () => assertAgentsTenantContext(null as unknown as TenantContext));
    expectCode('invalid_context', () =>
      assertAgentsTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertAgentsTenantContext({ tenantId: 't', principalId: ' ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertAgentsTenantContext({ tenantId: 't', principalId: 'p', authority: 'admin' } as unknown as TenantContext),
    );
    expectCode('invalid_context', () =>
      assertAgentsTenantContext({ tenantId: 't', principalId: 'p', authority: [1] } as unknown as TenantContext),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation — agent definitions
// ---------------------------------------------------------------------------

describe('validation — registerAgent', () => {
  it('normalizes a valid registration (slug lowercased, scopes deduped and ordered)', () => {
    const valid = validateRegisterAgentInput({
      ...validAgent(),
      slug: 'Support-Triage',
      permissions: ['recommend', 'observe', 'analyze', 'observe'],
    });
    expect(valid.slug).toBe('support-triage');
    expect(valid.permissions).toEqual(['observe', 'analyze', 'recommend']);
    expect(valid.runtimeConfig).toEqual({ assistantId: 'asst_123' });
  });

  it('defaults runtimeConfig to an empty object', () => {
    const { runtimeConfig, ...rest } = validAgent();
    void runtimeConfig;
    const valid = validateRegisterAgentInput(rest);
    expect(valid.runtimeConfig).toEqual({});
  });

  it('rejects malformed slugs, roles, instructions and providers', () => {
    expectCode('invalid_agent_input', () => validateRegisterAgentInput({ ...validAgent(), slug: 'X' }));
    expectCode('invalid_agent_input', () => validateRegisterAgentInput({ ...validAgent(), slug: '-lead' }));
    expectCode('invalid_agent_input', () => validateRegisterAgentInput({ ...validAgent(), slug: 'a'.repeat(65) }));
    expectCode('invalid_agent_input', () => validateRegisterAgentInput({ ...validAgent(), role: '' }));
    expectCode('invalid_agent_input', () => validateRegisterAgentInput({ ...validAgent(), role: ' '.repeat(129) }));
    expectCode('invalid_agent_input', () => validateRegisterAgentInput({ ...validAgent(), instructions: '' }));
    expectCode('invalid_agent_input', () =>
      validateRegisterAgentInput({ ...validAgent(), provider: 'openai' as never }),
    );
  });

  it('rejects permission lists outside the closed vocabulary, empty or oversized', () => {
    expectCode('invalid_agent_input', () =>
      validateRegisterAgentInput({ ...validAgent(), permissions: ['observe', 'fly'] as never }),
    );
    expectCode('invalid_agent_input', () => validateRegisterAgentInput({ ...validAgent(), permissions: [] }));
    expectCode('invalid_agent_input', () => validateRegisterAgentInput({ ...validAgent(), permissions: 'observe' as never }));
    expectCode('invalid_agent_input', () =>
      validateRegisterAgentInput({
        ...validAgent(),
        permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose', 'execute', 'observe'],
      }),
    );
  });

  it('rejects unknown fields and non-object inputs', () => {
    expectCode('invalid_agent_input', () =>
      validateRegisterAgentInput({ ...validAgent(), id: UUID_A } as never),
    );
    expectCode('invalid_agent_input', () =>
      validateRegisterAgentInput({ ...validAgent(), tenantId: 't' } as never),
    );
    expectCode('invalid_agent_input', () => validateRegisterAgentInput(null as never));
    expectCode('invalid_agent_input', () => validateRegisterAgentInput('agent' as never));
  });

  it('bounds the runtime configuration (plain JSON only)', () => {
    expectCode('invalid_agent_input', () =>
      validateRegisterAgentInput({ ...validAgent(), runtimeConfig: { deep: undefined } }),
    );
    expectCode('invalid_agent_input', () =>
      validateRegisterAgentInput({ ...validAgent(), runtimeConfig: 'x'.repeat(65_537) }),
    );
  });
});

describe('validation — updateAgent', () => {
  it('requires a uuid and at least one mutable change', () => {
    const base = { agentId: UUID_A } as UpdateAgentInput;
    expectCode('invalid_agent_input', () => validateUpdateAgentInput(base));
    expectCode('invalid_agent_input', () =>
      validateUpdateAgentInput({ agentId: 'not-a-uuid', role: 'r' } as never),
    );
    const valid = validateUpdateAgentInput({ agentId: UUID_A, status: 'disabled' });
    expect(valid.status).toBe('disabled');
    expect(valid.runtimeConfigSet).toBe(false);
  });

  it('normalizes permissions and validates status', () => {
    const valid = validateUpdateAgentInput({
      agentId: UUID_A,
      permissions: ['ask', 'observe', 'ask'],
    });
    expect(valid.permissions).toEqual(['observe', 'ask']);
    expectCode('invalid_agent_input', () =>
      validateUpdateAgentInput({ agentId: UUID_A, status: 'paused' } as never),
    );
    expectCode('invalid_agent_input', () =>
      validateUpdateAgentInput({ agentId: UUID_A, permissions: ['fly'] as never }),
    );
  });

  it('treats an explicit null runtimeConfig as a reset to empty', () => {
    const valid = validateUpdateAgentInput({ agentId: UUID_A, runtimeConfig: null });
    expect(valid.runtimeConfigSet).toBe(true);
    expect(valid.runtimeConfig).toEqual({});
  });

  it('rejects unknown fields', () => {
    expectCode('invalid_agent_input', () =>
      validateUpdateAgentInput({ agentId: UUID_A, role: 'r', slug: 'new-slug' } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation — execution submission
// ---------------------------------------------------------------------------

describe('validation — submitAgentExecution', () => {
  it('normalizes a valid submission with defaults', () => {
    const valid = validateSubmitAgentExecutionInput(validSubmission());
    expect(valid.agentId).toBe(UUID_A);
    expect(valid.requestedPermissions).toEqual(['observe', 'analyze']);
    expect(valid.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(valid.correlationId).toBeNull();
    expect(valid.causationId).toBeNull();
    expect(valid.idempotencyKey).toBeNull();
  });

  it('requires a non-null plain-JSON task within the byte bound', () => {
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), task: null }),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), task: undefined } as never),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), task: { x: () => 1 } }),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), task: 'x'.repeat(MAX_TASK_BYTES + 1) }),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), task: NaN }),
    );
  });

  it('requires a non-empty requested-permission set from the closed vocabulary', () => {
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), requestedPermissions: [] }),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), requestedPermissions: ['observe', 'fly'] as never }),
    );
  });

  it('bounds maxAttempts and the identity/idempotency keys', () => {
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), maxAttempts: 0 }),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), maxAttempts: 6 }),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), maxAttempts: 2.5 }),
    );
    const valid = validateSubmitAgentExecutionInput({
      ...validSubmission(),
      maxAttempts: 5,
      correlationId: 'flow-1',
      causationId: 'cause:9',
      idempotencyKey: 'agents:abc-1',
    });
    expect(valid.maxAttempts).toBe(5);
    expect(valid.correlationId).toBe('flow-1');
    expect(valid.causationId).toBe('cause:9');
    expect(valid.idempotencyKey).toBe('agents:abc-1');

    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), idempotencyKey: 'a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) }),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), idempotencyKey: 'has space' }),
    );
    expectCode('invalid_agent_input', () =>
      validateSubmitAgentExecutionInput({ ...validSubmission(), correlationId: 'has space' }),
    );
  });

  it('rejects unknown fields (identity, tenancy, lifecycle and accounting are minted)', () => {
    for (const field of ['id', 'tenantId', 'status', 'submittedBy', 'policy', 'attemptsCount', 'costMinor']) {
      expectCode('invalid_agent_input', () =>
        validateSubmitAgentExecutionInput({ ...validSubmission(), [field]: 'x' } as never),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Validation — pump, cancellation, queries
// ---------------------------------------------------------------------------

describe('validation — run/cancel/queries', () => {
  it('validates the pump and cancellation inputs', () => {
    expect(validateRunAgentExecutionInput({ executionId: UUID_A }).executionId).toBe(UUID_A);
    expectCode('invalid_query', () => validateRunAgentExecutionInput({ executionId: 'nope' }));
    expectCode('invalid_query', () => validateRunAgentExecutionInput({ executionId: UUID_A, extra: 1 } as never));

    const cancel: CancelAgentExecutionInput = { executionId: UUID_A, reason: 'superseded' };
    expect(validateCancelAgentExecutionInput(cancel).reason).toBe('superseded');
    expectCode('invalid_agent_input', () => validateCancelAgentExecutionInput({ ...cancel, reason: '' }));
    expectCode('invalid_agent_input', () =>
      validateCancelAgentExecutionInput({ ...cancel, reason: 'x'.repeat(513) }),
    );
    expectCode('invalid_agent_input', () => validateCancelAgentExecutionInput({ executionId: UUID_A } as never));
  });

  it('validates the list queries (filters, limits, unknown keys)', () => {
    const agents = validateListAgentsQuery({ provider: 'langgraph', status: 'active', limit: 10 });
    expect(agents).toEqual({ provider: 'langgraph', status: 'active', limit: 10 });
    expect(validateListAgentsQuery({}).limit).toBe(50);
    expectCode('invalid_query', () => validateListAgentsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListAgentsQuery({ limit: MAX_LIST_LIMIT + 1 }));
    expectCode('invalid_query', () => validateListAgentsQuery({ provider: 'openai' as never }));
    expectCode('invalid_query', () => validateListAgentsQuery({ extra: true } as never));

    const executions = validateListAgentExecutionsQuery({
      agentId: UUID_A,
      status: 'queued',
      correlationId: 'flow-1',
    });
    expect(executions.agentId).toBe(UUID_A);
    expect(executions.status).toBe('queued');
    expectCode('invalid_query', () => validateListAgentExecutionsQuery({ agentId: 'no' }));
    expectCode('invalid_query', () => validateListAgentExecutionsQuery({ status: 'running' as never }));
    expectCode('invalid_query', () => validateListAgentExecutionAttemptsQuery({ executionId: 'no' }));
    expectCode('invalid_query', () =>
      validateListAgentExecutionAttemptsQuery({ executionId: UUID_A, limit: 5 } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime adapters (pure wire translation)
// ---------------------------------------------------------------------------

describe('runtime adapters (provider isolation)', () => {
  const WIRE: Record<string, { config: unknown; payload: unknown; output: unknown }> = {
    'openai-assistants': {
      config: { assistantId: 'asst_42' },
      payload: {
        id: 'run_abc',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"triaged": true}' }] }],
        usage: { input_tokens: 1200, output_tokens: 800 },
      },
      output: { triaged: true },
    },
    langgraph: {
      config: { assistantId: 'triage-graph' },
      payload: {
        run_id: 'lg_7',
        output: { result: { decision: 'escalate' }, summary: 'Escalated to tier 2' },
        usage: { input_tokens: 1000, output_tokens: 500, steps: 4 },
      },
      output: { decision: 'escalate' },
    },
    crewai: {
      config: { crewName: 'collections-crew' },
      payload: {
        run_id: 'crew_9',
        status: 'completed',
        result: { recovered: 12 },
        token_usage: { input_tokens: 900, output_tokens: 450, requests: 3 },
      },
      output: { recovered: 12 },
    },
    autogen: {
      config: { teamId: 'research-team' },
      payload: {
        id: 'ag_1',
        summary: 'Two suppliers compared',
        result: { cheaper: 'supplier-b' },
        usage: { prompt_tokens: 2000, completion_tokens: 700 },
      },
      output: { cheaper: 'supplier-b' },
    },
    'semantic-kernel': {
      config: { agentId: 'sk-copilot' },
      payload: {
        runId: 'sk_run_5',
        output: { routed: 'incidents' },
        usage: { inputTokens: 600, outputTokens: 300, invocations: 2 },
      },
      output: { routed: 'incidents' },
    },
  };

  it('every canonical runtime speaks its own dialect through one canonical contract', () => {
    for (const adapter of allAgentRuntimeAdapters()) {
      const wire = WIRE[adapter.provider]!;
      expect(adapter.resolveRuntimeAgentRef(wire.config)).toBeTruthy();

      const body = adapter.buildTaskRequest({
        runtimeAgentRef: adapter.resolveRuntimeAgentRef(wire.config),
        instructions: 'Do the job.',
        task: { goal: 'test' },
        requestedPermissions: ['observe', 'analyze'],
      });
      expect(typeof body).toBe('object');

      const parsed = adapter.parseTaskResult(wire.payload);
      expect(parsed.output).toEqual(wire.output);
      expect(parsed.providerTaskId).toBeTruthy();
      expect(parsed.usage.inputTokens).not.toBeNull();
      expect(adapter.costForUsage(parsed.usage)).toBeGreaterThan(0);
      // Deterministic: the same usage always costs the same.
      expect(adapter.costForUsage(parsed.usage)).toBe(adapter.costForUsage(parsed.usage));
    }
  });

  it('openai-assistants keeps prose answers as text when they do not parse as JSON', () => {
    const adapter = getAgentRuntimeAdapter('openai-assistants');
    const parsed = adapter.parseTaskResult({
      id: 'run_1',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Escalate to a human.' }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(parsed.output).toBe('Escalate to a human.');
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 5, operations: null });
  });

  it('a payload that cannot be normalized fails LOUDly, never silently substitutes', () => {
    const adapter = getAgentRuntimeAdapter('langgraph');
    expectCode('provider_malformed_response', () => adapter.parseTaskResult({ output: 'not-an-object-detail' }));
    expectCode('provider_malformed_response', () => adapter.parseTaskResult(null));
    expectCode('provider_malformed_response', () =>
      getAgentRuntimeAdapter('openai-assistants').parseTaskResult({ output: [] }),
    );
    expectCode('provider_malformed_response', () =>
      getAgentRuntimeAdapter('crewai').parseTaskResult({ token_usage: { requests: 'many' } }),
    );
  });

  it('runtime configuration without a provider-side agent reference is a loud failure', () => {
    for (const adapter of allAgentRuntimeAdapters()) {
      expectCode('invalid_runtime_config', () => adapter.resolveRuntimeAgentRef({}));
      expectCode('invalid_runtime_config', () => adapter.resolveRuntimeAgentRef(null));
      expectCode('invalid_runtime_config', () => adapter.resolveRuntimeAgentRef('asst_1'));
    }
  });

  it('reports zero cost only for zero usage', () => {
    for (const adapter of allAgentRuntimeAdapters()) {
      expect(adapter.costForUsage({ inputTokens: null, outputTokens: null, operations: null })).toBe(0);
      expect(adapter.costForUsage({ inputTokens: 0, outputTokens: 0, operations: 0 })).toBe(0);
    }
    // A million tokens of each kind prices in whole dollars (integer minor units).
    const adapter: AgentRuntimeAdapter = getAgentRuntimeAdapter('openai-assistants');
    expect(adapter.costForUsage({ inputTokens: 1_000_000, outputTokens: 0, operations: null })).toBe(250);
    expect(adapter.costForUsage({ inputTokens: 0, outputTokens: 1_000_000, operations: null })).toBe(1000);
  });
});
