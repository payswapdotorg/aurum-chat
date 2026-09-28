// The REAL file-share edge connectivity adapter (W111) — the W088
// composition for private/on-prem incumbents.
//
// WHAT IT IS: an EdgeConnectivityAdapter (the edge-connector contract's
// own port — the seam where provider-native protocols live, entirely
// CUSTOMER-SIDE) whose connectivity kind is 'file-share' and whose
// INSPECT side really re-reads the incumbent's CSV export from the REAL
// file system. The migration module wires it (through
// createEdgeDeepActionTransport — the W084/W088 composition) as the
// commit-time verification transport: every staged record is re-read
// through a SIGNED, tenant-scoped edge job executed against this adapter,
// and any divergence between the staged payload and the re-read state is
// surfaced on the round — never silently fixed.
//
// READ-ONLY BY POLICY: the migration module never writes back to the
// incumbent through any path; this adapter's EXECUTE side is permanently
// refused (a 'rejected' receipt — the honest permanent-refusal taxonomy),
// and the module's tests carry the canary that proves it is never called.
//
// TARGET SEMANTICS: the request's opaque target is the incumbent external
// record id; the adapter answers from the LATEST export version on disk
// (the same version the import read — the export share IS the incumbent
// state for this connectivity kind).

import type {
  EdgeAdapterRequest,
  EdgeAdapterResult,
  EdgeConnectivityAdapter,
} from '@/modules/edge-connector/contract';
import {
  buildRecordCandidate,
  CsvRowError,
  listExportVersions,
  readExportVersion,
} from './csv-export-format';

/** Options of {@link createCsvFileShareAdapter}. */
export interface CsvFileShareAdapterOptions {
  /** The incumbent's export share root (csv-export-<NNN>/ directories). */
  exportRoot: string;
}

/** The real file-share adapter (read-only by policy). */
export interface CsvFileShareAdapter extends EdgeConnectivityAdapter {
  /** Every adapter call, in order (the exactly-once / read-only proofs). */
  readonly requests: readonly EdgeAdapterRequest[];
}

/**
 * Creates the read-only file-share adapter over the incumbent's export
 * root. The latest export version is resolved and REALLY read from disk
 * on every inspect (no caching — the same live-share posture as the
 * incumbent reader).
 */
export function createCsvFileShareAdapter(
  options: CsvFileShareAdapterOptions,
): CsvFileShareAdapter {
  const exportRoot = options.exportRoot;
  const requests: EdgeAdapterRequest[] = [];
  let receiptCounter = 0;
  const nextReceiptId = (): string => {
    receiptCounter += 1;
    return `edge-file-${receiptCounter.toString().padStart(4, '0')}`;
  };

  /** Really reads the latest export and answers one external id's state. */
  const inspectTarget = async (target: string): Promise<{ found: boolean; state: unknown }> => {
    const versions = await listExportVersions(exportRoot);
    const latest = versions[versions.length - 1];
    if (latest === undefined) {
      return { found: false, state: null };
    }
    const exportVersion = await readExportVersion(exportRoot, latest);
    for (const record of exportVersion.records) {
      let candidate: ReturnType<typeof buildRecordCandidate>;
      try {
        candidate = buildRecordCandidate(record, exportVersion.header);
      } catch (error) {
        if (error instanceof CsvRowError) continue; // unparseable rows cannot verify
        throw error;
      }
      if (candidate.externalId !== target) continue;
      if (candidate.deletedAt !== null) {
        // The record is a tombstone in the current export.
        return { found: true, state: null };
      }
      return { found: true, state: candidate.payload };
    }
    return { found: false, state: null };
  };

  return {
    connectivity: 'file-share',
    requests,
    async inspect(request: EdgeAdapterRequest): Promise<EdgeAdapterResult> {
      requests.push(request);
      const read = await inspectTarget(request.target);
      return {
        receipt: { status: 'accepted', receiptId: nextReceiptId(), detail: null },
        state: read,
      };
    },
    async execute(request: EdgeAdapterRequest): Promise<EdgeAdapterResult> {
      requests.push(request);
      return {
        receipt: {
          status: 'rejected',
          receiptId: null,
          detail:
            'the csv file-share verification adapter is read-only by policy — Aurum never writes back to the incumbent through the migration module',
        },
        state: null,
      };
    },
  };
}
