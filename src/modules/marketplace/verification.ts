// Pure automated-verification logic of the marketplace module (W028 —
// Marketplace Governance). No database, no context, no time.
//
// THE AUTOMATED_VERIFICATION PHASE (§17's third state) is a
// deterministic, re-runnable STATIC examination of the package's frozen
// artifact — evidence, not judgment. It runs before any human looks at
// the package (the pipeline only reaches PENDING_REVIEW through it), and
// its per-check outcomes are recorded as append-only evidence the
// platform reviewer reads. No LLM participates; no run outcome is ever
// overwritten.
//
// ONE SEMANTICS PER KIND (the extensions module's W025 contract comment:
// "The marketplace's AUTOMATED_VERIFICATION phase (W028) and the
// builder's verify step (W027) run the SAME exported pure checks — one
// semantics, no drift"):
//
//   * ExtensionPackage — the marketplace imports and runs the extensions
//     module's own `runManifestVerificationChecks` over the manifest
//     subject FROZEN into the package at creation (the package is a
//     self-contained platform artifact: the platform never reaches back
//     into the vendor tenant's registry at review time). The check
//     vocabulary is therefore exactly EXTENSION_VERIFICATION_CHECKS —
//     manifest-schema, permissions-consistency,
//     capability-declarations, quota-bounds, compatibility-bounds —
//     the same five checks the registry and the builder run.
//
//   * AgentPackage — the agents module has no versioned artifact store
//     to verify against, so the marketplace owns the agent-package check
//     vocabulary (below). Every rule it examines is pinned to a closed
//     vocabulary EXPORTED by the agents module's contract (runtime
//     providers, permission scopes, size bounds) — the marketplace never
//     invents its own provider/scope names, so agent packages can never
//     verify against a provider or permission the agent gateway does not
//     know (lock 24's provider isolation, applied at the gate).
//
// Why re-examine what creation already validated? The same three
// reasons the extensions module re-runs its checks over stored
// manifests: rules evolve (a check added later must fail an older
// artifact as a NEW run — drift detection), rows can be written by
// paths that bypass the service (defense in depth — the checks
// re-validate with runtime type guards rather than trusting the schema
// cast), and reviewers need per-check evidence, not a bare boolean.
//
// The marketplace deliberately does NOT import the extensions module's
// deriveVerificationState fold: a package's lifecycle state is NOT
// derived from its runs (the governed chain — PENDING_REVIEW or
// REJECTED — is applied atomically with the run by the service); the
// run history itself is the read surface.

import {
  AGENT_PERMISSION_SCOPES,
  AGENT_RUNTIME_PROVIDERS,
  isAgentPermissionScope,
  isAgentRuntimeProvider,
  MAX_INSTRUCTIONS_CHARS,
  MAX_PERMISSIONS,
  MAX_ROLE_CHARS,
} from '@/modules/agents/contract';
import { EXTENSION_VERIFICATION_CHECKS } from '@/modules/extensions/contract';

/**
 * The automated-verification check vocabulary for EXTENSION packages —
 * exactly the extensions module's own five checks (imported as a value so
 * the union type and the closed list can never drift apart).
 */
export const EXTENSION_PACKAGE_CHECKS = EXTENSION_VERIFICATION_CHECKS;

export type ExtensionPackageCheck = (typeof EXTENSION_PACKAGE_CHECKS)[number];

/** Every check name the AUTOMATED_VERIFICATION phase can record. */
export type PackageVerificationCheck = ExtensionPackageCheck | AgentPackageCheck;

/**
 * The manifest subject of an extension package (the manifest content
 * frozen at creation). Structurally identical to the extensions
 * module's ManifestVerificationSubject — kept local so a malformed
 * stored payload (a bypass write) is a type error here, not a silent
 * cast into the shared type.
 */
export interface ManifestSubjectLike {
  manifestSchemaVersion: number;
  requestedPermissions: unknown;
  capabilities: unknown;
  quotas: unknown;
  hostCompatibility: unknown;
}

/** The agent-spec subject of an agent package (frozen at creation). */
export interface AgentSubjectLike {
  role: unknown;
  instructions: unknown;
  provider: unknown;
  permissions: unknown;
}

/** One check outcome inside a verification run. */
export interface PackageVerificationCheckResult {
  check: PackageVerificationCheck;
  outcome: 'pass' | 'fail';
  /** null on a clean pass; the problems (joined) on a failure. */
  detail: string | null;
}

/** The outcome of a whole run: every check passed, or at least one failed. */
export type PackageVerificationRunOutcome = 'verified' | 'failed';

/**
 * The closed automated-verification check vocabulary for AGENT packages,
 * in canonical run order. (Extension packages use the extensions
 * module's own five-check vocabulary — see EXTENSION_PACKAGE_CHECKS.)
 */
export const AGENT_PACKAGE_CHECKS = [
  'agent-schema',
  'provider-known',
  'permission-scopes',
  'instructions-bounds',
] as const;

export type AgentPackageCheck = (typeof AGENT_PACKAGE_CHECKS)[number];

export function isAgentPackageCheck(value: unknown): value is AgentPackageCheck {
  return (
    typeof value === 'string' &&
    (AGENT_PACKAGE_CHECKS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The deterministic agent-package checks
// ---------------------------------------------------------------------------

/** `agent-schema` — the frozen agent spec is structurally well-formed. */
function checkAgentSchema(agent: AgentSubjectLike): string[] {
  const problems: string[] = [];
  if (typeof agent.role !== 'string' || agent.role.trim() === '') {
    problems.push('role must be a non-empty string');
  }
  if (typeof agent.instructions !== 'string' || agent.instructions.trim() === '') {
    problems.push('instructions must be a non-empty string');
  }
  if (typeof agent.provider !== 'string') {
    problems.push('provider must be a string');
  }
  if (!Array.isArray(agent.permissions)) {
    problems.push('permissions must be an array');
  }
  return problems;
}

/** `provider-known` — the runtime provider is one the agent gateway knows. */
function checkProviderKnown(agent: AgentSubjectLike): string[] {
  if (!isAgentRuntimeProvider(agent.provider)) {
    return [
      `provider must be one of ${AGENT_RUNTIME_PROVIDERS.join(', ')} (got '${String(agent.provider)}')`,
    ];
  }
  return [];
}

/**
 * `permission-scopes` — every requested scope is in the agents module's
 * closed vocabulary, without duplicates and within the size bound.
 */
function checkPermissionScopes(agent: AgentSubjectLike): string[] {
  if (!Array.isArray(agent.permissions)) {
    return ['permissions must be an array'];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const scope of agent.permissions) {
    if (!isAgentPermissionScope(scope)) {
      problems.push(
        `unknown permission scope '${String(scope)}' (closed vocabulary: ${AGENT_PERMISSION_SCOPES.join(', ')})`,
      );
      continue;
    }
    if (seen.has(scope)) {
      problems.push(`duplicate permission scope '${scope}'`);
    }
    seen.add(scope);
  }
  if (agent.permissions.length > MAX_PERMISSIONS) {
    problems.push(
      `permissions must contain at most ${MAX_PERMISSIONS} permission scopes (got ${agent.permissions.length})`,
    );
  }
  if (seen.size === 0 && problems.length === 0) {
    problems.push('permissions must contain at least one permission scope');
  }
  return problems;
}

/**
 * `instructions-bounds` — the operating contract fits the agent
 * gateway's size ceilings (role + instructions).
 */
function checkInstructionsBounds(agent: AgentSubjectLike): string[] {
  const problems: string[] = [];
  if (typeof agent.role === 'string' && agent.role.length > MAX_ROLE_CHARS) {
    problems.push(`role must be at most ${MAX_ROLE_CHARS} characters (got ${agent.role.length})`);
  }
  if (
    typeof agent.instructions === 'string' &&
    agent.instructions.length > MAX_INSTRUCTIONS_CHARS
  ) {
    problems.push(
      `instructions must be at most ${MAX_INSTRUCTIONS_CHARS} characters (got ${agent.instructions.length})`,
    );
  }
  return problems;
}

/**
 * Run every agent-package verification check against the frozen agent
 * spec — deterministic and total (a check that cannot even be evaluated
 * FAILS with the reason, it never throws). Results in canonical check
 * order.
 */
export function runAgentPackageVerificationChecks(
  agent: AgentSubjectLike,
): PackageVerificationCheckResult[] {
  const checks: Array<[AgentPackageCheck, (agent: AgentSubjectLike) => string[]]> = [
    ['agent-schema', checkAgentSchema],
    ['provider-known', checkProviderKnown],
    ['permission-scopes', checkPermissionScopes],
    ['instructions-bounds', checkInstructionsBounds],
  ];
  return checks.map(([check, run]) => {
    try {
      const problems = run(agent);
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

// ---------------------------------------------------------------------------
// Shared run outcome helpers (both kinds)
// ---------------------------------------------------------------------------

/** The run outcome a set of check results deterministically yields. */
export function packageVerificationOutcomeFor(
  results: readonly PackageVerificationCheckResult[],
): PackageVerificationRunOutcome {
  return results.every((result) => result.outcome === 'pass') ? 'verified' : 'failed';
}

/** Maximum length of a run's human-readable summary. */
export const MAX_PACKAGE_VERIFICATION_SUMMARY_CHARS = 512;

/** The one-line summary recorded on a run (deterministic, bounded). */
export function summarizePackageVerificationRun(
  results: readonly PackageVerificationCheckResult[],
): string {
  const passed = results.filter((result) => result.outcome === 'pass').length;
  if (passed === results.length) {
    return `${passed}/${results.length} checks passed`;
  }
  const failed = results
    .filter((result) => result.outcome === 'fail')
    .map((result) => result.check);
  const summary = `${passed}/${results.length} checks passed — failed: ${failed.join(', ')}`;
  return summary.length > MAX_PACKAGE_VERIFICATION_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_PACKAGE_VERIFICATION_SUMMARY_CHARS - 1)}…`
    : summary;
}
