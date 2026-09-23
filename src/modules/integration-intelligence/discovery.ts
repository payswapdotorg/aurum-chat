// Pure discovery-classification logic of the integration-intelligence
// module (no database, no clock, no network).
//
// The ONLY input to discovery is what an ADMIN-GRANTED source's authorized
// poll already delivered through the sources module (W036): canonical
// records that became immutable observations. This file interprets those
// records — it never fetches anything. The no-scan invariant is structural
// here: there is no function in this module that can touch a network, and
// the service refuses to poll anything without an active admin grant
// before a single byte of transport I/O happens.
//
// The canonical directory-record convention (what a discovery source's
// adapter/transport emits — the shape W082 connection brokers and W088
// Edge jobs will produce for approved directory/admin APIs):
//
//   kind    = 'directory.system.discovered'
//   payload = {
//     externalId: string,          // the directory's stable opaque id
//     displayName: string,         // how the organization knows this system
//     description?: string | null,
//     capabilityClasses: string[], // registry keys (validated, ≥ 1)
//     dataCategories?: string[],   // optional extras (validated; unioned
//                                  // with the class-derived set)
//     health?: 'healthy' | 'degraded' | 'unreachable',
//   }
//
// Records with any other kind are NOT directory system records; the caller
// ignores them (a directory source may legitimately deliver other record
// kinds). A directory record whose payload is malformed is a buggy-adapter
// defect and fails loudly with `invalid_directory_record` — the sources
// module's strict adapter-output discipline.

import { IntegrationError } from './errors';
import { capabilityClassOf, dataCategoryOf } from './vocabulary';
import type { SystemCapability, SystemHealth } from './types';

/** The canonical observation kind of one discovered-system directory record. */
export const DISCOVERY_RECORD_KIND = 'directory.system.discovered';

/** The validated, canonicalized manifest of one discovered system. */
export interface DiscoveredSystemManifest {
  externalId: string;
  displayName: string;
  description: string | null;
  /** Deduplicated, registry-validated, order-preserving. */
  capabilityClasses: string[];
  /** Sorted union of class-derived + manifest-declared categories. */
  dataCategories: string[];
  health: SystemHealth;
}

const MANIFEST_KEYS = [
  'externalId',
  'displayName',
  'description',
  'capabilityClasses',
  'dataCategories',
  'health',
] as const;

const MANIFEST_HEALTHS = new Set<SystemHealth>(['healthy', 'degraded', 'unreachable']);

/**
 * Classifies one polled record. Returns null when the record is not a
 * directory system record (the caller ignores it); returns the validated
 * manifest when it is; throws `invalid_directory_record` when it carries
 * the directory kind but a malformed payload (buggy adapter — never
 * silently swallowed).
 */
export function classifyDirectoryRecord(record: {
  kind: string;
  payload: unknown;
}): DiscoveredSystemManifest | null {
  if (record.kind !== DISCOVERY_RECORD_KIND) return null;
  return validateManifest(record.payload);
}

/** Strict manifest validation + canonicalization (unknown keys rejected). */
function validateManifest(payload: unknown): DiscoveredSystemManifest {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new IntegrationError(
      'invalid_directory_record',
      'directory record payload must be a JSON object',
    );
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(MANIFEST_KEYS as readonly string[]).includes(key)) {
      throw new IntegrationError(
        'invalid_directory_record',
        `directory record payload has unknown key '${key}'`,
      );
    }
  }

  const externalId = requirePrintable(record, 'externalId', 255);
  const displayName = requirePrintable(record, 'displayName', 200);

  let description: string | null = null;
  if (record.description !== undefined && record.description !== null) {
    if (typeof record.description !== 'string' || record.description.trim().length === 0) {
      throw new IntegrationError('invalid_directory_record', "'description' must be a non-empty string or null");
    }
    description = record.description.trim().slice(0, 2000);
  }

  // Capability classes: 1..16 registry keys, deduplicated order-preserving.
  const rawClasses = record.capabilityClasses;
  if (!Array.isArray(rawClasses) || rawClasses.length < 1 || rawClasses.length > 16) {
    throw new IntegrationError(
      'invalid_directory_record',
      "'capabilityClasses' must be an array of 1..16 registry keys",
    );
  }
  const capabilityClasses: string[] = [];
  for (const entry of rawClasses) {
    if (typeof entry !== 'string' || capabilityClassOf(entry) === null) {
      throw new IntegrationError(
        'invalid_directory_record',
        `'capabilityClasses' contains unknown capability class '${String(entry)}'`,
      );
    }
    if (!capabilityClasses.includes(entry)) capabilityClasses.push(entry);
  }

  // Data categories: optional 0..32 registry keys; unioned with the
  // class-derived set so the manifest can add categories its classes do
  // not imply, but never contradict them.
  const categories = new Set<string>();
  for (const classKey of capabilityClasses) {
    for (const category of capabilityClassOf(classKey)!.dataCategories) categories.add(category);
  }
  if (record.dataCategories !== undefined && record.dataCategories !== null) {
    if (!Array.isArray(record.dataCategories) || record.dataCategories.length > 32) {
      throw new IntegrationError(
        'invalid_directory_record',
        "'dataCategories' must be an array of at most 32 registry keys",
      );
    }
    for (const entry of record.dataCategories) {
      if (typeof entry !== 'string' || dataCategoryOf(entry) === null) {
        throw new IntegrationError(
          'invalid_directory_record',
          `'dataCategories' contains unknown data category '${String(entry)}'`,
        );
      }
      categories.add(entry);
    }
  }

  let health: SystemHealth = 'unknown';
  if (record.health !== undefined && record.health !== null) {
    if (typeof record.health !== 'string' || !MANIFEST_HEALTHS.has(record.health as SystemHealth)) {
      throw new IntegrationError('invalid_directory_record', `'health' must be one of healthy|degraded|unreachable`);
    }
    health = record.health as SystemHealth;
  }

  return {
    externalId,
    displayName,
    description,
    capabilityClasses,
    dataCategories: [...categories].sort(),
    health,
  };
}

function requirePrintable(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new IntegrationError(
      'invalid_directory_record',
      `'${key}' must be a non-empty printable string of at most ${maxLength} characters`,
    );
  }
  return value.trim();
}

/** The canonical tenant-unique identity of a discovered system. */
export function systemKeyOf(sourceId: string, externalId: string): string {
  return `${sourceId}:${externalId}`;
}

/**
 * Derives a system's full capability surface from its validated classes —
 * read capabilities and write-gated capabilities, in registry order.
 * This is the inventory's "capability surface" and the recommendation's
 * scope-impact source of truth (what would be read / what stays gated).
 */
export function deriveCapabilitySurface(capabilityClasses: readonly string[]): SystemCapability[] {
  const surface: SystemCapability[] = [];
  for (const classKey of capabilityClasses) {
    const entry = capabilityClassOf(classKey);
    if (entry === null) continue; // validated upstream; defensive only
    for (const read of entry.readCapabilities) {
      surface.push({
        key: read.key,
        capabilityClass: classKey,
        label: read.label,
        mode: 'read',
        dataCategories: [...entry.dataCategories],
      });
    }
    for (const write of entry.writeCapabilities) {
      surface.push({
        key: write.key,
        capabilityClass: classKey,
        label: write.label,
        mode: 'write',
        dataCategories: [...entry.dataCategories],
      });
    }
  }
  return surface;
}
