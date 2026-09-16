// Jira adapter (MODULE-INTERNAL). Envelope shape the Jira transport
// delivers: a clientKey-scoped body carrying issue lifecycle events.

import { SourcesError } from '../errors';
import {
  requireIsoInstant,
  requireObject,
  requireString,
  requireEvents,
} from './shared';
import { record, type SourceAdapter, type WebhookParseResult } from './types';

const EVENT_KINDS: Record<string, string> = {
  issue_created: 'issue.created',
  issue_updated: 'issue.updated',
  issue_deleted: 'issue.deleted',
  comment_added: 'issue.comment.created',
};

export const jiraAdapter: SourceAdapter = {
  provider: 'jira',
  modes: ['polling', 'webhook'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text;
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const envelope = requireObject(payload, 'the jira envelope');
    const clientKey = requireString(envelope.clientKey, 'clientKey');
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
      const issue = requireObject(event.issue, `events[${index}].issue`);
      const issueKey = requireString(issue.key, `events[${index}].issue.key`);
      return record(id, kind, occurredAt, {
        event: eventKind,
        issue: {
          key: issueKey,
          summary: issue.summary ?? null,
          status: issue.status ?? null,
        },
        comment: event.comment ?? null,
      });
    });
    return { providerAccountId: this.normalizeAccountId(clientKey), records };
  },
};
