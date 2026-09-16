// Linear adapter (MODULE-INTERNAL). Linear is ingested by polling its API
// through the fetch transport; it delivers no record-bearing webhooks to
// this module.

import { SourcesError } from '../errors';
import { webhookUnsupported } from './shared';
import type { SourceAdapter, WebhookParseResult } from './types';

export const linearAdapter: SourceAdapter = {
  provider: 'linear',
  modes: ['polling'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text.toLowerCase();
  },

  parseWebhook(_payload: unknown): WebhookParseResult {
    webhookUnsupported('linear');
  },
};
