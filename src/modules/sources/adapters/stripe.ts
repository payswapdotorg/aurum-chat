// Stripe adapter (MODULE-INTERNAL). Envelope shape the Stripe transport
// delivers: one account-scoped event object per delivery, with the event id
// as the stable dedupe key and a unix `created` second timestamp.

import { SourcesError } from '../errors';
import {
  requireObject,
  requireString,
  unsupportedEvent,
} from './shared';
import { record, type SourceAdapter, type WebhookParseResult } from './types';

const TYPE_KINDS: Record<string, string> = {
  'invoice.paid': 'invoice.paid',
  'invoice.payment_failed': 'invoice.payment_failed',
  'customer.updated': 'customer.updated',
  'charge.succeeded': 'charge.succeeded',
};

function unixSecondsToIso(value: unknown, where: string): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SourcesError('invalid_provider_payload', `${where} must be unix seconds`);
  }
  return new Date(value * 1_000).toISOString();
}

export const stripeAdapter: SourceAdapter = {
  provider: 'stripe',
  modes: ['polling', 'webhook'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text.toLowerCase();
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const envelope = requireObject(payload, 'the stripe envelope');
    const id = requireString(envelope.id, 'id');
    const account = requireString(envelope.account, 'account');
    const type = requireString(envelope.type, 'type');
    if (type === 'ping') {
      unsupportedEvent('stripe ping envelopes carry no records');
    }
    const kind = TYPE_KINDS[type];
    if (kind === undefined) {
      throw new SourcesError(
        'invalid_provider_payload',
        `type must be one of ${Object.keys(TYPE_KINDS).join(', ')} (got '${type}')`,
      );
    }
    const data = requireObject(envelope.data, 'data');
    requireObject(data.object, 'data.object');
    const occurredAt = unixSecondsToIso(envelope.created, 'created');
    return {
      providerAccountId: this.normalizeAccountId(account),
      records: [record(id, kind, occurredAt, { type, object: data.object })],
    };
  },
};
