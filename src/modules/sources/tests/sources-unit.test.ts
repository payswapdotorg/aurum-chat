// Unit tests for the sources module's pure logic (no database): input
// validation/normalization, canonical-record/fetch-result guards, the
// checkpoint predicate, and EVERY provider adapter's parse/normalize
// behavior.
//
// W036 acceptance covered here:
//  * canonical adapters exist for all thirteen providers (the module's
//    closed provider vocabulary) with an explicit polling/webhook mode
//    matrix;
//  * provider envelopes normalize into canonical records (account ids,
//    record ids, kinds, payloads, event times) and malformed or
//    recognized-but-non-record envelopes fail with the canonical error
//    codes;
//  * provider isolation: adapter files are reachable only inside the
//    module (tests import them directly — the contract never exposes them)
//    and the registry is closed over the provider vocabulary.

import { describe, expect, it } from 'vitest';
import { SourcesError } from '../errors';
import { allSourceAdapters, getSourceAdapter } from '../adapters';
import { confluenceAdapter } from '../adapters/confluence';
import { githubAdapter } from '../adapters/github';
import { googleCalendarAdapter } from '../adapters/google-calendar';
import { googleDriveAdapter } from '../adapters/google-drive';
import { hubspotAdapter } from '../adapters/hubspot';
import { jiraAdapter } from '../adapters/jira';
import { linearAdapter } from '../adapters/linear';
import { notionAdapter } from '../adapters/notion';
import { quickbooksAdapter } from '../adapters/quickbooks';
import { salesforceAdapter } from '../adapters/salesforce';
import { stripeAdapter } from '../adapters/stripe';
import { zendeskAdapter } from '../adapters/zendesk';
import { zapierAdapter } from '../adapters/zapier';
import type { SourceAdapter } from '../adapters/types';
import {
  assertSourcesTenantContext,
  cursorAdvance,
  isUuid,
  SOURCE_PROVIDERS,
  validateFetchResult,
  validateListSourceCheckpointsQuery,
  validateListSourcesQuery,
  validatePollSourceInput,
  validateReceiveWebhookInput,
  validateRegisterSourceInput,
  validateReplaySourceInput,
  validateSetSourceStatusInput,
  validateWebhookParseResult,
} from '../validation';

function expectCode(code: SourcesError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected SourcesError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof SourcesError)) throw error;
    expect(error.code).toBe(code);
  }
}

const GOOD_CONTEXT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  authority: [],
};

// ---------------------------------------------------------------------------
// Tenant context + registration input
// ---------------------------------------------------------------------------

describe('sources validation — context and registration', () => {
  it('accepts a well-formed TenantContext and rejects malformed ones', () => {
    expect(() => assertSourcesTenantContext(GOOD_CONTEXT)).not.toThrow();
    expectCode('invalid_context', () => assertSourcesTenantContext({ ...GOOD_CONTEXT, tenantId: '  ' }));
    expectCode('invalid_context', () => assertSourcesTenantContext({ ...GOOD_CONTEXT, principalId: '' }));
    expectCode('invalid_context', () =>
      assertSourcesTenantContext({ ...GOOD_CONTEXT, authority: 'admin' as unknown as string[] }),
    );
  });

  it('isUuid accepts uuids only', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('validates an oauth registration strictly (unknown keys, shapes)', () => {
    const valid = validateRegisterSourceInput({
      provider: 'salesforce',
      providerAccountId: '00Dxx0000000001',
      displayName: '  Acme CRM  ',
      authKind: 'oauth',
      credentialRef: 'secret-store://salesforce/acme',
      oauthScopes: ['crm.read', 'objects.read'],
      oauthExpiresAt: '2026-12-01T00:00:00Z',
    });
    expect(valid).toEqual({
      provider: 'salesforce',
      providerAccountId: '00Dxx0000000001',
      displayName: 'Acme CRM',
      authKind: 'oauth',
      credentialRef: 'secret-store://salesforce/acme',
      oauthScopes: ['crm.read', 'objects.read'],
      oauthExpiresAt: '2026-12-01T00:00:00Z',
    });

    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'carrier-pigeon',
        providerAccountId: 'x',
        authKind: 'credentials',
        credentialRef: 'r',
      } as never),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'jira',
        providerAccountId: 'x',
        authKind: 'credentials',
        credentialRef: 'r',
        tenantId: GOOD_CONTEXT.tenantId,
      } as never),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({ provider: 'jira', providerAccountId: '', authKind: 'credentials', credentialRef: 'r' }),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({ provider: 'jira', providerAccountId: 'k', authKind: 'credentials', credentialRef: '' }),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({ provider: 'jira', providerAccountId: 'k', authKind: 'magic', credentialRef: 'r' } as never),
    );
  });

  it('keeps OAuth state and credentials isolation coherent', () => {
    // credentials auth must carry NO oauth state
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'jira',
        providerAccountId: 'k',
        authKind: 'credentials',
        credentialRef: 'r',
        oauthScopes: ['read'],
      }),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'jira',
        providerAccountId: 'k',
        authKind: 'credentials',
        credentialRef: 'r',
        oauthExpiresAt: '2026-12-01T00:00:00Z',
      }),
    );
    // oauth auth must declare scopes
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'jira',
        providerAccountId: 'k',
        authKind: 'oauth',
        credentialRef: 'r',
      }),
    );
    // scopes: deduped, bounded, printable
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'jira',
        providerAccountId: 'k',
        authKind: 'oauth',
        credentialRef: 'r',
        oauthScopes: ['read', 'read'],
      }),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'jira',
        providerAccountId: 'k',
        authKind: 'oauth',
        credentialRef: 'r',
        oauthScopes: Array.from({ length: 33 }, (_, i) => `scope-${i}`),
      }),
    );
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'jira',
        providerAccountId: 'k',
        authKind: 'oauth',
        credentialRef: 'r',
        oauthScopes: [42 as unknown as string],
      }),
    );
    // expiry must be strict ISO with offset
    expectCode('invalid_source_input', () =>
      validateRegisterSourceInput({
        provider: 'jira',
        providerAccountId: 'k',
        authKind: 'oauth',
        credentialRef: 'r',
        oauthScopes: ['read'],
        oauthExpiresAt: 'December 1, 2026',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Query / operation inputs
// ---------------------------------------------------------------------------

describe('sources validation — queries and operation inputs', () => {
  it('validates list queries (filters, limits)', () => {
    expect(validateListSourcesQuery({})).toEqual({ provider: null, status: null, limit: 50 });
    expect(validateListSourcesQuery({ provider: 'stripe', status: 'active', limit: 500 })).toEqual({
      provider: 'stripe',
      status: 'active',
      limit: 500,
    });
    expectCode('invalid_source_query', () => validateListSourcesQuery({ provider: 'nope' } as never));
    expectCode('invalid_source_query', () => validateListSourcesQuery({ status: 'paused' } as never));
    expectCode('invalid_source_query', () => validateListSourcesQuery({ limit: 0 }));
    expectCode('invalid_source_query', () => validateListSourcesQuery({ limit: 501 }));
    expectCode('invalid_source_query', () => validateListSourcesQuery({ limit: 1.5 }));
  });

  it('validates status/poll/checkpoint/replay inputs', () => {
    expectCode('invalid_source_input', () =>
      validateSetSourceStatusInput({ sourceId: 'nope', status: 'disabled' }),
    );
    expectCode('invalid_source_input', () =>
      validateSetSourceStatusInput({ sourceId: GOOD_CONTEXT.tenantId, status: 'paused' } as never),
    );

    expect(validatePollSourceInput({ sourceId: GOOD_CONTEXT.tenantId })).toEqual({
      sourceId: GOOD_CONTEXT.tenantId,
      maxRecords: 50,
    });
    expect(validatePollSourceInput({ sourceId: GOOD_CONTEXT.tenantId, maxRecords: 200 })).toEqual({
      sourceId: GOOD_CONTEXT.tenantId,
      maxRecords: 200,
    });
    expectCode('invalid_source_input', () => validatePollSourceInput({ sourceId: 'x' }));
    expectCode('invalid_source_input', () =>
      validatePollSourceInput({ sourceId: GOOD_CONTEXT.tenantId, maxRecords: 201 }),
    );

    expect(validateListSourceCheckpointsQuery({ sourceId: GOOD_CONTEXT.tenantId, limit: 10 })).toEqual({
      sourceId: GOOD_CONTEXT.tenantId,
      limit: 10,
    });
    expectCode('invalid_source_query', () => validateListSourceCheckpointsQuery({ sourceId: 'x' }));

    // replay: exactly one target
    expectCode('invalid_source_input', () =>
      validateReplaySourceInput({ sourceId: GOOD_CONTEXT.tenantId }),
    );
    expectCode('invalid_source_input', () =>
      validateReplaySourceInput({ sourceId: GOOD_CONTEXT.tenantId, checkpointId: GOOD_CONTEXT.principalId, fromStart: true }),
    );
    expectCode('invalid_source_input', () =>
      validateReplaySourceInput({ sourceId: GOOD_CONTEXT.tenantId, checkpointId: 'not-a-uuid' }),
    );
    expect(
      validateReplaySourceInput({ sourceId: GOOD_CONTEXT.tenantId, fromStart: true }),
    ).toEqual({ sourceId: GOOD_CONTEXT.tenantId, checkpointId: null, fromStart: true });
  });

  it('webhook inputs require a known provider and an object payload', () => {
    expect(validateReceiveWebhookInput({ provider: 'stripe', payload: { id: 'evt_1' } })).toEqual({
      provider: 'stripe',
    });
    expectCode('invalid_source_input', () =>
      validateReceiveWebhookInput({ provider: 'nope', payload: {} } as never),
    );
    expectCode('invalid_provider_payload', () =>
      validateReceiveWebhookInput({ provider: 'stripe', payload: [] }),
    );
    expectCode('invalid_provider_payload', () =>
      validateReceiveWebhookInput({ provider: 'stripe', payload: 'evt_1' }),
    );
    expectCode('invalid_source_input', () => validateReceiveWebhookInput({ payload: {} } as never));
  });
});

// ---------------------------------------------------------------------------
// Canonical records, batches, fetch results, webhook parse results
// ---------------------------------------------------------------------------

describe('sources validation — canonical records and transport output', () => {
  const goodRecord = {
    providerRecordId: 'rec-0001',
    kind: 'crm.opportunity.updated',
    payload: { amount: 4200, stage: 'Closed Won' },
    occurredAt: '2026-09-14T10:15:00Z',
  };

  it('accepts a well-formed canonical record', () => {
    expect(validateWebhookParseResult({ providerAccountId: 'acct-1', records: [goodRecord] })).toEqual({
      providerAccountId: 'acct-1',
      records: [goodRecord],
    });
  });

  it('rejects malformed records with the context-appropriate code', () => {
    expectCode('invalid_provider_payload', () =>
      validateWebhookParseResult({ providerAccountId: 'a', records: [{ ...goodRecord, providerRecordId: '' }] }),
    );
    expectCode('invalid_provider_payload', () =>
      validateWebhookParseResult({ providerAccountId: 'a', records: [{ ...goodRecord, kind: 'not a kind!' }] }),
    );
    expectCode('invalid_provider_payload', () =>
      validateWebhookParseResult({ providerAccountId: 'a', records: [{ ...goodRecord, payload: null }] }),
    );
    expectCode('invalid_provider_payload', () =>
      validateWebhookParseResult({ providerAccountId: 'a', records: [{ ...goodRecord, occurredAt: 'yesterday' }] }),
    );
    // unknown keys can never smuggle extra provider state into a record
    expectCode('invalid_provider_payload', () =>
      validateWebhookParseResult({
        providerAccountId: 'a',
        records: [{ ...goodRecord, providerEnvelope: { secret: true } }],
      }),
    );
    // non-JSON payload values are rejected (a Date instance would serialize
    // deceptively)
    expectCode('invalid_provider_payload', () =>
      validateWebhookParseResult({
        providerAccountId: 'a',
        records: [{ ...goodRecord, payload: new Date(0) }],
      }),
    );
  });

  it('rejects duplicate record ids within one batch', () => {
    expectCode('invalid_provider_payload', () =>
      validateWebhookParseResult({ providerAccountId: 'a', records: [goodRecord, goodRecord] }),
    );
    expectCode('invalid_fetch_result', () =>
      validateFetchResult({ records: [goodRecord, goodRecord], nextCursor: null, hasMore: false }),
    );
  });

  it('validates fetch results strictly (transport output defense in depth)', () => {
    expect(
      validateFetchResult({
        records: [goodRecord],
        nextCursor: 'cursor-2',
        hasMore: true,
        authorizationExpiresAt: '2026-12-01T00:00:00Z',
      }),
    ).toEqual({
      records: [goodRecord],
      nextCursor: 'cursor-2',
      hasMore: true,
      authorizationExpiresAt: '2026-12-01T00:00:00Z',
    });
    expectCode('invalid_fetch_result', () => validateFetchResult('nope'));
    expectCode('invalid_fetch_result', () =>
      validateFetchResult({ records: [], nextCursor: 'c', hasMore: 'yes' } as never),
    );
    expectCode('invalid_fetch_result', () =>
      validateFetchResult({ records: [], nextCursor: 'c', hasMore: false, extra: 1 } as never),
    );
    expectCode('invalid_fetch_result', () =>
      validateFetchResult({ records: [], nextCursor: 'cur\u0000sor', hasMore: false }),
    );
    expectCode('invalid_fetch_result', () =>
      validateFetchResult({
        records: [],
        nextCursor: null,
        hasMore: false,
        authorizationExpiresAt: 'soon',
      }),
    );
  });

  it('cursorAdvance moves only on a genuinely new cursor', () => {
    expect(cursorAdvance(null, 'c1')).toBe(true);
    expect(cursorAdvance('c1', 'c2')).toBe(true);
    expect(cursorAdvance('c1', 'c1')).toBe(false);
    expect(cursorAdvance('c1', null)).toBe(false);
    expect(cursorAdvance(null, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adapter registry and mode matrix
// ---------------------------------------------------------------------------

describe('sources adapters — registry and modes', () => {
  it('covers the closed provider vocabulary exactly (exhaustiveness guard)', () => {
    const registered = allSourceAdapters().map((adapter) => adapter.provider).sort();
    expect(registered).toEqual([...SOURCE_PROVIDERS].sort());
    for (const provider of SOURCE_PROVIDERS) {
      expect(getSourceAdapter(provider).provider).toBe(provider);
    }
    expectCode('unsupported_provider', () => getSourceAdapter('carrier-pigeon'));
  });

  it('declares a coherent mode matrix (poll-only, webhook-only, both)', () => {
    const modesOf = (adapter: SourceAdapter) => [...adapter.modes].sort().join('+');
    expect(modesOf(getSourceAdapter('linear'))).toBe('polling');
    expect(modesOf(getSourceAdapter('notion'))).toBe('polling');
    expect(modesOf(getSourceAdapter('google-drive'))).toBe('polling');
    expect(modesOf(getSourceAdapter('google-calendar'))).toBe('polling');
    expect(modesOf(getSourceAdapter('quickbooks'))).toBe('polling');
    expect(modesOf(getSourceAdapter('zapier'))).toBe('webhook');
    expect(modesOf(getSourceAdapter('salesforce'))).toBe('polling+webhook');
    expect(modesOf(getSourceAdapter('stripe'))).toBe('polling+webhook');
    for (const adapter of allSourceAdapters()) {
      expect(adapter.modes.length).toBeGreaterThan(0);
    }
  });

  it('polling-only providers reject webhook envelopes with ingestion_mode_unsupported', () => {
    for (const adapter of [linearAdapter, notionAdapter, googleDriveAdapter, googleCalendarAdapter, quickbooksAdapter]) {
      expectCode('ingestion_mode_unsupported', () => adapter.parseWebhook({ anything: true }));
    }
  });
});

// ---------------------------------------------------------------------------
// Provider adapter behavior
// ---------------------------------------------------------------------------

describe('sources adapters — provider envelopes', () => {
  it('salesforce: normalizes org ids and parses change events', () => {
    expect(salesforceAdapter.normalizeAccountId('  00dxx0000000001 ')).toBe('00DXX0000000001');
    const parsed = salesforceAdapter.parseWebhook({
      organizationId: '00Dxx0000000001',
      events: [
        {
          id: 'evt-1',
          changeType: 'UPDATE',
          entity: 'Opportunity',
          occurredAt: '2026-09-14T10:15:00Z',
          record: { id: '006xx1', amount: 4200 },
        },
        {
          id: 'evt-2',
          changeType: 'CREATE',
          entity: 'Case',
          occurredAt: '2026-09-14T10:16:30Z',
          record: { id: '500xx2' },
        },
      ],
    });
    expect(parsed.providerAccountId).toBe('00DXX0000000001');
    expect(parsed.records).toEqual([
      {
        providerRecordId: 'evt-1',
        kind: 'crm.opportunity.updated',
        payload: { entity: 'Opportunity', changeType: 'UPDATE', record: { id: '006xx1', amount: 4200 } },
        occurredAt: '2026-09-14T10:15:00Z',
      },
      {
        providerRecordId: 'evt-2',
        kind: 'support.case.created',
        payload: { entity: 'Case', changeType: 'CREATE', record: { id: '500xx2' } },
        occurredAt: '2026-09-14T10:16:30Z',
      },
    ]);
    expectCode('unsupported_provider_event', () =>
      salesforceAdapter.parseWebhook({ organizationId: '00Dxx', handshake: 'ready' }),
    );
    expectCode('invalid_provider_payload', () => salesforceAdapter.parseWebhook({ organizationId: '00Dxx' }));
  });

  it('hubspot: digits-only portals, subscription mapping, url_verification handshake', () => {
    expect(hubspotAdapter.normalizeAccountId(' 12345 ')).toBe('12345');
    expectCode('invalid_source_input', () => hubspotAdapter.normalizeAccountId('portal-one'));
    const parsed = hubspotAdapter.parseWebhook({
      portalId: 12345,
      subscriptionType: 'deal.propertyChange',
      events: [
        { id: 'hse-1', occurredAt: '2026-09-14T09:00:00Z', objectId: 987, properties: { dealstage: 'CLOSE WON' } },
      ],
    });
    expect(parsed.providerAccountId).toBe('12345');
    expect(parsed.records[0]).toEqual({
      providerRecordId: 'hse-1',
      kind: 'crm.deal.updated',
      payload: { subscriptionType: 'deal.propertyChange', objectId: '987', properties: { dealstage: 'CLOSE WON' } },
      occurredAt: '2026-09-14T09:00:00Z',
    });
    expectCode('unsupported_provider_event', () =>
      hubspotAdapter.parseWebhook({ portalId: 12345, subscriptionType: 'url_verification', events: [] }),
    );
    expectCode('invalid_provider_payload', () =>
      hubspotAdapter.parseWebhook({ portalId: 'abc', subscriptionType: 'contact.creation', events: [] }),
    );
  });

  it('zendesk: lowercases subdomains and maps ticket types', () => {
    expect(zendeskAdapter.normalizeAccountId('Acme')).toBe('acme');
    const parsed = zendeskAdapter.parseWebhook({
      subdomain: 'acme',
      events: [
        { id: 'zd-1', type: 'Ticket Created', occurredAt: '2026-09-14T08:00:00Z', ticket: { id: '91', subject: 'Printer on fire' } },
      ],
    });
    expect(parsed.records[0]!.kind).toBe('support.ticket.created');
    expectCode('invalid_provider_payload', () =>
      zendeskAdapter.parseWebhook({ subdomain: 'acme', events: [{ id: 'zd-2', type: 'Unicorn Created', occurredAt: '2026-09-14T08:00:00Z', ticket: { id: '92' } }] }),
    );
  });

  it('jira: keeps client keys verbatim and maps issue events', () => {
    expect(jiraAdapter.normalizeAccountId(' jira-acme-key ')).toBe('jira-acme-key');
    const parsed = jiraAdapter.parseWebhook({
      clientKey: 'jira-acme-key',
      events: [
        { id: 'je-1', event: 'issue_created', occurredAt: '2026-09-14T07:30:00Z', issue: { key: 'ACME-7', summary: 'Fix billing' } },
        { id: 'je-2', event: 'comment_added', occurredAt: '2026-09-14T07:31:00Z', issue: { key: 'ACME-7' }, comment: { body: 'Reproduced' } },
      ],
    });
    expect(parsed.providerAccountId).toBe('jira-acme-key');
    expect(parsed.records.map((r) => r.kind)).toEqual(['issue.created', 'issue.comment.created']);
    expectCode('invalid_provider_payload', () =>
      jiraAdapter.parseWebhook({ clientKey: 'k', events: [{ id: 'x', event: 'sprint_started', occurredAt: '2026-09-14T07:30:00Z', issue: { key: 'A-1' } }] }),
    );
  });

  it('confluence: lowercases cloud ids and maps content events', () => {
    expect(confluenceAdapter.normalizeAccountId('Cloud-9')).toBe('cloud-9');
    const parsed = confluenceAdapter.parseWebhook({
      cloudId: 'cloud-9',
      events: [
        { id: 'ce-1', event: 'page_updated', occurredAt: '2026-09-14T06:00:00Z', content: { id: 'p1', title: 'Runbook', version: 4 } },
      ],
    });
    expect(parsed.records[0]).toEqual({
      providerRecordId: 'ce-1',
      kind: 'document.updated',
      payload: { event: 'page_updated', content: { id: 'p1', title: 'Runbook', version: 4 } },
      occurredAt: '2026-09-14T06:00:00Z',
    });
  });

  it('github: lowercases logins, classifies issues/pull requests/pushes, rejects pings', () => {
    expect(githubAdapter.normalizeAccountId(' Acme-Ops ')).toBe('acme-ops');
    const issue = githubAdapter.parseWebhook({
      installation: { account: { login: 'Acme-Ops' } },
      deliveryId: 'gh-delivery-1',
      event: 'issues',
      action: 'opened',
      occurredAt: '2026-09-14T05:00:00Z',
      issue: { number: 7, title: 'Investigate churn' },
    });
    expect(issue.providerAccountId).toBe('acme-ops');
    expect(issue.records[0]).toEqual({
      providerRecordId: 'gh-delivery-1',
      kind: 'issue.opened',
      payload: { event: 'issues', issue: { number: 7, title: 'Investigate churn' }, action: 'opened' },
      occurredAt: '2026-09-14T05:00:00Z',
    });
    const push = githubAdapter.parseWebhook({
      installation: { account: { login: 'acme-ops' } },
      deliveryId: 'gh-delivery-2',
      event: 'push',
      occurredAt: '2026-09-14T05:05:00Z',
      commits: [{ sha: 'abc' }],
      after: 'def',
    });
    expect(push.records[0]!.kind).toBe('code.pushed');
    expect(push.records[0]!.payload).toEqual({ event: 'push', commits: [{ sha: 'abc' }], after: 'def' });
    expectCode('unsupported_provider_event', () =>
      githubAdapter.parseWebhook({ zen: 'keep it simple', hook_id: 1 }),
    );
    expectCode('invalid_provider_payload', () =>
      githubAdapter.parseWebhook({
        installation: { account: { login: 'acme-ops' } },
        deliveryId: 'd3',
        event: 'issues',
        action: 'labeled',
        occurredAt: '2026-09-14T05:00:00Z',
      }),
    );
  });

  it('stripe: lowercases accounts, converts unix timestamps, maps event types', () => {
    expect(stripeAdapter.normalizeAccountId(' ACCT_9 ')).toBe('acct_9');
    const parsed = stripeAdapter.parseWebhook({
      id: 'evt_3N0001',
      account: 'acct_9',
      created: 1760000000,
      type: 'invoice.paid',
      data: { object: { invoice: 'in_1', amount_paid: 4200 } },
    });
    expect(parsed.providerAccountId).toBe('acct_9');
    expect(parsed.records[0]).toEqual({
      providerRecordId: 'evt_3N0001',
      kind: 'invoice.paid',
      payload: { type: 'invoice.paid', object: { invoice: 'in_1', amount_paid: 4200 } },
      occurredAt: new Date(1760000000 * 1_000).toISOString(),
    });
    expectCode('unsupported_provider_event', () =>
      stripeAdapter.parseWebhook({ id: 'evt_x', account: 'acct_9', created: 1, type: 'ping', data: { object: {} } }),
    );
    expectCode('invalid_provider_payload', () =>
      stripeAdapter.parseWebhook({ id: 'evt_x', account: 'acct_9', created: 1, type: 'invoice.voided', data: { object: {} } }),
    );
    expectCode('invalid_provider_payload', () =>
      stripeAdapter.parseWebhook({ id: 'evt_x', account: 'acct_9', created: 'soon', type: 'invoice.paid', data: { object: {} } }),
    );
  });

  it('zapier: parses triggered zaps and rejects handshakes', () => {
    expect(zapierAdapter.normalizeAccountId(' sub-1 ')).toBe('sub-1');
    const parsed = zapierAdapter.parseWebhook({
      subscriptionId: 'sub-1',
      events: [
        { id: 'zap-evt-1', occurredAt: '2026-09-14T04:00:00Z', zap: { id: 'z1', name: 'New form response' }, data: { name: 'Ada' } },
      ],
    });
    expect(parsed.records[0]).toEqual({
      providerRecordId: 'zap-evt-1',
      kind: 'automation.zap.triggered',
      payload: { zap: { id: 'z1', name: 'New form response' }, data: { name: 'Ada' } },
      occurredAt: '2026-09-14T04:00:00Z',
    });
    expectCode('unsupported_provider_event', () =>
      zapierAdapter.parseWebhook({ subscriptionId: 'sub-1', handshake: 'ready' }),
    );
  });

  it('polling-only account-id normalization rules', () => {
    expect(linearAdapter.normalizeAccountId('Team-Key')).toBe('team-key');
    expect(notionAdapter.normalizeAccountId('Workspace-1')).toBe('workspace-1');
    expect(googleDriveAdapter.normalizeAccountId('Drive@Acme')).toBe('drive@acme');
    expect(googleCalendarAdapter.normalizeAccountId('Cal@Acme')).toBe('cal@acme');
    expect(quickbooksAdapter.normalizeAccountId(' 1234567890 ')).toBe('1234567890');
    expectCode('invalid_source_input', () => quickbooksAdapter.normalizeAccountId('company-one'));
  });
});
