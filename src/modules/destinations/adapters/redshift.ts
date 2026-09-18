// Redshift adapter (MODULE-INTERNAL). Envelope convention: a Data-API
// batch body — rows keyed by their stable record id with the record's
// fields, appended to the table named by the batch's canonical kind.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const redshiftAdapter: DestinationAdapter = {
  provider: 'redshift',
  category: 'warehouse',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('redshift');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('rows', {
      table: batch.kind,
      rows: batch.records.map((record) => ({
        externalId: record.recordId,
        fields: record.data,
      })),
    });
  },
};
