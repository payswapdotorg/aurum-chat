// The canonical agent-runtime adapter interface (MODULE-INTERNAL).
//
// One adapter per canonical runtime provider (W021; the agents
// counterpart of the llm module's LlmAdapter). Adapters are the ONLY
// place where provider-native task bodies and result payloads exist
// (lock 24: "Agent providers/runtimes are hidden behind the Agent
// Gateway"; IMPLEMENTATION-STACK §6: provider SDKs may only be imported
// inside src/modules/agents/). Nothing in `adapters/` is exported through
// the module contract — the public surface speaks purely canonical types.
//
// Adapters are PURE (no database, no clock, no network): they translate
// canonical values into provider-native wire JSON and parse
// provider-native response JSON back into canonical values. Delivery is
// the transport port's job; persistence is the service's job. A runtime
// response that cannot be normalized fails with the canonical
// `provider_malformed_response` — the service treats that as a
// NON-retryable failed attempt (evidence), never as a fake success (the
// llm module's adapter discipline).
//
// Pricing: `costForUsage` is the deterministic integer-minor-unit cost of
// provider-reported usage. It lives with the adapter because only the
// adapter understands its provider's billable units — the interim home
// until W035 (Agent Provider Registry) centralizes runtime reference
// data, exactly like the llm registry owns model list prices.

import type { AgentRuntimeProvider } from '../policy';
import { AgentsError } from '../errors';

export function malformedResponse(message: string): AgentsError {
  return new AgentsError('provider_malformed_response', message);
}

export function invalidRuntimeConfig(message: string): AgentsError {
  return new AgentsError('invalid_runtime_config', message);
}

/** The canonical input the adapter turns into a provider-native task body. */
export interface WireTaskInput {
  /** Adapter-resolved provider-side agent reference (assistant id, crew name, …). */
  runtimeAgentRef: string;
  /** The agent definition's operating contract (instructions). */
  instructions: string;
  /** The canonical task payload (plain JSON). */
  task: unknown;
  /** The permission scopes the execution operates at. */
  requestedPermissions: string[];
}

/** Provider-reported usage, normalized (null = the runtime does not report it). */
export interface WireUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  operations: number | null;
}

/** The canonical result the adapter parses a runtime response into. */
export interface WireTaskResult {
  /** The agent's output — plain JSON. */
  output: unknown;
  /** One-line human-readable summary, when the runtime reports one. */
  summary: string | null;
  usage: WireUsage;
  /** The runtime's own task/run id (opaque string), when it returns one. */
  providerTaskId: string | null;
}

export interface AgentRuntimeAdapter {
  readonly provider: AgentRuntimeProvider;

  /**
   * Extract the provider-side agent reference from the tenant's OPAQUE
   * runtime configuration (e.g. an OpenAI assistant id, a LangGraph
   * assistant id, a CrewAI crew name). Throws `invalid_runtime_config`
   * when the configuration does not carry a usable reference — a loud
   * failure before any dispatch happens.
   */
  resolveRuntimeAgentRef(runtimeConfig: unknown): string;

  /** Canonical → provider-native task request body (opaque outside this module). */
  buildTaskRequest(input: WireTaskInput): unknown;

  /** Provider-native response payload → canonical task result. */
  parseTaskResult(payload: unknown): WireTaskResult;

  /** Deterministic integer-minor-unit (USD) cost of provider-reported usage. */
  costForUsage(usage: WireUsage): number;
}
