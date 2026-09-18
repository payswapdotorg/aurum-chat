// Tableau adapter (MODULE-INTERNAL). Envelope convention: a BI data-source
// append body carrying the batch as plain field-shaped row objects.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const tableauAdapter: DestinationAdapter = {
  provider: 'tableau',
  category: 'bi',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('tableau');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('rows', {
      datasource: batch.kind,
      rows: batch.records.map((record) => record.data),
    });
  },
};
