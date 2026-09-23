// The capability-class registry — W081's plain-organizational-language
// knowledge base (MODULE-INTERNAL; surfaced read-only through the contract
// for UIs and tests).
//
// §10 of the post-S002 handoff is binding here: "users see outcomes —
// quality, speed, cost, privacy, policy — not technology". A discovered
// system is therefore NEVER described by vendor or product names in this
// module's semantics. It is described by:
//
//   * capability CLASSES — what the system lets the organization do
//     ("customer records", "support desk", "billing"), each carrying
//     outcome-oriented statements across the five §10 dimensions;
//   * DATA CATEGORIES — which kinds of organizational data are in play;
//   * keywords — the deterministic bridge between a system's classes and
//     the org's own goals (W008), unknowns (W007) and capability gaps
//     (W017), used by explain.ts to ground every why-it-matters
//     explanation in what THIS organization is actually trying to achieve.
//
// This registry is deliberately provider-neutral (lock 16): no class or
// category names a vendor. Adding a class is a domain-vocabulary change
// owned by this module; directory records carrying unknown class keys are
// rejected by discovery.ts (strict adapter-output validation, the sources
// module's discipline).

import type { CapabilityClass, DataCategory, OutcomeDimension } from './types';

/** Canonical order of the §10 outcome dimensions (explanations sort by it). */
export const OUTCOME_DIMENSION_ORDER: readonly OutcomeDimension[] = [
  'quality',
  'speed',
  'cost',
  'privacy',
  'policy',
];

/** The data-category vocabulary (labels for surfaces, keywords for grounding). */
export const DATA_CATEGORIES: readonly DataCategory[] = [
  {
    key: 'customer-contacts',
    label: 'Customer contact details',
    keywords: ['customer', 'contact', 'client', 'account'],
  },
  {
    key: 'deals',
    label: 'Deals and opportunities',
    keywords: ['deal', 'pipeline', 'opportunity', 'forecast', 'revenue'],
  },
  {
    key: 'support-tickets',
    label: 'Support tickets',
    keywords: ['ticket', 'support', 'complaint', 'helpdesk', 'sla'],
  },
  {
    key: 'tasks-projects',
    label: 'Tasks and projects',
    keywords: ['task', 'project', 'milestone', 'sprint', 'delivery'],
  },
  {
    key: 'documents',
    label: 'Documents',
    keywords: ['document', 'doc', 'spec', 'proposal', 'wiki'],
  },
  {
    key: 'code',
    label: 'Source code and review history',
    keywords: ['code', 'repository', 'repo', 'release', 'pull'],
  },
  {
    key: 'schedules',
    label: 'Calendars and schedules',
    keywords: ['calendar', 'schedule', 'meeting', 'availability'],
  },
  {
    key: 'invoices',
    label: 'Invoices',
    keywords: ['invoice', 'billing', 'subscription'],
  },
  {
    key: 'payments',
    label: 'Payments',
    keywords: ['payment', 'charge', 'refund'],
  },
  {
    key: 'financial-records',
    label: 'Financial records',
    keywords: ['finance', 'financial', 'ledger', 'expense', 'budget', 'accounting'],
  },
  {
    key: 'automation-configs',
    label: 'Automation configurations',
    keywords: ['automation', 'workflow', 'integration', 'trigger', 'zap'],
  },
  {
    key: 'communications',
    label: 'Messages and conversations',
    keywords: ['message', 'chat', 'conversation', 'channel'],
  },
  {
    key: 'knowledge-content',
    label: 'Knowledge content',
    keywords: ['knowledge', 'article', 'faq', 'documentation', 'onboarding'],
  },
  {
    key: 'employee-records',
    label: 'People and role records',
    keywords: ['employee', 'people', 'role', 'directory', 'staff'],
  },
];

/** The capability-class vocabulary — the heart of the plain-language model. */
export const CAPABILITY_CLASSES: readonly CapabilityClass[] = [
  {
    key: 'customer-records',
    label: 'Customer records',
    connectionLead: 'see every customer and their history in one place',
    outcomes: [
      { dimension: 'quality', text: 'Answers about customers stop depending on who you ask.' },
      { dimension: 'speed', text: 'Customer questions get answered in minutes instead of days.' },
      { dimension: 'cost', text: 'Less time spent exporting and merging spreadsheets.' },
      { dimension: 'privacy', text: 'Customer data stays tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Nothing in the system of record changes without an explicit approval.' },
    ],
    keywords: ['customer', 'crm', 'contact', 'client', 'churn', 'retention'],
    readCapabilities: [{ key: 'read.customer-records', label: 'Read customer profiles and interaction history' }],
    writeCapabilities: [{ key: 'write.customer-records', label: 'Edit customer records' }],
    dataCategories: ['customer-contacts'],
  },
  {
    key: 'sales-pipeline',
    label: 'Sales pipeline',
    connectionLead: 'know which deals are at risk before they slip',
    outcomes: [
      { dimension: 'quality', text: 'Forecasts reflect what is actually in the pipeline.' },
      { dimension: 'speed', text: 'At-risk deals are flagged while there is still time to act.' },
      { dimension: 'cost', text: 'Fewer surprise misses at quarter end.' },
      { dimension: 'privacy', text: 'Deal data stays tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Deals are never edited without an explicit approval.' },
    ],
    keywords: ['sales', 'pipeline', 'deal', 'revenue', 'forecast', 'quota', 'opportunity'],
    readCapabilities: [{ key: 'read.sales-pipeline', label: 'Read deals, stages and forecasts' }],
    writeCapabilities: [{ key: 'write.sales-pipeline', label: 'Edit deals and pipeline stages' }],
    dataCategories: ['deals'],
  },
  {
    key: 'support-desk',
    label: 'Customer support desk',
    connectionLead: 'spot recurring customer problems early',
    outcomes: [
      { dimension: 'quality', text: 'Recurring problems surface before they become churn.' },
      { dimension: 'speed', text: 'Slow responses are visible the day they happen, not at month end.' },
      { dimension: 'cost', text: 'Support effort is spent where it actually retains customers.' },
      { dimension: 'privacy', text: 'Ticket contents stay tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Tickets are never replied to or closed without explicit authority.' },
    ],
    keywords: ['support', 'ticket', 'helpdesk', 'complaint', 'sla', 'response'],
    readCapabilities: [{ key: 'read.support-desk', label: 'Read support tickets and response times' }],
    writeCapabilities: [{ key: 'write.support-desk', label: 'Reply to or close support tickets' }],
    dataCategories: ['support-tickets'],
  },
  {
    key: 'project-tracking',
    label: 'Project and task tracking',
    connectionLead: 'see what is actually done and what is stuck across projects',
    outcomes: [
      { dimension: 'quality', text: 'Status reports match reality instead of optimism.' },
      { dimension: 'speed', text: 'Stuck work is visible without a round of status meetings.' },
      { dimension: 'cost', text: 'Less coordination overhead on every project.' },
      { dimension: 'privacy', text: 'Project data stays tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Tasks and projects are never edited without explicit authority.' },
    ],
    keywords: ['project', 'task', 'delivery', 'milestone', 'sprint', 'deadline'],
    readCapabilities: [{ key: 'read.project-tracking', label: 'Read projects, tasks and statuses' }],
    writeCapabilities: [{ key: 'write.project-tracking', label: 'Create or edit tasks and projects' }],
    dataCategories: ['tasks-projects'],
  },
  {
    key: 'document-collaboration',
    label: 'Document collaboration',
    connectionLead: 'find the latest version of any document without asking around',
    outcomes: [
      { dimension: 'quality', text: 'Decisions stop being made from outdated documents.' },
      { dimension: 'speed', text: 'The latest version of anything is seconds away.' },
      { dimension: 'cost', text: 'No more duplicated work on stale copies.' },
      { dimension: 'privacy', text: 'Documents stay tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Documents are never edited or published without explicit authority.' },
    ],
    keywords: ['document', 'wiki', 'spec', 'proposal', 'knowledge'],
    readCapabilities: [{ key: 'read.document-collaboration', label: 'Read documents and their latest versions' }],
    writeCapabilities: [{ key: 'write.document-collaboration', label: 'Create or edit documents' }],
    dataCategories: ['documents'],
  },
  {
    key: 'code-repositories',
    label: 'Code repositories',
    connectionLead: 'track what shipped and what is still in flight',
    outcomes: [
      { dimension: 'quality', text: 'Release status is grounded in the repositories, not in memory.' },
      { dimension: 'speed', text: '"What shipped last week?" is answered instantly.' },
      { dimension: 'cost', text: 'Less manual release bookkeeping.' },
      { dimension: 'privacy', text: 'Source code stays tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Nothing is ever merged or deployed through Aurum without explicit authority.' },
    ],
    keywords: ['code', 'repository', 'release', 'deploy', 'engineering', 'bug', 'software'],
    readCapabilities: [{ key: 'read.code-repositories', label: 'Read repositories, pull requests and releases' }],
    writeCapabilities: [{ key: 'write.code-repositories', label: 'Merge pull requests or change code' }],
    dataCategories: ['code'],
  },
  {
    key: 'calendar-scheduling',
    label: 'Calendars and scheduling',
    connectionLead: 'see how time is being spent and coordinate without email chains',
    outcomes: [
      { dimension: 'quality', text: 'Scheduling conflicts are caught before they happen.' },
      { dimension: 'speed', text: 'Finding a time takes seconds instead of an email thread.' },
      { dimension: 'cost', text: 'Less back-and-forth on every meeting.' },
      { dimension: 'privacy', text: 'Calendar data stays tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Events are never created or moved without explicit authority.' },
    ],
    keywords: ['calendar', 'meeting', 'schedule', 'time', 'availability'],
    readCapabilities: [{ key: 'read.calendar-scheduling', label: 'Read calendars and scheduled events' }],
    writeCapabilities: [{ key: 'write.calendar-scheduling', label: 'Create or move calendar events' }],
    dataCategories: ['schedules'],
  },
  {
    key: 'billing-payments',
    label: 'Billing and payments',
    connectionLead: 'catch billing issues and revenue changes as they happen',
    outcomes: [
      { dimension: 'quality', text: 'Revenue questions are answered from the billing records themselves.' },
      { dimension: 'speed', text: 'Failed charges and cancellations are visible the day they happen.' },
      { dimension: 'cost', text: 'Fewer lost revenue leaks from unnoticed billing problems.' },
      { dimension: 'privacy', text: 'Billing data stays tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Invoices and billing are never changed without explicit authority.' },
    ],
    keywords: ['billing', 'invoice', 'payment', 'subscription', 'revenue'],
    readCapabilities: [{ key: 'read.billing-payments', label: 'Read invoices, payments and subscriptions' }],
    writeCapabilities: [{ key: 'write.billing-payments', label: 'Issue invoices or change billing' }],
    dataCategories: ['invoices', 'payments'],
  },
  {
    key: 'accounting-finance',
    label: 'Accounting and finance',
    connectionLead: 'answer money questions directly from the books',
    outcomes: [
      { dimension: 'quality', text: 'Financial answers come from the ledger, not from recollection.' },
      { dimension: 'speed', text: 'Spend questions are answered without a finance round-trip.' },
      { dimension: 'cost', text: 'Less manual report assembly.' },
      { dimension: 'privacy', text: 'Financial records stay tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'The books are never posted to or edited without explicit authority.' },
    ],
    keywords: ['accounting', 'finance', 'ledger', 'expense', 'budget', 'book'],
    readCapabilities: [{ key: 'read.accounting-finance', label: 'Read ledger entries and financial reports' }],
    writeCapabilities: [{ key: 'write.accounting-finance', label: 'Post or edit ledger entries' }],
    dataCategories: ['financial-records'],
  },
  {
    key: 'workflows-automation',
    label: 'Workflows and automation',
    connectionLead: 'see which processes run automatically and where they break',
    outcomes: [
      { dimension: 'quality', text: 'Silent automation failures stop staying silent.' },
      { dimension: 'speed', text: 'Broken automations are flagged the moment they misbehave.' },
      { dimension: 'cost', text: 'Manual rework caused by broken automations disappears.' },
      { dimension: 'privacy', text: 'Automation configurations stay tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Automations are never created or changed without explicit authority.' },
    ],
    keywords: ['automation', 'workflow', 'integration', 'process', 'trigger'],
    readCapabilities: [{ key: 'read.workflows-automation', label: 'Read automation rules and their run history' }],
    writeCapabilities: [{ key: 'write.workflows-automation', label: 'Create or edit automations' }],
    dataCategories: ['automation-configs'],
  },
  {
    key: 'team-communication',
    label: 'Team communication',
    connectionLead: 'know what the organization is talking about',
    outcomes: [
      { dimension: 'quality', text: 'Decisions and context stop living only inside chat threads.' },
      { dimension: 'speed', text: 'Finding a past conversation takes seconds.' },
      { dimension: 'cost', text: 'Fewer meetings spent recounting what was already discussed.' },
      { dimension: 'privacy', text: 'Message contents stay tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Aurum never posts messages without explicit authority.' },
    ],
    keywords: ['chat', 'message', 'communication', 'channel', 'team'],
    readCapabilities: [{ key: 'read.team-communication', label: 'Read channel messages and threads' }],
    writeCapabilities: [{ key: 'write.team-communication', label: 'Post messages' }],
    dataCategories: ['communications'],
  },
  {
    key: 'knowledge-base',
    label: 'Knowledge base',
    connectionLead: 'surface the answers your organization has already written down',
    outcomes: [
      { dimension: 'quality', text: 'Questions get answered with what the organization already knows.' },
      { dimension: 'speed', text: 'Onboarding and recurring questions stop reinventing answers.' },
      { dimension: 'cost', text: 'Less duplicated writing of the same answer.' },
      { dimension: 'privacy', text: 'Knowledge content stays tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Articles are never published or edited without explicit authority.' },
    ],
    keywords: ['knowledge', 'faq', 'article', 'documentation', 'onboarding', 'answer'],
    readCapabilities: [{ key: 'read.knowledge-base', label: 'Read knowledge articles and answers' }],
    writeCapabilities: [{ key: 'write.knowledge-base', label: 'Publish or edit knowledge articles' }],
    dataCategories: ['knowledge-content'],
  },
  {
    key: 'identity-directory',
    label: 'People directory',
    connectionLead: 'keep an accurate picture of who does what',
    outcomes: [
      { dimension: 'quality', text: 'Who to ask about what is grounded in the directory, not folklore.' },
      { dimension: 'speed', text: 'Finding the right owner takes seconds.' },
      { dimension: 'cost', text: 'Less time spent figuring out who is responsible.' },
      { dimension: 'privacy', text: 'People records stay tenant-scoped and read-only.' },
      { dimension: 'policy', text: 'Roles and directory entries are never changed without explicit authority.' },
    ],
    keywords: ['people', 'employee', 'directory', 'role', 'staff', 'organization'],
    readCapabilities: [{ key: 'read.identity-directory', label: 'Read the people directory and roles' }],
    writeCapabilities: [{ key: 'write.identity-directory', label: 'Change roles or directory entries' }],
    dataCategories: ['employee-records'],
  },
];

/** Registry lookups (O(1) maps built once). */
const CLASS_BY_KEY = new Map<string, CapabilityClass>(
  CAPABILITY_CLASSES.map((entry) => [entry.key, entry]),
);
const CATEGORY_BY_KEY = new Map<string, DataCategory>(DATA_CATEGORIES.map((entry) => [entry.key, entry]));

/** The class for a registry key, or null for an unknown key. */
export function capabilityClassOf(key: string): CapabilityClass | null {
  return CLASS_BY_KEY.get(key) ?? null;
}

/** The data category for a registry key, or null for an unknown key. */
export function dataCategoryOf(key: string): DataCategory | null {
  return CATEGORY_BY_KEY.get(key) ?? null;
}

/** Every registry class key (validation vocabulary). */
export const CAPABILITY_CLASS_KEYS: readonly string[] = CAPABILITY_CLASSES.map((entry) => entry.key);

/** Every registry data-category key (validation vocabulary). */
export const DATA_CATEGORY_KEYS: readonly string[] = DATA_CATEGORIES.map((entry) => entry.key);
