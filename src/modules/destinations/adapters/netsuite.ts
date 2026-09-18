// NetSuite adapter (MODULE-INTERNAL). Envelope convention: a batch body —
// items keyed by the record's stable id as the external id, with the
// record's fields — against the record type named by the batch's
// canonical kind.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const netsuiteAdapter: DestinationAdapter = {
  provider: 'netsuite',
  category: 'crm-erp',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('netsuite');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('records', {
      recordType: batch.kind,
      items: batch.records.map((record) => ({
        externalId: record.recordId,
        fields: record.data,
      })),
    });
  },
};
