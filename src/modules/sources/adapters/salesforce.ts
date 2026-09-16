// Salesforce adapter (MODULE-INTERNAL). Envelope shape the Salesforce
// transport delivers: a Change-Data-Capture-style body carrying the org id
// and a list of record change events.

import { SourcesError } from '../errors';
import {
  requireIsoInstant,
  requireObject,
  requireString,
  requireEvents,
  unsupportedEvent,
} from './shared';
import { record, type SourceAdapter, type WebhookParseResult } from './types';

const ENTITY_KINDS: Record<string, string> = {
  account: 'crm.account',
  opportunity: 'crm.opportunity',
  lead: 'crm.lead',
  case: 'support.case',
};

const CHANGE_KINDS: Record<string, string> = {
  CREATE: 'created',
  UPDATE: 'updated',
  DELETE: 'deleted',
};

function classify(entity: string, changeType: string): string {
  const entityKind = ENTITY_KINDS[entity.toLowerCase()] ?? `salesforce.${entity.toLowerCase()}`;
  const change = CHANGE_KINDS[changeType];
  return change === undefined ? `${entityKind}.changed` : `${entityKind}.${change}`;
}

export const salesforceAdapter: SourceAdapter = {
  provider: 'salesforce',
  modes: ['polling', 'webhook'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text.toUpperCase();
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const envelope = requireObject(payload, 'the salesforce envelope');
    if (envelope.handshake !== undefined) {
      unsupportedEvent('salesforce handshake envelopes carry no records');
    }
    const organizationId = requireString(envelope.organizationId, 'organizationId');
    const events = requireEvents(envelope.events, 'events');
    const records = events.map((event, index) => {
      const id = requireString(event.id, `events[${index}].id`);
      const changeType = requireString(event.changeType, `events[${index}].changeType`);
      const entity = requireString(event.entity, `events[${index}].entity`);
      const occurredAt = requireIsoInstant(event.occurredAt, `events[${index}].occurredAt`);
      return record(id, classify(entity, changeType), occurredAt, {
        entity,
        changeType,
        record: event.record ?? null,
      });
    });
    return { providerAccountId: this.normalizeAccountId(organizationId), records };
  },
};
