// Pure execution-policy logic of the agents module (W021 — Agent
// Gateway). No database, no context, no time — everything here is a
// total, deterministic function of its arguments (the actions module's
// matrix.ts discipline), which is exactly what "provider-independent
// execution contract with permissions ... retries" demands: the same
// granted permissions, requested scopes and failure classification always
// yield the same decision, with no LLM, randomness or hidden state in the
// path (lock 10 mirrored: execution policy is application-owned).
//
// Three concerns live here, deliberately pure so downstream modules
// (W022 recruitment, W023 teams, W024 evaluation, W035 provider
// registry) can reuse them without a database:
//
//  1. PERMISSIONS — the closed scope vocabulary (the lowercase mirrors of
//     the six §20 authority levels), subset enforcement (an execution may
//     request only what its agent was granted) and the scope→level
//     mapping that routes every submission through the W009 authority
//     matrix at the HIGHEST level its scopes imply (§20 "applies
//     uniformly" to agent execution).
//
//  2. RETRIES — the deterministic classification of a dispatch failure
//     (transient vs permanent) and the next lifecycle state after a
//     failed attempt (retry while attempts remain, fail terminally
//     otherwise).
//
//  3. LIFECYCLE — the execution status vocabulary and its terminal/live
//     partition (lock 36: live states are resumable; terminal states are
//     history).

// (No imports: this file is pure by design — see the header. The §20
// authority-level strings are mirrored locally because importing the
// actions module's internals would be a cross-module violation; the
// vocabulary is frozen by ARCHITECTURE.md §20 and pinned by tests.)

/** The canonical agent-runtime provider keys (mirrored by the adapter registry). */
export const AGENT_RUNTIME_PROVIDERS = [
  'openai-assistants',
  'langgraph',
  'crewai',
  'autogen',
  'semantic-kernel',
] as const;

export type AgentRuntimeProvider = (typeof AGENT_RUNTIME_PROVIDERS)[number];

export function isAgentRuntimeProvider(value: unknown): value is AgentRuntimeProvider {
  return (
    typeof value === 'string' &&
    (AGENT_RUNTIME_PROVIDERS as readonly string[]).includes(value)
  );
}

/** The six §20 authority levels, in canonical consequentiality order. */
export const AUTHORITY_LEVELS = [
  'OBSERVE',
  'ANALYZE',
  'RECOMMEND',
  'ASK',
  'PROPOSE',
  'EXECUTE',
] as const;

export type AuthorityLevelWord = (typeof AUTHORITY_LEVELS)[number];

export function isAuthorityLevelWord(value: unknown): value is AuthorityLevelWord {
  return (
    typeof value === 'string' &&
    (AUTHORITY_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * The canonical permission scopes — the lowercase mirrors of the six
 * authority levels. An agent definition grants scopes; an execution
 * requests scopes; the gateway admits only covered requests.
 */
export const AGENT_PERMISSION_SCOPES = [
  'observe',
  'analyze',
  'recommend',
  'ask',
  'propose',
  'execute',
] as const;

export type AgentPermissionScopeWord = (typeof AGENT_PERMISSION_SCOPES)[number];

export function isAgentPermissionScope(value: unknown): value is AgentPermissionScopeWord {
  return (
    typeof value === 'string' &&
    (AGENT_PERMISSION_SCOPES as readonly string[]).includes(value)
  );
}

/** The execution lifecycle states (§16/lock 36). */
export const AGENT_EXECUTION_STATUSES = [
  'awaiting_approval',
  'queued',
  'succeeded',
  'failed',
  'refused',
  'cancelled',
] as const;

export type AgentExecutionStatusWord = (typeof AGENT_EXECUTION_STATUSES)[number];

export function isAgentExecutionStatus(value: unknown): value is AgentExecutionStatusWord {
  return (
    typeof value === 'string' &&
    (AGENT_EXECUTION_STATUSES as readonly string[]).includes(value)
  );
}

/** The terminal (non-resumable) execution states — history from then on. */
export const AGENT_EXECUTION_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'refused',
  'cancelled',
] as const;

export function isTerminalExecutionStatus(status: AgentExecutionStatusWord): boolean {
  return (AGENT_EXECUTION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The agent-definition lifecycle states (management configuration). */
export const AGENT_STATUSES = ['active', 'disabled'] as const;

export type AgentStatusWord = (typeof AGENT_STATUSES)[number];

export function isAgentStatus(value: unknown): value is AgentStatusWord {
  return (
    typeof value === 'string' &&
    (AGENT_STATUSES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Permissions (permission-scoped execution)
// ---------------------------------------------------------------------------

/** The scope that mirrors one §20 authority level (bijective by construction). */
export function scopeForAuthorityLevel(level: AuthorityLevelWord): AgentPermissionScopeWord {
  return level.toLowerCase() as AgentPermissionScopeWord;
}

/** The §20 authority level a scope implies (bijective by construction). */
export function authorityLevelForScope(scope: AgentPermissionScopeWord): AuthorityLevelWord {
  return scope.toUpperCase() as AuthorityLevelWord;
}

/**
 * The §20 level an execution must be authorized at: the HIGHEST level its
 * requested scopes imply. An empty request evaluates to OBSERVE (the least
 * consequential level) so the function stays total — validation requires
 * at least one scope long before this runs.
 */
export function authorityLevelForScopes(
  scopes: readonly AgentPermissionScopeWord[],
): AuthorityLevelWord {
  let highest: AuthorityLevelWord = 'OBSERVE';
  for (const scope of scopes) {
    const level = authorityLevelForScope(scope);
    if (AUTHORITY_LEVELS.indexOf(level) > AUTHORITY_LEVELS.indexOf(highest)) {
      highest = level;
    }
  }
  return highest;
}

/**
 * The first requested scope the grant does not cover, or null when the
 * request is fully covered. Pure subset enforcement — the deterministic
 * heart of "permission-scoped" (§16).
 */
export function missingPermissionScope(
  granted: readonly AgentPermissionScopeWord[],
  requested: readonly AgentPermissionScopeWord[],
): AgentPermissionScopeWord | null {
  for (const scope of requested) {
    if (!(granted as readonly string[]).includes(scope)) return scope;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Retries (deterministic failure classification and next state)
// ---------------------------------------------------------------------------

/** The failure classification of one dispatch attempt. */
export type AttemptFailure = {
  errorCode: 'dispatch_failed' | 'dispatch_rejected' | 'result_invalid';
  /** true when the execution should dispatch again (attempts remaining). */
  retryable: boolean;
};

/**
 * Classify one dispatch failure (deterministic):
 *  * transport `failed` (transient error) → `dispatch_failed`, retryable;
 *  * transport `rejected` (the runtime refused) → `dispatch_rejected`,
 *    permanent;
 *  * delivered but unnormalizable payload → `result_invalid`, permanent —
 *    a loud failure, never a silent substitute value (the llm module's
 *    adapter discipline).
 */
export function classifyAttemptFailure(
  kind: 'transport_failed' | 'transport_rejected' | 'result_invalid',
): AttemptFailure {
  switch (kind) {
    case 'transport_failed':
      return { errorCode: 'dispatch_failed', retryable: true };
    case 'transport_rejected':
      return { errorCode: 'dispatch_rejected', retryable: false };
    case 'result_invalid':
      return { errorCode: 'result_invalid', retryable: false };
  }
}

/**
 * The execution status after a failed attempt: `queued` (dispatch again)
 * while attempts remain under the ceiling, `failed` (terminal) otherwise.
 */
export function statusAfterFailedAttempt(
  attemptsCount: number,
  maxAttempts: number,
  retryable: boolean,
): 'queued' | 'failed' {
  if (retryable && attemptsCount < maxAttempts) return 'queued';
  return 'failed';
}

/** Authority claim that manages the tenant's agent definitions. */
export const AGENTS_AUTHORITY_ADMINISTER = 'agents:administer';

/** May these authority claims manage the tenant's agent definitions? */
export function canAdministerAgents(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(AGENTS_AUTHORITY_ADMINISTER);
}
