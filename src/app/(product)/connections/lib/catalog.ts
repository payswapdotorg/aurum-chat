// Connection & Integration Hub (W059) — the connector catalog.
//
// The catalog maps the CANONICAL provider vocabularies owned by the domain
// modules (identity's CHANNEL_PROVIDERS, sources' SOURCE_PROVIDERS,
// destinations' DESTINATION_PROVIDERS/CATEGORIES) onto display metadata for
// the connections center: a human label, a one-line description of what the
// connector is, and what the tenant supplies to connect it. It is pure data
// plus pure lookups — no I/O, no provider SDKs, no provider objects (lock 16:
// providers appear only as the neutral keys the contracts already own).
//
// CREDENTIAL DISCIPLINE (acceptance: "tenant-owned credential references
// only"): every catalog entry documents that the connect flow takes an OPAQUE
// secret-store reference (`credentialRef`), never a credential value. The
// catalog itself carries no credential fields at all.

import {
  CHANNEL_PROVIDERS,
  type ChannelProvider,
} from '@/modules/identity/contract';
import {
  SOURCE_PROVIDERS,
  type SourceProvider,
} from '@/modules/sources/contract';
import {
  DESTINATION_CATEGORIES,
  DESTINATION_PROVIDERS,
  type DestinationCategory,
  type DestinationProvider,
} from '@/modules/destinations/contract';

export type { ChannelProvider, SourceProvider, DestinationProvider, DestinationCategory };

/** How the tenant authorizes the connector (non-secret classification). */
export type AuthKind = 'oauth' | 'credentials';

/** One catalog entry — everything the UI needs to render a connect target. */
export interface CatalogEntry {
  /** The canonical provider key owned by the domain module's contract. */
  key: string;
  /** Human label (title case). */
  label: string;
  /** One line: what this connector is. */
  description: string;
  /** What the tenant supplies as `providerAccountId` (display hint only). */
  accountIdHint: string;
  /** Authorization classification this provider expects. */
  authKind: AuthKind;
}

const CHANNEL_DESCRIPTIONS: Record<ChannelProvider, [string, string, AuthKind]> = {
  whatsapp: ['WhatsApp business number the tenant sends and receives through', 'business number (E.164)', 'oauth'],
  telegram: ['Telegram bot the tenant operates', 'bot id', 'credentials'],
  signal: ['Signal sending endpoint', 'account number (E.164)', 'credentials'],
  slack: ['Slack workspace app the tenant installs', 'team id', 'oauth'],
  x: ['X (Twitter) account the tenant sends through', 'handle', 'oauth'],
  instagram: ['Instagram business account', 'account id', 'oauth'],
  facebook: ['Facebook Page / Messenger endpoint', 'page id', 'oauth'],
  linkedin: ['LinkedIn organization presence', 'organization id', 'oauth'],
  email: ['Inbound/outbound mailbox', 'mailbox address', 'credentials'],
  sms: ['SMS sending endpoint', 'number (E.164)', 'credentials'],
  voice: ['Voice endpoint', 'number (E.164)', 'credentials'],
  web: ['Web chat endpoint', 'site id', 'credentials'],
};

const SOURCE_DESCRIPTIONS: Record<SourceProvider, [string, string, AuthKind]> = {
  salesforce: ['Salesforce org (CRM records)', 'org id', 'oauth'],
  hubspot: ['HubSpot portal (CRM records)', 'portal id', 'oauth'],
  zendesk: ['Zendesk instance (support tickets)', 'subdomain', 'oauth'],
  jira: ['Jira site (work items)', 'site id', 'oauth'],
  linear: ['Linear workspace (work items)', 'workspace key', 'oauth'],
  confluence: ['Confluence site (documents)', 'site id', 'oauth'],
  notion: ['Notion workspace (documents)', 'workspace id', 'oauth'],
  github: ['GitHub org (repos, issues, activity)', 'org login', 'oauth'],
  'google-drive': ['Google Drive (documents)', 'account id', 'oauth'],
  'google-calendar': ['Google Calendar (events)', 'calendar id', 'oauth'],
  stripe: ['Stripe account (payments data)', 'account id', 'oauth'],
  quickbooks: ['QuickBooks company (finance data)', 'company id', 'oauth'],
  zapier: ['Zapier integration feeds', 'integration id', 'credentials'],
};

const DESTINATION_DESCRIPTIONS: Record<DestinationProvider, [string, string, AuthKind]> = {
  looker: ['Looker instance (BI)', 'instance id', 'oauth'],
  tableau: ['Tableau site (BI)', 'site id', 'oauth'],
  'power-bi': ['Power BI workspace (BI)', 'workspace id', 'oauth'],
  snowflake: ['Snowflake database (warehouse)', 'database id', 'oauth'],
  bigquery: ['BigQuery dataset (warehouse)', 'dataset id', 'oauth'],
  redshift: ['Redshift cluster (warehouse)', 'cluster id', 'oauth'],
  salesforce: ['Salesforce org (CRM write-back)', 'org id', 'oauth'],
  hubspot: ['HubSpot portal (CRM write-back)', 'portal id', 'oauth'],
  netsuite: ['NetSuite account (ERP)', 'account id', 'oauth'],
  'google-sheets': ['Google Sheets spreadsheet', 'spreadsheet id', 'oauth'],
  airtable: ['Airtable base', 'base id', 'oauth'],
  'http-api': ['HTTP API endpoint (records)', 'endpoint address', 'credentials'],
  webhook: ['Webhook endpoint (events)', 'endpoint address', 'credentials'],
};

const CATEGORY_LABELS: Record<DestinationCategory, string> = {
  bi: 'Business intelligence',
  warehouse: 'Data warehouse',
  'crm-erp': 'CRM / ERP',
  spreadsheet: 'Spreadsheets',
  api: 'HTTP APIs',
  webhook: 'Webhooks',
};

/** Proper display names for brand-cased provider keys. */
const DISPLAY_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  signal: 'Signal',
  slack: 'Slack',
  x: 'X',
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  email: 'Email',
  sms: 'SMS',
  voice: 'Voice',
  web: 'Web',
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
  zendesk: 'Zendesk',
  jira: 'Jira',
  linear: 'Linear',
  confluence: 'Confluence',
  notion: 'Notion',
  github: 'GitHub',
  'google-drive': 'Google Drive',
  'google-calendar': 'Google Calendar',
  stripe: 'Stripe',
  quickbooks: 'QuickBooks',
  zapier: 'Zapier',
  looker: 'Looker',
  tableau: 'Tableau',
  'power-bi': 'Power BI',
  snowflake: 'Snowflake',
  bigquery: 'BigQuery',
  redshift: 'Redshift',
  netsuite: 'NetSuite',
  'google-sheets': 'Google Sheets',
  airtable: 'Airtable',
  'http-api': 'HTTP API',
  webhook: 'Webhook',
};

function labelOf(key: string): string {
  const display = DISPLAY_LABELS[key];
  if (display !== undefined) return display;
  return key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function entry(
  key: string,
  meta: [description: string, hint: string, authKind: AuthKind],
): CatalogEntry {
  return {
    key,
    label: labelOf(key),
    description: meta[0],
    accountIdHint: meta[1],
    authKind: meta[2],
  };
}

/** Channel catalog (all providers — including ones not yet connected). */
export function channelCatalog(): CatalogEntry[] {
  return CHANNEL_PROVIDERS.map((provider) =>
    entry(provider, CHANNEL_DESCRIPTIONS[provider]),
  );
}

/** Source-system catalog (inbound connectors). */
export function sourceCatalog(): CatalogEntry[] {
  return SOURCE_PROVIDERS.map((provider) =>
    entry(provider, SOURCE_DESCRIPTIONS[provider]),
  );
}

/** Destination catalog grouped by canonical category (outbound connectors). */
export function destinationCatalog(): { category: DestinationCategory; label: string; entries: CatalogEntry[] }[] {
  return DESTINATION_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    entries: DESTINATION_PROVIDERS.filter(
      (provider) => destinationCategoryOf(provider) === category,
    ).map((provider) => entry(provider, DESTINATION_DESCRIPTIONS[provider])),
  }));
}

/** Canonical category of a destination provider (derived adapter classification). */
export function destinationCategoryOf(provider: DestinationProvider): DestinationCategory {
  switch (provider) {
    case 'looker':
    case 'tableau':
    case 'power-bi':
      return 'bi';
    case 'snowflake':
    case 'bigquery':
    case 'redshift':
      return 'warehouse';
    case 'salesforce':
    case 'hubspot':
    case 'netsuite':
      return 'crm-erp';
    case 'google-sheets':
    case 'airtable':
      return 'spreadsheet';
    case 'http-api':
      return 'api';
    case 'webhook':
      return 'webhook';
  }
}

/** Catalog lookup by provider key (null when the key is not in the vocabulary). */
export function catalogEntry(kind: 'channel' | 'source' | 'destination', key: string): CatalogEntry | null {
  const all =
    kind === 'channel'
      ? channelCatalog()
      : kind === 'source'
        ? sourceCatalog()
        : destinationCatalog().flatMap((group) => group.entries);
  return all.find((item) => item.key === key) ?? null;
}

/** Human label for a provider key, falling back to the key itself. */
export function providerLabel(kind: 'channel' | 'source' | 'destination', key: string): string {
  return catalogEntry(kind, key)?.label ?? key;
}
