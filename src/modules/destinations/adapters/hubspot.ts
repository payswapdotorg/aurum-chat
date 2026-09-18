// HubSpot adapter (MODULE-INTERNAL). Envelope convention: a batch upsert
// body — inputs keyed by the record's stable id as the idempotency key,
// with the record's fields as properties — against the object type named
// by the batch's canonical kind.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const hubspotAdapter: DestinationAdapter = {
  provider: 'hubspot',
  category: 'crm-erp',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('hubspot');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('records', {
      object: batch.kind,
      inputs: batch.records.map((record) => ({
        idempotencyKey: record.recordId,
        properties: record.data,
      })),
    });
  },
};
