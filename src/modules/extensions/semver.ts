// Pure semver logic of the extensions module (W025 — Extension
// Contracts). No database, no context, no time.
//
// W025 owns VERSIONED extension manifests (ARCHITECTURE.md §17: the
// extension runtime supports "versioning, deployment, rollback,
// disablement, compatibility and telemetry"). Versioning needs a total,
// deterministic order over extension versions, and compatibility needs a
// closed range of host-runtime versions — both live here as total
// functions of their arguments.
//
// Deliberately strict: RELEASE-ONLY semantic versions
// (`MAJOR.MINOR.PATCH`, numeric, no leading zeros, no prerelease or
// build tags). Prerelease precedence rules would make "which version is
// newer" ambiguous to review; a contracts module prefers the order that
// two humans read identically. Marketplace publication ordering (W028)
// can layer richer tags on top without redefining this floor.

/** Parsed release semver: three non-negative integers. */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

/** Each part is a bounded non-negative integer (fits PostgreSQL `int`). */
export const MAX_SEMVER_PART = 2_147_483_647; // 2^31 - 1

const SEMVER_PATTERN = new RegExp(
  `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$`,
);

/** Is `value` a well-formed release semver string? */
export function isSemver(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) return false;
  for (const part of [match[1]!, match[2]!, match[3]!]) {
    if (Number(part) > MAX_SEMVER_PART) return false;
  }
  return true;
}

/** Parse a release semver; null when malformed (total, pure). */
export function parseSemver(value: string): SemverParts | null {
  if (!isSemver(value)) return null;
  const match = SEMVER_PATTERN.exec(value)!;
  return {
    major: Number(match[1]!),
    minor: Number(match[2]!),
    patch: Number(match[3]!),
  };
}

/** Canonical text form of parsed parts (round-trips `parseSemver`). */
export function formatSemver(parts: SemverParts): string {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

/**
 * Total order over release semvers: negative when `a` is older than `b`,
 * zero when equal, positive when newer. Numeric part comparison —
 * `1.2.10` IS newer than `1.2.9` (lexicographic text order would say
 * otherwise, which is exactly why the order lives here and nowhere else).
 */
export function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** A closed-below, closed-above range of host-runtime versions. */
export interface SemverRange {
  /** Oldest host runtime this extension supports (inclusive). */
  minVersion: SemverParts;
  /** Newest supported host runtime (inclusive), or null = unbounded above. */
  maxVersion: SemverParts | null;
}

/** Why a host runtime version is incompatible with a range. */
export type CompatibilityReason =
  | 'host_below_minimum'
  | 'host_above_maximum'
  | 'malformed_host_version';

/** The deterministic result of checking one host version against a range. */
export interface CompatibilityVerdict {
  compatible: boolean;
  reasons: CompatibilityReason[];
}

/**
 * May an extension declaring `range` run on host runtime `hostVersion`?
 * (ARCHITECTURE.md §17 "compatibility".) A malformed host version is
 * never compatible and says so — the caller (W026 runtime, W028 review)
 * decides how to surface that. Pure and total.
 */
export function checkHostRuntimeCompatibility(
  hostVersion: string,
  range: SemverRange,
): CompatibilityVerdict {
  const host = parseSemver(hostVersion);
  if (host === null) {
    return { compatible: false, reasons: ['malformed_host_version'] };
  }
  const reasons: CompatibilityReason[] = [];
  if (compareSemver(host, range.minVersion) < 0) reasons.push('host_below_minimum');
  if (range.maxVersion !== null && compareSemver(host, range.maxVersion) > 0) {
    reasons.push('host_above_maximum');
  }
  return { compatible: reasons.length === 0, reasons };
}
