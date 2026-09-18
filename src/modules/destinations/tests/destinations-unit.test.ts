// Unit tests for the destinations module's pure logic (no database):
// input validation/normalization, envelope/receipt guards, the record
// content constraint, and EVERY provider adapter's normalize/format
// behavior.
//
// W037 acceptance covered here:
//  * canonical adapters exist for all thirteen providers across the six
//    work-item categories (BI, warehouses, CRM/ERP, spreadsheets, APIs,
//    webhooks) with an explicit category + content-constraint matrix;
//  * provider account ids normalize per provider convention; canonical
//    batches format into each provider's envelope convention — and every
//    adapter output passes the transport-port guard (provider isolation:
//    adapter files are reachable only inside the module; the contract
//    never exposes them);
//  * structured stores reject non-object record data; envelope-style
//    providers accept any JSON;
//  * the evidence-level export tag and the gate vocabulary constants.

import { describe, expect, it } from 'vitest';
import { DestinationsError } from '../errors';
import { allDestinationAdapters, getDestinationAdapter } from '../adapters';
import type { DestinationAdapter } from '../adapters/types';
import { httpApiAdapter } from '../adapters/http-api';
import { salesforceAdapter } from '../adapters/salesforce';
import { snowflakeAdapter } from '../adapters/snowflake';
import { googleSheetsAdapter } from '../adapters/google-sheets';
import { webhookAdapter } from '../adapters/webhook';
import { bigqueryAdapter } from '../adapters/bigquery';
import {
  assertDestinationsTenantContext,
  assertRecordsDeliverable,
  isUuid,
  validateDispatchDeliveryInput,
  validateFormattedDelivery,
  validateListDeliveriesQuery,
  validateListDestinationsQuery,
  validateRegisterDestinationInput,
  validateRetryDeliveryInput,
  validateTransportReceipt,
  DELIVERY_ACTION_KIND,
  DESTINATION_CATEGORIES,
  DESTINATION_PROVIDERS,
  EXPORT_FORBIDDING_USAGE_TAG,
} from '../validation';

function expectCode(code: DestinationsError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected DestinationsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof DestinationsError)) throw error;
    expect(error.code).toBe(code);
  }
}

const GOOD_CONTEXT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  authority: [],
};

const OBSERVATION_ID = '33333333-3333-4333-8333-333333333333';

// ---------------------------------------------------------------------------
// Tenant context + registration input
// ---------------------------------------------------------------------------

describe('destinations validation — context and registration', () => {
  it('accepts a well-formed TenantContext and rejects malformed ones', () => {
    expect(() => assertDestinationsTenantContext(GOOD_CONTEXT)).not.toThrow();
    expectCode('invalid_context', () => assertDestinationsTenantContext({ ...GOOD_CONTEXT, tenantId: '  ' }));
    expectCode('invalid_context', () => assertDestinationsTenantContext({ ...GOOD_CONTEXT, principalId: '' }));
    expectCode('invalid_context', () =>
      assertDestinationsTenantContext({ ...GOOD_CONTEXT, authority: 'admin' as unknown as string[] }),
    );
  });

  it('isUuid accepts uuids only', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('validates an oauth registration strictly (unknown keys, shapes)', () => {
    const valid = validateRegisterDestinationInput({
      provider: 'snowflake',
      providerAccountId: 'Acme-Prod',
      displayName: '  Acme Warehouse  ',
      authKind: 'oauth',
      credentialRef: 'secret-store://snowflake/acme',
      oauthScopes: ['warehouse.insert'],
      oauthExpiresAt: '2026-12-01T00:00:00Z',
    });
    expect(valid).toEqual({
      provider: 'snowflake',
      providerAccountId: 'Acme-Prod',
      displayName: 'Acme Warehouse',
      authKind: 'oauth',
      credentialRef: 'secret-store://snowflake/acme',
      oauthScopes: ['warehouse.insert'],
      oauthExpiresAt: '2026-12-01T00:00:00Z',
    });

    expectCode('invalid_destination_input', () =>
      validateRegisterDestinationInput({
        provider: 'carrier-pigeon',
        providerAccountId: 'x',
        authKind: 'credentials',
        credentialRef: 'r',
      } as never),
    );
    expectCode('invalid_destination_input', () =>
      validateRegisterDestinationInput({
        provider: 'webhook',
        providerAccountId: 'x',
        authKind: 'credentials',
        credentialRef: 'r',
        tenantId: GOOD_CONTEXT.tenantId,
      } as never),
    );
    expectCode('invalid_destination_input', () =>
      validateRegisterDestinationInput({ provider: 'webhook', providerAccountId: '', authKind: 'credentials', credentialRef: 'r' }),
    );
    expectCode('invalid_destination_input', () =>
      validateRegisterDestinationInput({ provider: 'webhook', providerAccountId: 'k', authKind: 'credentials', credentialRef: '' }),
    );
    expectCode('invalid_destination_input', () =>
      validateRegisterDestinationInput({ provider: 'webhook', providerAccountId: 'k', authKind: 'magic', credentialRef: 'r' } as never),
    );
  });

  it('keeps OAuth state and credentials isolation coherent', () => {
    // credentials auth must carry NO oauth state
    expectCode('invalid_destination_input', () =>
      validateRegisterDestinationInput({
        provider: 'webhook',
        providerAccountId: 'k',
        authKind: 'credentials',
        credentialRef: 'r',
        oauthScopes: ['push'],
      }),
    );
    expectCode('invalid_destination_input', () =>
      validateRegisterDestinationInput({
        provider: 'webhook',
        providerAccountId: 'k',
        authKind: 'credentials',
        credentialRef: 'r',
        oauthExpiresAt: '2026-12-01T00:00:00Z',
      }),
    );
    // oauth with a bogus expiry is rejected
    expectCode('invalid_destination_input', () =>
      validateRegisterDestinationInput({
        provider: 'snowflake',
        providerAccountId: 'k',
        authKind: 'oauth',
        credentialRef: 'r',
        oauthExpiresAt: 'soon',
      }),
    );
    // credentials alone is coherent
    expect(
      validateRegisterDestinationInput({
        provider: 'webhook',
        providerAccountId: 'k',
        authKind: 'credentials',
        credentialRef: 'r',
      }),
    ).toEqual({
      provider: 'webhook',
      providerAccountId: 'k',
      displayName: null,
      authKind: 'credentials',
      credentialRef: 'r',
      oauthScopes: [],
      oauthExpiresAt: null,
    });
  });

  it('validates list queries (provider/category/status vocabulary, limit)', () => {
    expect(
      validateListDestinationsQuery({ category: 'bi', limit: 10 }),
    ).toEqual({ provider: null, category: 'bi', status: null, limit: 10 });
    expectCode('invalid_destination_query', () => validateListDestinationsQuery({ provider: 'nope' } as never));
    expectCode('invalid_destination_query', () => validateListDestinationsQuery({ category: 'nosuch' } as never));
    expectCode('invalid_destination_query', () => validateListDestinationsQuery({ status: 'paused' } as never));
    expectCode('invalid_destination_query', () => validateListDestinationsQuery({ limit: 0 }));
    expectCode('invalid_destination_query', () => validateListDestinationsQuery({ limit: 501 }));
    expect(validateListDestinationsQuery({})).toEqual({
      provider: null,
      category: null,
      status: null,
      limit: 50,
    });
  });
});

// ---------------------------------------------------------------------------
// Dispatch inputs and delivery queries
// ---------------------------------------------------------------------------

describe('destinations validation — dispatch inputs', () => {
  const goodInput = {
    destinationId: GOOD_CONTEXT.tenantId,
    kind: 'findings.opportunities',
    records: [
      { recordId: 'opp-1', data: { name: 'Expand to EU', value: 42000 } },
      { recordId: 'opp-2', data: { name: 'Renew ACME', value: 18000 } },
    ],
    provenanceObservationIds: [OBSERVATION_ID],
    idempotencyKey: 'export-2026-09-14-001',
  };

  it('accepts a well-formed dispatch input unchanged', () => {
    expect(validateDispatchDeliveryInput(goodInput)).toEqual(goodInput);
    // defaults: no provenance, no idempotency key
    expect(
      validateDispatchDeliveryInput({
        destinationId: GOOD_CONTEXT.tenantId,
        kind: 'metrics.samples',
        records: [{ recordId: 'm-1', data: null }],
      }),
    ).toEqual({
      destinationId: GOOD_CONTEXT.tenantId,
      kind: 'metrics.samples',
      records: [{ recordId: 'm-1', data: null }],
      provenanceObservationIds: [],
      idempotencyKey: null,
    });
  });

  it('rejects malformed dispatch inputs with the input code', () => {
    expectCode('invalid_delivery_input', () => validateDispatchDeliveryInput('nope' as never));
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, destinationId: 'not-a-uuid' }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, kind: 'not a kind!' }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, kind: 'x'.repeat(129) }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, records: [] }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, records: 'nope' as never }),
    );
    // duplicate record ids
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({
        ...goodInput,
        records: [
          { recordId: 'opp-1', data: {} },
          { recordId: 'opp-1', data: {} },
        ],
      }),
    );
    // unknown keys on records can never smuggle extra state
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({
        ...goodInput,
        records: [{ recordId: 'opp-1', data: {}, extra: true } as never],
      }),
    );
    // non-JSON record data
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({
        ...goodInput,
        records: [{ recordId: 'opp-1', data: new Date(0) }],
      }),
    );
    // provenance ids must be uuids, unique, ≤ 32
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, provenanceObservationIds: ['nope'] }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({
        ...goodInput,
        provenanceObservationIds: [OBSERVATION_ID, OBSERVATION_ID],
      }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({
        ...goodInput,
        provenanceObservationIds: Array.from({ length: 33 }, () => OBSERVATION_ID.replace(/3/g, '4')),
      }),
    );
    // idempotency keys follow the actions module's dedupe-key discipline
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, idempotencyKey: '-nope' }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, idempotencyKey: 'has spaces' }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({ ...goodInput, idempotencyKey: 'x'.repeat(201) }),
    );
  });

  it('caps the serialized batch size (large artifacts belong in object storage)', () => {
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({
        ...goodInput,
        records: [{ recordId: 'big', data: { blob: 'x'.repeat(1_048_576) } }],
      }),
    );
    expectCode('invalid_delivery_input', () =>
      validateDispatchDeliveryInput({
        ...goodInput,
        records: Array.from({ length: 201 }, (_, index) => ({ recordId: `r-${index}`, data: {} })),
      }),
    );
  });

  it('validates delivery queries', () => {
    expect(validateRetryDeliveryInput({ deliveryId: OBSERVATION_ID })).toEqual({ deliveryId: OBSERVATION_ID });
    expectCode('invalid_delivery_input', () => validateRetryDeliveryInput({ deliveryId: 'x' }));
    expectCode('invalid_delivery_input', () => validateRetryDeliveryInput({ deliveryId: 'x', extra: 1 } as never));

    expect(
      validateListDeliveriesQuery({ destinationId: GOOD_CONTEXT.tenantId, status: 'failed', limit: 5 }),
    ).toEqual({ destinationId: GOOD_CONTEXT.tenantId, provider: null, kind: null, status: 'failed', limit: 5 });
    expectCode('invalid_delivery_query', () => validateListDeliveriesQuery({ provider: 'nope' } as never));
    expectCode('invalid_delivery_query', () => validateListDeliveriesQuery({ status: 'lost' } as never));
    expectCode('invalid_delivery_query', () => validateListDeliveriesQuery({ destinationId: 'x' }));
    expectCode('invalid_delivery_query', () => validateListDeliveriesQuery({ kind: 'not a kind!' }));
  });
});

// ---------------------------------------------------------------------------
// Provider-bound content constraint + adapter/transport output guards
// ---------------------------------------------------------------------------

describe('destinations validation — content constraint and boundary guards', () => {
  it('structured providers require object-shaped record data; envelope providers accept any JSON', () => {
    const objectRecords = [{ recordId: 'r-1', data: { value: 42 } }];
    const scalarRecords = [{ recordId: 'r-1', data: 42 }];
    expect(() => assertRecordsDeliverable(true, objectRecords)).not.toThrow();
    expectCode('invalid_delivery_records', () => assertRecordsDeliverable(true, scalarRecords));
    expectCode('invalid_delivery_records', () =>
      assertRecordsDeliverable(true, [{ recordId: 'r-1', data: [1, 2] }]),
    );
    expect(() => assertRecordsDeliverable(false, scalarRecords)).not.toThrow();
    expect(() => assertRecordsDeliverable(false, objectRecords)).not.toThrow();
  });

  it('validates adapter envelopes strictly (transport-boundary defense in depth)', () => {
    expect(validateFormattedDelivery({ shape: 'rows', body: { table: 't', rows: [] } })).toEqual({
      shape: 'rows',
      body: { table: 't', rows: [] },
    });
    expectCode('invalid_envelope', () => validateFormattedDelivery('nope'));
    expectCode('invalid_envelope', () => validateFormattedDelivery({ shape: 'blob', body: {} } as never));
    expectCode('invalid_envelope', () => validateFormattedDelivery({ shape: 'rows' } as never));
    expectCode('invalid_envelope', () => validateFormattedDelivery({ shape: 'rows', body: new Date(0) }));
    expectCode('invalid_envelope', () =>
      validateFormattedDelivery({ shape: 'rows', body: {}, extra: 1 } as never),
    );
    expectCode('invalid_envelope', () =>
      validateFormattedDelivery({ shape: 'rows', body: 'x'.repeat(2_097_153) }),
    );
  });

  it('validates transport receipts strictly (outcome vocabulary, shapes, expiries)', () => {
    expect(
      validateTransportReceipt({ status: 'delivered', providerDeliveryId: 'ack-1', detail: 'ok' }),
    ).toEqual({ status: 'delivered', providerDeliveryId: 'ack-1', detail: 'ok', authorizationExpiresAt: null });
    expect(validateTransportReceipt({ status: 'failed' })).toEqual({
      status: 'failed',
      providerDeliveryId: null,
      detail: null,
      authorizationExpiresAt: null,
    });
    expectCode('invalid_transport_receipt', () => validateTransportReceipt('nope'));
    expectCode('invalid_transport_receipt', () => validateTransportReceipt({ status: 'maybe' } as never));
    expectCode('invalid_transport_receipt', () =>
      validateTransportReceipt({ status: 'delivered', providerDeliveryId: '' }),
    );
    expectCode('invalid_transport_receipt', () =>
      validateTransportReceipt({ status: 'delivered', providerDeliveryId: 'x'.repeat(256) }),
    );
    expectCode('invalid_transport_receipt', () =>
      validateTransportReceipt({ status: 'delivered', authorizationExpiresAt: 'soon' }),
    );
    expectCode('invalid_transport_receipt', () =>
      validateTransportReceipt({ status: 'delivered', detail: 5 } as never),
    );
    expectCode('invalid_transport_receipt', () =>
      validateTransportReceipt({ status: 'delivered', extra: 1 } as never),
    );
    // overlong detail is truncated, not rejected (audit stays bounded)
    expect(
      validateTransportReceipt({ status: 'failed', detail: 'x'.repeat(3000) }).detail?.length,
    ).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Adapter registry, category matrix, formatting conventions
// ---------------------------------------------------------------------------

describe('destinations adapters — registry and matrix', () => {
  it('covers the closed provider vocabulary exactly (exhaustiveness guard)', () => {
    const registered = allDestinationAdapters().map((adapter) => adapter.provider).sort();
    expect(registered).toEqual([...DESTINATION_PROVIDERS].sort());
    for (const provider of DESTINATION_PROVIDERS) {
      expect(getDestinationAdapter(provider).provider).toBe(provider);
    }
    expectCode('unsupported_provider', () => getDestinationAdapter('carrier-pigeon'));
  });

  it('declares the six work-item categories coherently', () => {
    const categoryOf = (provider: string): string => getDestinationAdapter(provider).category;
    expect(categoryOf('looker')).toBe('bi');
    expect(categoryOf('tableau')).toBe('bi');
    expect(categoryOf('power-bi')).toBe('bi');
    expect(categoryOf('snowflake')).toBe('warehouse');
    expect(categoryOf('bigquery')).toBe('warehouse');
    expect(categoryOf('redshift')).toBe('warehouse');
    expect(categoryOf('salesforce')).toBe('crm-erp');
    expect(categoryOf('hubspot')).toBe('crm-erp');
    expect(categoryOf('netsuite')).toBe('crm-erp');
    expect(categoryOf('google-sheets')).toBe('spreadsheet');
    expect(categoryOf('airtable')).toBe('spreadsheet');
    expect(categoryOf('http-api')).toBe('api');
    expect(categoryOf('webhook')).toBe('webhook');
    const covered = new Set(allDestinationAdapters().map((adapter) => adapter.category));
    expect([...covered].sort()).toEqual([...DESTINATION_CATEGORIES].sort());
  });

  it('marks structured stores as object-record providers; envelope providers accept anything', () => {
    for (const adapter of allDestinationAdapters()) {
      const envelopeStyle = adapter.provider === 'http-api' || adapter.provider === 'webhook';
      expect(adapter.requiresObjectRecords).toBe(!envelopeStyle);
    }
  });
});

describe('destinations adapters — account normalization', () => {
  it('normalizes account ids per provider convention', () => {
    expect(salesforceAdapter.normalizeAccountId('  00dxx0000000001 ')).toBe('00DXX0000000001');
    expect(snowflakeAdapter.normalizeAccountId('  Acme-Prod ')).toBe('acme-prod');
    expect(bigqueryAdapter.normalizeAccountId('Acme.Prod')).toBe('acme.prod');
    expect(googleSheetsAdapter.normalizeAccountId('Sheet-1')).toBe('sheet-1');
    // endpoint addresses are case-sensitive — trim only
    expect(httpApiAdapter.normalizeAccountId('  https://api.acme.com/v1/exports ')).toBe(
      'https://api.acme.com/v1/exports',
    );
    expect(webhookAdapter.normalizeAccountId('https://hooks.acme.com/aurum')).toBe(
      'https://hooks.acme.com/aurum',
    );
  });

  it('rejects empty account ids with the canonical input code', () => {
    for (const adapter of allDestinationAdapters()) {
      expectCode('invalid_destination_input', () => adapter.normalizeAccountId('   '));
    }
  });
});

describe('destinations adapters — envelope conventions', () => {
  const batch = {
    deliveryId: '99999999-9999-4999-8999-999999999999',
    attempt: 2,
    kind: 'findings.opportunities',
    records: [
      { recordId: 'opp-1', data: { name: 'Expand to EU', value: 42000 } },
      { recordId: 'opp-2', data: { name: 'Renew ACME', value: 18000 } },
    ],
  };

  it('composes each provider envelope from the canonical batch deterministically', () => {
    // warehouses
    expect(snowflakeAdapter.formatDelivery(batch)).toEqual({
      shape: 'rows',
      body: {
        table: 'findings.opportunities',
        rows: [
          { name: 'Expand to EU', value: 42000 },
          { name: 'Renew ACME', value: 18000 },
        ],
      },
    });
    expect(bigqueryAdapter.formatDelivery(batch)).toEqual({
      shape: 'rows',
      body: {
        table: 'findings.opportunities',
        rows: [
          { json: { name: 'Expand to EU', value: 42000 } },
          { json: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
    expect(getDestinationAdapter('redshift').formatDelivery(batch)).toEqual({
      shape: 'rows',
      body: {
        table: 'findings.opportunities',
        rows: [
          { externalId: 'opp-1', fields: { name: 'Expand to EU', value: 42000 } },
          { externalId: 'opp-2', fields: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
    // BI
    expect(getDestinationAdapter('looker').formatDelivery(batch)).toEqual({
      shape: 'rows',
      body: {
        dataset: 'findings.opportunities',
        points: [
          { id: 'opp-1', fields: { name: 'Expand to EU', value: 42000 } },
          { id: 'opp-2', fields: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
    expect(getDestinationAdapter('tableau').formatDelivery(batch)).toEqual({
      shape: 'rows',
      body: {
        datasource: 'findings.opportunities',
        rows: [
          { name: 'Expand to EU', value: 42000 },
          { name: 'Renew ACME', value: 18000 },
        ],
      },
    });
    // CRM/ERP
    expect(salesforceAdapter.formatDelivery(batch)).toEqual({
      shape: 'records',
      body: {
        object: 'findings.opportunities',
        upsert: [
          { externalId: 'opp-1', fields: { name: 'Expand to EU', value: 42000 } },
          { externalId: 'opp-2', fields: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
    expect(getDestinationAdapter('hubspot').formatDelivery(batch)).toEqual({
      shape: 'records',
      body: {
        object: 'findings.opportunities',
        inputs: [
          { idempotencyKey: 'opp-1', properties: { name: 'Expand to EU', value: 42000 } },
          { idempotencyKey: 'opp-2', properties: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
    expect(getDestinationAdapter('netsuite').formatDelivery(batch)).toEqual({
      shape: 'records',
      body: {
        recordType: 'findings.opportunities',
        items: [
          { externalId: 'opp-1', fields: { name: 'Expand to EU', value: 42000 } },
          { externalId: 'opp-2', fields: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
    // spreadsheets
    expect(googleSheetsAdapter.formatDelivery(batch)).toEqual({
      shape: 'rows',
      body: {
        range: 'findings.opportunities',
        values: [
          ['Expand to EU', 42000], // cell order: sorted field names (name, value)
          ['Renew ACME', 18000],
        ],
      },
    });
    expect(getDestinationAdapter('airtable').formatDelivery(batch)).toEqual({
      shape: 'records',
      body: {
        table: 'findings.opportunities',
        records: [
          { fields: { name: 'Expand to EU', value: 42000 } },
          { fields: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
    // API + webhook carry delivery/attempt stamps for receiver-side dedupe
    expect(httpApiAdapter.formatDelivery(batch)).toEqual({
      shape: 'records',
      body: {
        type: 'findings.opportunities',
        deliveryId: batch.deliveryId,
        attempt: 2,
        items: [
          { recordId: 'opp-1', data: { name: 'Expand to EU', value: 42000 } },
          { recordId: 'opp-2', data: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
    expect(webhookAdapter.formatDelivery(batch)).toEqual({
      shape: 'event',
      body: {
        event: 'findings.opportunities',
        deliveryId: batch.deliveryId,
        attempt: 2,
        records: [
          { recordId: 'opp-1', data: { name: 'Expand to EU', value: 42000 } },
          { recordId: 'opp-2', data: { name: 'Renew ACME', value: 18000 } },
        ],
      },
    });
  });

  it('every adapter output passes the transport-port guard (provider isolation discipline)', () => {
    for (const adapter of allDestinationAdapters()) {
      const formatted = (adapter as DestinationAdapter).formatDelivery(batch);
      expect(() => validateFormattedDelivery(formatted)).not.toThrow();
    }
  });

  it('envelope-style adapters accept any plain-JSON record data', () => {
    const scalarBatch = {
      ...batch,
      records: [{ recordId: 'r-1', data: 42 }, { recordId: 'r-2', data: [1, 2, 3] }],
    };
    expect(() => httpApiAdapter.formatDelivery(scalarBatch)).not.toThrow();
    expect(() => webhookAdapter.formatDelivery(scalarBatch)).not.toThrow();
    expect(webhookAdapter.formatDelivery(scalarBatch).shape).toBe('event');
  });
});

// ---------------------------------------------------------------------------
// Gate vocabulary
// ---------------------------------------------------------------------------

describe('destinations — authority-gate vocabulary', () => {
  it('anchors the §20 action kind and the evidence-level export tag', () => {
    // W009's CANONICAL_ACTION_KINDS enumerates 'data-export'; W037
    // registers its kind by using it (the actions module's open kind
    // namespace).
    expect(DELIVERY_ACTION_KIND).toBe('data-export');
    // the W004 usage-constraint tag this module consumes
    expect(EXPORT_FORBIDDING_USAGE_TAG).toBe('no-export');
  });
});
