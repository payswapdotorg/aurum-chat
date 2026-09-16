// Pure verification logic of the extensions module (W025 — Extension
// Contracts). No database, no context, no time.
//
// THE VERIFICATION STATES (the catalog entry's fourth noun). A manifest
// version carries a DERIVED verification state, folded from its
// append-only verification runs:
//
//   UNVERIFIED — no run has been recorded for this manifest version;
//   VERIFIED   — the latest recorded run passed every check;
//   FAILED     — the latest recorded run failed at least one check.
//
// A run is a deterministic, re-runnable STATIC examination of the stored
// manifest against a closed check vocabulary — evidence, not judgment:
// the marketplace's AUTOMATED_VERIFICATION phase and platform review
// (W028) and the builder's verify step (W027) consume and append these
// runs; no LLM participates and no run outcome is ever overwritten
// (append-only, like every evidence store in this codebase).
//
// Why re-examine what registration already validated? Because rules
// evolve: a check added later must be able to FAIL an older manifest
// (drift detection), because rows can be written by paths that bypass
// the service (defense in depth — the checks re-validate with runtime
// type guards rather than trusting the schema cast), and because
// reviewers need per-check evidence, not a bare boolean. The checks are
// exported pure functions so W027/W028 run the SAME verification the
// registry records — one semantics, no drift.

import {
  capabilityDeclarationProblems,
  capabilityPermissionProblems,
  capabilityQuotaProblems,
  EXTENSION_PERMISSIONS,
  isExtensionPermission,
  type ExtensionCapabilities,
  type ExtensionQuotas,
} from './manifest-rules';
import { compareSemver, parseSemver } from './semver';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** The derived verification states of a manifest version. */
export const EXTENSION_VERIFICATION_STATES = [
  'UNVERIFIED',
  'VERIFIED',
  'FAILED',
] as const;

export type ExtensionVerificationState = (typeof EXTENSION_VERIFICATION_STATES)[number];

export function isExtensionVerificationState(
  value: unknown,
): value is ExtensionVerificationState {
  return (
    typeof value === 'string' &&
    (EXTENSION_VERIFICATION_STATES as readonly string[]).includes(value)
  );
}

/**
 * The manifest-format versions this contract understands ("versioned
// extension manifests" — the FORMAT is versioned separately from the
// extension's own semver). Registration accepts exactly these; the
 * `manifest-schema` check re-pins them.
 */
export const MANIFEST_SCHEMA_VERSIONS = [1] as const;

export type ManifestSchemaVersion = (typeof MANIFEST_SCHEMA_VERSIONS)[number];

export function isSupportedManifestSchemaVersion(value: unknown): value is ManifestSchemaVersion {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (MANIFEST_SCHEMA_VERSIONS as readonly number[]).includes(value)
  );
}

/**
 * The closed verification check vocabulary, in canonical run order. Each
 * check is a deterministic pure function of the stored manifest.
 */
export const EXTENSION_VERIFICATION_CHECKS = [
  'manifest-schema',
  'permissions-consistency',
  'capability-declarations',
  'quota-bounds',
  'compatibility-bounds',
] as const;

export type ExtensionVerificationCheck = (typeof EXTENSION_VERIFICATION_CHECKS)[number];

export function isExtensionVerificationCheck(value: unknown): value is ExtensionVerificationCheck {
  return (
    typeof value === 'string' &&
    (EXTENSION_VERIFICATION_CHECKS as readonly string[]).includes(value)
  );
}

/** One check outcome inside a verification run. */
export interface ExtensionVerificationCheckResult {
  check: ExtensionVerificationCheck;
  outcome: 'pass' | 'fail';
  /** null on a clean pass; the problems (joined) on a failure. */
  detail: string | null;
}

/** The outcome of a whole run: every check passed, or at least one failed. */
export type ExtensionVerificationRunOutcome = 'verified' | 'failed';

/** Structural shape a verification run examines (a stored manifest). */
export interface ManifestVerificationSubject {
  manifestSchemaVersion: number;
  requestedPermissions: string[];
  capabilities: ExtensionCapabilities;
  quotas: ExtensionQuotas;
  hostCompatibility: { minVersion: string; maxVersion: string | null };
}

/** A verification run in derived-state shape (what `deriveVerificationState` folds). */
export interface VerificationRunLike {
  id: string;
  /** ISO timestamp of the run. */
  ranAt: string;
  outcome: ExtensionVerificationRunOutcome;
}

// ---------------------------------------------------------------------------
// The deterministic checks
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}


/** `manifest-schema` — the format version is supported and the four rule-bearing sections exist. */
function checkManifestSchema(subject: ManifestVerificationSubject): string[] {
  const problems: string[] = [];
  if (!isSupportedManifestSchemaVersion(subject.manifestSchemaVersion)) {
    problems.push(
      `manifestSchemaVersion must be one of ${MANIFEST_SCHEMA_VERSIONS.join(', ')} (got '${String(subject.manifestSchemaVersion)}')`,
    );
  }
  if (!Array.isArray(subject.requestedPermissions)) {
    problems.push('requestedPermissions must be an array');
  }
  if (!isPlainObject(subject.capabilities)) {
    problems.push('capabilities must be an object');
  }
  if (!isPlainObject(subject.quotas)) {
    problems.push('quotas must be an object');
  }
  if (!isPlainObject(subject.hostCompatibility)) {
    problems.push('hostCompatibility must be an object');
  } else {
    if (typeof subject.hostCompatibility.minVersion !== 'string') {
      problems.push('hostCompatibility.minVersion must be a string');
    }
    if (
      subject.hostCompatibility.maxVersion !== null &&
      subject.hostCompatibility.maxVersion !== undefined &&
      typeof subject.hostCompatibility.maxVersion !== 'string'
    ) {
      problems.push('hostCompatibility.maxVersion must be a semver string or null');
    }
  }
  return problems;
}

/** `permissions-consistency` — closed vocabulary + exact capability/permission match, both directions. */
function checkPermissionsConsistency(subject: ManifestVerificationSubject): string[] {
  const problems: string[] = [];
  if (!Array.isArray(subject.requestedPermissions)) {
    return ['requestedPermissions must be an array'];
  }
  for (const permission of subject.requestedPermissions) {
    if (!isExtensionPermission(permission)) {
      problems.push(
        `unknown permission '${String(permission)}' (closed vocabulary: ${EXTENSION_PERMISSIONS.join(', ')})`,
      );
    }
  }
  if (!isPlainObject(subject.capabilities)) {
    problems.push('capabilities must be an object');
    return problems;
  }
  problems.push(...capabilityPermissionProblems(subject.capabilities, subject.requestedPermissions));
  return problems;
}

/** `capability-declarations` — every declared capability is well-formed. */
function checkCapabilityDeclarations(subject: ManifestVerificationSubject): string[] {
  if (!isPlainObject(subject.capabilities)) {
    return ['capabilities must be an object'];
  }
  return capabilityDeclarationProblems(subject.capabilities);
}

/** `quota-bounds` — integer quotas within ceilings, present exactly when their capability is. */
function checkQuotaBounds(subject: ManifestVerificationSubject): string[] {
  if (!isPlainObject(subject.quotas)) {
    return ['quotas must be an object'];
  }
  for (const field of ['maxStateBytes', 'maxScheduleInvocationsPerDay', 'maxExternalCallsPerDay']) {
    const value = (subject.quotas as Record<string, unknown>)[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return [`quotas.${field} must be an integer (got '${String(value)}')`];
    }
  }
  if (!isPlainObject(subject.capabilities)) {
    return ['capabilities must be an object'];
  }
  return capabilityQuotaProblems(subject.capabilities, subject.quotas);
}

/** `compatibility-bounds` — the declared host-runtime range parses and is well-ordered. */
function checkCompatibilityBounds(subject: ManifestVerificationSubject): string[] {
  const problems: string[] = [];
  if (!isPlainObject(subject.hostCompatibility)) {
    return ['hostCompatibility must be an object'];
  }
  const min = subject.hostCompatibility.minVersion;
  const max = subject.hostCompatibility.maxVersion ?? null;
  if (typeof min !== 'string') {
    return ['hostCompatibility.minVersion must be a semver string'];
  }
  const minParts = parseSemver(min);
  if (minParts === null) {
    problems.push(`hostCompatibility.minVersion '${min}' is not a release semver`);
  }
  if (max !== null) {
    if (typeof max !== 'string') {
      problems.push('hostCompatibility.maxVersion must be a semver string or null');
    } else {
      const maxParts = parseSemver(max);
      if (maxParts === null) {
        problems.push(`hostCompatibility.maxVersion '${max}' is not a release semver`);
      } else if (minParts !== null && compareSemver(minParts, maxParts) > 0) {
        problems.push(
          `hostCompatibility range is inverted: minVersion ${min} is newer than maxVersion ${max}`,
        );
      }
    }
  }
  return problems;
}

/**
 * Run every verification check against a stored manifest — deterministic,
 * total (a check that cannot even be evaluated FAILS with the reason,
 * it never throws). Results in canonical check order.
 */
export function runManifestVerificationChecks(
  subject: ManifestVerificationSubject,
): ExtensionVerificationCheckResult[] {
  const checks: Array<[ExtensionVerificationCheck, (subject: ManifestVerificationSubject) => string[]]> = [
    ['manifest-schema', checkManifestSchema],
    ['permissions-consistency', checkPermissionsConsistency],
    ['capability-declarations', checkCapabilityDeclarations],
    ['quota-bounds', checkQuotaBounds],
    ['compatibility-bounds', checkCompatibilityBounds],
  ];
  return checks.map(([check, run]) => {
    try {
      const problems = run(subject);
      return problems.length === 0
        ? { check, outcome: 'pass' as const, detail: null }
        : { check, outcome: 'fail' as const, detail: problems.join('; ') };
    } catch (error) {
      // A subject so malformed the check threw: record the failure as
      // evidence rather than letting one corrupt row break verification.
      return {
        check,
        outcome: 'fail' as const,
        detail: `check could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}

/** The run outcome a set of check results deterministically yields. */
export function verificationOutcomeFor(
  results: readonly ExtensionVerificationCheckResult[],
): ExtensionVerificationRunOutcome {
  return results.every((result) => result.outcome === 'pass') ? 'verified' : 'failed';
}

/** Maximum length of a run's human-readable summary. */
export const MAX_VERIFICATION_SUMMARY_CHARS = 512;

/** The one-line summary recorded on a run (deterministic, bounded). */
export function summarizeVerificationRun(
  results: readonly ExtensionVerificationCheckResult[],
): string {
  const passed = results.filter((result) => result.outcome === 'pass').length;
  if (passed === results.length) {
    return `${passed}/${results.length} checks passed`;
  }
  const failed = results
    .filter((result) => result.outcome === 'fail')
    .map((result) => result.check);
  const summary = `${passed}/${results.length} checks passed — failed: ${failed.join(', ')}`;
  return summary.length > MAX_VERIFICATION_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_VERIFICATION_SUMMARY_CHARS - 1)}…`
    : summary;
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * Fold the verification state of a manifest from its runs (latest run
 * decides; ties broken by id descending so the fold is total and
 * deterministic). No runs → UNVERIFIED. Pure.
 */
export function deriveVerificationState(
  runs: readonly VerificationRunLike[],
): ExtensionVerificationState {
  if (runs.length === 0) return 'UNVERIFIED';
  const ordered = [...runs].sort((a, b) => {
    const byTime = a.ranAt < b.ranAt ? -1 : a.ranAt > b.ranAt ? 1 : 0;
    if (byTime !== 0) return -byTime; // newest first
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // then by id, newest-first convention
  });
  return ordered[0]!.outcome === 'verified' ? 'VERIFIED' : 'FAILED';
}
