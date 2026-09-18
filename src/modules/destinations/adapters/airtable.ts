// Airtable adapter (MODULE-INTERNAL). Envelope convention: the
// create-records body — one `{ fields }` entry per record — against the
// table named by the batch's canonical kind.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const airtableAdapter: DestinationAdapter = {
  provider: 'airtable',
  category: 'spreadsheet',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('airtable');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('records', {
      table: batch.kind,
      records: batch.records.map((record) => ({ fields: record.data })),
    });
  },
};
