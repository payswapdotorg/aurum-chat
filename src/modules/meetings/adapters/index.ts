// The canonical adapter registry (MODULE-INTERNAL).
//
// Exactly one adapter per canonical meeting provider (the module's own
// MEETING_PROVIDERS vocabulary, W085). Adapters are private to the
// meetings module: the contract speaks only canonical types, so swapping a
// provider implementation (or adding one) never touches a domain contract.

import type { MeetingProvider } from '../types';
import { MeetingsError } from '../errors';
import type { MeetingAdapter } from './types';
import { googleMeetAdapter } from './google-meet';
import { microsoftTeamsAdapter } from './microsoft-teams';
import { recallAdapter } from './recall';
import { zoomAdapter } from './zoom';

const ADAPTERS: Record<MeetingProvider, MeetingAdapter> = {
  zoom: zoomAdapter,
  'microsoft-teams': microsoftTeamsAdapter,
  'google-meet': googleMeetAdapter,
  recall: recallAdapter,
};

/** The adapter of a canonical provider (never null — the vocabulary is closed). */
export function getMeetingAdapter(provider: string): MeetingAdapter {
  const adapter = (ADAPTERS as Record<string, MeetingAdapter | undefined>)[provider];
  if (adapter === undefined) {
    throw new MeetingsError('unsupported_provider', `unsupported meeting provider '${provider}'`);
  }
  return adapter;
}

/** Every canonical provider has an adapter (exhaustiveness guard). */
export function allMeetingAdapters(): MeetingAdapter[] {
  return Object.values(ADAPTERS);
}
