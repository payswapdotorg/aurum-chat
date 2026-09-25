// The canonical telecom-adapter registry (MODULE-INTERNAL).
//
// Exactly one adapter per canonical telecom provider. Adapters are
// private to the cellular module: the contract speaks only canonical
// types, so swapping a vendor implementation (or adding one) never
// touches a domain contract (W087 acceptance property — "multiple
// telecom adapters"; the realtime module's adapter-registry discipline).

import { CellularError } from '../errors';
import type { CellularProvider } from '../types';
import type { CellularAdapter } from './types';
import { telnyxAdapter } from './telnyx';
import { twilioAdapter } from './twilio';

const ADAPTERS: Record<CellularProvider, CellularAdapter> = {
  twilio: twilioAdapter,
  telnyx: telnyxAdapter,
};

/** The adapter of a canonical telecom provider (never null — the vocabulary is closed). */
export function getCellularAdapter(provider: string): CellularAdapter {
  const adapter = (ADAPTERS as Record<string, CellularAdapter | undefined>)[provider];
  if (adapter === undefined) {
    throw new CellularError(
      'invalid_cellular_input',
      `unsupported telecom provider '${provider}'`,
    );
  }
  return adapter;
}

/** Every canonical telecom provider has an adapter (exhaustiveness guard). */
export function allCellularAdapters(): CellularAdapter[] {
  return Object.values(ADAPTERS);
}
