// Salesforce adapter (MODULE-INTERNAL). Envelope convention: an upsert
// body — one record per entry, keyed by its stable record id as the
// external id, with the record's fields — against the SObject named by
// the batch's canonical kind. Account ids are Salesforce org ids
// (uppercase, mirroring the sources module's Salesforce adapter).

import type { DestinationAdapter } from './types';
import { envelope, invalidAccountId } from './types';
import type { FormattedDelivery } from '../types';

export const salesforceAdapter: DestinationAdapter = {
  provider: 'salesforce',
  category: 'crm-erp',
  requiresObjectRecords: true,

  normalizeAccountId(raw: string): string {
    const text = raw.trim();
    if (text === '') throw invalidAccountId('salesforce');
    return text.toUpperCase();
  },

  formatDelivery(batch): FormattedDelivery {
    return envelope('records', {
      object: batch.kind,
      upsert: batch.records.map((record) => ({
        externalId: record.recordId,
        fields: record.data,
      })),
    });
  },
};
