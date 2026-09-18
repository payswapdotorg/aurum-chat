// Google Sheets adapter (MODULE-INTERNAL). Envelope convention: an
// append-cells body — each record's object fields flattened to a cell
// value row in DETERMINISTIC (sorted key) order, appended to the range
// named by the batch's canonical kind. The sorted-key order keeps cell
// layout a pure function of the record's content.

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const googleSheetsAdapter: DestinationAdapter = {
  provider: 'google-sheets',
  category: 'spreadsheet',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('google-sheets');
    return text.toLowerCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('rows', {
      range: batch.kind,
      values: batch.records.map((record) => {
        const fields = record.data as Record<string, unknown>;
        return Object.keys(fields)
          .sort()
          .map((key) => fields[key]);
      }),
    });
  },
};
