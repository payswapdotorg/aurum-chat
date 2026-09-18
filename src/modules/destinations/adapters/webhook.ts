// Generic webhook adapter (MODULE-INTERNAL). Envelope convention: a JSON
// webhook event — the batch's canonical kind as the event name, stamped
// with the delivery id and attempt number (webhook receivers commonly
// dedupe retries), carrying the records keyed by their stable ids. The
// provider account id canonically carries the endpoint ADDRESS (opaque to
// this module — the transport owns its interpretation); the signing
// secret stays behind the credential reference. Accepts ANY plain-JSON
// record data (envelope-style provider).

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const webhookAdapter: DestinationAdapter = {
  provider: 'webhook',
  category: 'webhook',
  requiresObjectRecords: false,

  normalizeAccountId(raw: string): string {
    // Endpoint addresses are case-sensitive paths — trim only.
    const text = raw.trim();
    if (text === '') throw invalidAccountId('webhook');
    return text;
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('event', {
      event: batch.kind,
      deliveryId: batch.deliveryId,
      attempt: batch.attempt,
      records: batch.records.map((record) => ({
        recordId: record.recordId,
        data: record.data,
      })),
    });
  },
};
