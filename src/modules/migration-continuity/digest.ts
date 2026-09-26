// The pure canonical-JSON + checksum surface of the migration-continuity
// module (W094) — the vertical-kits digest.ts precedent: content
// integrity is a computation, not an opinion (lock 10).
//
// The import manifest's no-silent-data-loss contract rests on these
// functions: the SOURCE checksum freezes what the incumbent served, the
// LANDED checksum freezes what Aurum's owning modules actually hold
// (read back through their contracts), and any later disagreement
// between a manifest and the landed rows is a hard failure.

import { createHash } from 'node:crypto';

/**
 * Canonical JSON: keys sorted recursively, no whitespace, stable
// string escaping — two structurally equal plain-JSON values always
 * produce the same bytes (the vertical-kits canonicalKitJson
 * discipline; arrays keep their order).
 */
export function canonicalMigrationJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
    parts.push(`${JSON.stringify(key)}:${serialize(entry === undefined ? null : entry)}`);
  }
  return `{${parts.join(',')}}`;
}

/** sha-256 (hex) of the canonical JSON of a plain-JSON value. */
export function checksumOf(value: unknown): string {
  return createHash('sha256').update(canonicalMigrationJson(value), 'utf8').digest('hex');
}

/**
 * sha-256 (hex) over an ordered list of canonical forms — the batch
 * checksum: the caller sorts the records deterministically (by
 * incumbent id) so the checksum is stable across replays.
 */
export function checksumOfAll(values: unknown[]): string {
  return checksumOf(values);
}

/** Whether a string is a sha-256 hex digest (64 lowercase hex chars). */
export function isChecksum(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
