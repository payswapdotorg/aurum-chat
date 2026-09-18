// Looker adapter (MODULE-INTERNAL). Envelope convention: a BI data-push
// body carrying the batch as metric points — one point per record, keyed
// by the record's stable id with the record's fields as measures.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const lookerAdapter: DestinationAdapter = {
  provider: 'looker',
  category: 'bi',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('looker');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('rows', {
      dataset: batch.kind,
      points: batch.records.map((record) => ({
        id: record.recordId,
        fields: record.data,
      })),
    });
  },
};
