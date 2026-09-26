// Pure digest logic of the vertical-kits module (W092). No database, no
// context, no time.
//
// THE SIGNED MANIFEST. Every stored kit version carries the sha-256
// digest of the canonical JSON serialization of its frozen manifest,
// computed by the service at registration. The digest is the manifest's
// integrity signature:
//
//   * deterministic — the same manifest content always digests
//     identically (canonical JSON: recursively sorted object keys, no
//     whitespace), so two humans reviewing the same version agree on the
//     same signature;
//   * tamper-evident — a manifest row edited outside the service fails
//     verification's manifest-integrity check (the recomputed digest
//     differs) and the version read exposes the mismatch as derived
//     state; drift is visible as a new failed run, never a rewrite
//     (the extensions module's verification-drift discipline).

import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization: object keys sorted recursively, no
 * whitespace, JSON string escaping. Arrays keep their order (order is
 * semantic); plain-JSON values only (the manifest is validated before
 * digesting, so undefined/functions never reach here).
 */
export function canonicalKitJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonical(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serializeCanonical(v)}`).join(',')}}`;
}

/**
 * The sha-256 hex digest of the canonical JSON of a kit manifest — the
 * manifest's integrity signature (64 lowercase hex characters).
 */
export function digestKitManifest(manifest: unknown): string {
  return createHash('sha256').update(canonicalKitJson(manifest), 'utf8').digest('hex');
}

/** Is `value` a well-formed manifest digest (64 lowercase hex chars)? */
export function isManifestDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
