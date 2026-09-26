// The starter-kit registry (W092) — THE DATA, AND ONLY THE DATA.
//
// The two starter kits this work item ships live here as versioned
// data records. Everything else in this module (validation, service,
// reads, the tower surface) is INDUSTRY-BLIND: it validates, installs,
// audits and removes whatever records the registry carries, with zero
// kit-specific or industry-specific branching. The core-independence
// test under tests/ pins both directions at grep level:
//
//   * no kit-content term of this file appears in ANY other module of
//     the repository (vertical semantics never enter core);
//   * no kit-content term appears in this module outside THIS file
//     (the module's own logic stays generic).
//
// CONTENT HONESTY: the two kits are SYNTHETIC but STRUCTURALLY VALID
// against every contract they ride — real permission vocabularies, the
// extensions module's own consistency rules, the W081 capability-class
// registry, the W082 provider vocabulary and the W084 operation bounds.
// The metadata says exactly what each kit is and is not (see the
// notIncluded lists); the edgeExecution field declares which recipes
// expect the W088 Edge Connector and renders 'pending-w088' — no edge
// execution exists or is claimed at this base.

import { parseSemver } from '@/modules/extensions/contract';
import type { VerticalKitDefinition } from './types';

// ---------------------------------------------------------------------------
// W092 starter kit 1 — professional services (time / expense /
// engagement systems of record)
// ---------------------------------------------------------------------------

const PROFESSIONAL_SERVICES: VerticalKitDefinition = {
  kitKey: 'professional-services',
  version: '1.0.0',
  versionParts: parseSemver('1.0.0')!,
  metadata: {
    industry: 'Professional services',
    description:
      'Starter kit for professional-services organizations whose systems of record are ' +
      'engagement/project trackers and time-and-expense ledgers: two composed extension ' +
      'integrations, one multi-system deep-action recipe template, and the broker ' +
      'connection classes the kit needs.',
    outcomes: [
      'Engagement and time records surface beside goals and evidence without manual exports',
      'Month-end engagement close becomes one proposed, authorized and reconciled deep action',
      'Extension capability is granted exactly at the declared footprint and removable',
    ],
    notIncluded: [
      'No real provider credentials, tenant data or live system access — template content is synthetic',
      'Edge execution is PENDING W088: edge-expecting recipes validate and render, but never execute',
      'No time-sheet parsing or billing-math logic — data interpretation stays with the tenant and its agents',
    ],
  },
  permissionFootprint: [
    'state:read',
    'state:write',
    'ui:render',
    'schedule:run',
    'events:subscribe',
    'external:participate',
  ],
  connectionRequirements: [
    {
      key: 'ps-engagement-sor',
      label: 'Engagement / project tracking system of record',
      brokerProvider: 'jira',
      capabilityClasses: ['project-tracking', 'document-collaboration'],
    },
    {
      key: 'ps-financial-sor',
      label: 'Time, expense and billing system of record',
      brokerProvider: 'quickbooks',
      capabilityClasses: ['accounting-finance', 'billing-payments'],
    },
  ],
  extensionManifests: [
    {
      connectionKey: 'ps-engagement-sor',
      systemOfRecord: 'Engagement and project tracker',
      manifest: {
        extensionKey: 'ps-engagement-sync',
        version: '1.0.0',
        manifestSchemaVersion: 1,
        displayName: 'Engagement Sync',
        description:
          'Mirrors engagement and project records into tenant-scoped state and renders the ' +
          'engagement panel in the control tower.',
        hostRuntime: { minVersion: '1.0.0', maxVersion: null },
        requestedPermissions: ['state:read', 'state:write', 'ui:render', 'events:subscribe', 'external:participate'],
        stateScope: 'tenant',
        uiSurfaces: ['control-tower-panel'],
        schedules: [],
        eventSubscriptions: ['goal.updated', 'person.updated'],
        externalParticipants: [
          { label: 'Engagement system of record', origin: 'https://engagement-sor.example.test' },
        ],
        telemetry: false,
        quotas: {
          maxStateBytes: 1_048_576,
          maxScheduleInvocationsPerDay: 0,
          maxExternalCallsPerDay: 5_000,
        },
      },
    },
    {
      connectionKey: 'ps-financial-sor',
      systemOfRecord: 'Time and expense ledger',
      manifest: {
        extensionKey: 'ps-time-expense-bridge',
        version: '1.0.0',
        manifestSchemaVersion: 1,
        displayName: 'Time & Expense Bridge',
        description:
          'Pulls time and expense entries on a schedule and keeps a tenant-scoped cache ' +
          'of the synced entries.',
        hostRuntime: { minVersion: '1.0.0', maxVersion: null },
        requestedPermissions: [
          'state:read',
          'state:write',
          'schedule:run',
          'external:participate',
        ],
        stateScope: 'tenant',
        uiSurfaces: [],
        schedules: [{ name: 'daily-timesheet-pull', cron: '0 6 * * *' }],
        eventSubscriptions: [],
        externalParticipants: [
          { label: 'Time and expense system of record', origin: 'https://time-expense-sor.example.test' },
        ],
        telemetry: false,
        quotas: {
          maxStateBytes: 4_194_304,
          maxScheduleInvocationsPerDay: 4,
          maxExternalCallsPerDay: 10_000,
        },
      },
    },
  ],
  deepActionRecipes: [
    {
      recipeKey: 'close-engagement-month',
      description:
        'Close one engagement month across the systems of record: post the finalized ' +
        'time-and-expense entries, then issue the engagement invoice, each write verified ' +
        'against its expected downstream state.',
      operations: [
        {
          key: 'post-month-timesheets',
          connectionKey: 'ps-financial-sor',
          capabilityKey: 'write.accounting-finance',
          targetTemplate: 'ledger/engagements/:engagementId/month/:period',
          payload: { entryKind: 'timesheet-batch', status: 'finalized' },
          expectation: { postingStatus: 'posted', reviewState: 'locked' },
        },
        {
          key: 'issue-engagement-invoice',
          connectionKey: 'ps-financial-sor',
          capabilityKey: 'write.billing-payments',
          targetTemplate: 'invoices/engagements/:engagementId',
          payload: { invoiceKind: 'engagement-month', periodSource: 'posted-timesheets' },
          expectation: { invoiceState: 'issued' },
        },
      ],
    },
  ],
  edgeExecution: {
    recipeKeys: [],
    note:
      'No recipe of this kit expects the Edge Connector: month-end close is a batch flow ' +
      'over broker connections. The field is still validated and renders pending-w088 ' +
      'for any future recipe that declares edge expectations.',
  },
};

// ---------------------------------------------------------------------------
// v1.1.0 — the minor upgrade of the same kit: the engagement sync's
// external-call quota rises, and the time & expense bridge ADDS sync-
// health telemetry — a REAL permission-set change (the 1.1.0 footprint
// grows by 'telemetry:emit'), so an upgrade visibly REPLACES the grant
// set instead of mutating it in place, and both states stay on the
// append-only audit trail.
// ---------------------------------------------------------------------------

const PROFESSIONAL_SERVICES_V1_1_0: VerticalKitDefinition = {
  kitKey: 'professional-services',
  version: '1.1.0',
  versionParts: parseSemver('1.1.0')!,
  metadata: {
    industry: 'Professional services',
    description:
      'Starter kit for professional-services organizations whose systems of record are ' +
      'engagement/project trackers and time-and-expense ledgers: two composed extension ' +
      'integrations, one multi-system deep-action recipe template, and the broker ' +
      'connection classes the kit needs. v1.1.0 adds sync-health telemetry to the ' +
      'time & expense bridge.',
    outcomes: [
      'Engagement and time records surface beside goals and evidence without manual exports',
      'Month-end engagement close becomes one proposed, authorized and reconciled deep action',
      'Extension capability is granted exactly at the declared footprint and removable',
    ],
    notIncluded: [
      'No real provider credentials, tenant data or live system access — template content is synthetic',
      'Edge execution is PENDING W088: edge-expecting recipes validate and render, but never execute',
      'No time-sheet parsing or billing-math logic — data interpretation stays with the tenant and its agents',
    ],
  },
  permissionFootprint: [
    'state:read',
    'state:write',
    'ui:render',
    'schedule:run',
    'events:subscribe',
    'external:participate',
    'telemetry:emit',
  ],
  connectionRequirements: [
    {
      key: 'ps-engagement-sor',
      label: 'Engagement / project tracking system of record',
      brokerProvider: 'jira',
      capabilityClasses: ['project-tracking', 'document-collaboration'],
    },
    {
      key: 'ps-financial-sor',
      label: 'Time, expense and billing system of record',
      brokerProvider: 'quickbooks',
      capabilityClasses: ['accounting-finance', 'billing-payments'],
    },
  ],
  extensionManifests: [
    {
      connectionKey: 'ps-engagement-sor',
      systemOfRecord: 'Engagement and project tracker',
      manifest: {
        extensionKey: 'ps-engagement-sync',
        version: '1.1.0',
        manifestSchemaVersion: 1,
        displayName: 'Engagement Sync',
        description:
          'Mirrors engagement and project records into tenant-scoped state and renders the ' +
          'engagement panel in the control tower (v1.1.0 raises the external-call ceiling).',
        hostRuntime: { minVersion: '1.0.0', maxVersion: null },
        requestedPermissions: ['state:read', 'state:write', 'ui:render', 'events:subscribe', 'external:participate'],
        stateScope: 'tenant',
        uiSurfaces: ['control-tower-panel'],
        schedules: [],
        eventSubscriptions: ['goal.updated', 'person.updated'],
        externalParticipants: [
          { label: 'Engagement system of record', origin: 'https://engagement-sor.example.test' },
        ],
        telemetry: false,
        quotas: {
          maxStateBytes: 1_048_576,
          maxScheduleInvocationsPerDay: 0,
          maxExternalCallsPerDay: 8_000,
        },
      },
    },
    {
      connectionKey: 'ps-financial-sor',
      systemOfRecord: 'Time and expense ledger',
      manifest: {
        extensionKey: 'ps-time-expense-bridge',
        version: '1.1.0',
        manifestSchemaVersion: 1,
        displayName: 'Time & Expense Bridge',
        description:
          'Pulls time and expense entries on a schedule, keeps a tenant-scoped cache and ' +
          'emits telemetry on sync health (v1.1.0 adds the telemetry capability).',
        hostRuntime: { minVersion: '1.0.0', maxVersion: null },
        requestedPermissions: [
          'state:read',
          'state:write',
          'schedule:run',
          'external:participate',
          'telemetry:emit',
        ],
        stateScope: 'tenant',
        uiSurfaces: [],
        schedules: [{ name: 'daily-timesheet-pull', cron: '0 6 * * *' }],
        eventSubscriptions: [],
        externalParticipants: [
          { label: 'Time and expense system of record', origin: 'https://time-expense-sor.example.test' },
        ],
        telemetry: true,
        quotas: {
          maxStateBytes: 4_194_304,
          maxScheduleInvocationsPerDay: 4,
          maxExternalCallsPerDay: 10_000,
        },
      },
    },
  ],
  deepActionRecipes: [
    {
      recipeKey: 'close-engagement-month',
      description:
        'Close one engagement month across the systems of record: post the finalized ' +
        'time-and-expense entries, then issue the engagement invoice, each write verified ' +
        'against its expected downstream state.',
      operations: [
        {
          key: 'post-month-timesheets',
          connectionKey: 'ps-financial-sor',
          capabilityKey: 'write.accounting-finance',
          targetTemplate: 'ledger/engagements/:engagementId/month/:period',
          payload: { entryKind: 'timesheet-batch', status: 'finalized' },
          expectation: { postingStatus: 'posted', reviewState: 'locked' },
        },
        {
          key: 'issue-engagement-invoice',
          connectionKey: 'ps-financial-sor',
          capabilityKey: 'write.billing-payments',
          targetTemplate: 'invoices/engagements/:engagementId',
          payload: { invoiceKind: 'engagement-month', periodSource: 'posted-timesheets' },
          expectation: { invoiceState: 'issued' },
        },
      ],
    },
  ],
  edgeExecution: {
    recipeKeys: [],
    note:
      'No recipe of this kit expects the Edge Connector: month-end close is a batch flow ' +
      'over broker connections. The field is still validated and renders pending-w088 ' +
      'for any future recipe that declares edge expectations.',
  },
};

// ---------------------------------------------------------------------------
// W092 starter kit 2 — logistics operations (shipment / inventory
// systems of record)
// ---------------------------------------------------------------------------

const LOGISTICS_OPERATIONS: VerticalKitDefinition = {
  kitKey: 'logistics-operations',
  version: '1.0.0',
  versionParts: parseSemver('1.0.0')!,
  metadata: {
    industry: 'Logistics operations',
    description:
      'Starter kit for logistics operators whose systems of record are order/shipment ' +
      'trackers and workflow automations: two composed extension integrations, one ' +
      'latency-sensitive deep-action recipe template that declares edge expectations, ' +
      'and the broker connection classes the kit needs.',
    outcomes: [
      'Shipment and order records surface beside goals and evidence without manual exports',
      'Expedite replanning becomes one proposed, authorized and reconciled deep action',
      'Extension capability is granted exactly at the declared footprint and removable',
    ],
    notIncluded: [
      'No real provider credentials, tenant data or live system access — template content is synthetic',
      'Edge execution is PENDING W088: the edge-expecting recipe validates and renders, but never executes',
      'The W081 vocabulary has no inventory capability class yet — templates ride the existing order and workflow classes; an inventory class arrives with its own work item',
    ],
  },
  permissionFootprint: [
    'state:read',
    'state:write',
    'schedule:run',
    'events:subscribe',
    'external:participate',
    'telemetry:emit',
  ],
  connectionRequirements: [
    {
      key: 'shipment-order-sor',
      label: 'Order and shipment system of record',
      brokerProvider: 'salesforce',
      capabilityClasses: ['customer-records', 'sales-pipeline'],
    },
    {
      key: 'shipment-workflow-sor',
      label: 'Shipment workflow automation system of record',
      brokerProvider: 'zapier',
      capabilityClasses: ['workflows-automation'],
    },
  ],
  extensionManifests: [
    {
      connectionKey: 'shipment-order-sor',
      systemOfRecord: 'Order and shipment tracker',
      manifest: {
        extensionKey: 'logistics-shipment-tracker',
        version: '1.0.0',
        manifestSchemaVersion: 1,
        displayName: 'Shipment Tracker',
        description:
          'Subscribes to shipment events from the order system of record, keeps a ' +
          'tenant-scoped mirror and emits telemetry on shipment health.',
        hostRuntime: { minVersion: '1.0.0', maxVersion: null },
        requestedPermissions: [
          'state:read',
          'state:write',
          'events:subscribe',
          'external:participate',
          'telemetry:emit',
        ],
        stateScope: 'tenant',
        uiSurfaces: [],
        schedules: [],
        eventSubscriptions: ['goal.updated', 'observation.recorded'],
        externalParticipants: [
          { label: 'Order and shipment system of record', origin: 'https://shipment-sor.example.test' },
        ],
        telemetry: true,
        quotas: {
          maxStateBytes: 4_194_304,
          maxScheduleInvocationsPerDay: 0,
          maxExternalCallsPerDay: 20_000,
        },
      },
    },
    {
      connectionKey: 'shipment-workflow-sor',
      systemOfRecord: 'Shipment workflow automation',
      manifest: {
        extensionKey: 'logistics-inventory-writer',
        version: '1.0.0',
        manifestSchemaVersion: 1,
        displayName: 'Inventory Writeback',
        description:
          'Runs the nightly inventory reconciliation writeback into the workflow system ' +
          'of record from install-scoped state.',
        hostRuntime: { minVersion: '1.0.0', maxVersion: null },
        requestedPermissions: ['state:read', 'state:write', 'schedule:run', 'external:participate'],
        stateScope: 'install',
        uiSurfaces: [],
        schedules: [{ name: 'nightly-inventory-writeback', cron: '30 2 * * *' }],
        eventSubscriptions: [],
        externalParticipants: [
          { label: 'Shipment workflow system of record', origin: 'https://workflow-sor.example.test' },
        ],
        telemetry: false,
        quotas: {
          maxStateBytes: 2_097_152,
          maxScheduleInvocationsPerDay: 2,
          maxExternalCallsPerDay: 5_000,
        },
      },
    },
  ],
  deepActionRecipes: [
    {
      recipeKey: 'expedite-shipment-replan',
      description:
        'Replan one shipment expedition across the systems of record: update the shipment ' +
        'record on the order system, then trigger the replanning workflow on the automation ' +
        'system, each write verified against its expected downstream state. Latency-sensitive ' +
        'by design: this recipe declares edge-execution expectations (PENDING W088).',
      operations: [
        {
          key: 'flag-shipment-expedite',
          connectionKey: 'shipment-order-sor',
          capabilityKey: 'write.customer-records',
          targetTemplate: 'shipments/:shipmentId',
          payload: { priority: 'expedited', replanReason: 'at-risk-delivery' },
          expectation: { shipmentPriority: 'expedited' },
        },
        {
          key: 'trigger-replan-workflow',
          connectionKey: 'shipment-workflow-sor',
          capabilityKey: 'write.workflows-automation',
          targetTemplate: 'workflows/shipment-replan/:shipmentId',
          payload: { trigger: 'expedite', mode: 'full-replan' },
          expectation: { workflowState: 'running' },
        },
      ],
    },
  ],
  edgeExecution: {
    recipeKeys: ['expedite-shipment-replan'],
    note:
      'The expedite-shipment-replan recipe is latency-sensitive and expects the Edge ' +
      'Connector for in-flight execution. The Edge Connector is W088 (in flight on a ' +
      'sibling branch at this base): the expectation is validated and rendered ' +
      'pending-w088, and no edge execution is claimed or performed here.',
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The registered starter kits, in registry order. Pure DATA: versioned
 * bundles the generic module code validates (see validation.ts — the
 * unit tests prove every registered record passes) and serves. Adding
 * a kit or a version means adding a record here — never branching the
 * module's logic.
 */
export const KIT_REGISTRY: readonly VerticalKitDefinition[] = [
  PROFESSIONAL_SERVICES,
  PROFESSIONAL_SERVICES_V1_1_0,
  LOGISTICS_OPERATIONS,
];
