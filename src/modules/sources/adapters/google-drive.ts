// Google Drive adapter (MODULE-INTERNAL). Google Drive is ingested by
// polling the changes feed through the fetch transport; it delivers no
// record-bearing webhooks to this module.

import { SourcesError } from '../errors';
import { webhookUnsupported } from './shared';
import type { SourceAdapter, WebhookParseResult } from './types';

export const googleDriveAdapter: SourceAdapter = {
  provider: 'google-drive',
  modes: ['polling'],

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') {
      throw new SourcesError('invalid_source_input', 'providerAccountId must be a non-empty string');
    }
    return text.toLowerCase();
  },

  parseWebhook(_payload: unknown): WebhookParseResult {
    webhookUnsupported('google-drive');
  },
};
