// Pure validation/normalization logic of the vertical-kits module (no
// database). Everything a kit bundle declares crosses these guards
// FIRST — at registration (tests assert the shipped registry is valid)
// and again on every resolve the service performs. The rules ride the
// OWNED vocabularies of the contracts the kit composes, imported
// through their contracts only:
//
//   * extensions (W025)   — the permission vocabulary, the manifest
//     capability/permission/quota consistency rules, the semver
//     discipline, the manifest-schema versions: a kit manifest is an
//     ordinary manifest input and satisfies the SAME exported pure
//     rules the registry, the storage triggers and verification run
//     (one semantics — this module invents none of its own);
//   * marketplace (W028)  — the package subject shape a kit's
//     normalized manifest must equal for an honest package binding;
//   * deep-actions (W084) — the operation bounds and shapes a recipe
//     template composes into at use time (DATA, no execution logic);
//   * connection-broker (W082) — the closed BROKER_PROVIDERS
//     vocabulary a connection requirement rides;
//   * integration-intelligence (W081) — the closed capability-class
//     registry (CAPABILITY_CLASSES) whose write capability keys a
//     recipe operation may exercise.
//
// FAIL-CLOSED FOOTPRINT RULE (the W092 acceptance core): the declared
// permissionFootprint must be EXACTLY the union of the manifests'
// requested permission sets — a kit that declares more than its
// manifests justify is rejected (no scope hoarding at the bundle
// level), and so is a kit that declares less (the footprint is what
// installing grants; under-declaring would misrepresent the grant).
// The hostile-manifest probe — a kit whose footprint carries an extra
// permission no manifest requests — dies here, before any registry
// write, marketplace read or grant is ever attempted.

import {
  BROKER_PROVIDERS,
} from '@/modules/connection-broker/contract';
import {
  CAPABILITY_CLASSES,
} from '@/modules/integration-intelligence/contract';
import {
  MAX_CAPABILITY_KEY_LENGTH,
  MAX_OPERATION_KEY_LENGTH,
  MAX_OPERATIONS,
  MAX_TARGET_LENGTH,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_VALUE_BYTES,
  MIN_TASK_DESCRIPTION_LENGTH,
} from '@/modules/deep-actions/contract';
import {
  EXTENSION_PERMISSIONS,
  EXTENSION_STATE_SCOPES,
  EXTENSION_UI_SURFACES,
  MANIFEST_SCHEMA_VERSIONS,
  MAX_DESCRIPTION_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_EVENT_TOPICS,
  MAX_EXTERNAL_PARTICIPANTS,
  MAX_SCHEDULES,
  capabilityPermissionProblems,
  capabilityQuotaProblems,
  compareSemver,
  isEventTopic,
  isExtensionPermission,
  isExtensionStateScope,
  isExtensionUiSurface,
  isHttpsOrigin,
  isNameSlug,
  isSemver,
  isValidCronExpression,
  jsonByteLength,
  parseSemver,
  type ExtensionCapabilities,
  type ExtensionPermission,
  type ExtensionQuotas,
  type RegisterExtensionManifestInput,
  type SemverParts,
} from '@/modules/extensions/contract';
import { VerticalKitsError } from './errors';
import type {
  DeepActionRecipeTemplate,
  KitConnectionRequirement,
  KitExtensionManifestSpec,
  KitManifestSubject,
  VerticalKitDefinition,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (this module's own; everything contract-owned is imported)
// ---------------------------------------------------------------------------

/** Kit key rule — the extensions module's extension-key discipline. */
export const KIT_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Connection/recipe requirement key rule (the same slug discipline). */
export const REQUIREMENT_KEY_PATTERN = KIT_KEY_PATTERN;

export const MAX_KIT_KEY_LENGTH = 63;
export const MAX_INDUSTRY_CHARS = 120;
export const MAX_METADATA_TEXT_CHARS = 2000;
export const MAX_OUTCOME_ITEMS = 12;
export const MAX_NOT_INCLUDED_ITEMS = 12;
export const MAX_METADATA_ITEM_CHARS = 400;
export const MIN_MANIFESTS_PER_KIT = 2;
export const MIN_RECIPES_PER_KIT = 1;
export const MIN_CONNECTIONS_PER_KIT = 1;
export const MAX_MANIFESTS_PER_KIT = 16;
export const MAX_RECIPES_PER_KIT = 16;
export const MAX_CONNECTIONS_PER_KIT = 16;
export const MAX_SOR_LABEL_CHARS = 200;
export const MAX_RECIPES_PER_OPERATION = 16;

/** The W084 operation-key pattern, mirrored (not exported there). */
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The W081 write-capability key convention ('write.<class>'). */
const WRITE_CAPABILITY_PREFIX = 'write.';

// ---------------------------------------------------------------------------
// Small helpers (the marketplace validation's house style)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kitError(problem: string): never {
  throw new VerticalKitsError('invalid_kit', problem);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    kitError(`'${field}' must be a string (got '${String(value)}')`);
  }
  return value;
}

function requirePlainObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    kitError(`'${field}' must be an object`);
  }
  return value;
}

function boundedStringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxItemChars: number,
): string[] {
  if (!Array.isArray(value)) {
    kitError(`'${field}' must be an array of plain-language strings`);
  }
  if (value.length === 0 || value.length > maxItems) {
    kitError(`'${field}' must carry between 1 and ${maxItems} entries (got ${value.length})`);
  }
  const out: string[] = [];
  for (const entry of value) {
    const text = requireString(entry, `${field}[]`);
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > maxItemChars) {
      kitError(`'${field}[]' entries must be 1..${maxItemChars} characters (got ${trimmed.length})`);
    }
    out.push(trimmed);
  }
  return out;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Manifest-input validation (the extensions module's own rules, re-run)
// ---------------------------------------------------------------------------

/**
 * Validate + normalize ONE kit manifest input into the canonical
 * declaration the extensions registry stores — the same normalization
 * the extensions module's own validation performs (canonical permission
 * order, canonical UI-surface order, sorted schedules/topics, defaulted
 * quotas), so the subject computed here equals the subject a frozen
 * ExtensionPackage carries when the vendor registered the same input.
 */
export function normalizeKitManifest(input: RegisterExtensionManifestInput): {
  extensionKey: string;
  version: string;
  versionParts: SemverParts;
  displayName: string;
  description: string | null;
  requestedPermissions: ExtensionPermission[];
  capabilities: ExtensionCapabilities;
  quotas: ExtensionQuotas;
  hostCompatibility: { minVersion: string; maxVersion: string | null };
} {
  const raw = requirePlainObject(input, 'manifest');

  const extensionKey = requireString(raw['extensionKey'], 'manifest.extensionKey');
  if (!isNameSlug(extensionKey)) {
    kitError(
      `manifest.extensionKey '${extensionKey}' must be a slug of at most 63 characters (the extensions module's key rule)`,
    );
  }
  const version = requireString(raw['version'], 'manifest.version');
  if (!isSemver(version)) {
    kitError(`manifest.version must be a release semver MAJOR.MINOR.PATCH (got '${version}')`);
  }
  const manifestSchemaVersion = raw['manifestSchemaVersion'];
  if (
    typeof manifestSchemaVersion !== 'number' ||
    !(MANIFEST_SCHEMA_VERSIONS as readonly number[]).includes(manifestSchemaVersion)
  ) {
    kitError(
      `manifest.manifestSchemaVersion must be one of ${MANIFEST_SCHEMA_VERSIONS.join(', ')} (got '${String(manifestSchemaVersion)}')`,
    );
  }
  const displayName = requireString(raw['displayName'], 'manifest.displayName');
  if (displayName.length > MAX_DISPLAY_NAME_CHARS) {
    kitError(`manifest.displayName must be at most ${MAX_DISPLAY_NAME_CHARS} characters`);
  }
  const descriptionRaw = raw['description'];
  if (
    descriptionRaw !== undefined &&
    descriptionRaw !== null &&
    (typeof descriptionRaw !== 'string' || descriptionRaw.length > MAX_DESCRIPTION_CHARS)
  ) {
    kitError(`manifest.description must be null or at most ${MAX_DESCRIPTION_CHARS} characters`);
  }
  const description =
    descriptionRaw === undefined || descriptionRaw === null || descriptionRaw === ''
      ? null
      : (descriptionRaw as string);

  // Requested permissions: closed vocabulary, deduplicated, canonical
  // order — the extensions module's own normalization.
  const permissionsRaw = raw['requestedPermissions'] ?? [];
  if (!Array.isArray(permissionsRaw)) {
    kitError('manifest.requestedPermissions must be an array of extension permissions');
  }
  const requestedPermissions = [...EXTENSION_PERMISSIONS].filter((permission) =>
    (permissionsRaw as readonly unknown[]).includes(permission),
  );
  for (const entry of permissionsRaw) {
    if (!isExtensionPermission(entry)) {
      kitError(
        `manifest.requestedPermissions entry '${String(entry)}' is not a known extension permission (closed vocabulary)`,
      );
    }
  }

  // Capabilities: the closed vocabularies + bounds of the extensions
  // module (state scope, UI surfaces, schedules, topics, participants).
  const stateScopeRaw = raw['stateScope'] ?? 'none';
  if (!isExtensionStateScope(stateScopeRaw)) {
    kitError(
      `manifest.stateScope must be one of ${EXTENSION_STATE_SCOPES.join(', ')} (got '${String(stateScopeRaw)}')`,
    );
  }
  const uiSurfacesRaw = raw['uiSurfaces'] ?? [];
  if (!Array.isArray(uiSurfacesRaw)) {
    kitError('manifest.uiSurfaces must be an array of declarative UI surfaces');
  }
  const uiSurfaces = [...EXTENSION_UI_SURFACES].filter((surface) =>
    (uiSurfacesRaw as readonly unknown[]).includes(surface),
  );
  for (const entry of uiSurfacesRaw) {
    if (!isExtensionUiSurface(entry)) {
      kitError(`manifest.uiSurfaces entry '${String(entry)}' is not a known declarative UI surface`);
    }
  }

  const schedulesRaw = raw['schedules'] ?? [];
  if (!Array.isArray(schedulesRaw)) {
    kitError('manifest.schedules must be an array of { name, cron } declarations');
  }
  if (schedulesRaw.length > MAX_SCHEDULES) {
    kitError(`manifest.schedules must declare at most ${MAX_SCHEDULES} triggers`);
  }
  const schedules: { name: string; cron: string }[] = [];
  const scheduleNames = new Set<string>();
  for (const entry of schedulesRaw) {
    const schedule = requirePlainObject(entry, 'manifest.schedules[]');
    const name = requireString(schedule['name'], 'manifest.schedules[].name');
    if (!isNameSlug(name)) {
      kitError(`manifest.schedules[].name '${name}' must be a slug (the extensions module's rule)`);
    }
    if (scheduleNames.has(name)) {
      kitError(`duplicate manifest.schedules[].name '${name}'`);
    }
    scheduleNames.add(name);
    const cron = requireString(schedule['cron'], `manifest.schedules['${name}'].cron`);
    if (!isValidCronExpression(cron)) {
      kitError(`manifest.schedules['${name}'].cron must be a five-field cron expression (got '${cron}')`);
    }
    schedules.push({ name, cron });
  }
  schedules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const topicsRaw = raw['eventSubscriptions'] ?? [];
  if (!Array.isArray(topicsRaw)) {
    kitError('manifest.eventSubscriptions must be an array of canonical event topics');
  }
  if (topicsRaw.length > MAX_EVENT_TOPICS) {
    kitError(`manifest.eventSubscriptions must declare at most ${MAX_EVENT_TOPICS} topics`);
  }
  const eventSubscriptions: string[] = [];
  for (const entry of topicsRaw) {
    const topic = requireString(entry, 'manifest.eventSubscriptions[]');
    if (!isEventTopic(topic)) {
      kitError(`manifest.eventSubscriptions topic '${topic}' is not a canonical topic slug`);
    }
    if (!eventSubscriptions.includes(topic)) eventSubscriptions.push(topic);
  }
  eventSubscriptions.sort();

  const participantsRaw = raw['externalParticipants'] ?? [];
  if (!Array.isArray(participantsRaw)) {
    kitError('manifest.externalParticipants must be an array of { label, origin } declarations');
  }
  if (participantsRaw.length > MAX_EXTERNAL_PARTICIPANTS) {
    kitError(
      `manifest.externalParticipants must declare at most ${MAX_EXTERNAL_PARTICIPANTS} participants`,
    );
  }
  const externalParticipants: { label: string; origin: string }[] = [];
  const origins = new Set<string>();
  for (const entry of participantsRaw) {
    const participant = requirePlainObject(entry, 'manifest.externalParticipants[]');
    const label = requireString(participant['label'], 'manifest.externalParticipants[].label');
    if (label.trim().length === 0 || label.length > 200) {
      kitError('manifest.externalParticipants[].label must be 1..200 characters');
    }
    const origin = requireString(participant['origin'], `manifest.externalParticipants['${label}'].origin`);
    if (!isHttpsOrigin(origin)) {
      kitError(
        `manifest.externalParticipants['${label}'].origin must be a plain https origin (got '${origin}')`,
      );
    }
    if (origins.has(origin)) {
      kitError(`duplicate manifest.externalParticipants origin '${origin}'`);
    }
    origins.add(origin);
    externalParticipants.push({ label, origin });
  }

  const telemetryRaw = raw['telemetry'] ?? false;
  if (typeof telemetryRaw !== 'boolean') {
    kitError('manifest.telemetry must be a boolean');
  }

  const capabilities: ExtensionCapabilities = {
    stateScope: stateScopeRaw,
    uiSurfaces,
    schedules,
    eventSubscriptions,
    externalParticipants,
    telemetry: telemetryRaw,
  };

  const quotasRaw = requirePlainObject(raw['quotas'] ?? {}, 'manifest.quotas');
  const readQuota = (field: string): number => {
    const value = quotasRaw[field];
    if (value === undefined || value === null) return 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      kitError(`manifest.quotas.${field} must be a non-negative integer`);
    }
    return value as number;
  };
  const quotas: ExtensionQuotas = {
    maxStateBytes: readQuota('maxStateBytes'),
    maxScheduleInvocationsPerDay: readQuota('maxScheduleInvocationsPerDay'),
    maxExternalCallsPerDay: readQuota('maxExternalCallsPerDay'),
  };

  // THE EXTENSIONS MODULE'S OWN CONSISTENCY RULES — re-run, not forked:
  // a kit manifest with an unjustified permission, an undeclared
  // capability or a missing quota is invalid HERE, exactly as it would
  // be at the registry.
  const permissionProblems = capabilityPermissionProblems(capabilities, requestedPermissions);
  if (permissionProblems.length > 0) {
    kitError(`manifest permission/capability inconsistency: ${permissionProblems.join('; ')}`);
  }
  const quotaProblems = capabilityQuotaProblems(capabilities, quotas);
  if (quotaProblems.length > 0) {
    kitError(`manifest quota inconsistency: ${quotaProblems.join('; ')}`);
  }

  const hostRuntimeRaw = requirePlainObject(raw['hostRuntime'], 'manifest.hostRuntime');
  const minVersion = requireString(hostRuntimeRaw['minVersion'], 'manifest.hostRuntime.minVersion');
  if (!isSemver(minVersion)) {
    kitError(`manifest.hostRuntime.minVersion must be a release semver (got '${minVersion}')`);
  }
  const maxVersionRaw = hostRuntimeRaw['maxVersion'];
  let maxVersion: string | null = null;
  if (maxVersionRaw !== undefined && maxVersionRaw !== null) {
    maxVersion = requireString(maxVersionRaw, 'manifest.hostRuntime.maxVersion');
    if (!isSemver(maxVersion)) {
      kitError(`manifest.hostRuntime.maxVersion must be a release semver or null (got '${maxVersion}')`);
    }
    if (compareSemver(parseSemver(minVersion)!, parseSemver(maxVersion)!) > 0) {
      kitError(`manifest.hostRuntime range is inverted: ${minVersion} > ${maxVersion}`);
    }
  }

  return {
    extensionKey,
    version,
    versionParts: parseSemver(version)!,
    displayName,
    description,
    requestedPermissions,
    capabilities,
    quotas,
    hostCompatibility: { minVersion, maxVersion },
  };
}

/**
 * The marketplace package subject of a kit manifest — the shape an
 * ExtensionPackage freezes (W028). An install's package binding is
 * honest only when the frozen subject EQUALS this (deep compare).
 */
export function kitManifestSubject(input: RegisterExtensionManifestInput): KitManifestSubject {
  const normalized = normalizeKitManifest(input);
  return {
    manifestSchemaVersion: input.manifestSchemaVersion,
    requestedPermissions: [...normalized.requestedPermissions],
    capabilities: normalized.capabilities,
    quotas: normalized.quotas,
    hostCompatibility: normalized.hostCompatibility,
  };
}

// ---------------------------------------------------------------------------
// Kit-definition validation (fail-closed, pure)
// ---------------------------------------------------------------------------

/** Every write capability key the W081 registry offers, by class. */
const WRITE_CAPABILITY_KEYS_BY_CLASS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  CAPABILITY_CLASSES.map((entry) => [
    entry.key,
    new Set(entry.writeCapabilities.map((capability) => capability.key)),
  ]),
);

function validateConnectionRequirement(
  spec: KitConnectionRequirement,
  index: number,
): void {
  const raw = requirePlainObject(spec, `connectionRequirements[${index}]`);
  const key = requireString(raw['key'], `connectionRequirements[${index}].key`);
  if (!REQUIREMENT_KEY_PATTERN.test(key)) {
    kitError(`connectionRequirements[${index}].key '${key}' must be a slug of at most 63 characters`);
  }
  const label = requireString(raw['label'], `connectionRequirements['${key}'].label`);
  if (label.trim().length === 0 || label.length > MAX_SOR_LABEL_CHARS) {
    kitError(`connectionRequirements['${key}'].label must be 1..${MAX_SOR_LABEL_CHARS} characters`);
  }
  const provider = raw['brokerProvider'];
  if (
    typeof provider !== 'string' ||
    !(BROKER_PROVIDERS as readonly string[]).includes(provider)
  ) {
    kitError(
      `connectionRequirements['${key}'].brokerProvider '${String(provider)}' is not in the connection-broker's closed provider vocabulary`,
    );
  }
  const classesRaw = raw['capabilityClasses'];
  if (!Array.isArray(classesRaw) || classesRaw.length === 0) {
    kitError(`connectionRequirements['${key}'].capabilityClasses must be a non-empty array`);
  }
  for (const entry of classesRaw) {
    if (!WRITE_CAPABILITY_KEYS_BY_CLASS.has(String(entry))) {
      kitError(
        `connectionRequirements['${key}'].capabilityClasses entry '${String(entry)}' is not a W081 capability class key`,
      );
    }
  }
}

function validateManifestSpec(
  spec: KitExtensionManifestSpec,
  index: number,
  connectionKeys: ReadonlySet<string>,
): { extensionKey: string; permissions: ExtensionPermission[] } {
  const raw = requirePlainObject(spec, `extensionManifests[${index}]`);
  const connectionKey = requireString(raw['connectionKey'], `extensionManifests[${index}].connectionKey`);
  if (!connectionKeys.has(connectionKey)) {
    kitError(
      `extensionManifests[${index}].connectionKey '${connectionKey}' does not name a kit connection requirement`,
    );
  }
  const systemOfRecord = requireString(raw['systemOfRecord'], `extensionManifests[${index}].systemOfRecord`);
  if (systemOfRecord.trim().length === 0 || systemOfRecord.length > MAX_SOR_LABEL_CHARS) {
    kitError(`extensionManifests[${index}].systemOfRecord must be 1..${MAX_SOR_LABEL_CHARS} characters`);
  }
  const manifestInput = raw['manifest'];
  if (!isPlainObject(manifestInput)) {
    kitError(`extensionManifests[${index}].manifest must be an extensions-contract manifest input`);
  }
  // Re-runs the extensions module's own rules (vocabulary, consistency,
  // semver, host range) — the registry would refuse anything else.
  const normalized = normalizeKitManifest(manifestInput as unknown as RegisterExtensionManifestInput);
  return {
    extensionKey: normalized.extensionKey,
    permissions: normalized.requestedPermissions,
  };
}

function validateRecipe(
  recipe: DeepActionRecipeTemplate,
  index: number,
  connectionClasses: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const raw = requirePlainObject(recipe, `deepActionRecipes[${index}]`);
  const recipeKey = requireString(raw['recipeKey'], `deepActionRecipes[${index}].recipeKey`);
  if (!REQUIREMENT_KEY_PATTERN.test(recipeKey)) {
    kitError(`deepActionRecipes[${index}].recipeKey '${recipeKey}' must be a slug of at most 63 characters`);
  }
  const description = requireString(raw['description'], `deepActionRecipes['${recipeKey}'].description`);
  if (
    description.trim().length < MIN_TASK_DESCRIPTION_LENGTH ||
    description.length > MAX_TASK_DESCRIPTION_LENGTH
  ) {
    kitError(
      `deepActionRecipes['${recipeKey}'].description must be ${MIN_TASK_DESCRIPTION_LENGTH}..${MAX_TASK_DESCRIPTION_LENGTH} characters (the W084 task-description bounds)`,
    );
  }
  const operationsRaw = raw['operations'];
  if (!Array.isArray(operationsRaw) || operationsRaw.length === 0) {
    kitError(`deepActionRecipes['${recipeKey}'].operations must be a non-empty array`);
  }
  if (operationsRaw.length > MAX_OPERATIONS) {
    kitError(
      `deepActionRecipes['${recipeKey}'].operations must carry at most ${MAX_OPERATIONS} operations (the W084 bound)`,
    );
  }
  const operationKeys = new Set<string>();
  for (let opIndex = 0; opIndex < operationsRaw.length; opIndex += 1) {
    const operation = requirePlainObject(
      operationsRaw[opIndex],
      `deepActionRecipes['${recipeKey}'].operations[${opIndex}]`,
    );
    const key = requireString(operation['key'], `operations[${opIndex}].key`);
    if (!OPERATION_KEY_PATTERN.test(key) || key.length > MAX_OPERATION_KEY_LENGTH) {
      kitError(`operations[${opIndex}].key '${key}' must match the W084 operation-key pattern`);
    }
    if (operationKeys.has(key)) {
      kitError(`duplicate operations key '${key}' within recipe '${recipeKey}'`);
    }
    operationKeys.add(key);

    const connectionKey = requireString(operation['connectionKey'], `operations['${key}'].connectionKey`);
    const classes = connectionClasses.get(connectionKey);
    if (classes === undefined) {
      kitError(
        `operations['${key}'].connectionKey '${connectionKey}' does not name a kit connection requirement`,
      );
    }
    const capabilityKey = requireString(operation['capabilityKey'], `operations['${key}'].capabilityKey`);
    if (
      !capabilityKey.startsWith(WRITE_CAPABILITY_PREFIX) ||
      capabilityKey.length <= WRITE_CAPABILITY_PREFIX.length ||
      capabilityKey.length > MAX_CAPABILITY_KEY_LENGTH
    ) {
      kitError(
        `operations['${key}'].capabilityKey must be a W081 WRITE capability key ('write.<class>')`,
      );
    }
    if (!classes.has(capabilityKey)) {
      kitError(
        `operations['${key}'].capabilityKey '${capabilityKey}' is not offered by connection '${connectionKey}' (the W081 class's write capability registry)`,
      );
    }

    const targetTemplate = requireString(operation['targetTemplate'], `operations['${key}'].targetTemplate`);
    if (targetTemplate.trim().length === 0 || targetTemplate.length > MAX_TARGET_LENGTH) {
      kitError(`operations['${key}'].targetTemplate must be 1..${MAX_TARGET_LENGTH} characters`);
    }
    for (const field of ['payload', 'expectation'] as const) {
      const value = operation[field];
      if (!isPlainObject(value)) {
        kitError(`operations['${key}'].${field} must be a plain JSON object`);
      }
      const size = jsonByteLength(value);
      if (size === null || size > MAX_VALUE_BYTES) {
        kitError(`operations['${key}'].${field} exceeds the W084 canonical value bound`);
      }
    }
  }
  return recipeKey;
}

/**
 * Validate one kit definition completely. Throws `VerticalKitsError`
 * ('invalid_kit') on the FIRST problem — fail-closed, pure, no
 * database. The five bundle parts are each validated against their
 * owning contracts' exported rules, and the FOOTPRINT rule pins the
 * declared permission set to EXACTLY the union of the manifests'
 * requested sets.
 */
export function validateKitDefinition(kit: VerticalKitDefinition): void {
  const raw = requirePlainObject(kit, 'kit');

  const kitKey = requireString(raw['kitKey'], 'kit.kitKey');
  if (!KIT_KEY_PATTERN.test(kitKey) || kitKey.length > MAX_KIT_KEY_LENGTH) {
    kitError(`kit.kitKey '${kitKey}' must be a slug of at most ${MAX_KIT_KEY_LENGTH} characters`);
  }
  const version = requireString(raw['version'], 'kit.version');
  if (!isSemver(version)) {
    kitError(`kit.version must be a release semver MAJOR.MINOR.PATCH (got '${version}')`);
  }

  // Honest metadata: industry label, description, outcomes, the honest
  // not-included boundary (non-empty — a kit without an explicit
  // boundary is not honest metadata).
  const metadata = requirePlainObject(raw['metadata'], 'kit.metadata');
  const industry = requireString(metadata['industry'], 'kit.metadata.industry');
  if (industry.trim().length === 0 || industry.length > MAX_INDUSTRY_CHARS) {
    kitError(`kit.metadata.industry must be 1..${MAX_INDUSTRY_CHARS} characters`);
  }
  const metadataDescription = requireString(metadata['description'], 'kit.metadata.description');
  if (
    metadataDescription.trim().length === 0 ||
    metadataDescription.length > MAX_METADATA_TEXT_CHARS
  ) {
    kitError(`kit.metadata.description must be 1..${MAX_METADATA_TEXT_CHARS} characters`);
  }
  boundedStringList(metadata['outcomes'], 'kit.metadata.outcomes', MAX_OUTCOME_ITEMS, MAX_METADATA_ITEM_CHARS);
  const notIncluded = boundedStringList(
    metadata['notIncluded'],
    'kit.metadata.notIncluded',
    MAX_NOT_INCLUDED_ITEMS,
    MAX_METADATA_ITEM_CHARS,
  );
  if (notIncluded.length === 0) {
    kitError('kit.metadata.notIncluded must declare at least one honest boundary entry');
  }

  // Connection-class requirements: the W082 provider vocabulary + the
  // W081 capability-class registry.
  const connectionsRaw = raw['connectionRequirements'];
  if (!Array.isArray(connectionsRaw)) {
    kitError('kit.connectionRequirements must be an array');
  }
  if (connectionsRaw.length < MIN_CONNECTIONS_PER_KIT || connectionsRaw.length > MAX_CONNECTIONS_PER_KIT) {
    kitError(
      `kit.connectionRequirements must carry ${MIN_CONNECTIONS_PER_KIT}..${MAX_CONNECTIONS_PER_KIT} entries (got ${connectionsRaw.length})`,
    );
  }
  const connectionKeys = new Set<string>();
  for (let index = 0; index < connectionsRaw.length; index += 1) {
    const spec = requirePlainObject(connectionsRaw[index], `connectionRequirements[${index}]`);
    validateConnectionRequirement(spec as unknown as KitConnectionRequirement, index);
    connectionKeys.add(String(spec['key']));
  }
  const connectionClasses = new Map<string, ReadonlySet<string>>();
  for (const spec of connectionsRaw as KitConnectionRequirement[]) {
    const classes = new Set<string>();
    for (const classKey of spec.capabilityClasses) {
      const writeKeys = WRITE_CAPABILITY_KEYS_BY_CLASS.get(classKey);
      if (writeKeys === undefined) continue; // already rejected above
      for (const writeKey of writeKeys) classes.add(writeKey);
    }
    connectionClasses.set(spec.key, classes);
  }

  // Extension manifests: each an ordinary extensions-contract input
  // (re-validated through the extensions module's own rules), riding a
  // declared connection. At least TWO per kit.
  const manifestsRaw = raw['extensionManifests'];
  if (!Array.isArray(manifestsRaw)) {
    kitError('kit.extensionManifests must be an array');
  }
  if (manifestsRaw.length < MIN_MANIFESTS_PER_KIT || manifestsRaw.length > MAX_MANIFESTS_PER_KIT) {
    kitError(
      `kit.extensionManifests must carry ${MIN_MANIFESTS_PER_KIT}..${MAX_MANIFESTS_PER_KIT} integrations (got ${manifestsRaw.length})`,
    );
  }
  const extensionKeys = new Set<string>();
  const unionPermissions = new Set<ExtensionPermission>();
  for (let index = 0; index < manifestsRaw.length; index += 1) {
    const spec = requirePlainObject(manifestsRaw[index], `extensionManifests[${index}]`);
    const { extensionKey, permissions } = validateManifestSpec(
      spec as unknown as KitExtensionManifestSpec,
      index,
      connectionKeys,
    );
    if (extensionKeys.has(extensionKey)) {
      kitError(`duplicate manifest extensionKey '${extensionKey}' within the kit`);
    }
    extensionKeys.add(extensionKey);
    for (const permission of permissions) unionPermissions.add(permission);
  }

  // Deep-action recipe templates: DATA shaped after the W084 operation
  // contract, riding kit connections + W081 write capabilities. At
  // least ONE per kit.
  const recipesRaw = raw['deepActionRecipes'];
  if (!Array.isArray(recipesRaw)) {
    kitError('kit.deepActionRecipes must be an array');
  }
  if (recipesRaw.length < MIN_RECIPES_PER_KIT || recipesRaw.length > MAX_RECIPES_PER_KIT) {
    kitError(
      `kit.deepActionRecipes must carry ${MIN_RECIPES_PER_KIT}..${MAX_RECIPES_PER_KIT} templates (got ${recipesRaw.length})`,
    );
  }
  const recipeKeys = new Set<string>();
  for (let index = 0; index < recipesRaw.length; index += 1) {
    const recipe = requirePlainObject(recipesRaw[index], `deepActionRecipes[${index}]`);
    const recipeKey = validateRecipe(
      recipe as unknown as DeepActionRecipeTemplate,
      index,
      connectionClasses,
    );
    if (recipeKeys.has(recipeKey)) {
      kitError(`duplicate deepActionRecipes recipeKey '${recipeKey}' within the kit`);
    }
    recipeKeys.add(recipeKey);
  }

  // The edge-execution declaration: validated (every entry a known
  // recipe), rendered 'pending-w088' — never an execution claim.
  const edgeRaw = requirePlainObject(raw['edgeExecution'], 'kit.edgeExecution');
  const edgeRecipesRaw = edgeRaw['recipeKeys'];
  if (!Array.isArray(edgeRecipesRaw) || edgeRecipesRaw.length > MAX_RECIPES_PER_OPERATION) {
    kitError('kit.edgeExecution.recipeKeys must be an array of known recipe keys');
  }
  for (const entry of edgeRecipesRaw) {
    if (!recipeKeys.has(String(entry))) {
      kitError(`kit.edgeExecution.recipeKeys entry '${String(entry)}' is not a recipe of this kit`);
    }
  }
  const edgeNote = requireString(edgeRaw['note'], 'kit.edgeExecution.note');
  if (edgeNote.trim().length === 0 || edgeNote.length > MAX_METADATA_ITEM_CHARS) {
    kitError(`kit.edgeExecution.note must be 1..${MAX_METADATA_ITEM_CHARS} characters`);
  }

  // THE FOOTPRINT RULE (fail-closed): the declared permission footprint
  // must be EXACTLY the union of the manifests' requested sets — the
  // hostile probe (an extra permission no manifest requests) dies here,
  // and so does an under-declared footprint.
  const footprintRaw = raw['permissionFootprint'];
  if (!Array.isArray(footprintRaw)) {
    kitError('kit.permissionFootprint must be an array of extension permissions');
  }
  const footprint = [...EXTENSION_PERMISSIONS].filter((permission) =>
    (footprintRaw as readonly unknown[]).includes(permission),
  );
  for (const entry of footprintRaw) {
    if (!isExtensionPermission(entry)) {
      kitError(`kit.permissionFootprint entry '${String(entry)}' is not a known extension permission`);
    }
  }
  const union = new Set<ExtensionPermission>(unionPermissions);
  for (const permission of EXTENSION_PERMISSIONS) {
    const declared = footprint.includes(permission);
    const justified = union.has(permission);
    if (declared && !justified) {
      kitError(
        `kit.permissionFootprint declares '${permission}' but no kit manifest requests it — the footprint must be EXACTLY the manifests' union (fail-closed)`,
      );
    }
    if (!declared && justified) {
      kitError(
        `kit.permissionFootprint omits '${permission}' which a kit manifest requests — the footprint must be EXACTLY the manifests' union (fail-closed)`,
      );
    }
  }
}

/**
 * The permissions a kit's manifests require — the exact union, in
 * canonical order (each manifest normalized first, so the union is of
 * the canonical requested sets).
 */
export function unionPermissionsOf(kit: VerticalKitDefinition): ExtensionPermission[] {
  const union = new Set<ExtensionPermission>();
  for (const spec of kit.extensionManifests) {
    const normalized = normalizeKitManifest(spec.manifest);
    for (const permission of normalized.requestedPermissions) {
      union.add(permission);
    }
  }
  return [...EXTENSION_PERMISSIONS].filter((permission) => union.has(permission));
}

/** Guard: is this a plausible kit key slug? */
export function isVerticalKitKey(value: unknown): value is string {
  return typeof value === 'string' && KIT_KEY_PATTERN.test(value);
}

/** Guard: is this a UUID (the id shapes this module stores/queries)? */
export function isVerticalKitsUuid(value: unknown): value is string {
  return isUuid(value);
}
