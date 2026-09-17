// W048 — Provider Hot-Swap Verification: the recording fake transports.
//
// Two fakes implement the provider-neutral TRANSPORT ports (exported by
// the llm and agents contracts) and speak every provider's NATIVE wire
// dialect: for a hot-swap verification, "the same capability ran through
// provider X" must mean the adapter actually built X's request shape and
// parsed X's response shape — dialect realism, not a generic echo. Each
// fake records every request it receives so the suite can assert, per
// provider, that the wire body carried that provider's native markers
// (locks 28/24: the dialects live inside the gateways' adapters; the fakes
// only complete the loop the same way a real transport would).
//
// Security note (work-item brief §4): fake credential references are
// assembled from string FRAGMENTS at runtime — no realistic full token
// literal appears in source (GitHub push protection discipline).

import type {
  LlmTransport,
  LlmTransportReceipt,
  LlmTransportRequest,
} from '@/modules/llm/contract';
import type {
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
} from '@/modules/agents/contract';

// ---------------------------------------------------------------------------
// Fake credentials (fragment-assembled at runtime)
// ---------------------------------------------------------------------------

const CREDENTIAL_SCHEME = ['secret', 'store'].join('-');
const CREDENTIAL_PREFIX = [CREDENTIAL_SCHEME, 'byoa'].join('://');

/** An opaque secret-store reference — the credential VALUE never appears. */
export function fakeCredentialRef(provider: string, label: string): string {
  return [CREDENTIAL_PREFIX, provider, label].join('/');
}

// ---------------------------------------------------------------------------
// The fake LLM transport (seven provider dialects)
// ---------------------------------------------------------------------------

export interface FakeLlmContent {
  /** The canonical text every configured provider must return. */
  text?: string;
  /** The canonical vector every configured provider must return. */
  vector?: number[];
}

/**
 * Records every transport request and answers in the ADDRESSEE's native
 * dialect. Usage is deliberately provider-specific (each provider reports
 * its own token counts) so evidence (usage/cost/latency) differs per
 * provider while the CANONICAL result stays identical — exactly the split
 * the hot-swap property claims: provider identity lives in evidence,
 * semantics live in the canonical contract.
 */
export class RecordingLlmTransport implements LlmTransport {
  readonly requests: LlmTransportRequest[] = [];
  private readonly content = new Map<string, FakeLlmContent>();
  private counter = 0;

  /** Serve `content` (canonical) to every request addressed to `provider`. */
  serve(provider: string, content: FakeLlmContent): void {
    this.content.set(provider, content);
  }

  async send(request: LlmTransportRequest): Promise<LlmTransportReceipt> {
    this.requests.push(request);
    const content = this.content.get(request.provider) ?? {};
    this.counter += 1;
    const serial = String(this.counter).padStart(6, '0');
    const payload = this.nativePayload(request, content, serial);
    return {
      status: 'delivered',
      payload,
      providerExecutionId: this.nativeExecutionId(request.provider, serial),
      detail: null,
    };
  }

  /** The provider's own execution-id prefix (opaque outside the gateway). */
  private nativeExecutionId(provider: string, serial: string): string {
    const prefix = PROVIDER_ID_PREFIXES[provider] ?? 'x';
    return `${prefix}_${serial}`;
  }

  /** Builds the provider-NATIVE response payload for its adapter to parse. */
  private nativePayload(
    request: LlmTransportRequest,
    content: FakeLlmContent,
    serial: string,
  ): unknown {
    const text = content.text ?? 'The canonical answer.';
    const vector = content.vector ?? [0.5, 0.25, 0.125];
    // Per-provider usage: same semantic work, different provider metering.
    const usage = usageFor(request.provider, request.kind);
    switch (request.provider) {
      case 'anthropic':
        return request.kind === 'completion'
          ? {
              id: `msg_${serial}`,
              content: [{ type: 'text', text }],
              usage: { input_tokens: usage.input, output_tokens: usage.output },
            }
          : unsupportedEmbedding('anthropic');
      case 'google':
        return request.kind === 'completion'
          ? {
              responseId: `resp_${serial}`,
              candidates: [{ content: { parts: [{ text }] } }],
              usageMetadata: {
                promptTokenCount: usage.input,
                candidatesTokenCount: usage.output,
              },
            }
          : {
              responseId: `resp_${serial}`,
              embedding: { values: vector },
              usageMetadata: { tokenCount: usage.input },
            };
      case 'cohere':
        return request.kind === 'completion'
          ? {
              id: `coh_${serial}`,
              text,
              usage: { input_tokens: usage.input, output_tokens: usage.output },
            }
          : {
              id: `coh_${serial}`,
              embeddings: { float: [vector] },
              meta: { billed_units: { input_tokens: usage.input } },
            };
      case 'mistral':
        return request.kind === 'completion'
          ? {
              id: `mist_${serial}`,
              choices: [{ message: { content: text } }],
              usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
            }
          : {
              id: `mist_${serial}`,
              data: [{ embedding: vector }],
              usage: { prompt_tokens: usage.input },
            };
      default:
        // openai + the OpenAI-compatible providers (deepseek, groq)
        return request.kind === 'completion'
          ? {
              id: `chat_${serial}`,
              choices: [{ message: { content: text } }],
              usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
            }
          : {
              id: `emb_${serial}`,
              data: [{ embedding: vector }],
              usage: { prompt_tokens: usage.input },
            };
    }
  }
}

const PROVIDER_ID_PREFIXES: Record<string, string> = {
  openai: 'chat',
  anthropic: 'msg',
  google: 'resp',
  mistral: 'mist',
  cohere: 'coh',
  deepseek: 'chat',
  groq: 'chat',
};

/** Provider-specific metering for the same semantic work. */
function usageFor(provider: string, kind: 'completion' | 'embedding'): { input: number; output: number } {
  const table: Record<string, { input: number; output: number }> = {
    openai: { input: 1_100, output: 220 },
    anthropic: { input: 1_150, output: 210 },
    google: { input: 1_200, output: 200 },
    mistral: { input: 1_050, output: 230 },
    cohere: { input: 1_000, output: 240 },
    deepseek: { input: 980, output: 250 },
    groq: { input: 1_020, output: 260 },
  };
  const usage = table[provider] ?? { input: 1_000, output: 200 };
  return kind === 'embedding' ? { input: 24, output: 0 } : usage;
}

function unsupportedEmbedding(provider: string): never {
  throw new Error(
    `the fake ${provider} transport cannot embed — the registry carries no ${provider} embedding model`,
  );
}

// ---------------------------------------------------------------------------
// The fake agent-runtime transport (five runtime dialects)
// ---------------------------------------------------------------------------

export interface FakeAgentContent {
  /** The canonical verdict every configured runtime must return. */
  output?: unknown;
  summary?: string | null;
}

/**
 * Records every dispatch and answers in the ADDRESSED runtime's native
 * dialect. Like the llm fake: per-runtime usage metering differs (evidence
 * differs per runtime) while the canonical result stays identical.
 */
export class RecordingAgentRuntimeTransport implements AgentRuntimeTransport {
  readonly requests: AgentRuntimeTransportRequest[] = [];
  private readonly content = new Map<string, FakeAgentContent>();
  private counter = 0;

  /** Serve `content` (canonical) to every dispatch addressed to `runtime`. */
  serve(runtime: string, content: FakeAgentContent): void {
    this.content.set(runtime, content);
  }

  async send(request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    this.requests.push(request);
    const content = this.content.get(request.provider) ?? {};
    this.counter += 1;
    const serial = String(this.counter).padStart(6, '0');
    const output = content.output ?? { triaged: true };
    const summary = content.summary ?? null;
    const usage = agentUsageFor(request.provider);
    switch (request.provider) {
      case 'openai-assistants':
        return {
          status: 'delivered',
          payload: {
            id: `run_${serial}`,
            status: 'completed',
            summary,
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text:
                      typeof output === 'string'
                        ? output
                        : JSON.stringify(output),
                  },
                ],
              },
            ],
            usage: { input_tokens: usage.input, output_tokens: usage.output },
          },
          providerTaskId: `run_${serial}`,
          detail: null,
        };
      case 'langgraph':
        return {
          status: 'delivered',
          payload: {
            run_id: `lg_${serial}`,
            output: { result: output, summary },
            usage: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              steps: usage.operations,
            },
          },
          providerTaskId: `lg_${serial}`,
          detail: null,
        };
      case 'crewai':
        return {
          status: 'delivered',
          payload: {
            run_id: `crew_${serial}`,
            status: 'completed',
            result: output,
            summary,
            token_usage: {
              input_tokens: usage.input,
              output_tokens: usage.output,
              requests: usage.operations,
            },
          },
          providerTaskId: `crew_${serial}`,
          detail: null,
        };
      case 'autogen':
        return {
          status: 'delivered',
          payload: {
            id: `ag_${serial}`,
            summary,
            result: output,
            usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
          },
          providerTaskId: `ag_${serial}`,
          detail: null,
        };
      default: // semantic-kernel
        return {
          status: 'delivered',
          payload: {
            runId: `sk_${serial}`,
            output,
            summary,
            usage: {
              inputTokens: usage.input,
              outputTokens: usage.output,
              invocations: usage.operations,
            },
          },
          providerTaskId: `sk_${serial}`,
          detail: null,
        };
    }
  }
}

/** Per-runtime metering for the same semantic work (evidence, not semantics). */
function agentUsageFor(runtime: string): { input: number; output: number; operations: number } {
  const table: Record<string, { input: number; output: number; operations: number }> = {
    'openai-assistants': { input: 1_200, output: 800, operations: 3 },
    langgraph: { input: 1_300, output: 780, operations: 4 },
    crewai: { input: 1_250, output: 820, operations: 3 },
    autogen: { input: 1_180, output: 760, operations: 0 },
    'semantic-kernel': { input: 1_260, output: 790, operations: 5 },
  };
  return table[runtime] ?? { input: 1_200, output: 800, operations: 3 };
}
