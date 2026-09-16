// QuickBooks adapter (MODULE-INTERNAL). QuickBooks is ingested by polling
// through the fetch transport; it delivers no record-bearing webhooks to
// this module.

import { SourcesError } from '../errors';
import { webhookUnsupported } from './shared';
import type { SourceAdapter, WebhookParseResult } from './types';

export const quickbooksAdapter: SourceAdapter = {
  provider: 'quickbooks',
  modes: ['polling'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    if (!/^\d+$/.test(text)) {
      throw new SourcesError(
        'invalid_source_input',
        `a quickbooks company id is digits-only (got '${text}')`,
      );
    }
    return text;
  },

  parseWebhook(_payload: unknown): WebhookParseResult {
    webhookUnsupported('quickbooks');
  },
};
