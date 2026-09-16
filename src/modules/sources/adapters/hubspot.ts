// HubSpot adapter (MODULE-INTERNAL). Envelope shape the HubSpot transport
// delivers: a subscription-style body carrying the portal id, the
// subscription type and the event batch.

import { SourcesError } from '../errors';
import {
  requireIsoInstant,
  requireObject,
  requireString,
  requireEvents,
  unsupportedEvent,
} from './shared';
import { record, type SourceAdapter, type WebhookParseResult } from './types';

const SUBSCRIPTION_KINDS: Record<string, string> = {
  'contact.creation': 'crm.contact.created',
  'contact.deletion': 'crm.contact.deleted',
  'deal.creation': 'crm.deal.created',
  'deal.propertyChange': 'crm.deal.updated',
  'company.creation': 'crm.company.created',
  'company.deletion': 'crm.company.deleted',
};

export const hubspotAdapter: SourceAdapter = {
  provider: 'hubspot',
  modes: ['polling', 'webhook'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    if (!/^\d+$/.test(text)) {
      throw new SourcesError(
        'invalid_source_input',
        `a hubspot portal id is digits-only (got '${text}')`,
      );
    }
    return text;
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const envelope = requireObject(payload, 'the hubspot envelope');
    // HubSpot delivers portal ids as JSON numbers; canonical account ids
    // are their digits-only string form.
    if (
      typeof envelope.portalId !== 'number' ||
      !Number.isInteger(envelope.portalId) ||
      envelope.portalId < 0
    ) {
      throw new SourcesError(
        'invalid_provider_payload',
        `portalId must be a numeric portal id (got '${String(envelope.portalId)}')`,
      );
    }
    const portalId = String(envelope.portalId);
    const subscriptionType = requireString(envelope.subscriptionType, 'subscriptionType');
    if (subscriptionType === 'url_verification') {
      unsupportedEvent('hubspot url_verification envelopes carry no records');
    }
    const kind =
      SUBSCRIPTION_KINDS[subscriptionType] ?? `crm.record.${subscriptionType.includes('deletion') ? 'deleted' : 'updated'}`;
    const events = requireEvents(envelope.events, 'events');
    const records = events.map((event, index) => {
      const id = requireString(event.id, `events[${index}].id`);
      const occurredAt = requireIsoInstant(event.occurredAt, `events[${index}].occurredAt`);
      const objectId = event.objectId;
      if (objectId === undefined || objectId === null || typeof objectId === 'object') {
        throw new SourcesError('invalid_provider_payload', `events[${index}].objectId must be a scalar id`);
      }
      return record(id, kind, occurredAt, {
        subscriptionType,
        objectId: String(objectId),
        properties: event.properties ?? null,
      });
    });
    return { providerAccountId: this.normalizeAccountId(portalId), records };
  },
};
