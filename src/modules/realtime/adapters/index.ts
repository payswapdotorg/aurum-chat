// The canonical adapter registry (MODULE-INTERNAL).
//
// Exactly one adapter per canonical realtime transport provider (the
// module's own REALTIME_PROVIDERS vocabulary, W086). Adapters are private
// to the realtime module: the contract speaks only canonical types, so
// swapping a transport provider (or adding one) never touches a domain
// contract — the W086 acceptance property "transport provider can be
// swapped without domain rewrite".

import { RealtimeError } from '../errors';
import type { RealtimeProvider } from '../types';
import { livekitAdapter } from './livekit';
import { openaiRealtimeAdapter } from './openai-realtime';
import type { RealtimeAdapter } from './types';

const ADAPTERS: Record<RealtimeProvider, RealtimeAdapter> = {
  livekit: livekitAdapter,
  'openai-realtime': openaiRealtimeAdapter,
};

/** The adapter of a canonical provider (never null — the vocabulary is closed). */
export function getRealtimeAdapter(provider: string): RealtimeAdapter {
  const adapter = (ADAPTERS as Record<string, RealtimeAdapter | undefined>)[provider];
  if (adapter === undefined) {
    throw new RealtimeError('unsupported_provider', `unsupported realtime provider '${provider}'`);
  }
  return adapter;
}

/** Every canonical provider has an adapter (exhaustiveness guard). */
export function allRealtimeAdapters(): RealtimeAdapter[] {
  return Object.values(ADAPTERS);
}
