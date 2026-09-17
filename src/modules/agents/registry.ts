// The agent-runtime provider registry of the agents module (W035 — Agent
// Provider Registry): the platform's canonical, code-owned catalog of agent
// runtimes/providers and their execution reference data.
//
// WHY CODE, NOT A TABLE (the llm module's W034 discipline, applied to the
// agent runtime family): every persisted domain table must be tenant-scoped
// (check-architecture rule (d); only `tenants`/`_migrations` are exempt),
// and runtime catalog entries are PLATFORM reference data, not tenant data —
// they change with adapter code (a runtime whose dialect this module cannot
// speak cannot be routed to), so the registry and the adapter set version
// together. Tenants do NOT mutate the registry; they register tenant-owned
// agent runtime ACCOUNTS against it (`agent_runtime_accounts`, migration
// 004) — "Register multiple agent runtimes/providers" (work item W035) is
// that tenant surface, exactly like BYOA accounts register against the llm
// module's provider/model catalog (lock 29: "Tenants may BYOA through
// explicit AIProviderAccount and agent/provider account boundaries").
//
// No runtime is architecturally privileged (lock 30 mirrored for the agent
// family): the catalog is a flat list; routing preference comes only from
// tenant account configuration (priority ordering), never from registry
// position.
//
// PRICING CENTRALIZATION (the W035 change the W021 adapters anticipated —
// adapters/types.ts: "costForUsage ... the interim home until W035 (Agent
// Provider Registry) centralizes runtime reference data, exactly like the
// llm registry owns model list prices"): list prices are integer minor
// units (IMPLEMENTATION-STACK §8: integer minor units + ISO currency code)
// and the deterministic `agentRuntimeCostMinor` below is now the SINGLE
// source of cost truth. The formula preserves the adapters' historical
// arithmetic exactly — one Math.round over the token terms plus the
// operation term, so every previously recorded cost stays reproducible:
//
//   cost = round((inputTokens·inputMinorPerMillion
//                + outputTokens·outputMinorPerMillion) / 1e6
//               + operations·operationMinorPerThousand / 1e3)
//
// (Per-operation prices are expressed per thousand to keep one unit:
// CrewAI's $0.10/request → 1000 minor per thousand requests; Semantic
// Kernel's $0.05/invocation → 500 minor per thousand invocations.)

import type { AgentRuntimeProvider } from './policy';
import { AGENT_RUNTIME_PROVIDERS, isAgentRuntimeProvider } from './policy';

// ---------------------------------------------------------------------------
// Capabilities (what the gateway can route a dispatch on)
// ---------------------------------------------------------------------------

/**
 * The canonical execution capabilities the agent gateway can route. Every
 * runtime adapter in `adapters/` implements exactly this contract today:
 * submit one canonical task, run it, return one normalized result with
 * usage — hence the single entry `task-execution`. The vocabulary is the
 * routing seam (accounts permit subsets; runtimes serve subsets), so new
 * runtime features (streaming, multi-agent choreography, human-in-the-loop
 * handoffs …) extend HERE first, never as provider-specific special cases
 * (lock 24: no semantic provider coupling on the contract surface).
 */
export const AGENT_RUNTIME_CAPABILITIES = ['task-execution'] as const;

export type AgentRuntimeCapability = (typeof AGENT_RUNTIME_CAPABILITIES)[number];

export function isAgentRuntimeCapability(value: unknown): value is AgentRuntimeCapability {
  return (
    typeof value === 'string' &&
    (AGENT_RUNTIME_CAPABILITIES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Descriptors (platform reference data, one per canonical runtime)
// ---------------------------------------------------------------------------

/**
 * Deterministic list pricing of one runtime, in integer minor units (USD):
 *  * `inputMinorPerMillion`  — per 1,000,000 reported input tokens;
 *  * `outputMinorPerMillion` — per 1,000,000 reported output tokens;
 *  * `operationMinorPerThousand` — per 1,000 reported billable operations
 *    (graph steps, crew requests, kernel invocations); null = the runtime's
 *    operations are not billed (token pricing only).
 */
export interface AgentRuntimePricing {
  inputMinorPerMillion: number;
  outputMinorPerMillion: number;
  operationMinorPerThousand: number | null;
  currency: 'USD';
}

/**
 * One runtime in the registry: what it serves and what it costs. The
 * provider key is the canonical `AgentRuntimeProvider` — the ONLY runtime
 * identity on any contract surface; everything else here is neutral
 * reference data. `reportsOperations` documents whether the runtime's
 * dialect reports billable operations at all (it feeds cost explanation,
 * never eligibility).
 */
export interface AgentRuntimeDescriptor {
  provider: AgentRuntimeProvider;
  /** Neutral display label (management surfaces). */
  label: string;
  /** What the runtime serves, from AGENT_RUNTIME_CAPABILITIES. */
  capabilities: readonly AgentRuntimeCapability[];
  /** Whether the runtime's dialect reports billable operations. */
  reportsOperations: boolean;
  pricing: AgentRuntimePricing;
}

// The registry itself (MODULE-INTERNAL data; read access is re-exported
// read-only through the contract). Prices moved verbatim from the W021
// adapters' interim constants (openai-assistants, langgraph, crewai,
// autogen, semantic-kernel) — see each adapter's costForUsage history.
const RUNTIMES: readonly AgentRuntimeDescriptor[] = [
  {
    provider: 'openai-assistants',
    label: 'OpenAI Assistants',
    capabilities: ['task-execution'],
    reportsOperations: false,
    pricing: {
      inputMinorPerMillion: 250,
      outputMinorPerMillion: 1_000,
      operationMinorPerThousand: null,
      currency: 'USD',
    },
  },
  {
    provider: 'langgraph',
    label: 'LangGraph',
    capabilities: ['task-execution'],
    reportsOperations: true,
    pricing: {
      inputMinorPerMillion: 250,
      outputMinorPerMillion: 1_000,
      operationMinorPerThousand: 20,
      currency: 'USD',
    },
  },
  {
    provider: 'crewai',
    label: 'CrewAI',
    capabilities: ['task-execution'],
    reportsOperations: true,
    pricing: {
      inputMinorPerMillion: 150,
      outputMinorPerMillion: 600,
      operationMinorPerThousand: 10_000,
      currency: 'USD',
    },
  },
  {
    provider: 'autogen',
    label: 'AutoGen',
    capabilities: ['task-execution'],
    reportsOperations: false,
    pricing: {
      inputMinorPerMillion: 300,
      outputMinorPerMillion: 900,
      operationMinorPerThousand: null,
      currency: 'USD',
    },
  },
  {
    provider: 'semantic-kernel',
    label: 'Semantic Kernel',
    capabilities: ['task-execution'],
    reportsOperations: true,
    pricing: {
      inputMinorPerMillion: 200,
      outputMinorPerMillion: 800,
      operationMinorPerThousand: 5_000,
      currency: 'USD',
    },
  },
] as const;

const BY_PROVIDER = new Map<string, AgentRuntimeDescriptor>(
  RUNTIMES.map((runtime) => [runtime.provider, runtime] as const),
);

/** Every canonical runtime in the registry, in registry order. */
export function listAgentRuntimes(): AgentRuntimeDescriptor[] {
  return RUNTIMES.map((runtime) => ({ ...runtime, capabilities: [...runtime.capabilities] }));
}

/** Look up one runtime; null when the registry carries no such entry. */
export function findAgentRuntime(provider: AgentRuntimeProvider): AgentRuntimeDescriptor | null {
  const found = BY_PROVIDER.get(provider);
  // A copy, never the live descriptor (the llm registry's findLlmModel rule).
  return found === undefined
    ? null
    : { ...found, capabilities: [...found.capabilities] };
}

/**
 * Internal invariant guard: a registry runtime must serve at least one
 * capability and its prices must be non-negative integers (the data is
 * static, but the guard keeps future edits honest — the llm registry's
 * `isValidModelDescriptor` discipline).
 */
export function isValidAgentRuntimeDescriptor(runtime: AgentRuntimeDescriptor): boolean {
  return (
    isAgentRuntimeProvider(runtime.provider) &&
    typeof runtime.label === 'string' &&
    runtime.label.length > 0 &&
    runtime.capabilities.length > 0 &&
    runtime.capabilities.every((capability) => isAgentRuntimeCapability(capability)) &&
    typeof runtime.reportsOperations === 'boolean' &&
    Number.isSafeInteger(runtime.pricing.inputMinorPerMillion) &&
    runtime.pricing.inputMinorPerMillion >= 0 &&
    Number.isSafeInteger(runtime.pricing.outputMinorPerMillion) &&
    runtime.pricing.outputMinorPerMillion >= 0 &&
    (runtime.pricing.operationMinorPerThousand === null ||
      (Number.isSafeInteger(runtime.pricing.operationMinorPerThousand) &&
        runtime.pricing.operationMinorPerThousand >= 0)) &&
    runtime.pricing.currency === 'USD'
  );
}

/**
 * Internal invariant guard: the registry covers exactly the canonical
 * provider vocabulary (policy.ts) with one descriptor each — the adapter
 * registry and the runtime registry can never drift apart.
 */
export function registryCoversVocabulary(): boolean {
  const providers = new Set(RUNTIMES.map((runtime) => runtime.provider));
  if (providers.size !== RUNTIMES.length) return false;
  return AGENT_RUNTIME_PROVIDERS.every((provider) => providers.has(provider));
}

// ---------------------------------------------------------------------------
// Deterministic cost accounting (the single source of cost truth — W035)
// ---------------------------------------------------------------------------

/** The usage shape cost accounting needs (structurally the adapters' WireUsage). */
export interface UsageForCost {
  inputTokens: number | null;
  outputTokens: number | null;
  operations: number | null;
}

/**
 * The deterministic integer-minor-unit cost of one dispatch's provider-
 * reported usage: usage × the registry runtime's list prices, ONE rounding
 * over the whole expression (the adapters' historical arithmetic, kept
 * byte-for-byte so previously recorded costs stay reproducible). Null
 * usage fields count as zero; failed dispatches report no usage and cost
 * nothing (the caller's discipline, unchanged from W021).
 */
export function agentRuntimeCostMinor(pricing: AgentRuntimePricing, usage: UsageForCost): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const operations = usage.operations ?? 0;
  const operationTerm =
    pricing.operationMinorPerThousand === null
      ? 0
      : (operations * pricing.operationMinorPerThousand) / 1_000;
  return Math.round(
    (input * pricing.inputMinorPerMillion + output * pricing.outputMinorPerMillion) / 1_000_000 +
      operationTerm,
  );
}
