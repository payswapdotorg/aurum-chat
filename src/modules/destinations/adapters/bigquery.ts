// BigQuery adapter (MODULE-INTERNAL). Envelope convention: the
// insert-rows body — one `{ json }` row per record appended to the table
// named by the batch's canonical kind.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const bigqueryAdapter: DestinationAdapter = {
  provider: 'bigquery',
  category: 'warehouse',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('bigquery');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('rows', {
      table: batch.kind,
      rows: batch.records.map((record) => ({ json: record.data })),
    });
  },
};
