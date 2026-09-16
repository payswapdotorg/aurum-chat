// Zendesk adapter (MODULE-INTERNAL). Envelope shape the Zendesk transport
// delivers: a subdomain-scoped body carrying ticket lifecycle events.

import { SourcesError } from '../errors';
import {
  requireIsoInstant,
  requireObject,
  requireString,
  requireEvents,
} from './shared';
import { record, type SourceAdapter, type WebhookParseResult } from './types';

const TYPE_KINDS: Record<string, string> = {
  'Ticket Created': 'support.ticket.created',
  'Ticket Updated': 'support.ticket.updated',
  'Comment Created': 'support.ticket.comment.created',
};

export const zendeskAdapter: SourceAdapter = {
  provider: 'zendesk',
  modes: ['polling', 'webhook'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text.toLowerCase();
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const envelope = requireObject(payload, 'the zendesk envelope');
    const subdomain = requireString(envelope.subdomain, 'subdomain');
    const events = requireEvents(envelope.events, 'events');
    const records = events.map((event, index) => {
      const id = requireString(event.id, `events[${index}].id`);
      const type = requireString(event.type, `events[${index}].type`);
      const kind = TYPE_KINDS[type];
      if (kind === undefined) {
        throw new SourcesError(
          'invalid_provider_payload',
          `events[${index}].type must be one of ${Object.keys(TYPE_KINDS).join(', ')} (got '${type}')`,
        );
      }
      const occurredAt = requireIsoInstant(event.occurredAt, `events[${index}].occurredAt`);
      const ticket = requireObject(event.ticket, `events[${index}].ticket`);
      const ticketId = requireString(ticket.id, `events[${index}].ticket.id`);
      return record(id, kind, occurredAt, {
        type,
        ticket: {
          id: ticketId,
          subject: ticket.subject ?? null,
          status: ticket.status ?? null,
        },
      });
    });
    return { providerAccountId: this.normalizeAccountId(subdomain), records };
  },
};
