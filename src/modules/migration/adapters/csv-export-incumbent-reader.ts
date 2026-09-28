// The REAL incumbent reader adapter (W111) — the CSV export-library
// reader behind the W094 MigrationIncumbentReader port.
//
// THE INCUMBENT IT SERVES: a private/on-prem legacy system that exports
// its records as versioned full-state CSV snapshots onto a share (the
// real legacy-CRM pattern — the operator configures the incumbent's
// export job once; every run drops csv-export-<NNN>/records.csv; see
// csv-export-format.ts for the exact format contract).
//
// WHAT MAKES IT REAL: it reads the REAL file system (no fixture, no
// in-memory double), parses REAL RFC 4180 CSV (quoted fields, embedded
// commas/quotes/newlines, CRLF, BOM), decodes real bytes (invalid UTF-8
// is surfaced per-row, never silently mangled), and canonicalizes every
// row with the migration module's OWN canonicalization so the rejection
// reasons are the module's real ones.
//
// NO SILENT DATA LOSS (the W111 acceptance): the module's snapshot-level
// canonicalization is all-or-nothing — one malformed row would fail a
// whole round. This adapter canonicalizes PER ROW instead: every
// malformed / oversized / duplicate / undecodable row is EXPLICITLY
// rejected with a recorded reason (surfaced through the
// IncumbentRejectionSource capability; captureSnapshot persists them in
// the migration_reader_rejections ledger linked to the round), and only
// canonical records cross the port. The round's counts reconcile:
//   export data rows = returned records + rejected rows.
//
// THE PORT IS READ-ONLY (no write method exists); the request's opaque
// credentialRef passes straight through uninterpreted (the W082
// discipline — recorded for the pass-through proofs, never stored, never
// logged into the rejection ledger).
//
// DELTA READS ride the version chain: sinceSnapshotRef csv-export-<N>
// diffs version N against the LATEST version (row-level canonical
// equality); rows deleted by the incumbent surface as tombstone records
// (deleted_at), and rows that VANISHED without a tombstone are explicit
// 'disappeared-without-tombstone' rejections — never silent drops.

import type {
  IncumbentReaderRejection,
  IncumbentRecord,
  IncumbentSnapshotRequest,
  IncumbentSnapshotResult,
  MigrationIncumbentReader,
} from '../types';
import { canonicalizeIncumbentRecord, MAX_ROUND_RECORDS } from '../validation';
import { MigrationError } from '../errors';
import {
  buildRecordCandidate,
  CSV_EXPORT_DIR_PREFIX,
  CsvRowError,
  listExportVersions,
  readExportVersion,
  versionOfSnapshotRef,
  type CsvExportVersion,
} from './csv-export-format';

/** Options of {@link createCsvExportIncumbentReader}. */
export interface CsvExportIncumbentReaderOptions {
  /**
   * The incumbent's export share root — the directory holding the
   * csv-export-<NNN>/ version directories (an absolute path, or relative
   * to the process working directory).
   */
  exportRoot: string;
}

/** The adapter's stable reader-kind string (recorded on every rejection). */
export const CSV_EXPORT_READER_KIND = 'csv-export';

/**
 * The real CSV export-library incumbent reader. Implements the read-only
 * MigrationIncumbentReader port AND the IncumbentRejectionSource
 * capability (per-row rejections of the last completed read, drained by
 * captureSnapshot).
 */
export interface CsvExportIncumbentReader extends MigrationIncumbentReader {
  /** Every readSnapshot request, in order (the pass-through proofs). */
  readonly requests: readonly IncumbentSnapshotRequest[];
  drainRejections(): IncumbentReaderRejection[];
}

/** One canonicalized row (the internal diff/equality unit). */
interface CanonicalRow {
  externalId: string;
  matchKey: string | null;
  entityType: string | null;
  payload: Record<string, unknown> | null;
  tombstone: boolean;
  /** The incumbent's real deletion timestamp (strict ISO; null when live). */
  deletedAt: string | null;
}

/** The ledger's raw-row evidence bound (mirrors the SQL CHECK). */
const RAW_ROW_BOUND = 4_000;

function serializeRow(row: CanonicalRow): string {
  return JSON.stringify([
    row.externalId,
    row.matchKey,
    row.entityType,
    row.payload,
    row.tombstone,
    row.deletedAt,
  ]);
}

function toIncumbentRecord(row: CanonicalRow): IncumbentRecord {
  return {
    externalId: row.externalId,
    matchKey: row.matchKey,
    entityType: row.entityType,
    payload: row.payload === null ? null : { ...row.payload },
    deletedAt: row.deletedAt,
  };
}

/** Bounds one raw source row to the ledger's evidence limit (marked). */
function boundedRaw(rawRow: string): string {
  if (rawRow.length <= RAW_ROW_BOUND) return rawRow;
  return `${rawRow.slice(0, RAW_ROW_BOUND - 14)}…[truncated]`;
}

/**
 * Creates the reader. The export root is read LIVE on every snapshot
 * read (no caching — the incumbent's export job may drop a new version
 * between rounds; the reader always answers from what is on disk now).
 */
export function createCsvExportIncumbentReader(
  options: CsvExportIncumbentReaderOptions,
): CsvExportIncumbentReader {
  const exportRoot = options.exportRoot;
  const requests: IncumbentSnapshotRequest[] = [];
  let pendingRejections: IncumbentReaderRejection[] = [];

  /** Canonicalizes one export file's rows; returns accepted + rejections. */
  const loadVersion = async (version: number): Promise<{
    accepted: Map<string, { row: CanonicalRow; lineNumber: number }>;
    rejections: IncumbentReaderRejection[];
    snapshotRef: string;
  }> => {
    const exportVersion: CsvExportVersion = await readExportVersion(exportRoot, version);
    const accepted = new Map<string, { row: CanonicalRow; lineNumber: number }>();
    const rejections: IncumbentReaderRejection[] = [];
    const snapshotRef = exportVersion.snapshotRef;
    for (const [index, record] of exportVersion.records.entries()) {
      const lineNumber = index + 1;
      // Encoding: undecodable UTF-8 surfaces as U+FFFD inside the row.
      if (record.raw.includes('\uFFFD') || record.fields.some((field) => field.includes('\uFFFD'))) {
        rejections.push({
          readerKind: CSV_EXPORT_READER_KIND,
          snapshotRef,
          externalId: null,
          lineNumber,
          reasonCode: 'invalid-encoding',
          reason: `row ${lineNumber} of '${snapshotRef}' contains bytes that are not valid UTF-8 — fix the incumbent export encoding`,
          rawRow: boundedRaw(record.raw),
        });
        continue;
      }
      let candidate: ReturnType<typeof buildRecordCandidate>;
      try {
        candidate = buildRecordCandidate(record, exportVersion.header);
      } catch (error) {
        if (error instanceof CsvRowError) {
          rejections.push({
            readerKind: CSV_EXPORT_READER_KIND,
            snapshotRef,
            externalId: null,
            lineNumber,
            reasonCode: error.reasonCode,
            reason: `row ${lineNumber} of '${snapshotRef}': ${error.message}`,
            rawRow: boundedRaw(record.raw),
          });
          continue;
        }
        throw error;
      }
      let canonical: ReturnType<typeof canonicalizeIncumbentRecord>;
      try {
        // The candidate passes through UNCHANGED (a tombstone that still
        // carries a payload must be REJECTED by the canonicalization —
        // never silently stripped here).
        canonical = canonicalizeIncumbentRecord(
          {
            externalId: candidate.externalId,
            matchKey: candidate.matchKey,
            entityType: candidate.entityType,
            payload: candidate.payload,
            deletedAt: candidate.deletedAt,
          },
          lineNumber,
        );
      } catch (error) {
        if (error instanceof MigrationError) {
          rejections.push({
            readerKind: CSV_EXPORT_READER_KIND,
            snapshotRef,
            externalId: candidate.externalId === '' ? null : candidate.externalId,
            lineNumber,
            reasonCode: 'invalid-record',
            reason: `row ${lineNumber} of '${snapshotRef}' was rejected by the migration module's canonicalization: ${error.message}`,
            rawRow: boundedRaw(record.raw),
          });
          continue;
        }
        throw error;
      }
      const row: CanonicalRow = {
        externalId: canonical.externalId,
        matchKey: canonical.matchKey,
        entityType: canonical.entityType,
        payload: canonical.payload,
        tombstone: canonical.tombstone,
        deletedAt: candidate.deletedAt,
      };
      if (accepted.has(row.externalId)) {
        rejections.push({
          readerKind: CSV_EXPORT_READER_KIND,
          snapshotRef,
          externalId: row.externalId,
          lineNumber,
          reasonCode: 'duplicate-external-id',
          reason: `row ${lineNumber} of '${snapshotRef}' repeats external id '${row.externalId}' already carried by an earlier row of the same export — the FIRST row wins and this duplicate is surfaced, never silently overriding it`,
          rawRow: boundedRaw(record.raw),
        });
        continue;
      }
      accepted.set(row.externalId, { row, lineNumber });
    }
    return { accepted, rejections, snapshotRef };
  };

  const reader: CsvExportIncumbentReader = {
    requests,
    drainRejections(): IncumbentReaderRejection[] {
      const drained = pendingRejections;
      pendingRejections = [];
      return drained;
    },
    async readSnapshot(request: IncumbentSnapshotRequest): Promise<IncumbentSnapshotResult> {
      requests.push(request);
      // A new read starts from a clean rejection buffer (a failed read's
      // partial rejections never leak into another round; the rows are
      // re-encountered on the next read of the same export).
      pendingRejections = [];

      const versions = await listExportVersions(exportRoot);
      if (versions.length === 0) {
        throw new MigrationError(
          'invalid_reader_result',
          `the csv export root '${exportRoot}' carries no ${CSV_EXPORT_DIR_PREFIX}<NNN> version directories — the incumbent export job must run (or its share mount fixed) before migration reads`,
        );
      }
      const latestVersion = versions[versions.length - 1]!;

      const baseVersion = versionOfSnapshotRef(request.sinceSnapshotRef);
      if (request.sinceSnapshotRef !== null && baseVersion === null) {
        throw new MigrationError(
          'invalid_reader_result',
          `the csv export reader does not know snapshot reference '${request.sinceSnapshotRef}' (expected '${CSV_EXPORT_DIR_PREFIX}<NNN>')`,
        );
      }
      if (baseVersion !== null && !versions.includes(baseVersion)) {
        throw new MigrationError(
          'invalid_reader_result',
          `the csv export root no longer carries version ${baseVersion} (present: ${versions.join(', ')}) — export versions are immutable; a missing base version means the share was rebuilt and the delta base is unreliable (capture a full round)`,
        );
      }

      const latest = await loadVersion(latestVersion);

      if (baseVersion === null) {
        // A FULL read: every accepted row of the latest version.
        if (latest.accepted.size > MAX_ROUND_RECORDS) {
          throw new MigrationError(
            'snapshot_too_large',
            `the csv export version '${latest.snapshotRef}' carries ${latest.accepted.size} canonical record(s) — the per-round cap is ${MAX_ROUND_RECORDS}; the operator must export smaller windows (the format's versioned directories are the batching surface)`,
          );
        }
        pendingRejections = latest.rejections;
        return {
          snapshotRef: latest.snapshotRef,
          records: [...latest.accepted.values()].map(({ row }) => toIncumbentRecord(row)),
        };
      }

      // A DELTA read: the row-diff base → latest (canonical equality).
      const base = await loadVersion(baseVersion);
      const records: IncumbentRecord[] = [];
      const rejections = [...latest.rejections];
      for (const [externalId, entry] of latest.accepted) {
        const before = base.accepted.get(externalId);
        if (before === undefined || serializeRow(before.row) !== serializeRow(entry.row)) {
          records.push(toIncumbentRecord(entry.row));
        }
      }
      for (const [externalId, entry] of base.accepted) {
        if (latest.accepted.has(externalId)) continue;
        rejections.push({
          readerKind: CSV_EXPORT_READER_KIND,
          snapshotRef: latest.snapshotRef,
          externalId,
          lineNumber: entry.lineNumber,
          reasonCode: 'disappeared-without-tombstone',
          reason: `external id '${externalId}' was present in base version '${base.snapshotRef}' (row ${entry.lineNumber}) but is ABSENT from '${latest.snapshotRef}' with no tombstone — the export itself is inconsistent; the row is surfaced here rather than silently treated as deleted`,
          rawRow: null,
        });
      }
      if (records.length > MAX_ROUND_RECORDS) {
        throw new MigrationError(
          'snapshot_too_large',
          `the delta from '${base.snapshotRef}' to '${latest.snapshotRef}' carries ${records.length} changed record(s) — the per-round cap is ${MAX_ROUND_RECORDS}; the operator must export smaller windows`,
        );
      }
      pendingRejections = rejections;
      return { snapshotRef: latest.snapshotRef, records };
    },
  };
  return reader;
}
