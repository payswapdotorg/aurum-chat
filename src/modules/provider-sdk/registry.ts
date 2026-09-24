// The OSS technology registry (W089): the committed, machine-readable
// record of evaluated technologies with the §15 due-diligence fields
// (license, security posture, maintenance health, operations fit,
// deployment, data handling, cost/performance, failure modes, exit
// strategy, adapter status, last reviewed).
//
// WHY VERSIONED JSON, NOT A SQL TABLE (the work item leaves the choice to
// the implementer; this is the justification): registry entries are
// PLATFORM REFERENCE DATA that version with review decisions, not tenant
// data — the same reasoning the llm module (W034) applied when it made its
// provider/model catalog code-owned instead of a table: every persisted
// domain table must be tenant-scoped (check-architecture rule (d); only
// the platform allowlist is exempt), and a global technology registry is
// not tenant data. A committed JSON file additionally gives the Tech Lead
// git-reviewable diffs (every registry change is a reviewable commit) and
// avoids touching the shared scripts/arch-allowlist.json. Queryability is
// provided by the typed query functions below (and the review CLI at
// scripts/technology-registry.ts); schema validation runs at load and is
// enforced by this module's tests.
//
// SEED PROVENANCE: entries are seeded from spec/TECHNOLOGY-RESEARCH-2026-
// 09-23.md with STRICT provenance — fields the research record did not
// assess are recorded as null/unknown rather than invented, and every
// entry cites its sources. The adopting work item must complete the
// unknown fields before its adapter merges (the §15 gate).
//
// Communication-neutrality (final reconciliation, Wave-0 baseline §3):
// entries record evaluated technologies without presupposing any
// communication-kernel technology; the CommOS fusion section of the
// research record is therefore NOT seeded as a registry entry.

import registryData from './registry/technologies.json';
import { ProviderSdkError } from './errors';

// ---------------------------------------------------------------------------
// Schema (mirrors registry/technologies.json; documented in README.md)
// ---------------------------------------------------------------------------

export const TECHNOLOGY_REGISTRY_SCHEMA_VERSION = 1;

export type TechnologyPriority = 'P0' | 'P1' | 'P2';

export type LicenseSourceAvailability =
  | 'open-source'
  | 'source-available'
  | 'proprietary'
  | 'open-standard'
  | 'unknown';

export type SecurityPosture = 'strong' | 'adequate' | 'needs-review' | 'unknown';

export type MaintenanceHealth = 'active' | 'maintained' | 'slowing' | 'unclear' | 'unknown';

export type OperationsFit = 'excellent' | 'good' | 'conditional' | 'poor' | 'unknown';

export type TechnologyAdapterStatus =
  | 'adopted' // an adapter/port implementation exists in the repository
  | 'adapter-planned' // a committed work item will build the adapter
  | 'candidate' // evaluated; not yet committed
  | 'monitoring' // tracked; no adoption intent without new evidence
  | 'rejected'; // evaluated and declined

export interface TechnologyLicense {
  /** SPDX identifier when verified; null when unverified. */
  readonly spdx: string | null;
  readonly source: LicenseSourceAvailability;
  readonly notes: string | null;
}

export interface TechnologySecurity {
  readonly posture: SecurityPosture;
  readonly notes: string | null;
}

export interface TechnologyMaintenance {
  readonly health: MaintenanceHealth;
  readonly notes: string | null;
}

export interface TechnologyOperations {
  readonly fit: OperationsFit;
  /** Short deployment/control descriptor (e.g. 'hosted API', 'self-hosted'). */
  readonly deployment: string | null;
  readonly notes: string | null;
}

export interface TechnologyDataHandling {
  readonly summary: string | null;
  readonly notes: string | null;
}

export interface TechnologyCostPerformance {
  readonly summary: string | null;
  readonly notes: string | null;
}

export interface TechnologyExitStrategy {
  /** How the technology is replaced/removed without domain damage. */
  readonly replacementPath: string | null;
  readonly notes: string | null;
}

export interface TechnologyRegistryEntry {
  /** Stable unique slug (e.g. 'livekit'). */
  readonly entryId: string;
  /** The capability family this technology was evaluated for. */
  readonly capability: string;
  /** Provider/project display name. */
  readonly technology: string;
  /** What capability it solves (§15 field 1). */
  readonly summary: string;
  /** Candidate priority from the research record; null for adopted/unranked. */
  readonly priority: TechnologyPriority | null;
  readonly license: TechnologyLicense;
  readonly security: TechnologySecurity;
  readonly maintenance: TechnologyMaintenance;
  readonly operations: TechnologyOperations;
  readonly dataHandling: TechnologyDataHandling;
  readonly costPerformance: TechnologyCostPerformance;
  /** Known failure modes (§15). */
  readonly failureModes: readonly string[];
  readonly exitStrategy: TechnologyExitStrategy;
  readonly adapterStatus: TechnologyAdapterStatus;
  /** Repository location of the implementing adapter/port; null when none exists yet. */
  readonly adapterModule: string | null;
  /** ISO date (YYYY-MM-DD) of the last recorded review. */
  readonly lastReviewed: string;
  readonly reviewedBy: string;
  /** Provenance: the documents this entry cites. */
  readonly sources: readonly string[];
}

interface RegistryFile {
  readonly registryVersion: number;
  readonly seedSource: string;
  readonly entries: unknown;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PRIORITIES: readonly string[] = ['P0', 'P1', 'P2'];
const LICENSE_SOURCES: readonly string[] = ['open-source', 'source-available', 'proprietary', 'open-standard', 'unknown'];
const SECURITY_POSTURES: readonly string[] = ['strong', 'adequate', 'needs-review', 'unknown'];
const MAINTENANCE_HEALTHS: readonly string[] = ['active', 'maintained', 'slowing', 'unclear', 'unknown'];
const OPERATIONS_FITS: readonly string[] = ['excellent', 'good', 'conditional', 'poor', 'unknown'];
const ADAPTER_STATUSES: readonly string[] = ['adopted', 'adapter-planned', 'candidate', 'monitoring', 'rejected'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Every string field of the subobject must be a non-empty string or null. */
function validateStringOrNullFields(value: unknown, where: string, fields: readonly string[], issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push(`${where} must be an object`);
    return;
  }
  for (const field of fields) {
    const raw = value[field];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string' || raw.trim() === '') {
      issues.push(`${where}.${field} must be a non-empty string or null`);
    }
  }
}

function validateEnumField(
  holder: unknown,
  where: string,
  field: string,
  allowed: readonly string[],
  issues: string[],
): void {
  if (!isPlainObject(holder)) return; // the object-shape error is reported elsewhere
  const value = holder[field];
  if (!allowed.includes(value as string)) {
    issues.push(`${where}.${field} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`);
  }
}

/**
 * Validate one registry entry against the schema. Returns the list of
 * issues (empty = valid). Total and deterministic — safe on untrusted data.
 */
export function validateTechnologyRegistryEntry(entry: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(entry)) {
    issues.push('the entry must be an object');
    return issues;
  }

  const entryId = entry['entryId'];
  if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) {
    issues.push(`entryId must be a lowercase kebab-case slug (got ${JSON.stringify(entryId)})`);
  }
  for (const field of ['capability', 'technology', 'summary'] as const) {
    const value = entry[field];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(`${field} must be a non-empty string`);
    }
  }
  const priority = entry['priority'];
  if (priority !== null && priority !== undefined && !PRIORITIES.includes(priority as string)) {
    issues.push(`priority must be 'P0' | 'P1' | 'P2' or null (got ${JSON.stringify(priority)})`);
  }

  validateStringOrNullFields(entry['license'], 'license', ['spdx', 'notes'], issues);
  validateEnumField(entry['license'], 'license', 'source', LICENSE_SOURCES, issues);

  validateStringOrNullFields(entry['security'], 'security', ['notes'], issues);
  validateEnumField(entry['security'], 'security', 'posture', SECURITY_POSTURES, issues);

  validateStringOrNullFields(entry['maintenance'], 'maintenance', ['notes'], issues);
  validateEnumField(entry['maintenance'], 'maintenance', 'health', MAINTENANCE_HEALTHS, issues);

  validateStringOrNullFields(entry['operations'], 'operations', ['deployment', 'notes'], issues);
  validateEnumField(entry['operations'], 'operations', 'fit', OPERATIONS_FITS, issues);

  validateStringOrNullFields(entry['dataHandling'], 'dataHandling', ['summary', 'notes'], issues);
  validateStringOrNullFields(entry['costPerformance'], 'costPerformance', ['summary', 'notes'], issues);

  const failureModes = entry['failureModes'];
  if (!Array.isArray(failureModes)) {
    issues.push('failureModes must be an array of strings');
  } else {
    for (const mode of failureModes) {
      if (typeof mode !== 'string' || mode.trim() === '') {
        issues.push('failureModes must contain non-empty strings only');
      }
    }
  }

  validateStringOrNullFields(entry['exitStrategy'], 'exitStrategy', ['replacementPath', 'notes'], issues);

  validateEnumField(entry, 'entry', 'adapterStatus', ADAPTER_STATUSES, issues);
  const adapterModule = entry['adapterModule'];
  if (adapterModule !== null && adapterModule !== undefined && typeof adapterModule !== 'string') {
    issues.push('adapterModule must be a string or null');
  }
  const lastReviewed = entry['lastReviewed'];
  if (typeof lastReviewed !== 'string' || !ISO_DATE_PATTERN.test(lastReviewed)) {
    issues.push(`lastReviewed must be an ISO date (YYYY-MM-DD) (got ${JSON.stringify(lastReviewed)})`);
  }
  if (typeof entry['reviewedBy'] !== 'string' || (entry['reviewedBy'] as string).trim() === '') {
    issues.push('reviewedBy must be a non-empty string');
  }
  const sources = entry['sources'];
  if (!Array.isArray(sources) || sources.length === 0) {
    issues.push('sources must be a non-empty array (every entry cites its provenance)');
  } else {
    for (const source of sources) {
      if (typeof source !== 'string' || source.trim() === '') {
        issues.push('sources must contain non-empty strings only');
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Load + query
// ---------------------------------------------------------------------------

const file = registryData as RegistryFile;

if (file.registryVersion !== TECHNOLOGY_REGISTRY_SCHEMA_VERSION) {
  throw new ProviderSdkError(
    'invalid_registry_entry',
    `technology registry schema version mismatch: file carries ${String(file.registryVersion)}, code expects ${TECHNOLOGY_REGISTRY_SCHEMA_VERSION}`,
  );
}
if (!Array.isArray(file.entries)) {
  throw new ProviderSdkError('invalid_registry_entry', 'technology registry file must carry an entries array');
}

// Load-time validation: every committed entry must be schema-valid and the
// entry ids unique — a malformed registry fails loudly at import, never
// silently (tested in sdk-registry.test.ts).
{
  const seen = new Set<string>();
  for (const raw of file.entries) {
    const issues = validateTechnologyRegistryEntry(raw);
    const id = isPlainObject(raw) ? String(raw['entryId']) : '<missing entryId>';
    if (issues.length > 0) {
      throw new ProviderSdkError(
        'invalid_registry_entry',
        `technology registry entry '${id}' is invalid: ${issues.join('; ')}`,
      );
    }
    if (seen.has(id)) {
      throw new ProviderSdkError('invalid_registry_entry', `technology registry entry id '${id}' is not unique`);
    }
    seen.add(id);
  }
}

const ENTRIES: readonly TechnologyRegistryEntry[] = (file.entries as unknown[]).map(
  (raw) => raw as TechnologyRegistryEntry,
);

/** Every registry entry, in committed order. */
export function listTechnologyEntries(): TechnologyRegistryEntry[] {
  return ENTRIES.map((entry) => ({ ...entry }));
}

/** Find one entry by its stable id; null when absent. */
export function findTechnologyEntry(entryId: string): TechnologyRegistryEntry | null {
  const found = ENTRIES.find((entry) => entry.entryId === entryId);
  return found === undefined ? null : { ...found };
}

/** Every entry evaluated for one capability family. */
export function listTechnologyEntriesByCapability(capability: string): TechnologyRegistryEntry[] {
  return ENTRIES.filter((entry) => entry.capability === capability).map((entry) => ({ ...entry }));
}

/** Every entry with one candidate priority (adopted/unranked entries carry null). */
export function listTechnologyEntriesByPriority(priority: TechnologyPriority): TechnologyRegistryEntry[] {
  return ENTRIES.filter((entry) => entry.priority === priority).map((entry) => ({ ...entry }));
}

/** Every entry in one adapter status. */
export function listTechnologyEntriesByAdapterStatus(
  status: TechnologyAdapterStatus,
): TechnologyRegistryEntry[] {
  return ENTRIES.filter((entry) => entry.adapterStatus === status).map((entry) => ({ ...entry }));
}

/** The distinct capability families the registry records. */
export function listTechnologyCapabilities(): string[] {
  return [...new Set(ENTRIES.map((entry) => entry.capability))].sort();
}

/**
 * Review summary for the Tech Lead: counts per status and per priority,
 * plus entries still carrying unassessed §15 fields (the due-diligence
 * backlog the adopting work items must clear).
 */
export function technologyRegistryReviewSummary(): {
  readonly totalEntries: number;
  readonly byAdapterStatus: Readonly<Record<string, number>>;
  readonly byPriority: Readonly<Record<string, number>>;
  readonly capabilities: readonly string[];
  readonly pendingDueDiligence: ReadonlyArray<{
    readonly entryId: string;
    readonly missingFields: readonly string[];
  }>;
} {
  const byAdapterStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const pending: Array<{ entryId: string; missingFields: string[] }> = [];
  for (const entry of ENTRIES) {
    byAdapterStatus[entry.adapterStatus] = (byAdapterStatus[entry.adapterStatus] ?? 0) + 1;
    const priorityKey = entry.priority ?? 'unranked';
    byPriority[priorityKey] = (byPriority[priorityKey] ?? 0) + 1;
    const missing: string[] = [];
    if (entry.license.spdx === null || entry.license.source === 'unknown') missing.push('license');
    if (entry.security.posture === 'unknown') missing.push('security');
    if (entry.maintenance.health === 'unknown') missing.push('maintenance');
    if (entry.operations.fit === 'unknown') missing.push('operations.fit');
    if (entry.dataHandling.summary === null) missing.push('dataHandling');
    if (entry.costPerformance.summary === null) missing.push('costPerformance');
    if (entry.failureModes.length === 0) missing.push('failureModes');
    if (missing.length > 0) pending.push({ entryId: entry.entryId, missingFields: missing });
  }
  return {
    totalEntries: ENTRIES.length,
    byAdapterStatus,
    byPriority,
    capabilities: listTechnologyCapabilities(),
    pendingDueDiligence: pending,
  };
}
