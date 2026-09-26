// The PURE deterministic logic of the migration module (W094) — no
// database, no clock, no network, no LLM (lock 10 discipline: comparison
// is a computation, not an opinion).
//
// TWO computations live here, and both RE-USE the deep-actions module's
// own pure reconciliation surface through its public contract (the
// computer-use precedent — ONE comparison semantics, never a fork):
//
//   1. THE DUAL-RUN COMPARISON — `compareEntity` answers ONE question
//      per entity: do the incumbent-imported state and the native Aurum
//      state agree? Value divergences ride `reconcileOperation` (the
//      W084 subset walk with path/expected/actual mismatch enumeration);
//      one-sided fields are enumerated structurally. The verdict and its
//      deterministic reason are DATA — divergences are surfaced, never
//      reconciled silently.
//
//   2. THE TRANSFORM'S SCHEMA-HINT CHECK — `detectSchemaHintIssues`
//      validates one staged record's payload against a bound vertical
//      kit's declared schema hints (W092, read through the vertical-kits
//      contract's manifest shape). Issues are surfaced on the record —
//      the transform NEVER drops a record silently.
//
// The kit-schema-hint field types are the kit manifest's plain-language
// vocabulary ('string', 'date', 'decimal', ...). The recognized set is
// checked shallowly and deterministically; an unrecognized hint type is
// itself surfaced as an issue rather than guessed at.

import {
  jsonDeepEqual,
  reconcileOperation,
} from '@/modules/deep-actions/contract';
import type {
  ComparisonEntryKind,
  ComparisonMismatch,
  ComparisonStructuralField,
  ImportedRecordIssue,
} from './types';

// ---------------------------------------------------------------------------
// The dual-run comparison (the acceptance core)
// ---------------------------------------------------------------------------

/** The pure comparison verdict for one entity. */
export interface EntityComparison {
  kind: ComparisonEntryKind;
  /** Value divergences (empty unless kind = 'divergence'). */
  mismatches: ComparisonMismatch[];
  /** Fields only the incumbent-imported state holds. */
  incumbentOnlyFields: ComparisonStructuralField[];
  /** Fields only the native state holds. */
  nativeOnlyFields: ComparisonStructuralField[];
  /** The deterministic divergence reason (null on agreements). */
  reason: string | null;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'absent';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'non-JSON' : serialized;
}

/**
 * The deterministic divergence reason — the investigating operator reads
 * the same sentence the comparison entry carries (the W084
 * buildMismatchReason precedent: exact paths and values, never merely
 * "something diverged").
 */
export function buildDivergenceReason(
  aurumEntityId: string,
  mismatches: ComparisonMismatch[],
  incumbentOnly: ComparisonStructuralField[],
  nativeOnly: ComparisonStructuralField[],
): string {
  const parts: string[] = [];
  for (const mismatch of mismatches) {
    parts.push(
      `field '${mismatch.path}' diverges (incumbent-imported ${describeValue(mismatch.expected)} vs native ${describeValue(mismatch.actual)})`,
    );
  }
  for (const field of incumbentOnly) {
    parts.push(`field '${field.field}' only exists in the incumbent-imported state`);
  }
  for (const field of nativeOnly) {
    parts.push(`field '${field.field}' only exists in the native Aurum state`);
  }
  return `entity '${aurumEntityId}' diverges between incumbent-imported and native Aurum state: ${parts.join('; ')}`;
}

/**
 * Compares one entity's incumbent-imported state against its native
 * Aurum state — THE dual-run question, evaluated deterministically.
 *
 *   * incumbent null (tombstoned) + native present  → 'incumbent-deleted';
 *   * incumbent present + native null               → 'native-missing';
 *   * both present → every shared top-level field compared with the W084
 *     reconciliation walk (subset semantics over the incumbent's shared
 *     fields — nested objects descend, arrays compare ordered), one-sided
 *     fields enumerated structurally; any divergence → 'divergence' with
 *     the mismatches and the deterministic reason, else 'agreement'.
 */
export function compareEntity(input: {
  aurumEntityId: string;
  incumbentState: Record<string, unknown> | null;
  nativeState: Record<string, unknown> | null;
}): EntityComparison {
  const { aurumEntityId, incumbentState, nativeState } = input;
  if (incumbentState === null && nativeState === null) {
    return {
      kind: 'agreement',
      mismatches: [],
      incumbentOnlyFields: [],
      nativeOnlyFields: [],
      reason: null,
    };
  }
  if (incumbentState === null) {
    return {
      kind: 'incumbent-deleted',
      mismatches: [],
      incumbentOnlyFields: [],
      nativeOnlyFields: [],
      reason: `entity '${aurumEntityId}' is deleted in the incumbent but the native Aurum state still holds it`,
    };
  }
  if (nativeState === null) {
    return {
      kind: 'native-missing',
      mismatches: [],
      incumbentOnlyFields: [],
      nativeOnlyFields: [],
      reason: `entity '${aurumEntityId}' is imported from the incumbent but Aurum holds no native state for it`,
    };
  }
  const incumbentKeys = Object.keys(incumbentState);
  const nativeKeys = Object.keys(nativeState);
  const nativeKeySet = new Set(nativeKeys);
  const incumbentKeySet = new Set(incumbentKeys);
  const sharedKeys = incumbentKeys.filter((key) => nativeKeySet.has(key));
  const incumbentOnly = incumbentKeys.filter((key) => !nativeKeySet.has(key));
  const nativeOnly = nativeKeys.filter((key) => !incumbentKeySet.has(key));

  // The W084 reconciliation walk over the incumbent's shared fields: every
  // incumbent-imported value must be present and structurally equal in the
  // native state (expected = incumbent-imported, actual = native).
  const sharedExpectation: Record<string, unknown> = {};
  for (const key of sharedKeys) {
    sharedExpectation[key] = incumbentState[key];
  }
  const reconciliation = reconcileOperation(
    sharedExpectation,
    nativeState,
    null,
  );

  const incumbentOnlyFields: ComparisonStructuralField[] = incumbentOnly.map((field) => ({
    field,
    value: incumbentState[field],
  }));
  const nativeOnlyFields: ComparisonStructuralField[] = nativeOnly.map((field) => ({
    field,
    value: nativeState[field],
  }));

  if (
    reconciliation.mismatches.length === 0 &&
    incumbentOnlyFields.length === 0 &&
    nativeOnlyFields.length === 0
  ) {
    return {
      kind: 'agreement',
      mismatches: [],
      incumbentOnlyFields: [],
      nativeOnlyFields: [],
      reason: null,
    };
  }
  return {
    kind: 'divergence',
    mismatches: reconciliation.mismatches,
    incumbentOnlyFields,
    nativeOnlyFields,
    reason: buildDivergenceReason(
      aurumEntityId,
      reconciliation.mismatches,
      incumbentOnlyFields,
      nativeOnlyFields,
    ),
  };
}

/** The deterministic reason for a native-only entity (surfaced, not hidden). */
export function buildIncumbentMissingReason(aurumEntityId: string): string {
  return `entity '${aurumEntityId}' holds a native Aurum state the incumbent never imported (a native-only entity)`;
}

// ---------------------------------------------------------------------------
// The transform's schema-hint check (the W092 composition)
// ---------------------------------------------------------------------------

/** The kit manifest's plain-language field hint (the W092 contract shape). */
export interface KitSchemaHintFieldLike {
  name: string;
  type: string;
  required: boolean;
}

/** The kit manifest's schema-hint shape (the W092 contract shape). */
export interface KitSchemaHintLike {
  entity: string;
  fields: KitSchemaHintFieldLike[];
}

/** The hint types the check recognizes (shallow, deterministic). */
const RECOGNIZED_HINT_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'decimal',
]);

function valueMatchesHintType(value: unknown, hintType: string): boolean {
  switch (hintType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'decimal':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    default:
      return false;
  }
}

/**
 * Validates one staged record's payload against the kit's declared
 * schema hints for the record's entity type. A missing hint for the
 * entity type means NO check (the kit simply does not hint that entity —
 * never an error). Every finding is a SURFACED issue — the transform
 * never drops a record and never rewrites its payload.
 */
export function detectSchemaHintIssues(
  payload: Record<string, unknown>,
  entityType: string | null,
  schemaHints: readonly KitSchemaHintLike[],
): ImportedRecordIssue[] {
  if (entityType === null) return [];
  const hint = schemaHints.find((candidate) => candidate.entity === entityType);
  if (hint === undefined) return [];
  const issues: ImportedRecordIssue[] = [];
  const present = new Set(Object.keys(payload));
  for (const field of hint.fields) {
    if (!present.has(field.name)) {
      if (field.required) {
        issues.push({
          code: 'schema-hint-required-field-missing',
          field: field.name,
          detail: `the bound kit declares '${field.name}' as required on '${entityType}' but the incumbent record does not carry it`,
        });
      }
      continue;
    }
    const value = payload[field.name];
    if (value === null) {
      if (field.required) {
        issues.push({
          code: 'schema-hint-required-field-null',
          field: field.name,
          detail: `the bound kit declares '${field.name}' as required on '${entityType}' but the incumbent record carries null`,
        });
      }
      continue;
    }
    if (!RECOGNIZED_HINT_TYPES.has(field.type)) {
      issues.push({
        code: 'schema-hint-type-unrecognized',
        field: field.name,
        detail: `the bound kit declares the type '${field.type}' for '${field.name}' on '${entityType}' which the transform does not recognize — the field is carried as-is`,
      });
      continue;
    }
    if (!valueMatchesHintType(value, field.type)) {
      issues.push({
        code: 'schema-hint-type-mismatch',
        field: field.name,
        detail: `the bound kit declares '${field.name}' on '${entityType}' as '${field.type}' but the incumbent record carries ${describeValue(value)}`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Shared structural helpers
// ---------------------------------------------------------------------------

export { jsonDeepEqual };
