// Zapier adapter (MODULE-INTERNAL). Zapier pushes triggered zap events to
// Aurum over webhooks; it exposes no pollable record feed to this module.

import { SourcesError } from '../errors';
import {
  requireIsoInstant,
  requireObject,
  requireString,
  requireEvents,
  unsupportedEvent,
} from './shared';
import { record, type SourceAdapter, type WebhookParseResult } from './types';

export const zapierAdapter: SourceAdapter = {
  provider: 'zapier',
  modes: ['webhook'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text;
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const envelope = requireObject(payload, 'the zapier envelope');
    if (envelope.handshake !== undefined) {
      unsupportedEvent('zapier handshake envelopes carry no records');
    }
    const subscriptionId = requireString(envelope.subscriptionId, 'subscriptionId');
    const events = requireEvents(envelope.events, 'events');
    const records = events.map((event, index) => {
      const id = requireString(event.id, `events[${index}].id`);
      const occurredAt = requireIsoInstant(event.occurredAt, `events[${index}].occurredAt`);
      const zap = requireObject(event.zap, `events[${index}].zap`);
      const zapId = requireString(zap.id, `events[${index}].zap.id`);
      return record(id, 'automation.zap.triggered', occurredAt, {
        zap: { id: zapId, name: zap.name ?? null },
        data: event.data ?? null,
      });
    });
    return { providerAccountId: this.normalizeAccountId(subscriptionId), records };
  },
};
