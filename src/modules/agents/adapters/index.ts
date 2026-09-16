// The canonical agent-runtime adapter registry (MODULE-INTERNAL).
//
// Exactly one adapter per canonical runtime provider (the agents module's
// vocabulary, policy.ts). Adapters are private to the agents module: the
// contract speaks only canonical types, so swapping a runtime (or adding
// one) never touches a domain contract — the provider-replacement
// property W021 must demonstrate and W035/W048 will build on.

import type { AgentRuntimeProvider } from '../policy';
import { AGENT_RUNTIME_PROVIDERS } from '../policy';
import { AgentsError } from '../errors';
import { autogenAdapter } from './autogen';
import { crewaiAdapter } from './crewai';
import { langgraphAdapter } from './langgraph';
import { openaiAssistantsAdapter } from './openai-assistants';
import { semanticKernelAdapter } from './semantic-kernel';
import type { AgentRuntimeAdapter } from './types';

const ADAPTERS: Record<AgentRuntimeProvider, AgentRuntimeAdapter> = {
  'openai-assistants': openaiAssistantsAdapter,
  langgraph: langgraphAdapter,
  crewai: crewaiAdapter,
  autogen: autogenAdapter,
  'semantic-kernel': semanticKernelAdapter,
};

/** The adapter of a canonical runtime provider (never null — the vocabulary is closed). */
export function getAgentRuntimeAdapter(provider: string): AgentRuntimeAdapter {
  const adapter = (ADAPTERS as Record<string, AgentRuntimeAdapter | undefined>)[provider];
  if (adapter === undefined) {
    throw new AgentsError('unsupported_provider', `unsupported agent runtime provider '${provider}'`);
  }
  return adapter;
}

/** Every canonical runtime provider has an adapter (exhaustiveness guard). */
export function allAgentRuntimeAdapters(): AgentRuntimeAdapter[] {
  return AGENT_RUNTIME_PROVIDERS.map((provider) => ADAPTERS[provider]);
}
