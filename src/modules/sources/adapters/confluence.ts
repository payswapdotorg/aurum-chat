// Confluence adapter (MODULE-INTERNAL). Envelope shape the Confluence
// transport delivers: a cloudId-scoped body carrying content lifecycle
// events.

import { SourcesError } from '../errors';
import {
  requireIsoInstant,
  requireObject,
  requireString,
  requireEvents,
} from './shared';
import { record, type SourceAdapter, type WebhookParseResult } from './types';

const EVENT_KINDS: Record<string, string> = {
  page_created: 'document.created',
  page_updated: 'document.updated',
  page_trashed: 'document.deleted',
  comment_created: 'document.comment.created',
};

export const confluenceAdapter: SourceAdapter = {
  provider: 'confluence',
  modes: ['polling', 'webhook'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text.toLowerCase();
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const envelope = requireObject(payload, 'the confluence envelope');
    const cloudId = requireString(envelope.cloudId, 'cloudId');
    const events = requireEvents(envelope.events, 'events');
    const records = events.map((event, index) => {
      const id = requireString(event.id, `events[${index}].id`);
      const eventKind = requireString(event.event, `events[${index}].event`);
      const kind = EVENT_KINDS[eventKind];
      if (kind === undefined) {
        throw new SourcesError(
          'invalid_provider_payload',
          `events[${index}].event must be one of ${Object.keys(EVENT_KINDS).join(', ')} (got '${eventKind}')`,
        );
      }
      const occurredAt = requireIsoInstant(event.occurredAt, `events[${index}].occurredAt`);
      const content = requireObject(event.content, `events[${index}].content`);
      const contentId = requireString(content.id, `events[${index}].content.id`);
      const title = requireString(content.title, `events[${index}].content.title`);
      return record(id, kind, occurredAt, {
        event: eventKind,
        content: { id: contentId, title, version: content.version ?? null },
      });
    });
    return { providerAccountId: this.normalizeAccountId(cloudId), records };
  },
};
