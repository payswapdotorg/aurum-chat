// Snowflake adapter (MODULE-INTERNAL). Envelope convention: a batch INSERT
// body — column-named row objects appended to the table named by the
// batch's canonical kind.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const snowflakeAdapter: DestinationAdapter = {
  provider: 'snowflake',
  category: 'warehouse',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('snowflake');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('rows', {
      table: batch.kind,
      rows: batch.records.map((record) => record.data),
    });
  },
};
