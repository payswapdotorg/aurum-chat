// Power BI adapter (MODULE-INTERNAL). Envelope convention: a push-dataset
// rows body (field-shaped row objects appended to the dataset).

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const powerBiAdapter: DestinationAdapter = {
  provider: 'power-bi',
  category: 'bi',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('power-bi');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('rows', {
      dataset: batch.kind,
      rows: batch.records.map((record) => record.data),
    });
  },
};
