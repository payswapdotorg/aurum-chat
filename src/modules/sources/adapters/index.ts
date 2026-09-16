// The canonical adapter registry (MODULE-INTERNAL).
//
// Exactly one adapter per canonical source provider (the module's own
// SOURCE_PROVIDERS vocabulary, W036). Adapters are private to the sources
// module: the contract speaks only canonical types, so swapping a provider
// implementation (or adding one) never touches a domain contract.

import type { SourceProvider } from '../types';
import { SourcesError } from '../errors';
import type { SourceAdapter } from './types';
import { confluenceAdapter } from './confluence';
import { githubAdapter } from './github';
import { googleCalendarAdapter } from './google-calendar';
import { googleDriveAdapter } from './google-drive';
import { hubspotAdapter } from './hubspot';
import { jiraAdapter } from './jira';
import { linearAdapter } from './linear';
import { notionAdapter } from './notion';
import { quickbooksAdapter } from './quickbooks';
import { salesforceAdapter } from './salesforce';
import { stripeAdapter } from './stripe';
import { zendeskAdapter } from './zendesk';
import { zapierAdapter } from './zapier';

const ADAPTERS: Record<SourceProvider, SourceAdapter> = {
  salesforce: salesforceAdapter,
  hubspot: hubspotAdapter,
  zendesk: zendeskAdapter,
  jira: jiraAdapter,
  linear: linearAdapter,
  confluence: confluenceAdapter,
  notion: notionAdapter,
  github: githubAdapter,
  'google-drive': googleDriveAdapter,
  'google-calendar': googleCalendarAdapter,
  stripe: stripeAdapter,
  quickbooks: quickbooksAdapter,
  zapier: zapierAdapter,
};

/** The adapter of a canonical provider (never null — the vocabulary is closed). */
export function getSourceAdapter(provider: string): SourceAdapter {
  const adapter = (ADAPTERS as Record<string, SourceAdapter | undefined>)[provider];
  if (adapter === undefined) {
    throw new SourcesError('unsupported_provider', `unsupported source provider '${provider}'`);
  }
  return adapter;
}

/** Every canonical provider has an adapter (exhaustiveness guard). */
export function allSourceAdapters(): SourceAdapter[] {
  return Object.values(ADAPTERS);
}
