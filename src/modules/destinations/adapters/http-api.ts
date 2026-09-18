// Generic HTTP API adapter (MODULE-INTERNAL). Envelope convention: an
// API POST body — typed by the batch's canonical kind, stamped with the
// delivery id and attempt number (APIs commonly dedupe retries), carrying
// the records as keyed items. The provider account id canonically carries
// the endpoint ADDRESS (opaque to this module — the transport owns its
// interpretation); the API token stays behind the credential reference.
// Accepts ANY plain-JSON record data (envelope-style provider).

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const httpApiAdapter: DestinationAdapter = {
  provider: 'http-api',
  category: 'api',
  requiresObjectRecords: false,

  normalizeAccountId(raw: string): string {
    // Endpoint addresses are case-sensitive paths — trim only.
    const text = raw.trim();
    if (text === '') throw invalidAccountId('http-api');
    return text;
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('records', {
      type: batch.kind,
      deliveryId: batch.deliveryId,
      attempt: batch.attempt,
      items: batch.records.map((record) => ({
        recordId: record.recordId,
        data: record.data,
      })),
    });
  },
};
