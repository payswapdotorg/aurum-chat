// D1-LIVE — the REAL provider transports for the first post-certification
// opt-in: upgrading certification demonstration D1 (provider/model swap)
// from FIXTURE (two-path) to LIVE — two REAL provider accounts (OpenRouter
// + Alibaba DashScope International) through the real W132 provider-fabric
// and the real W021 execution seam.
//
// TEST-SUPPORT MODULE (no production code): it implements exactly the two
// seams the architecture sanctions for infrastructure wiring —
//
//   1. FabricDiscoveryTransport (the W132 discovery port,
//      setFabricDiscoveryTransport): GET {baseUrl}/models per provider (the
//      OpenAI-compatible wire protocol's model-listing endpoint), mapped
//      into the fabric's provider-neutral FabricDiscoveredModelSample
//      shape. The listing is REAL network; the samples handed to the fabric
//      are filtered to the run's VERIFIED model ids (cost/behavior
//      discipline — the full provider listing is COUNTED for the artifact,
//      not cataloged row by row).
//
//   2. AgentRuntimeTransport (the W021 execution port, setAgentTransport):
//      a PURE ROUTER over the route the composition boundary resolved
//      OUTSIDE the dispatch — the agents service invokes transport.send
//      INSIDE its open dispatch transaction, and its own law is explicit
//      ("a base-connection read inside an open transaction would starve
//      the embedded database's single connection"). The router therefore
//      NEVER queries the DB inside send: buildLiveAgentRouter exposes
//      refreshRoute(ctx), which resolves the tenant's ACTIVE cognition
//      binding through the provider-fabric contract on the base
//      connection (outside any dispatch) and caches {endpoint, modelId};
//      the executor refreshes the route before each dispatch (the
//      composition boundary's duty — the fabric supplies definitions/
//      catalogs/bindings and never invokes models; whoever executes
//      resolves the binding and routes). send() then POSTs
//      {baseUrl}/chat/completions with the cached route and adapts the
//      OpenAI-compatible response into the openai-assistants dialect the
//      agents module's own adapter normalizes (id, status 'completed',
//      output[0] message with output_text, summary, usage{input_tokens,
//      output_tokens}). The chat/completions → assistants-dialect
//      adaptation happens at the transport edge — the sanctioned seam; the
//      canonical W021 contract carries only normalized results.
//
// HONESTY RULES (binding): API keys NEVER appear in observations, logs or
// artifacts — keyFingerprint() carries the last four characters only; every
// observation records endpoints, model ids, HTTP statuses, token counts and
// latencies, nothing credential-shaped.

import { createHash } from 'node:crypto';
import type { TenantContext } from '@/infra/tenant';
import type {
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
} from '@/modules/agents/contract';
import {
  getActiveModelBinding,
  getProviderDefinition,
} from '@/modules/provider-fabric/contract';
import type {
  FabricDiscoveredModelSample,
  FabricDiscoveryReceipt,
  FabricDiscoveryRequest,
  FabricDiscoveryTransport,
} from '@/modules/provider-fabric/contract';

// ---------------------------------------------------------------------------
// The two LIVE provider endpoints (verified working from this sandbox)
// ---------------------------------------------------------------------------

export interface LiveProviderEndpoint {
  /** The custom-definition slug the journey registers under (must not collide with the W034 vocabulary). */
  readonly providerSlug: string;
  /** The definition label shown in binding swap evidence. */
  readonly label: string;
  /** The REAL OpenAI-compatible base URL. */
  readonly baseUrl: string;
  /** The REAL account credential — never printed, never persisted, fingerprint only. */
  readonly apiKey: string;
  /** The model ids this run verified as live-compliant (discovery filters to these). */
  readonly verifiedModelIds: readonly string[];
}

export function openRouterEndpoint(apiKey: string): LiveProviderEndpoint {
  return {
    providerSlug: 'openrouter',
    label: 'OpenRouter (LIVE)',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    verifiedModelIds: [
      'meta-llama/llama-3.1-8b-instruct',
      'qwen/qwen-2.5-7b-instruct',
    ],
  };
}

export function dashscopeIntlEndpoint(apiKey: string): LiveProviderEndpoint {
  return {
    providerSlug: 'dashscope-intl',
    label: 'Alibaba DashScope International (LIVE)',
    // The INTERNATIONAL endpoint — the China endpoint (dashscope.aliyuncs.com)
    // rejects this credential with invalid_api_key.
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey,
    verifiedModelIds: ['qwen3.8-omni-flash'],
  };
}

/** Last four characters only — the fingerprint discipline (never the value). */
export function keyFingerprint(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// The REAL discovery transport (the W132 seam)
// ---------------------------------------------------------------------------

/** What one REAL discovery probe observed — no secrets, counts and statuses only. */
export interface LiveDiscoveryObservation {
  readonly baseUrl: string;
  readonly httpStatus: number | null;
  /** How many models the provider's listing endpoint reported in total. */
  readonly rawListedModelCount: number | null;
  /** Which of the verified model ids the REAL listing actually contained. */
  readonly verifiedModelsFound: readonly string[];
  readonly detail: string;
}

/** The OpenAI-compatible models-listing entry shape (the wire protocol both providers speak). */
interface WireModelListingEntry {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly context_length?: unknown;
  readonly pricing?: unknown;
}

export function buildLiveDiscoveryTransport(
  endpoints: readonly LiveProviderEndpoint[],
  observations: LiveDiscoveryObservation[],
): FabricDiscoveryTransport {
  const byBaseUrl = new Map(endpoints.map((endpoint) => [endpoint.baseUrl, endpoint]));
  return {
    listModels: async (request: FabricDiscoveryRequest): Promise<FabricDiscoveryReceipt> => {
      const endpoint = request.baseUrl === null ? null : byBaseUrl.get(request.baseUrl) ?? null;
      if (endpoint === null) {
        const detail = `no LIVE provider is wired for base url '${request.baseUrl ?? '(none)'}' — the D1-LIVE transport serves exactly the two registered endpoints`;
        observations.push({
          baseUrl: request.baseUrl ?? '(none)',
          httpStatus: null,
          rawListedModelCount: null,
          verifiedModelsFound: [],
          detail,
        });
        return { status: 'failed', models: [], detail };
      }
      let httpStatus: number | null = null;
      try {
        const response = await fetch(`${endpoint.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${endpoint.apiKey}` },
          signal: AbortSignal.timeout(45_000),
        });
        httpStatus = response.status;
        if (!response.ok) {
          const detail = `LIVE listing at ${endpoint.baseUrl}/models returned HTTP ${response.status}`;
          observations.push({
            baseUrl: endpoint.baseUrl,
            httpStatus,
            rawListedModelCount: null,
            verifiedModelsFound: [],
            detail,
          });
          return { status: 'failed', models: [], detail };
        }
        const body = (await response.json()) as { data?: unknown };
        const listed: readonly WireModelListingEntry[] = Array.isArray(body.data)
          ? (body.data as WireModelListingEntry[])
          : [];
        // REAL discovery: the provider's own listing decides what exists.
        // The fabric catalog retains the VERIFIED models (cost discipline —
        // the full listing is counted, not cataloged).
        const verified = new Set(endpoint.verifiedModelIds);
        const models: FabricDiscoveredModelSample[] = [];
        const found: string[] = [];
        for (const entry of listed) {
          if (typeof entry.id !== 'string' || !verified.has(entry.id)) continue;
          found.push(entry.id);
          models.push({
            modelId: entry.id,
            displayName: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : null,
            capabilities: ['text-generation'],
            contextWindowTokens:
              typeof entry.context_length === 'number' && Number.isSafeInteger(entry.context_length) && entry.context_length > 0
                ? entry.context_length
                : null,
            maxOutputTokens: null,
            priceInputMinorPerMillion: minorPerMillion(entry.pricing, 'prompt'),
            priceOutputMinorPerMillion: minorPerMillion(entry.pricing, 'completion'),
          });
        }
        const detail =
          `LIVE listing at ${endpoint.baseUrl}/models: ${listed.length} models reported by the provider, ` +
          `${models.length} verified model(s) mapped into the fabric catalog`;
        observations.push({
          baseUrl: endpoint.baseUrl,
          httpStatus,
          rawListedModelCount: listed.length,
          verifiedModelsFound: found,
          detail,
        });
        return { status: 'succeeded', models, detail };
      } catch (error) {
        const detail = `LIVE listing at ${endpoint.baseUrl}/models failed: ${(error as Error).message}`;
        observations.push({
          baseUrl: endpoint.baseUrl,
          httpStatus,
          rawListedModelCount: null,
          verifiedModelsFound: [],
          detail,
        });
        return { status: 'failed', models: [], detail };
      }
    },
  };
}

/** OpenRouter reports per-token USD prices as decimal strings; minor units per million tokens, or null when absent. */
function minorPerMillion(pricing: unknown, field: 'prompt' | 'completion'): number | null {
  if (typeof pricing !== 'object' || pricing === null) return null;
  const value = (pricing as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.trim() === '') return null;
  const perToken = Number.parseFloat(value);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  const minor = Math.round(perToken * 1_000_000 * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

// ---------------------------------------------------------------------------
// The REAL agent execution transport (the W021 seam)
// ---------------------------------------------------------------------------

/** What one REAL dispatch observed — no secrets, ids/counts/latencies only. */
export interface LiveExecutionObservation {
  readonly endpointBaseUrl: string | null;
  readonly modelId: string | null;
  readonly httpStatus: number | null;
  readonly providerTaskId: string | null;
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null } | null;
  readonly latencyMs: number | null;
  readonly completionChars: number | null;
  readonly error: string | null;
}

/** The max_tokens bound per call — the cost discipline (tiny completions only). */
export const LIVE_MAX_TOKENS = 64;

export interface LiveAgentRouter {
  /** The W021 seam wiring (a PURE ROUTER — no DB access inside send). */
  readonly transport: AgentRuntimeTransport;
  /**
   * Resolves the tenant's ACTIVE cognition binding through the fabric
   * contract ON THE BASE CONNECTION — the composition boundary's duty,
   * OUTSIDE any dispatch transaction (the agents service invokes
   * transport.send inside its open dispatch transaction; a base-connection
   * read there would starve the embedded database's single connection).
   * The executor calls this before each dispatch; send() routes on the
   * cached result.
   */
  refreshRoute(ctx: TenantContext): Promise<void>;
}

export function buildLiveAgentRouter(
  endpoints: readonly LiveProviderEndpoint[],
  observations: LiveExecutionObservation[],
): LiveAgentRouter {
  const byBaseUrl = new Map(endpoints.map((endpoint) => [endpoint.baseUrl, endpoint]));
  let route: { endpoint: LiveProviderEndpoint; modelId: string } | null = null;
  return {
    refreshRoute: async (ctx: TenantContext) => {
      const binding = await getActiveModelBinding(ctx, { purpose: 'cognition' });
      if (binding === null) {
        route = null;
        return;
      }
      const definition = await getProviderDefinition(ctx, { definitionId: binding.definitionId });
      const endpoint = definition.baseUrl === null ? null : byBaseUrl.get(definition.baseUrl) ?? null;
      route = endpoint === null ? null : { endpoint, modelId: binding.modelId };
    },
    transport: {
      send: async (request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> => {
        const startedAt = Date.now();
        const observe = (
          partial: Omit<LiveExecutionObservation, 'latencyMs'>,
        ): LiveExecutionObservation => ({
          ...partial,
          latencyMs: Date.now() - startedAt,
        });
        if (route === null) {
          const detail =
            'no LIVE route cached — the executor must refreshRoute(ctx) on the base connection before each dispatch (the composition boundary resolves the binding; the transport never queries the DB inside the dispatch transaction)';
          observations.push(observe({
            endpointBaseUrl: null, modelId: null, httpStatus: null, providerTaskId: null,
            usage: null, completionChars: null, error: detail,
          }));
          return { status: 'failed', payload: null, providerTaskId: null, detail };
        }
        const { endpoint, modelId } = route;
        const endpointBaseUrl: string | null = endpoint.baseUrl;
        try {
          const instruction = extractUserInstruction(request);
        const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${endpoint.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: LIVE_MAX_TOKENS,
            messages: [{ role: 'user', content: instruction }],
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          const detail = `LIVE chat/completions at ${endpoint.baseUrl} returned HTTP ${response.status}`;
          observations.push(observe({
            endpointBaseUrl, modelId, httpStatus: response.status, providerTaskId: null,
            usage: null, completionChars: null, error: detail,
          }));
          return { status: 'failed', payload: null, providerTaskId: null, detail };
        }
        const completion = (await response.json()) as {
          id?: unknown;
          choices?: unknown;
          usage?: unknown;
        };
        const choices = Array.isArray(completion.choices) ? completion.choices : [];
        const first = isRecord(choices[0]) ? choices[0] : null;
        const message = first !== null && isRecord(first.message) ? first.message : null;
        const content = message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          const detail = 'the LIVE completion carried no message content (choices[0].message.content missing or empty)';
          observations.push(observe({
            endpointBaseUrl, modelId, httpStatus: response.status,
            providerTaskId: typeof completion.id === 'string' ? completion.id : null,
            usage: wireUsage(completion.usage), completionChars: null, error: detail,
          }));
          return { status: 'failed', payload: null, providerTaskId: null, detail };
        }
        const providerTaskId = typeof completion.id === 'string' && completion.id.trim() !== '' ? completion.id.trim() : null;
        const usage = wireUsage(completion.usage);
        // The adaptation into the openai-assistants dialect — the module's
        // own adapter normalizes this shape into the canonical W021
        // contract (id, status 'completed', output[0] message with
        // output_text, summary, usage{input_tokens, output_tokens}).
        const payload = {
          id: providerTaskId,
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: content }],
            },
          ],
          summary: `LIVE completion via ${endpoint.providerSlug}/${modelId} at ${endpoint.baseUrl} (chat/completions adapted at the transport edge)`,
          usage: {
            input_tokens: usage?.inputTokens ?? undefined,
            output_tokens: usage?.outputTokens ?? undefined,
          },
        };
        observations.push(observe({
          endpointBaseUrl, modelId, httpStatus: response.status, providerTaskId,
          usage, completionChars: content.length, error: null,
        }));
        return { status: 'delivered', payload, providerTaskId, detail: null };
        } catch (error) {
          const detail = `the LIVE dispatch failed: ${(error as Error).message}`;
          observations.push(observe({
            endpointBaseUrl, modelId, httpStatus: null, providerTaskId: null,
            usage: null, completionChars: null, error: detail,
          }));
          return { status: 'failed', payload: null, providerTaskId: null, detail };
        }
      },
    },
  };
}

/** The usage block of an OpenAI-compatible chat completion, when present. */
function wireUsage(
  usage: unknown,
): { inputTokens: number | null; outputTokens: number | null } | null {
  if (!isRecord(usage)) return null;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  return {
    inputTokens: typeof prompt === 'number' && Number.isSafeInteger(prompt) && prompt >= 0 ? prompt : null,
    outputTokens:
      typeof completion === 'number' && Number.isSafeInteger(completion) && completion >= 0 ? completion : null,
  };
}

/**
 * Extracts the human instruction from the adapter-built task body (the
 * openai-assistants dialect: input[0].content carries the JSON-serialized
 * W021 task {instruction, context}; instructions carries the agent
 * definition's standing orders). The LIVE dispatch sends the task, falling
 * back to the standing orders — never the serialized envelope.
 */
function extractUserInstruction(request: AgentRuntimeTransportRequest): string {
  const body = isRecord(request.body) ? request.body : null;
  const input = body !== null && Array.isArray(body.input) ? body.input : [];
  const first = isRecord(input[0]) ? input[0] : null;
  const content = first !== null && typeof first.content === 'string' ? first.content : '';
  let instruction = '';
  let context = '';
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && isRecord(parsed.task)) {
      if (typeof parsed.task.instruction === 'string') instruction = parsed.task.instruction.trim();
      if (typeof parsed.task.context === 'string') context = parsed.task.context.trim();
    }
  } catch {
    // Prose content — the task text IS the content.
    instruction = content.trim();
  }
  if (instruction === '' && body !== null && typeof body.instructions === 'string') {
    instruction = body.instructions.trim();
  }
  if (instruction === '') instruction = content.trim();
  return context === '' ? instruction : `${instruction}\n\nTask context: ${context}`;
}

// ---------------------------------------------------------------------------
// The canonical-marker outcome normalization
// ---------------------------------------------------------------------------

export interface D1LiveDomainOutcome {
  readonly delivered: boolean;
  readonly marker: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outcomeFromRecord(value: Record<string, unknown>): D1LiveDomainOutcome | null {
  if (value.delivered === true && typeof value.marker === 'string' && value.marker.trim() !== '') {
    return { delivered: true, marker: value.marker.trim() };
  }
  return null;
}

/**
 * Normalizes a W021 execution result's domain outcome: the canonical marker
 * JSON {"delivered":true,"marker":"D1-LIVE-COMPLETE"} — directly when the
 * adapter already parsed it, else extracted from the completion text with a
 * JSON-substring scan (tolerating surrounding prose or code fences).
 * Null when the outcome is not the canonical marker.
 */
export function normalizeDomainOutcome(output: unknown): D1LiveDomainOutcome | null {
  if (isRecord(output)) {
    const direct = outcomeFromRecord(output);
    if (direct !== null) return direct;
  }
  if (typeof output === 'string') {
    try {
      const parsed: unknown = JSON.parse(output);
      if (isRecord(parsed)) {
        const exact = outcomeFromRecord(parsed);
        if (exact !== null) return exact;
      }
    } catch {
      // Prose — fall through to the substring scan.
    }
    for (const candidate of output.match(/\{[^{}]*\}/g) ?? []) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (isRecord(parsed)) {
          const scan = outcomeFromRecord(parsed);
          if (scan !== null) return scan;
        }
      } catch {
        // Not JSON — next candidate.
      }
    }
  }
  return null;
}

/** The deterministic body-record hash (serialize + sha256) for the byte-for-byte swap proof. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
