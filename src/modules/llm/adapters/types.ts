// The canonical LLM adapter interface (MODULE-INTERNAL).
//
// One adapter per canonical provider (W034). Adapters are the ONLY place
// where provider-native request bodies and response payloads exist (lock
// 28: "AI/LLM providers are accessed only through the LLM Gateway";
// IMPLEMENTATION-STACK §6: provider SDKs may only be imported inside
// src/modules/llm/). Nothing in `adapters/` is exported through the module
// contract — the public surface speaks purely canonical types.
//
// Adapters are PURE (no database, no clock, no network): they translate
// canonical values into provider-native wire JSON and parse provider-native
// response JSON back into canonical values. Delivery is the transport
// port's job; persistence is the service's job. A provider response that
// cannot be normalized fails with the canonical
// `provider_malformed_response` — the service treats that as a failed
// attempt (evidence + failover), never as a fake success (the channels
// module's adapter discipline).

import type { LlmProvider } from '../registry';
import { LlmError } from '../errors';
import type { CanonicalLlmMessage } from '../types';

export function malformedResponse(message: string): LlmError {
  return new LlmError('provider_malformed_response', message);
}

/** The canonical input the adapter turns into a provider-native completion body. */
export interface WireCompletionInput {
  model: string;
  messages: CanonicalLlmMessage[];
  temperature: number | null;
  maxOutputTokens: number;
}

/** The canonical input the adapter turns into a provider-native embedding body. */
export interface WireEmbeddingInput {
  model: string;
  input: string;
}

export interface WireUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface WireCompletionResult {
  text: string;
  usage: WireUsage;
  providerExecutionId: string | null;
}

export interface WireEmbeddingResult {
  vector: number[];
  usage: WireUsage;
  providerExecutionId: string | null;
}

export interface LlmAdapter {
  readonly provider: LlmProvider;

  /** Canonical → provider-native completion request body (opaque outside this module). */
  buildCompletionRequest(input: WireCompletionInput): unknown;

  /** Canonical → provider-native embedding request body (opaque outside this module). */
  buildEmbeddingRequest(input: WireEmbeddingInput): unknown;

  /** Provider-native response payload → canonical completion result. */
  parseCompletionResponse(payload: unknown): WireCompletionResult;

  /** Provider-native response payload → canonical embedding result. */
  parseEmbeddingResponse(payload: unknown): WireEmbeddingResult;
}
