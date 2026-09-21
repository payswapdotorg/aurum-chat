// AI/BYOA & Provider Routing UX (W066) — the action surface.
//
// The /ai surface's WRITE path is a thin, explicit dispatcher over the llm
// module's contract (W034 — the LLM Gateway is the single way in, lock 28):
//
//   account.register    — add a tenant-owned provider account (BYOA)
//   account.update      — the policy/routing configuration (scopes,
//                         capabilities, data-policy ceiling, priority,
//                         budget, credential rotation)
//   account.setStatus   — revoke (disable) / restore (enable) an account
//   account.test        — TEST CONNECTION: one tiny pinned invocation
//                         through the account (the same canonical gateway
//                         path production traffic takes), returned as a
//                         structured outcome — a failed test is a RESULT,
//                         not an API error
//   availability.set    — manual availability override per (account, model)
//   hotswap.verify      — run the SAME canonical request through two pinned
//                         (provider, model) targets and record the
//                         deterministic comparison (W048 discipline)
//
// Discipline (scope rules / GOVERNANCE):
//   * this surface implements NO domain logic — every operation delegates
//     to a contract call and lets the module's own validation, tenant
//     scoping and authority checks decide ('llm:administer' gates the
//     management writes);
//   * configuration takes an OPAQUE `credentialRef` — there is no field
//     anywhere in this surface that accepts a credential VALUE;
//   * body parsing/validation is pure and unit-testable; execution is a
//     separate step so tests drive the exact code the /api/product/ai
//     route drives without booting Next.js;
//   * idempotency keys are DETERMINISTIC per (target, capability): when a
//     tenant gates 'llm-invocation' behind human approval, the retry after
//     the decision replays the SAME action request and proceeds (the
//     contract's documented replay semantics).

import type { TenantContext } from '@/infra/tenant';
import {
  DATA_CLASSIFICATIONS,
  LLM_SCOPES,
  MAX_BUDGET_MINOR,
  MAX_PRIORITY,
  MIN_PRIORITY,
  invokeLlm,
  isLlmCapability,
  isLlmProvider,
  listLlmModels,
  registerAiProviderAccount,
  setAiAvailability,
  updateAiProviderAccount,
  verifyProviderHotSwap,
  getAiProviderAccount,
  LlmError,
} from '@/modules/llm/contract';
import type {
  AiProviderAccount,
  CanonicalLlmMessage,
  DataClassification,
  LlmCapability,
  LlmExecution,
  LlmHotSwapVerification,
  LlmProvider,
  LlmScope,
  RegisterAiProviderAccountInput,
  UpdateAiProviderAccountInput,
  VerifyProviderHotSwapInput,
} from '@/modules/llm/contract';
import {
  ACCOUNT_TEST_PROMPT,
  EMBEDDING_TEST_INPUT,
  HOT_SWAP_PROMPT,
} from './labels';

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

export const AI_ACTIONS = [
  'account.register',
  'account.update',
  'account.setStatus',
  'account.test',
  'availability.set',
  'hotswap.verify',
] as const;

export type AiAction = (typeof AI_ACTIONS)[number];

export function isAiAction(value: unknown): value is AiAction {
  return typeof value === 'string' && (AI_ACTIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Parsed inputs (shape-checked; the contract re-validates authoritatively)
// ---------------------------------------------------------------------------

export type ParsedActionInput =
  | {
      action: 'account.register';
      provider: LlmProvider;
      label: string;
      credentialRef: string;
      scopes: LlmScope[];
      capabilities: LlmCapability[];
      maxDataClassification: DataClassification;
      priority: number;
      budgetMinor: number | null;
    }
  | {
      action: 'account.update';
      accountId: string;
      credentialRef: string | null;
      scopes: LlmScope[] | null;
      capabilities: LlmCapability[] | null;
      maxDataClassification: DataClassification | null;
      priority: number | null;
      budgetMinor: number | null;
      budgetProvided: boolean;
    }
  | { action: 'account.setStatus'; accountId: string; status: 'active' | 'disabled' }
  | {
      action: 'account.test';
      accountId: string;
      model: string | null;
      capability: string | null;
      scope: string | null;
    }
  | {
      action: 'availability.set';
      accountId: string;
      model: string;
      state: 'available' | 'unavailable';
      reason: string | null;
      expiresAt: string | null;
    }
  | {
      action: 'hotswap.verify';
      targetA: { accountId: string; model: string };
      targetB: { accountId: string; model: string };
      capability: LlmCapability;
      scope: LlmScope;
      dataClassification: DataClassification;
      prompt: string | null;
    };

export type ParseResult =
  | { ok: true; value: ParsedActionInput }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure body parsing
// ---------------------------------------------------------------------------

function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requireText(record: Record<string, unknown>, field: string): string | null {
  return text(record[field]) ?? null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

function parseScopes(value: unknown): LlmScope[] | null {
  const scopes = stringArray(value);
  if (scopes === null) return null;
  if (!scopes.every((scope) => (LLM_SCOPES as readonly string[]).includes(scope))) return null;
  return scopes as LlmScope[];
}

function parseCapabilities(value: unknown): LlmCapability[] | null {
  const capabilities = stringArray(value);
  if (capabilities === null) return null;
  if (!capabilities.every((capability) => isLlmCapability(capability))) return null;
  return capabilities as LlmCapability[];
}

function parseClassification(value: unknown): DataClassification | null {
  return (DATA_CLASSIFICATIONS as readonly string[]).includes(value as string)
    ? (value as DataClassification)
    : null;
}

function parsePriority(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < MIN_PRIORITY || value > MAX_PRIORITY) return null;
  return value;
}

function parseBudget(value: unknown): { ok: true; minor: number | null } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, minor: null };
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false };
  if (value < 1 || value > MAX_BUDGET_MINOR) return { ok: false };
  return { ok: true, minor: value };
}

function parseIsoInstant(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'invalid';
  const trimmed = value.trim();
  return Number.isNaN(Date.parse(trimmed)) ? 'invalid' : trimmed;
}

/**
 * Parse and shape-check one action body. PURE. The llm contract remains
 * the authoritative validator — this layer only guarantees the shape the
 * dispatcher needs and produces readable 400 messages.
 */
export function parseActionBody(body: unknown): ParseResult {
  if (!isObject(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const action = body['action'];
  if (!isAiAction(action)) {
    return {
      ok: false,
      error: `unknown action '${String(action)}' (supported: ${AI_ACTIONS.join(', ')})`,
    };
  }

  switch (action) {
    case 'account.register': {
      const provider = requireText(body, 'provider');
      const label = requireText(body, 'label');
      const credentialRef = requireText(body, 'credentialRef');
      if (provider === null || label === null || credentialRef === null) {
        return {
          ok: false,
          error: 'account.register requires provider, label and credentialRef (an opaque secret-store reference — never a credential value)',
        };
      }
      if (!isLlmProvider(provider)) {
        return { ok: false, error: `account.register: '${provider}' is not a registry provider` };
      }
      const scopes = parseScopes(body['scopes']);
      if (scopes === null) {
        return {
          ok: false,
          error: `account.register: scopes must be a non-empty array from ${LLM_SCOPES.join(', ')}`,
        };
      }
      if (scopes.length === 0) {
        return { ok: false, error: 'account.register: at least one scope is required' };
      }
      const capabilities = parseCapabilities(body['capabilities']);
      if (capabilities === null || capabilities.length === 0) {
        return {
          ok: false,
          error: 'account.register: capabilities must be a non-empty array of text-generation and/or embedding',
        };
      }
      const classification = parseClassification(body['maxDataClassification']);
      if (classification === null) {
        return {
          ok: false,
          error: `account.register: maxDataClassification must be one of ${DATA_CLASSIFICATIONS.join(', ')}`,
        };
      }
      const priority = parsePriority(body['priority']);
      if (priority === null) {
        return {
          ok: false,
          error: `account.register: priority must be an integer between ${MIN_PRIORITY} and ${MAX_PRIORITY} (lower is preferred)`,
        };
      }
      const budget = parseBudget(body['budgetMinor']);
      if (!budget.ok) {
        return {
          ok: false,
          error: `account.register: budgetMinor must be an integer of at least 1 cent, at most ${MAX_BUDGET_MINOR} minor units, or null`,
        };
      }
      return {
        ok: true,
        value: {
          action,
          provider,
          label,
          credentialRef,
          scopes,
          capabilities,
          maxDataClassification: classification,
          priority,
          budgetMinor: budget.minor,
        },
      };
    }
    case 'account.update': {
      const accountId = requireText(body, 'accountId');
      if (accountId === null) {
        return { ok: false, error: 'account.update requires accountId' };
      }
      const credentialRef = text(body['credentialRef']);
      const scopes =
        body['scopes'] === undefined ? null : parseScopes(body['scopes']);
      if (scopes === null && body['scopes'] !== undefined) {
        return {
          ok: false,
          error: `account.update: scopes must be a non-empty array from ${LLM_SCOPES.join(', ')}`,
        };
      }
      const capabilities =
        body['capabilities'] === undefined ? null : parseCapabilities(body['capabilities']);
      if (capabilities === null && body['capabilities'] !== undefined) {
        return { ok: false, error: 'account.update: capabilities must be a non-empty capability array' };
      }
      const classification =
        body['maxDataClassification'] === undefined
          ? null
          : parseClassification(body['maxDataClassification']);
      if (classification === null && body['maxDataClassification'] !== undefined) {
        return {
          ok: false,
          error: `account.update: maxDataClassification must be one of ${DATA_CLASSIFICATIONS.join(', ')}`,
        };
      }
      const priority = body['priority'] === undefined ? null : parsePriority(body['priority']);
      if (priority === null && body['priority'] !== undefined) {
        return {
          ok: false,
          error: `account.update: priority must be an integer between ${MIN_PRIORITY} and ${MAX_PRIORITY}`,
        };
      }
      const budgetProvided = body['budgetMinor'] !== undefined;
      const budgetParsed = budgetProvided
        ? parseBudget(body['budgetMinor'])
        : ({ ok: true, minor: null } as { ok: true; minor: number | null });
      if (!budgetParsed.ok) {
        return {
          ok: false,
          error: `account.update: budgetMinor must be an integer of at least 1 cent, at most ${MAX_BUDGET_MINOR} minor units, or null (clears the budget)`,
        };
      }
      const budgetMinor = budgetParsed.minor;
      if (
        credentialRef === null &&
        scopes === null &&
        capabilities === null &&
        classification === null &&
        priority === null &&
        !budgetProvided
      ) {
        return {
          ok: false,
          error: 'account.update requires at least one field to change (credentialRef, scopes, capabilities, maxDataClassification, priority, budgetMinor)',
        };
      }
      return {
        ok: true,
        value: {
          action,
          accountId,
          credentialRef,
          scopes,
          capabilities,
          maxDataClassification: classification,
          priority,
          budgetMinor,
          budgetProvided,
        },
      };
    }
    case 'account.setStatus': {
      const accountId = requireText(body, 'accountId');
      if (accountId === null) {
        return { ok: false, error: 'account.setStatus requires accountId' };
      }
      const status = body['status'];
      if (status !== 'active' && status !== 'disabled') {
        return {
          ok: false,
          error: "account.setStatus requires status 'active' (restore) or 'disabled' (revoke)",
        };
      }
      return { ok: true, value: { action, accountId, status } };
    }
    case 'account.test': {
      const accountId = requireText(body, 'accountId');
      if (accountId === null) {
        return { ok: false, error: 'account.test requires accountId' };
      }
      return {
        ok: true,
        value: {
          action,
          accountId,
          model: text(body['model']),
          capability: text(body['capability']),
          scope: text(body['scope']),
        },
      };
    }
    case 'availability.set': {
      const accountId = requireText(body, 'accountId');
      const model = requireText(body, 'model');
      if (accountId === null || model === null) {
        return { ok: false, error: 'availability.set requires accountId and model' };
      }
      const state = body['state'];
      if (state !== 'available' && state !== 'unavailable') {
        return {
          ok: false,
          error: "availability.set requires state 'available' or 'unavailable'",
        };
      }
      const expiresAt = parseIsoInstant(body['expiresAt']);
      if (expiresAt === 'invalid') {
        return {
          ok: false,
          error: 'availability.set: expiresAt must be an ISO 8601 timestamp (or empty, for an indefinite hold)',
        };
      }
      if (state === 'available' && expiresAt !== null) {
        return {
          ok: false,
          error: 'availability.set: expiresAt applies to unavailable holds only',
        };
      }
      return {
        ok: true,
        value: {
          action,
          accountId,
          model,
          state,
          reason: text(body['reason']),
          expiresAt,
        },
      };
    }
    case 'hotswap.verify': {
      const parseTarget = (
        value: unknown,
        name: string,
      ): { accountId: string; model: string } | { error: string } => {
        if (!isObject(value)) {
          return { error: `hotswap.verify: ${name} must be an object with accountId and model` };
        }
        const accountId = requireText(value, 'accountId');
        const model = requireText(value, 'model');
        if (accountId === null || model === null) {
          return { error: `hotswap.verify: ${name} requires accountId and model` };
        }
        return { accountId, model };
      };
      const targetA = parseTarget(body['targetA'], 'targetA');
      if ('error' in targetA) return { ok: false, error: targetA.error };
      const targetB = parseTarget(body['targetB'], 'targetB');
      if ('error' in targetB) return { ok: false, error: targetB.error };
      const capability = body['capability'];
      if (!isLlmCapability(capability)) {
        return {
          ok: false,
          error: 'hotswap.verify: capability must be text-generation or embedding',
        };
      }
      const scope = body['scope'];
      if (typeof scope !== 'string' || !(LLM_SCOPES as readonly string[]).includes(scope)) {
        return {
          ok: false,
          error: `hotswap.verify: scope must be one of ${LLM_SCOPES.join(', ')}`,
        };
      }
      const classification = parseClassification(body['dataClassification']);
      if (classification === null) {
        return {
          ok: false,
          error: `hotswap.verify: dataClassification must be one of ${DATA_CLASSIFICATIONS.join(', ')}`,
        };
      }
      const prompt = text(body['prompt']);
      if (prompt !== null && prompt.length > 500) {
        return { ok: false, error: 'hotswap.verify: prompt must be at most 500 characters' };
      }
      return {
        ok: true,
        value: {
          action,
          targetA,
          targetB,
          capability,
          scope: scope as LlmScope,
          dataClassification: classification,
          prompt,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Execution (contract delegation only)
// ---------------------------------------------------------------------------

export interface AiActionOutcome {
  action: AiAction;
  /** One human sentence describing what happened. */
  summary: string;
  /** The contract result (already provider-neutral and credential-free). */
  result: unknown;
}

/** The structured result of one connection test (a failed test is a result). */
export interface TestConnectionResult {
  accountId: string;
  provider: LlmProvider;
  label: string;
  /** The capability the test exercised (null when none was testable). */
  capability: LlmCapability | null;
  /** The scope the test rode (null when none was permitted). */
  scope: LlmScope | null;
  /** The model the pinned routing chose (null when no model was reached). */
  model: string | null;
  outcome: 'verified' | 'failed' | 'awaiting-approval';
  executionId: string | null;
  latencyMs: number | null;
  costMinor: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  /** The pending action request awaiting a human decision, when gated. */
  actionRequestId: string | null;
  note: string;
}

/** The structured result of one hot-swap verification run. */
export interface HotSwapActionResult {
  status: 'verified' | 'awaiting-approval';
  verification: LlmHotSwapVerification | null;
  executionA: LlmExecution | null;
  executionB: LlmExecution | null;
  actionRequestId: string | null;
}

/**
 * The action request id of a gate-pending llm invocation, extracted from
 * the module's own error message (`action request '<uuid>' …`). Null when
 * the message carries no id (never worse than a missing deep link).
 */
export function extractGateActionRequestId(message: string): string | null {
  const match = /action request '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/.exec(
    message,
  );
  return match === null ? null : match[1] ?? null;
}

/** The deterministic idempotency key of one connection-test target (gate replay). */
export function accountTestIdempotencyKey(
  accountId: string,
  model: string | null,
  capability: LlmCapability,
): string {
  return `ai-test:${accountId}:${model ?? 'auto'}:${capability}`;
}

/** The deterministic idempotency key of one hot-swap target pair (gate replay). */
export function hotSwapIdempotencyKey(
  targetA: { accountId: string; model: string },
  targetB: { accountId: string; model: string },
  capability: LlmCapability,
): string {
  return `ai-hotswap:${targetA.accountId}:${targetA.model}:${targetB.accountId}:${targetB.model}:${capability}`;
}

/**
 * Pick the capability a connection test should exercise: the requested one,
 * else the account's first permitted capability that some registry model of
 * its provider actually serves.
 */
export function pickTestCapability(
  account: AiProviderAccount,
  requested: string | null,
): { capability: LlmCapability; model: string | null } | { error: string } {
  const providerModels = listLlmModels(account.provider);
  if (requested !== null) {
    if (!isLlmCapability(requested)) {
      return { error: `'${requested}' is not a capability (text-generation or embedding)` };
    }
    if (!(account.capabilities as readonly string[]).includes(requested)) {
      return {
        error: `the account does not permit capability '${requested}' — add it to the account's capabilities first`,
      };
    }
    const supported = providerModels.some((model) =>
      (model.capabilities as readonly string[]).includes(requested),
    );
    if (!supported) {
      return {
        error: `no ${account.provider} model in the registry serves capability '${requested}'`,
      };
    }
    return { capability: requested, model: null };
  }
  for (const capability of account.capabilities) {
    const model = providerModels.find((candidate) =>
      (candidate.capabilities as readonly string[]).includes(capability),
    );
    if (model !== undefined) {
      return { capability, model: null };
    }
  }
  return {
    error: `the account permits no capability that any ${account.provider} registry model serves`,
  };
}

/** The scope a connection test should ride: the requested one, else the account's first permitted scope. */
export function pickTestScope(
  account: AiProviderAccount,
  requested: string | null,
): { scope: LlmScope; error: null } | { scope: null; error: string } {
  if (requested === null) {
    const first = LLM_SCOPES.find((scope) =>
      (account.scopes as readonly string[]).includes(scope),
    );
    return first === undefined
      ? { scope: null, error: 'the account permits no scope — configure at least one first' }
      : { scope: first, error: null };
  }
  if (!(LLM_SCOPES as readonly string[]).includes(requested)) {
    return { scope: null, error: `'${requested}' is not a scope (${LLM_SCOPES.join(', ')})` };
  }
  if (!(account.scopes as readonly string[]).includes(requested)) {
    return { scope: null, error: `the account does not permit scope '${requested}'` };
  }
  return { scope: requested as LlmScope, error: null };
}

/** Execute one parsed action against the llm contract. */
export async function executeAiAction(
  ctx: TenantContext,
  input: ParsedActionInput,
): Promise<AiActionOutcome> {
  switch (input.action) {
    case 'account.register': {
      const payload: RegisterAiProviderAccountInput = {
        provider: input.provider,
        label: input.label,
        credentialRef: input.credentialRef,
        scopes: input.scopes,
        capabilities: input.capabilities,
        maxDataClassification: input.maxDataClassification,
        priority: input.priority,
        ...(input.budgetMinor === null ? {} : { budgetMinor: input.budgetMinor }),
      };
      const registration = await registerAiProviderAccount(ctx, payload);
      return {
        action: input.action,
        summary: registration.created
          ? `Added ${input.provider} account “${input.label}”.`
          : `An ${input.provider} account labeled “${input.label}” already exists — the first registration wins (change its configuration instead).`,
        result: registration,
      };
    }
    case 'account.update': {
      const payload: UpdateAiProviderAccountInput = {
        accountId: input.accountId,
        ...(input.credentialRef === null ? {} : { credentialRef: input.credentialRef }),
        ...(input.scopes === null ? {} : { scopes: input.scopes }),
        ...(input.capabilities === null ? {} : { capabilities: input.capabilities }),
        ...(input.maxDataClassification === null
          ? {}
          : { maxDataClassification: input.maxDataClassification }),
        ...(input.priority === null ? {} : { priority: input.priority }),
        ...(input.budgetProvided ? { budgetMinor: input.budgetMinor } : {}),
      };
      const account = await updateAiProviderAccount(ctx, payload);
      return {
        action: input.action,
        summary: `Updated ${account.provider} account “${account.label}” — routing re-reads the new configuration on the next request.`,
        result: account,
      };
    }
    case 'account.setStatus': {
      const account = await updateAiProviderAccount(ctx, {
        accountId: input.accountId,
        status: input.status,
      });
      return {
        action: input.action,
        summary:
          input.status === 'disabled'
            ? `Revoked ${account.provider} account “${account.label}” — the gateway no longer routes here (evidence and spend history are retained).`
            : `Restored ${account.provider} account “${account.label}” — it is eligible for routing again.`,
        result: account,
      };
    }
    case 'account.test': {
      const account = await getAiProviderAccount(ctx, { accountId: input.accountId });
      const capability = pickTestCapability(account, input.capability);
      if ('error' in capability) {
        return {
          action: input.action,
          summary: `Could not test ${account.provider} account “${account.label}”: ${capability.error}.`,
          result: {
            accountId: account.id,
            provider: account.provider,
            label: account.label,
            capability: null,
            scope: null,
            model: null,
            outcome: 'failed',
            executionId: null,
            latencyMs: null,
            costMinor: null,
            errorCode: 'invalid_test_request',
            errorDetail: capability.error,
            actionRequestId: null,
            note: 'Nothing was sent to the provider.',
          } satisfies TestConnectionResult,
        };
      }
      const scopePick = pickTestScope(account, input.scope);
      if (scopePick.error !== null) {
        return {
          action: input.action,
          summary: `Could not test ${account.provider} account “${account.label}”: ${scopePick.error}.`,
          result: {
            accountId: account.id,
            provider: account.provider,
            label: account.label,
            capability: capability.capability,
            scope: null,
            model: null,
            outcome: 'failed',
            executionId: null,
            latencyMs: null,
            costMinor: null,
            errorCode: 'invalid_test_request',
            errorDetail: scopePick.error,
            actionRequestId: null,
            note: 'Nothing was sent to the provider.',
          } satisfies TestConnectionResult,
        };
      }
      const scope = scopePick.scope;
      const testCapability = capability.capability;
      try {
        const execution = await invokeLlm(ctx, {
          capability: testCapability,
          scope,
          dataClassification: 'public',
          ...(testCapability === 'text-generation'
            ? {
                messages: [
                  { role: 'user', content: ACCOUNT_TEST_PROMPT },
                ] satisfies CanonicalLlmMessage[],
                temperature: 0,
                maxOutputTokens: 16,
              }
            : { embeddingInput: EMBEDDING_TEST_INPUT }),
          pinnedAccountId: account.id,
          ...(input.model === null ? {} : { pinnedModel: input.model }),
          idempotencyKey: accountTestIdempotencyKey(
            account.id,
            input.model,
            testCapability,
          ),
        });
        const verified = execution.status === 'completed';
        return {
          action: input.action,
          summary: verified
            ? `Verified ${account.provider} account “${account.label}” through ${execution.model} — ${execution.latencyMs} ms.`
            : `The test through ${account.provider} account “${account.label}” failed (${execution.errorCode ?? 'unknown'}) — the failure is recorded as evidence.`,
          result: {
            accountId: account.id,
            provider: account.provider,
            label: account.label,
            capability: testCapability,
            scope,
            model: execution.model,
            outcome: verified ? 'verified' : 'failed',
            executionId: execution.id,
            latencyMs: execution.latencyMs,
            costMinor: execution.costMinor,
            errorCode: execution.errorCode,
            errorDetail: execution.errorDetail,
            actionRequestId: null,
            note: verified
              ? 'The account, its routing and the provider transport all worked — one pinned invocation completed.'
              : 'The pinned invocation was attempted and recorded; the provider refused or failed it.',
          } satisfies TestConnectionResult,
        };
      } catch (error) {
        if (error instanceof LlmError) {
          const gated = error.code === 'invocation_approval_required';
          const actionRequestId = gated ? extractGateActionRequestId(error.message) : null;
          return {
            action: input.action,
            summary: gated
              ? `The test is waiting for a human approval — the tenant policy gates llm invocations.`
              : `The test of ${account.provider} account “${account.label}” could not complete: ${error.message}`,
            result: {
              accountId: account.id,
              provider: account.provider,
              label: account.label,
              capability: testCapability,
              scope,
              model: input.model,
              outcome: gated ? 'awaiting-approval' : 'failed',
              executionId: null,
              latencyMs: null,
              costMinor: null,
              errorCode: error.code,
              errorDetail: error.message,
              actionRequestId,
              note: gated
                ? 'Approve the request, then run the test again — the same target replays the same request.'
                : 'No provider interaction completed. When the failure was a provider/transport failure, the attempt is recorded as evidence with a cooldown.',
            } satisfies TestConnectionResult,
          };
        }
        throw error;
      }
    }
    case 'availability.set': {
      const availability = await setAiAvailability(ctx, {
        accountId: input.accountId,
        model: input.model,
        state: input.state,
        ...(input.reason === null ? {} : { reason: input.reason }),
        ...(input.expiresAt === null ? {} : { expiresAt: input.expiresAt }),
      });
      return {
        action: input.action,
        summary:
          input.state === 'unavailable'
            ? `Held ${availability.provider} ${input.model} as unavailable${input.expiresAt === null ? ' (indefinite)' : ` until ${input.expiresAt}`} — automatic routing avoids it until the hold lapses.`
            : `Released the hold on ${availability.provider} ${input.model} — it is available to automatic routing again.`,
        result: availability,
      };
    }
    case 'hotswap.verify': {
      const messages: CanonicalLlmMessage[] = [
        {
          role: 'user',
          content:
            input.prompt === null
              ? input.capability === 'text-generation'
                ? HOT_SWAP_PROMPT
                : EMBEDDING_TEST_INPUT
              : input.prompt,
        },
      ];
      const payload: VerifyProviderHotSwapInput = {
        capability: input.capability,
        scope: input.scope,
        dataClassification: input.dataClassification,
        ...(input.capability === 'text-generation'
          ? { messages, temperature: 0, maxOutputTokens: 32 }
          : { embeddingInput: messages[0]!.content }),
        targetA: input.targetA,
        targetB: input.targetB,
        idempotencyKey: hotSwapIdempotencyKey(
          input.targetA,
          input.targetB,
          input.capability,
        ),
      };
      try {
        const outcome = await verifyProviderHotSwap(ctx, payload);
        return {
          action: input.action,
          summary: `Hot-swap verified: ${outcome.verification.targetA.provider}/${outcome.verification.targetA.model} ↔ ${outcome.verification.targetB.provider}/${outcome.verification.targetB.model} — ${outcome.verification.outcome}.`,
          result: {
            status: 'verified',
            verification: outcome.verification,
            executionA: outcome.executionA,
            executionB: outcome.executionB,
            actionRequestId: null,
          } satisfies HotSwapActionResult,
        };
      } catch (error) {
        if (error instanceof LlmError && error.code === 'invocation_approval_required') {
          const actionRequestId = extractGateActionRequestId(error.message);
          return {
            action: input.action,
            summary:
              'The hot-swap run is waiting for a human approval — the tenant policy gates llm invocations.',
            result: {
              status: 'awaiting-approval',
              verification: null,
              executionA: null,
              executionB: null,
              actionRequestId,
            } satisfies HotSwapActionResult,
          };
        }
        throw error;
      }
    }
  }
}
