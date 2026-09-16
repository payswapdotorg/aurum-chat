// GitHub adapter (MODULE-INTERNAL). Envelope shape the GitHub transport
// delivers: one event per delivery, carrying the installation account, the
// event resource, the action and the delivery id (the stable dedupe key).

import { SourcesError } from '../errors';
import {
  requireIsoInstant,
  requireObject,
  requireString,
  unsupportedEvent,
} from './shared';
import { record, type SourceAdapter, type WebhookParseResult } from './types';

const EVENT_ACTION_KINDS: Record<string, Record<string, string>> = {
  issues: {
    opened: 'issue.opened',
    closed: 'issue.closed',
    reopened: 'issue.reopened',
  },
  pull_request: {
    opened: 'pull_request.opened',
    closed: 'pull_request.closed',
    merged: 'pull_request.merged',
  },
};

const PUSH_KIND = 'code.pushed';

function classify(event: string, action: string | null): string {
  if (event === 'push') return PUSH_KIND;
  const byAction = EVENT_ACTION_KINDS[event];
  if (byAction === undefined || action === null) {
    throw new SourcesError(
      'invalid_provider_payload',
      `event must be one of ${[...Object.keys(EVENT_ACTION_KINDS), 'push'].join(', ')} (got '${event}')`,
    );
  }
  const kind = byAction[action];
  if (kind === undefined) {
    throw new SourcesError(
      'invalid_provider_payload',
      `action '${action}' is not a record-bearing ${event} action`,
    );
  }
  return kind;
}

export const githubAdapter: SourceAdapter = {
  provider: 'github',
  modes: ['polling', 'webhook'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text.toLowerCase();
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const envelope = requireObject(payload, 'the github envelope');
    if (envelope.zen !== undefined) {
      unsupportedEvent('github ping envelopes carry no records');
    }
    const installation = requireObject(envelope.installation, 'installation');
    const account = requireObject(installation.account, 'installation.account');
    const login = requireString(account.login, 'installation.account.login');
    const deliveryId = requireString(envelope.deliveryId, 'deliveryId');
    const event = requireString(envelope.event, 'event');
    const action =
      envelope.action === undefined || envelope.action === null
        ? null
        : requireString(envelope.action, 'action');
    const kind = classify(event, action);
    const occurredAt = requireIsoInstant(envelope.occurredAt, 'occurredAt');
    const resource =
      kind === PUSH_KIND
        ? { commits: envelope.commits ?? [], after: envelope.after ?? null }
        : {
            issue: envelope.issue ?? envelope.pull_request ?? null,
            action,
          };
    return {
      providerAccountId: this.normalizeAccountId(login),
      records: [record(deliveryId, kind, occurredAt, { event, ...resource })],
    };
  },
};
