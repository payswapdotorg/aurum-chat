// The first-class starter kit content of the vertical-kits module (W092).
//
// "Create reusable specialist extension/agent starter kits and first deep
//  integrations for system-of-record-heavy industries without moving
//  vertical semantics into Aurum core."
//
// Two system-of-record-heavy verticals ship as first-class content:
//
//   * LEGAL_CASE_MANAGEMENT_KIT  ('legal-case-management') — the law-firm
//     / legal-operations vertical: matters, dockets, engagement letters.
//   * ACCOUNTING_LEDGER_ERP_KIT  ('accounting-ledger-erp') — the
//     accounting / ledger-ERP vertical: chart of accounts, journal
//     entries, receivables/payables, period close.
//
// EVERYTHING vertical lives inside these manifests — the capability
// declarations, the starter extension/agent definitions, the vertical
// data-schema hints and the edge-integration declarations. No core
// module names, stores or interprets anything vertical (the work item's
// hard boundary); a kit is registered into a tenant's registry through
// `registerKitVersion` (the module's exported content is the seed
// tenants register), verified by the same deterministic checks as any
// other kit, and installed through the governed lifecycle.
//
// The starter component definitions are DEFINITIONS, not deployed
// software: materializing them into the tenant's extension/agent
// registries follows those modules' own governed lifecycles downstream.
// The edge integrations declare the system-of-record surfaces the kit
// will reach THROUGH the Edge Connector once W088 lands — until then
// they are honestly reported as 'deferred-on-w088' by the status
// surface.
//
// The capability keys follow the W081 read./write. plain-language
// convention; the agent definitions use the agents module's closed
// permission-scope and runtime-provider vocabularies; the extension
// definitions follow the W025 manifest shape with its exact permission ↔
// capability consistency (validated by the extensions module's own pure
// rule sets during kit verification).

import type { VerticalKitManifest } from './types';

// ---------------------------------------------------------------------------
// (a) Legal / case management
// ---------------------------------------------------------------------------

export const LEGAL_CASE_MANAGEMENT_KIT: VerticalKitManifest = {
  kitSchemaVersion: 1,
  kitKey: 'legal-case-management',
  version: '1.0.0',
  verticalKey: 'legal',
  displayName: 'Legal & Case Management Starter Kit',
  description:
    'Specialist starter kit for legal operations: matter intake and lifecycle, court docket and deadline watching, engagement-letter drafting support, and billing-record visibility for law firms and legal departments.',
  requiredCapabilities: [
    {
      key: 'read.case-matters',
      label: 'Read matters, engagement records and client references',
      dataCategories: ['case-records', 'client-identity', 'privileged-notes'],
      mode: 'read',
    },
    {
      key: 'write.case-matters',
      label: 'Open, update and close matters',
      dataCategories: ['case-records', 'client-identity'],
      mode: 'write',
    },
    {
      key: 'read.docket-calendar',
      label: 'Read court dockets, hearings and statutory deadlines',
      dataCategories: ['docket-records', 'deadlines'],
      mode: 'read',
    },
    {
      key: 'write.docket-entries',
      label: 'Record docket entries and calendar deadline changes',
      dataCategories: ['docket-records', 'deadlines'],
      mode: 'write',
    },
    {
      key: 'read.billing-records',
      label: 'Read time entries and matter billing records',
      dataCategories: ['billing-records', 'time-entries'],
      mode: 'read',
    },
  ],
  extensionDefinitions: [
    {
      definitionKey: 'matter-intake-form',
      displayName: 'Matter intake form',
      description:
        'Host-rendered intake form capturing new matters with practice-area, jurisdiction and statute-of-limitations fields, persisted per install.',
      capabilities: {
        stateScope: 'install',
        uiSurfaces: ['settings-form', 'control-tower-panel'],
        schedules: [],
        eventSubscriptions: [],
        externalParticipants: [],
        telemetry: false,
      },
      quotas: {
        maxStateBytes: 1_048_576,
        maxScheduleInvocationsPerDay: 0,
        maxExternalCallsPerDay: 0,
      },
      requestedPermissions: ['state:read', 'state:write', 'ui:render'],
    },
    {
      definitionKey: 'docket-deadline-watcher',
      displayName: 'Docket deadline watcher',
      description:
        'Scheduled watcher that reviews upcoming court dates and statute-of-limitations deadlines each morning and emits telemetry when a critical deadline approaches.',
      capabilities: {
        stateScope: 'none',
        uiSurfaces: [],
        schedules: [{ name: 'morning-docket-review', cron: '0 6 * * *' }],
        eventSubscriptions: ['matter.opened', 'matter.deadline.changed'],
        externalParticipants: [],
        telemetry: true,
      },
      quotas: {
        maxStateBytes: 0,
        maxScheduleInvocationsPerDay: 24,
        maxExternalCallsPerDay: 0,
      },
      requestedPermissions: ['schedule:run', 'events:subscribe', 'telemetry:emit'],
    },
    {
      definitionKey: 'engagement-letter-assistant',
      displayName: 'Engagement letter assistant',
      description:
        'Drafts engagement-letter structures from matter metadata and participates with the document system of record over its scoped https origin.',
      capabilities: {
        stateScope: 'tenant',
        uiSurfaces: ['chat-panel'],
        schedules: [],
        eventSubscriptions: [],
        externalParticipants: [
          { label: 'Document system of record', origin: 'https://docs.legal.example' },
        ],
        telemetry: false,
      },
      quotas: {
        maxStateBytes: 4_194_304,
        maxScheduleInvocationsPerDay: 0,
        maxExternalCallsPerDay: 500,
      },
      requestedPermissions: [
        'state:read',
        'state:write',
        'ui:render',
        'external:participate',
      ],
    },
  ],
  agentDefinitions: [
    {
      definitionKey: 'case-matter-specialist',
      displayName: 'Case matter specialist',
      role: 'legal case-management specialist',
      description:
        'Answers matter-status questions, summarizes matter history and flags missing engagement prerequisites for the responsible attorney.',
      provider: 'langgraph',
      instructions:
        'You support legal operations. Given a matter reference, summarize its status, upcoming deadlines and missing engagement prerequisites in plain language for the responsible attorney. Never give legal advice; propose, never decide. Always cite the matter fields you relied on.',
      permissions: ['observe', 'analyze', 'recommend', 'ask'],
    },
    {
      definitionKey: 'docket-reviewer',
      displayName: 'Docket reviewer',
      role: 'docket and deadline reviewer',
      description:
        'Reviews the docket calendar each day, surfaces hearings and statute-of-limitations deadlines at risk, and recommends rescheduling actions.',
      provider: 'openai-assistants',
      instructions:
        'You review court dockets and statutory deadlines. For each upcoming item, assess risk of missing it and recommend the next concrete step. Never file anything; recommendations only, with the docket fields you used.',
      permissions: ['observe', 'analyze', 'recommend'],
    },
  ],
  dataSchemaHints: [
    {
      entity: 'matter',
      label: 'Case matter',
      note: 'The central system-of-record entity of the legal vertical.',
      fields: [
        { name: 'matterNumber', type: 'string', required: true, note: 'Firm-assigned reference' },
        { name: 'clientRef', type: 'string', required: true, note: 'Client identity reference' },
        { name: 'practiceArea', type: 'string', required: true, note: 'e.g. litigation, corporate' },
        { name: 'jurisdiction', type: 'string', required: true },
        { name: 'openedOn', type: 'date', required: true },
        { name: 'statuteOfLimitationsDate', type: 'date', required: false },
        { name: 'responsibleAttorney', type: 'string', required: true },
        { name: 'status', type: 'string', required: true, note: 'open, pending-close, closed' },
      ],
    },
    {
      entity: 'docket-entry',
      label: 'Docket entry',
      fields: [
        { name: 'docketId', type: 'string', required: true },
        { name: 'matterNumber', type: 'string', required: true },
        { name: 'court', type: 'string', required: true },
        { name: 'eventDate', type: 'date', required: true },
        { name: 'eventType', type: 'string', required: true, note: 'hearing, filing, deadline' },
        { name: 'notes', type: 'string', required: false },
      ],
    },
    {
      entity: 'engagement-letter',
      label: 'Engagement letter',
      fields: [
        { name: 'letterId', type: 'string', required: true },
        { name: 'matterNumber', type: 'string', required: true },
        { name: 'clientRef', type: 'string', required: true },
        { name: 'scopeText', type: 'string', required: true },
        { name: 'executedOn', type: 'date', required: false },
        { name: 'version', type: 'string', required: true },
      ],
    },
    {
      entity: 'time-entry',
      label: 'Billable time entry',
      fields: [
        { name: 'entryId', type: 'string', required: true },
        { name: 'matterNumber', type: 'string', required: true },
        { name: 'timekeeperRef', type: 'string', required: true },
        { name: 'workedOn', type: 'date', required: true },
        { name: 'hours', type: 'decimal', required: true },
        { name: 'narrative', type: 'string', required: false },
        { name: 'billed', type: 'boolean', required: true },
      ],
    },
  ],
  edgeIntegrations: [
    {
      integrationKey: 'case-management-sor',
      systemLabel: 'Legal case management system of record',
      description:
        'Reaches the matter registry of record: reads matters and engagement records, and opens/updates/closes matters. Deep-integration path DEFERRED-ON-W088 (the Edge Connector).',
      readCapabilityKey: 'read.case-matters',
      writeCapabilityKey: 'write.case-matters',
      schemaHintEntities: ['matter', 'engagement-letter'],
    },
    {
      integrationKey: 'court-docket-sor',
      systemLabel: 'Court docket calendar system of record',
      description:
        'Reaches the docket calendar of record: reads hearings and statutory deadlines, records docket-entry changes. Deep-integration path DEFERRED-ON-W088 (the Edge Connector).',
      readCapabilityKey: 'read.docket-calendar',
      writeCapabilityKey: 'write.docket-entries',
      schemaHintEntities: ['docket-entry', 'matter'],
    },
  ],
};

// ---------------------------------------------------------------------------
// (b) Accounting / ledger ERP
// ---------------------------------------------------------------------------

export const ACCOUNTING_LEDGER_ERP_KIT: VerticalKitManifest = {
  kitSchemaVersion: 1,
  kitKey: 'accounting-ledger-erp',
  version: '1.0.0',
  verticalKey: 'accounting',
  displayName: 'Accounting & Ledger ERP Starter Kit',
  description:
    'Specialist starter kit for accounting operations: chart-of-accounts and ledger visibility, journal-entry review and posting support, receivables/payables aging, and period-close checklists for finance teams.',
  requiredCapabilities: [
    {
      key: 'read.ledger-accounts',
      label: 'Read the chart of accounts and account balances',
      dataCategories: ['chart-of-accounts', 'balances'],
      mode: 'read',
    },
    {
      key: 'read.journal-entries',
      label: 'Read journal entries and their lines',
      dataCategories: ['journal-entries'],
      mode: 'read',
    },
    {
      key: 'write.journal-entries',
      label: 'Post and adjust journal entries',
      dataCategories: ['journal-entries'],
      mode: 'write',
    },
    {
      key: 'read.receivables-ledger',
      label: 'Read customer invoices and receivables aging',
      dataCategories: ['receivables', 'customer-records'],
      mode: 'read',
    },
    {
      key: 'read.payables-ledger',
      label: 'Read vendor bills and payables aging',
      dataCategories: ['payables', 'vendor-records'],
      mode: 'read',
    },
  ],
  extensionDefinitions: [
    {
      definitionKey: 'period-close-checklist',
      displayName: 'Period close checklist',
      description:
        'Scheduled period-close checklist that tracks close tasks on the control tower panel and records completion state per period.',
      capabilities: {
        stateScope: 'tenant',
        uiSurfaces: ['control-tower-panel'],
        schedules: [{ name: 'close-morning-rollup', cron: '30 7 * * 1-5' }],
        eventSubscriptions: ['journal-entry.posted', 'period.opened'],
        externalParticipants: [],
        telemetry: true,
      },
      quotas: {
        maxStateBytes: 4_194_304,
        maxScheduleInvocationsPerDay: 10,
        maxExternalCallsPerDay: 0,
      },
      requestedPermissions: ['state:read', 'state:write', 'ui:render', 'schedule:run', 'events:subscribe', 'telemetry:emit'],
    },
    {
      definitionKey: 'journal-entry-review-form',
      displayName: 'Journal entry review form',
      description:
        'Host-rendered review form for drafted journal entries with imbalance warnings, persisted per install until the entry is posted.',
      capabilities: {
        stateScope: 'install',
        uiSurfaces: ['settings-form', 'chat-panel'],
        schedules: [],
        eventSubscriptions: [],
        externalParticipants: [],
        telemetry: false,
      },
      quotas: {
        maxStateBytes: 1_048_576,
        maxScheduleInvocationsPerDay: 0,
        maxExternalCallsPerDay: 0,
      },
      requestedPermissions: ['state:read', 'state:write', 'ui:render'],
    },
    {
      definitionKey: 'ar-aging-dashboard',
      displayName: 'Receivables aging dashboard',
      description:
        'Control-tower panel summarizing receivables aging buckets and the largest overdue balances, refreshed on schedule.',
      capabilities: {
        stateScope: 'none',
        uiSurfaces: ['control-tower-panel', 'briefing-card'],
        schedules: [{ name: 'aging-daily-refresh', cron: '15 8 * * 1-5' }],
        eventSubscriptions: ['invoice.issued', 'payment.received'],
        externalParticipants: [],
        telemetry: false,
      },
      quotas: {
        maxStateBytes: 0,
        maxScheduleInvocationsPerDay: 5,
        maxExternalCallsPerDay: 0,
      },
      requestedPermissions: ['ui:render', 'schedule:run', 'events:subscribe'],
    },
  ],
  agentDefinitions: [
    {
      definitionKey: 'period-close-specialist',
      displayName: 'Period close specialist',
      role: 'accounting period-close specialist',
      description:
        'Tracks the period-close checklist, summarizes what is open, and recommends the next close actions with owners.',
      provider: 'crewai',
      instructions:
        'You support period close. Given the current period, summarize open checklist tasks, flag journal entries still unposted, and recommend the next actions with owners. Never post entries yourself; recommendations only.',
      permissions: ['observe', 'analyze', 'recommend', 'ask'],
    },
    {
      definitionKey: 'reconciliation-reviewer',
      displayName: 'Reconciliation reviewer',
      role: 'ledger reconciliation reviewer',
      description:
        'Compares ledger balances against receivables/payables subledgers, surfaces mismatches with evidence, and recommends reconciling entries.',
      provider: 'semantic-kernel',
      instructions:
        'You review ledger reconciliations. For each mismatch you find, state the accounts, the amounts, and a recommended reconciling journal entry. Never execute postings; propose them with the figures you used.',
      permissions: ['observe', 'analyze', 'recommend'],
    },
  ],
  dataSchemaHints: [
    {
      entity: 'ledger-account',
      label: 'Chart-of-accounts account',
      note: 'The backbone entity of the ledger vertical.',
      fields: [
        { name: 'accountCode', type: 'string', required: true },
        { name: 'name', type: 'string', required: true },
        { name: 'accountType', type: 'string', required: true, note: 'asset, liability, equity, revenue, expense' },
        { name: 'parentAccountCode', type: 'string', required: false },
        { name: 'active', type: 'boolean', required: true },
      ],
    },
    {
      entity: 'journal-entry',
      label: 'Journal entry',
      note: 'A balanced set of journal lines; the unit of ledger writes.',
      fields: [
        { name: 'entryId', type: 'string', required: true },
        { name: 'entryDate', type: 'date', required: true },
        { name: 'periodName', type: 'string', required: true, note: 'e.g. 2026-09' },
        { name: 'memo', type: 'string', required: false },
        { name: 'status', type: 'string', required: true, note: 'draft, posted, reversed' },
        { name: 'lines', type: 'journal-line[]', required: true, note: 'debit/credit lines; must sum to zero' },
      ],
    },
    {
      entity: 'ar-invoice',
      label: 'Receivables invoice',
      fields: [
        { name: 'invoiceId', type: 'string', required: true },
        { name: 'customerRef', type: 'string', required: true },
        { name: 'issuedOn', type: 'date', required: true },
        { name: 'dueOn', type: 'date', required: true },
        { name: 'amount', type: 'decimal', required: true },
        { name: 'currency', type: 'string', required: true },
        { name: 'remaining', type: 'decimal', required: true },
      ],
    },
    {
      entity: 'ap-bill',
      label: 'Payables bill',
      fields: [
        { name: 'billId', type: 'string', required: true },
        { name: 'vendorRef', type: 'string', required: true },
        { name: 'issuedOn', type: 'date', required: true },
        { name: 'dueOn', type: 'date', required: true },
        { name: 'amount', type: 'decimal', required: true },
        { name: 'currency', type: 'string', required: true },
        { name: 'remaining', type: 'decimal', required: true },
      ],
    },
    {
      entity: 'period-close-task',
      label: 'Period close task',
      fields: [
        { name: 'taskId', type: 'string', required: true },
        { name: 'periodName', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
        { name: 'ownerRef', type: 'string', required: false },
        { name: 'dueOn', type: 'date', required: true },
        { name: 'status', type: 'string', required: true, note: 'open, done, blocked' },
      ],
    },
  ],
  edgeIntegrations: [
    {
      integrationKey: 'ledger-erp-sor',
      systemLabel: 'Ledger ERP system of record',
      description:
        'Reaches the ledger ERP of record: reads the chart of accounts and journal entries, posts and adjusts journal entries. Deep-integration path DEFERRED-ON-W088 (the Edge Connector).',
      readCapabilityKey: 'read.journal-entries',
      writeCapabilityKey: 'write.journal-entries',
      schemaHintEntities: ['ledger-account', 'journal-entry'],
    },
    {
      integrationKey: 'ar-aging-sor',
      systemLabel: 'Receivables aging system of record',
      description:
        'Reads customer invoices and receivables aging from the receivables subledger of record. Read-only deep integration — no write path, and the write side stays DEFERRED-ON-W088 (the Edge Connector).',
      readCapabilityKey: 'read.receivables-ledger',
      writeCapabilityKey: null,
      schemaHintEntities: ['ar-invoice'],
    },
  ],
};

/** The module's shipped first-class starter kits, in stable order. */
export const STARTER_KITS: readonly VerticalKitManifest[] = [
  LEGAL_CASE_MANAGEMENT_KIT,
  ACCOUNTING_LEDGER_ERP_KIT,
];
