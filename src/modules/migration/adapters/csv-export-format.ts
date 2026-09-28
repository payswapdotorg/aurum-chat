// The CSV export-library format core (W111) — shared by the real
// incumbent reader (csv-export-incumbent-reader.ts) and the W088
// file-share verification adapter (file-share-verify.ts).
//
// THE EXPORT FORMAT (the documented contract a private/on-prem incumbent
// follows when dropping exports onto a share — the real legacy-CRM export
// pattern: a versioned directory of full-state CSV snapshots):
//
//   <exportRoot>/csv-export-<NNN>/records.csv
//
//   * csv-export-<NNN> — one immutable, monotonically numbered export
//     VERSION (NNN = 1, 2, 3, ... zero-padding optional). The snapshot
//     reference this adapter mints is exactly the directory name.
//   * records.csv — a real RFC 4180 CSV file: an optional UTF-8 BOM, one
//     HEADER record, then one DATA record per incumbent row. Quoted
//     fields may embed commas, double quotes ("" escaped) and line
//     breaks; CRLF, LF and CR record separators are all accepted; a
//     final record without a trailing separator is accepted.
//
//   HEADER COLUMNS (any order; no duplicates; no unknown columns):
//     external_id  — REQUIRED column. The incumbent's opaque record id.
//     payload_json — REQUIRED column. The record's canonical payload as
//                    a JSON object literal (multi-value fields are JSON
//                    arrays inside it — the format's answer to real CRM
//                    multi-value cells). Empty ONLY on tombstone rows.
//     match_key    — OPTIONAL column. The natural match key (empty = the
//                    record mints a fresh entity).
//     entity_type  — OPTIONAL column. The record-type discriminator.
//     deleted_at   — OPTIONAL column. Strict ISO 8601 on tombstone rows
//                    (the incumbent's soft-delete export — records stay
//                    in the export with deleted_at set, exactly how real
//                    systems export soft deletes); empty on live rows.
//
// DELTA SEMANTICS: an export version is a FULL state; a delta read diffs
// the referenced version against the LATEST version by row (canonical
// record equality). The export format carries no interim change journal,
// so a row that appeared AND vanished between two endpoint versions is
// invisible to their diff — an inherent format limitation, documented
// here rather than papered over. A row present in the base version but
// ABSENT from the latest (without a tombstone) is surfaced as an explicit
// rejection ('disappeared-without-tombstone') — never silently dropped.
//
// This module is deliberately provider-neutral and dependency-free (pure
// node builtins + the migration module's own shapes): provider objects
// never cross (lock 16), and no CSV third-party parser is pulled in — the
// RFC 4180 state machine below is small, deterministic and fully covered
// by the W111 tests.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MigrationError } from '../errors';

/** The export-version directory prefix (csv-export-<NNN>). */
export const CSV_EXPORT_DIR_PREFIX = 'csv-export-';

/** The export file every version directory carries. */
export const CSV_EXPORT_RECORDS_FILE = 'records.csv';

/** The snapshot reference pattern a version directory mints. */
export const CSV_EXPORT_SNAPSHOT_REF_PATTERN = /^csv-export-(\d+)$/;

/** The header columns this format defines. */
export const CSV_EXPORT_COLUMNS = [
  'external_id',
  'payload_json',
  'match_key',
  'entity_type',
  'deleted_at',
] as const;

/** The columns every export must carry (the rest are optional). */
export const CSV_EXPORT_REQUIRED_COLUMNS: readonly string[] = ['external_id', 'payload_json'];

/** One parsed CSV record: its fields plus its RAW source text (evidence). */
export interface CsvRecord {
  /** The decoded fields (RFC 4180 unescaped). */
  fields: string[];
  /** The record's raw source text (without the record separator). */
  raw: string;
}

/** One parsed export version file. */
export interface CsvExportVersion {
  /** The version number (the NNN of its directory). */
  version: number;
  /** The snapshot reference (the directory name). */
  snapshotRef: string;
  /** The header columns, in file order. */
  header: string[];
  /** The data records (header excluded), in file order. */
  records: CsvRecord[];
}

// ---------------------------------------------------------------------------
// The RFC 4180 state machine
// ---------------------------------------------------------------------------

/**
 * Parses RFC 4180 CSV text into records. Accepted (documented, real-world
 * tolerant): CRLF / LF / CR separators, quoted fields embedding commas,
 * doubled quotes and line breaks, a missing trailing separator on the
 * final record, an optional leading UTF-8 BOM, and an unterminated quoted
 * field at end-of-input (the field closes at the buffer's end). A record
 * consisting of exactly one empty field (a blank line) carries no data
 * and is skipped.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let recordStart = 0;
  let recordHasData = false;

  const pushField = (): void => {
    fields.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const pushRecord = (end: number): void => {
    const raw = text.slice(recordStart, end);
    // A blank line (exactly one empty, unquoted field) carries no data.
    if (!(fields.length === 1 && fields[0] === '' && !recordHasData)) {
      records.push({ fields: [...fields], raw });
    }
    fields = [];
    recordHasData = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '' && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
      recordHasData = true;
      continue;
    }
    if (char === ',') {
      pushField();
      recordHasData = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      // Consume the full separator (CRLF as one).
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      pushField();
      pushRecord(index + 1);
      recordStart = index + 1;
      continue;
    }
    field += char;
    recordHasData = true;
  }
  // End of input: close any open field/record (a missing trailing
  // separator or an unterminated quote both close here).
  if (inQuotes || field !== '' || fields.length > 0 || recordHasData) {
    pushField();
    pushRecord(text.length);
  }
  return records;
}

// ---------------------------------------------------------------------------
// The export-directory library
// ---------------------------------------------------------------------------

/** Lists the export versions present under the root (ascending). */
export async function listExportVersions(exportRoot: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(exportRoot);
  } catch (error) {
    throw new MigrationError(
      'invalid_reader_result',
      `the csv export root '${exportRoot}' cannot be read (${(error as Error).message}) — the incumbent export share must be mounted before reads`,
    );
  }
  const versions: number[] = [];
  for (const entry of entries) {
    const match = CSV_EXPORT_SNAPSHOT_REF_PATTERN.exec(entry);
    if (match !== null) versions.push(Number.parseInt(match[1]!, 10));
  }
  return versions.sort((a, b) => a - b);
}

/** Resolves a snapshot reference to its version number (null = a full read). */
export function versionOfSnapshotRef(snapshotRef: string | null): number | null {
  if (snapshotRef === null) return null;
  const match = CSV_EXPORT_SNAPSHOT_REF_PATTERN.exec(snapshotRef);
  return match === null ? null : Number.parseInt(match[1]!, 10);
}

/**
 * Reads + parses one export version. The file is read as raw bytes and
 * decoded UTF-8 with replacement (undecodable sequences surface as
 * U+FFFD INSIDE the affected rows — the reader rejects those rows
 * per-row as 'invalid-encoding' instead of failing the whole export).
 */
export async function readExportVersion(
  exportRoot: string,
  version: number,
): Promise<CsvExportVersion> {
  const snapshotRef = `${CSV_EXPORT_DIR_PREFIX}${version}`;
  const file = path.join(exportRoot, snapshotRef, CSV_EXPORT_RECORDS_FILE);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new MigrationError(
      'invalid_reader_result',
      `the csv export version '${snapshotRef}' has no readable '${CSV_EXPORT_RECORDS_FILE}' (${(error as Error).message})`,
    );
  }
  const decoder = new TextDecoder('utf-8');
  let text = decoder.decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = parseCsvRecords(text);
  const headerRecord = records[0];
  if (headerRecord === undefined) {
    throw new MigrationError(
      'invalid_reader_result',
      `the csv export version '${snapshotRef}' carries no header record — configure the incumbent export with the columns ${CSV_EXPORT_COLUMNS.join(', ')}`,
    );
  }
  const header = headerRecord.fields.map((column) => column.trim());
  validateHeader(header, snapshotRef);
  return { version, snapshotRef, header, records: records.slice(1) };
}

/** Validates the header: required columns present, no duplicates, no unknowns. */
function validateHeader(header: string[], snapshotRef: string): void {
  const seen = new Set<string>();
  for (const column of header) {
    if (!(CSV_EXPORT_COLUMNS as readonly string[]).includes(column)) {
      throw new MigrationError(
        'invalid_reader_result',
        `the csv export version '${snapshotRef}' declares unknown header column '${column}' (recognized: ${CSV_EXPORT_COLUMNS.join(', ')}) — fix the incumbent export configuration`,
      );
    }
    if (seen.has(column)) {
      throw new MigrationError(
        'invalid_reader_result',
        `the csv export version '${snapshotRef}' declares header column '${column}' twice — fix the incumbent export configuration`,
      );
    }
    seen.add(column);
  }
  for (const required of CSV_EXPORT_REQUIRED_COLUMNS) {
    if (!seen.has(required)) {
      throw new MigrationError(
        'invalid_reader_result',
        `the csv export version '${snapshotRef}' is missing the required header column '${required}' — fix the incumbent export configuration`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Row → candidate mapping
// ---------------------------------------------------------------------------

/** A row-mapping failure carrying its own reason code (never thrown past the reader). */
export class CsvRowError extends Error {
  constructor(
    public readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'CsvRowError';
  }
}

/**
 * Maps one parsed data record to the incumbent-record candidate shape
 * (the pre-canonicalization object — the reader canonicalizes it with the
 * module's own `canonicalizeIncumbentRecord` so a REAL rejection reason
 * is recorded, never a guessed one).
 */
export function buildRecordCandidate(
  record: CsvRecord,
  header: readonly string[],
): {
  externalId: string;
  matchKey: string | null;
  entityType: string | null;
  payload: Record<string, unknown> | null;
  deletedAt: string | null;
} {
  if (record.fields.length !== header.length) {
    throw new CsvRowError(
      'wrong-field-count',
      `the row has ${record.fields.length} field(s) but the header declares ${header.length} — a truncated or hand-edited export row`,
    );
  }
  const cell = (column: string): string => {
    const index = header.indexOf(column);
    return index === -1 ? '' : (record.fields[index] ?? '');
  };
  const externalId = cell('external_id');
  const deletedAtCell = cell('deleted_at');
  const deletedAt = deletedAtCell === '' ? null : deletedAtCell;
  const payloadCell = cell('payload_json');

  let payload: Record<string, unknown> | null = null;
  if (payloadCell !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadCell);
    } catch (error) {
      throw new CsvRowError(
        'invalid-record',
        `the payload_json cell is not valid JSON (${(error as Error).message})`,
      );
    }
    payload = parsed as Record<string, unknown>;
  }
  return {
    externalId,
    matchKey: cell('match_key') === '' ? null : cell('match_key'),
    entityType: cell('entity_type') === '' ? null : cell('entity_type'),
    payload,
    deletedAt,
  };
}
