// Pure deterministic verification of the vertical-kits module (W092).
// No database, no clock, no network — the same rules run at three
// enforcers so they can never drift apart:
//
//   1. validation.ts   — registration-time input validation (a manifest
//                        that fails verification is refused storage);
//   2. the service     — `runKitVerification` re-examines a STORED
//                        version and appends one immutable run with
//                        per-check outcomes (install requires the
//                        derived state VERIFIED);
//   3. migrations/001  — storage-level CHECK constraints re-pin the
//                        vocabularies and state shapes for writes that
//                        bypass the service.
//
// THE CLOSED CHECK VOCABULARY (canonical order):
//   manifest-shape         — the manifest parses into the canonical kit
//                            shape (every section present and typed);
//   manifest-integrity     — the recomputed sha-256 digest of the stored
//                            manifest equals the recorded digest (the
//                            signed-manifest discipline: a row edited
//                            outside the service fails loudly — drift is
//                            a new failed run, never a rewrite);
//   capability-declarations— every required capability is well-formed
//                            (W081-style read./write. keys, labels, data
//                            categories, mode consistent with the key,
//                            no duplicates);
//   extension-definitions  — every starter extension definition is
//                            well-formed AND consistent by the EXTENSIONS
//                            MODULE'S OWN pure rules (declaration
//                            vocabulary, permission ↔ capability
//                            consistency, quota consistency) — one
//                            semantics, reused, not forked;
//   agent-definitions      — every starter agent definition is
//                            well-formed by the AGENTS MODULE'S OWN
//                            vocabularies (permission scopes, runtime
//                            providers, bounded role/instructions);
//   integration-references— every edge integration's read/write
//                            capability keys are declared capabilities of
//                            the same manifest, and its schema-hint
//                            entity references resolve;
//   schema-hints           — the vertical data-schema hints are
//                            well-formed and uniquely named.
//
// A kit that fails any check does not become installable: registration
// refuses it outright, and a stored version whose re-verification fails
// (a rule added later, or a tampered row) carries derived state FAILED
// until a fixed version is registered as a NEW version.

import {
  capabilityDeclarationProblems,
  capabilityPermissionProblems,
  capabilityQuotaProblems,
} from '@/modules/extensions/contract';
import { isAgentPermissionScope, isAgentRuntimeProvider } from '@/modules/agents/contract';
import type {
  KitVerificationCheckResult,
  VerticalKitManifest,
} from './types';
import { digestKitManifest } from './digest';

/** The closed verification check vocabulary, in canonical order. */
export const KIT_VERIFICATION_CHECKS = [
  'manifest-shape',
  'manifest-integrity',
  'capability-declarations',
  'extension-definitions',
  'agent-definitions',
  'integration-references',
  'schema-hints',
] as const;

export type KitVerificationCheck = (typeof KIT_VERIFICATION_CHECKS)[number];

export function isKitVerificationCheck(value: unknown): value is KitVerificationCheck {
  return (
    typeof value === 'string' && (KIT_VERIFICATION_CHECKS as readonly string[]).includes(value)
  );
}

/** The verification outcome of one manifest (all checks + verdict). */
export interface KitVerificationOutcome {
  checks: KitVerificationCheckResult[];
  outcome: 'verified' | 'failed';
  summary: string;
}

// ---------------------------------------------------------------------------
// Bounds (mirror the service-side input validation)
// ---------------------------------------------------------------------------

export const MAX_KIT_CAPABILITIES = 32;
export const MAX_KIT_EXTENSIONS = 16;
export const MAX_KIT_AGENTS = 16;
export const MAX_KIT_INTEGRATIONS = 16;
export const MAX_KIT_SCHEMA_HINTS = 24;
export const MAX_SCHEMA_HINT_FIELDS = 48;

const CAPABILITY_KEY_PATTERN = /^(read|write)\.[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/;
const KIT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,127}$/;
const VERTICAL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ENTITY_PATTERN = /^[A-Za-z][A-Za-z0-9-]{1,63}$/;
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// The per-check problem finders (each tolerates malformed input and
// reports what it found — a check never throws on bad shape)
// ---------------------------------------------------------------------------

/** manifest-shape: the canonical kit manifest shape. */
export function manifestShapeProblems(manifest: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(manifest)) {
    return ['the manifest must be a JSON object'];
  }
  const schemaVersion = manifest.kitSchemaVersion;
  if (schemaVersion !== 1) {
    problems.push(`kitSchemaVersion must be 1 (got ${String(schemaVersion)})`);
  }
  for (const field of ['kitKey', 'version', 'verticalKey', 'displayName', 'description'] as const) {
    const text = textOf(manifest[field]);
    if (text === null) {
      problems.push(`${field} must be a string`);
      continue;
    }
    if (field === 'kitKey' && !KIT_KEY_PATTERN.test(text)) {
      problems.push(`kitKey must be a lowercase slug of 3..128 chars (got '${text}')`);
    }
    if (field === 'version' && !SEMVER_PATTERN.test(text)) {
      problems.push(`version must be a release semver MAJOR.MINOR.PATCH (got '${text}')`);
    }
    if (field === 'verticalKey' && !VERTICAL_KEY_PATTERN.test(text)) {
      problems.push(`verticalKey must be a lowercase slug of 2..64 chars (got '${text}')`);
    }
    if ((field === 'displayName' || field === 'description') && text.length < 1) {
      problems.push(`${field} must not be empty`);
    }
  }
  const displayName = textOf(manifest.displayName);
  if (displayName !== null && displayName.length > 200) {
    problems.push('displayName must be at most 200 chars');
  }
  const description = textOf(manifest.description);
  if (description !== null && description.length > 2000) {
    problems.push('description must be at most 2000 chars');
  }
  for (const field of [
    'requiredCapabilities',
    'extensionDefinitions',
    'agentDefinitions',
    'dataSchemaHints',
    'edgeIntegrations',
  ] as const) {
    if (!Array.isArray(manifest[field])) {
      problems.push(`${field} must be an array`);
    }
  }
  return problems;
}

/** capability-declarations: the required-capability list. */
export function capabilityDeclarationProblemsForKit(
  capabilities: unknown,
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(capabilities)) return ['requiredCapabilities must be an array'];
  if (capabilities.length < 1) {
    problems.push('a kit must declare at least one required capability');
  }
  if (capabilities.length > MAX_KIT_CAPABILITIES) {
    problems.push(`a kit may declare at most ${MAX_KIT_CAPABILITIES} capabilities`);
  }
  const seen = new Set<string>();
  for (const entry of capabilities) {
    if (!isRecord(entry)) {
      problems.push('each required capability must be an object');
      continue;
    }
    const key = textOf(entry.key);
    if (key === null || !CAPABILITY_KEY_PATTERN.test(key)) {
      problems.push(`capability key '${String(entry.key)}' must match read.<subject> or write.<subject>`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`capability '${key}' is declared more than once`);
      continue;
    }
    seen.add(key);
    const label = textOf(entry.label);
    if (label === null || label.length < 1 || label.length > 200) {
      problems.push(`capability '${key}' must carry a label of 1..200 chars`);
    }
    const mode = textOf(entry.mode);
    if (mode !== 'read' && mode !== 'write') {
      problems.push(`capability '${key}' mode must be 'read' or 'write'`);
    } else if (key !== null) {
      const prefix = mode === 'read' ? 'read.' : 'write.';
      if (!key.startsWith(prefix)) {
        problems.push(`capability '${key}' mode '${mode}' does not match its key prefix`);
      }
    }
    if (!Array.isArray(entry.dataCategories)) {
      problems.push(`capability '${key}' dataCategories must be an array`);
    } else {
      if (entry.dataCategories.length > 16) {
        problems.push(`capability '${key}' may carry at most 16 data categories`);
      }
      for (const category of entry.dataCategories) {
        if (typeof category !== 'string' || category.length < 1 || category.length > 64) {
          problems.push(`capability '${key}' has a malformed data category`);
          break;
        }
      }
    }
  }
  return problems;
}

/** extension-definitions: W025's own consistency rules, reused. */
export function extensionDefinitionProblemsForKit(definitions: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(definitions)) return ['extensionDefinitions must be an array'];
  if (definitions.length > MAX_KIT_EXTENSIONS) {
    problems.push(`a kit may carry at most ${MAX_KIT_EXTENSIONS} extension definitions`);
  }
  const seen = new Set<string>();
  for (const entry of definitions) {
    if (!isRecord(entry)) {
      problems.push('each extension definition must be an object');
      continue;
    }
    const key = textOf(entry.definitionKey);
    if (key === null || !SLUG_PATTERN.test(key)) {
      problems.push(`extension definition key '${String(entry.definitionKey)}' must be a slug of 1..64 chars`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`extension definition '${key}' appears more than once`);
      continue;
    }
    seen.add(key);
    for (const field of ['displayName', 'description'] as const) {
      const text = textOf(entry[field]);
      if (text === null || text.length < 1 || text.length > 500) {
        problems.push(`extension definition '${key}' ${field} must be 1..500 chars`);
      }
    }
    if (!isRecord(entry.capabilities) || !isRecord(entry.quotas)) {
      problems.push(`extension definition '${key}' must carry capabilities and quotas objects`);
      continue;
    }
    // The extensions module's OWN pure rule sets — one semantics, reused
    // (never forked): the declarations must be well-formed, the requested
    // permissions EXACTLY what the declared capabilities require, and
    // the quotas present exactly when their capability is declared.
    const capabilities = entry.capabilities as unknown as Parameters<
      typeof capabilityDeclarationProblems
    >[0];
    problems.push(...capabilityDeclarationProblems(capabilities).map((p) => `extension '${key}': ${p}`));
    if (!Array.isArray(entry.requestedPermissions)) {
      problems.push(`extension '${key}': requestedPermissions must be an array`);
    } else {
      problems.push(
        ...capabilityPermissionProblems(
          capabilities,
          entry.requestedPermissions as string[],
        ).map((p) => `extension '${key}': ${p}`),
      );
    }
    problems.push(
      ...capabilityQuotaProblems(
        capabilities,
        entry.quotas as unknown as Parameters<typeof capabilityQuotaProblems>[1],
      ).map((p) => `extension '${key}': ${p}`),
    );
  }
  return problems;
}

/** agent-definitions: the agents module's own vocabularies, reused. */
export function agentDefinitionProblemsForKit(definitions: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(definitions)) return ['agentDefinitions must be an array'];
  if (definitions.length > MAX_KIT_AGENTS) {
    problems.push(`a kit may carry at most ${MAX_KIT_AGENTS} agent definitions`);
  }
  const seen = new Set<string>();
  for (const entry of definitions) {
    if (!isRecord(entry)) {
      problems.push('each agent definition must be an object');
      continue;
    }
    const key = textOf(entry.definitionKey);
    if (key === null || !SLUG_PATTERN.test(key)) {
      problems.push(`agent definition key '${String(entry.definitionKey)}' must be a slug of 1..64 chars`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`agent definition '${key}' appears more than once`);
      continue;
    }
    seen.add(key);
    for (const field of ['displayName', 'role', 'instructions', 'description'] as const) {
      const text = textOf(entry[field]);
      if (text === null || text.length < 1 || text.length > 4000) {
        problems.push(`agent definition '${key}' ${field} must be 1..4000 chars`);
      }
    }
    if (!isAgentRuntimeProvider(entry.provider)) {
      problems.push(`agent definition '${key}' provider '${String(entry.provider)}' is not a known runtime provider`);
    }
    if (!Array.isArray(entry.permissions) || entry.permissions.length < 1) {
      problems.push(`agent definition '${key}' permissions must be a non-empty array`);
    } else {
      const scopes = new Set<string>();
      for (const scope of entry.permissions) {
        if (!isAgentPermissionScope(scope)) {
          problems.push(`agent definition '${key}' permission '${String(scope)}' is not a known scope`);
        }
        scopes.add(String(scope));
      }
      if (scopes.size !== entry.permissions.length) {
        problems.push(`agent definition '${key}' carries duplicate permission scopes`);
      }
    }
  }
  return problems;
}

/** schema-hints: the vertical data-schema hints. */
export function schemaHintProblemsForKit(hints: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(hints)) return ['dataSchemaHints must be an array'];
  if (hints.length > MAX_KIT_SCHEMA_HINTS) {
    problems.push(`a kit may carry at most ${MAX_KIT_SCHEMA_HINTS} schema hints`);
  }
  const seen = new Set<string>();
  for (const entry of hints) {
    if (!isRecord(entry)) {
      problems.push('each schema hint must be an object');
      continue;
    }
    const entity = textOf(entry.entity);
    if (entity === null || !ENTITY_PATTERN.test(entity)) {
      problems.push(`schema hint entity '${String(entry.entity)}' must be a slug of 2..64 chars starting with a letter`);
      continue;
    }
    if (seen.has(entity)) {
      problems.push(`schema hint entity '${entity}' appears more than once`);
      continue;
    }
    seen.add(entity);
    const label = textOf(entry.label);
    if (label === null || label.length < 1 || label.length > 200) {
      problems.push(`schema hint '${entity}' must carry a label of 1..200 chars`);
    }
    if (!Array.isArray(entry.fields) || entry.fields.length < 1) {
      problems.push(`schema hint '${entity}' must carry at least one field`);
    } else {
      if (entry.fields.length > MAX_SCHEMA_HINT_FIELDS) {
        problems.push(`schema hint '${entity}' may carry at most ${MAX_SCHEMA_HINT_FIELDS} fields`);
      }
      const fieldNames = new Set<string>();
      for (const field of entry.fields) {
        if (!isRecord(field)) {
          problems.push(`schema hint '${entity}' has a malformed field`);
          continue;
        }
        const name = textOf(field.name);
        if (name === null || !FIELD_NAME_PATTERN.test(name)) {
          problems.push(`schema hint '${entity}' field name '${String(field.name)}' is malformed`);
          continue;
        }
        if (fieldNames.has(name)) {
          problems.push(`schema hint '${entity}' field '${name}' appears more than once`);
          continue;
        }
        fieldNames.add(name);
        const type = textOf(field.type);
        if (type === null || type.length < 1 || type.length > 32) {
          problems.push(`schema hint '${entity}' field '${name}' type must be 1..32 chars`);
        }
        if (typeof field.required !== 'boolean') {
          problems.push(`schema hint '${entity}' field '${name}' required must be a boolean`);
        }
      }
    }
  }
  return problems;
}

/** integration-references: edge integrations resolve against the same manifest. */
export function integrationReferenceProblems(
  integrations: unknown,
  capabilities: unknown,
  hints: unknown,
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(integrations)) return ['edgeIntegrations must be an array'];
  if (integrations.length > MAX_KIT_INTEGRATIONS) {
    problems.push(`a kit may declare at most ${MAX_KIT_INTEGRATIONS} edge integrations`);
  }
  const declaredKeys = new Set<string>();
  if (Array.isArray(capabilities)) {
    for (const entry of capabilities) {
      if (isRecord(entry) && typeof entry.key === 'string') declaredKeys.add(entry.key);
    }
  }
  const hintEntities = new Set<string>();
  if (Array.isArray(hints)) {
    for (const entry of hints) {
      if (isRecord(entry) && typeof entry.entity === 'string') hintEntities.add(entry.entity);
    }
  }
  const seen = new Set<string>();
  for (const entry of integrations) {
    if (!isRecord(entry)) {
      problems.push('each edge integration must be an object');
      continue;
    }
    const key = textOf(entry.integrationKey);
    if (key === null || !SLUG_PATTERN.test(key)) {
      problems.push(`integration key '${String(entry.integrationKey)}' must be a slug of 1..64 chars`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`integration '${key}' appears more than once`);
      continue;
    }
    seen.add(key);
    const label = textOf(entry.systemLabel);
    if (label === null || label.length < 1 || label.length > 200) {
      problems.push(`integration '${key}' must carry a systemLabel of 1..200 chars`);
    }
    const description = textOf(entry.description);
    if (description === null || description.length < 1 || description.length > 2000) {
      problems.push(`integration '${key}' must carry a description of 1..2000 chars`);
    }
    const readKey = textOf(entry.readCapabilityKey);
    if (readKey === null || !declaredKeys.has(readKey)) {
      problems.push(`integration '${key}' readCapabilityKey '${String(entry.readCapabilityKey)}' is not a declared kit capability`);
    }
    const writeKey = textOf(entry.writeCapabilityKey);
    if (entry.writeCapabilityKey !== null && writeKey === null) {
      problems.push(`integration '${key}' writeCapabilityKey must be a string or null`);
    } else if (writeKey !== null && !declaredKeys.has(writeKey)) {
      problems.push(`integration '${key}' writeCapabilityKey '${writeKey}' is not a declared kit capability`);
    }
    if (readKey !== null && writeKey !== null && readKey === writeKey) {
      problems.push(`integration '${key}' read and write capability keys must differ`);
    }
    if (!Array.isArray(entry.schemaHintEntities)) {
      problems.push(`integration '${key}' schemaHintEntities must be an array`);
    } else {
      for (const entity of entry.schemaHintEntities) {
        if (typeof entity !== 'string' || !hintEntities.has(entity)) {
          problems.push(`integration '${key}' references unknown schema hint entity '${String(entity)}'`);
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The check runner
// ---------------------------------------------------------------------------

function check(
  name: KitVerificationCheck,
  problems: string[],
): KitVerificationCheckResult {
  return {
    check: name,
    passed: problems.length === 0,
    detail: problems.length === 0 ? null : problems.slice(0, 8).join('; '),
  };
}

/**
 * Run every deterministic verification check over a manifest. When
 * `storedDigest` is non-null the manifest-integrity check compares the
 * recomputed digest against it (the stored-row discipline); when null
 * (pre-registration) the digest is recomputed and reported, which always
 * passes by construction — the check exists for the stored path.
 */
export function verifyKitManifest(
  manifest: unknown,
  storedDigest: string | null = null,
): KitVerificationOutcome {
  const shape = manifestShapeProblems(manifest);
  const record = isRecord(manifest) ? manifest : {};
  const integrityProblems: string[] = [];
  const recomputed = digestKitManifest(manifest);
  if (storedDigest !== null && storedDigest !== recomputed) {
    integrityProblems.push(
      `the recorded manifest digest does not match the stored content (recorded ${storedDigest}, recomputed ${recomputed}) — the version row was modified outside the service`,
    );
  }
  const checks: KitVerificationCheckResult[] = [
    check('manifest-shape', shape),
    check('manifest-integrity', integrityProblems),
    check(
      'capability-declarations',
      capabilityDeclarationProblemsForKit(record.requiredCapabilities),
    ),
    check(
      'extension-definitions',
      extensionDefinitionProblemsForKit(record.extensionDefinitions),
    ),
    check('agent-definitions', agentDefinitionProblemsForKit(record.agentDefinitions)),
    check(
      'integration-references',
      integrationReferenceProblems(
        record.edgeIntegrations,
        record.requiredCapabilities,
        record.dataSchemaHints,
      ),
    ),
    check('schema-hints', schemaHintProblemsForKit(record.dataSchemaHints)),
  ];
  const failed = checks.filter((entry) => !entry.passed);
  const outcome = failed.length === 0 ? 'verified' : 'failed';
  const summary =
    outcome === 'verified'
      ? `all ${checks.length} checks passed (digest ${recomputed})`
      : `${failed.length} of ${checks.length} checks failed: ${failed
          .map((entry) => entry.check)
          .join(', ')}`;
  return { checks, outcome, summary };
}

/**
 * The typed projection of a manifest whose shape check passed (the
 * service uses this after registration-time validation; verification
 * itself never needs it — it re-examines the unknown JSON directly).
 */
export function asVerifiedKitManifest(manifest: unknown): VerticalKitManifest {
  return manifest as VerticalKitManifest;
}
