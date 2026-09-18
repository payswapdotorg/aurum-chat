// The canonical adapter registry (MODULE-INTERNAL).
//
// Exactly one adapter per canonical destination provider (the module's own
// DESTINATION_PROVIDERS vocabulary, W037). Adapters are private to the
// destinations module: the contract speaks only canonical types, so
// swapping a provider implementation (or adding one) never touches a
// domain contract (ADR-0015 provider independence).

import type { DestinationProvider } from '../types';
import { DestinationsError } from '../errors';
import type { DestinationAdapter } from './types';
import { airtableAdapter } from './airtable';
import { bigqueryAdapter } from './bigquery';
import { googleSheetsAdapter } from './google-sheets';
import { httpApiAdapter } from './http-api';
import { hubspotAdapter } from './hubspot';
import { lookerAdapter } from './looker';
import { netsuiteAdapter } from './netsuite';
import { powerBiAdapter } from './power-bi';
import { redshiftAdapter } from './redshift';
import { salesforceAdapter } from './salesforce';
import { snowflakeAdapter } from './snowflake';
import { tableauAdapter } from './tableau';
import { webhookAdapter } from './webhook';

const ADAPTERS: Record<DestinationProvider, DestinationAdapter> = {
  looker: lookerAdapter,
  tableau: tableauAdapter,
  'power-bi': powerBiAdapter,
  snowflake: snowflakeAdapter,
  bigquery: bigqueryAdapter,
  redshift: redshiftAdapter,
  salesforce: salesforceAdapter,
  hubspot: hubspotAdapter,
  netsuite: netsuiteAdapter,
  'google-sheets': googleSheetsAdapter,
  airtable: airtableAdapter,
  'http-api': httpApiAdapter,
  webhook: webhookAdapter,
};

/** The adapter of a canonical provider (never null — the vocabulary is closed). */
export function getDestinationAdapter(provider: string): DestinationAdapter {
  const adapter = (ADAPTERS as Record<string, DestinationAdapter | undefined>)[provider];
  if (adapter === undefined) {
    throw new DestinationsError(
      'unsupported_provider',
      `unsupported destination provider '${provider}'`,
    );
  }
  return adapter;
}

/** Every canonical provider has an adapter (exhaustiveness guard). */
export function allDestinationAdapters(): DestinationAdapter[] {
  return Object.values(ADAPTERS);
}
