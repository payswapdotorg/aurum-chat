// Implementation of the vertical-kits module's public operations (see
// contract.ts). W092 — Vertical Extension Starter Kits.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL;
// timestamps come from the injectable clock and are never
// caller-supplied; every table this module owns is tenant-scoped
// (migrations/001) and every statement pins tenant_id.
//
// THE INSTALL PATH IS MARKETPLACE-PACKAGE-DRIVEN AND COMPOSES THE REAL
// CONTRACTS — nothing is simulated:
//
//   1. RESOLVE the kit (a validated versioned data record — kits.ts);
//   2. for every kit manifest, resolve the platform catalog (the W028
//      marketplace contract, read under the INSTALLER's own tenant
//      context) to the INSTALLABLE ExtensionPackage whose frozen
//      subject EQUALS the kit's normalized declaration — a missing
//      package is `kit_not_available`, a package whose content differs
//      is `package_mismatch` (fail-closed: a tampered or drifted
//      artifact never binds);
//   3. ensure the manifest exists in the TENANT's own extensions
//      registry (the W025 contract — registering when absent, refusing
//      `kit_conflict` when a foreign declaration already occupies the
//      key/version), and re-run the registry's own deterministic
//      verification (VERIFIED required — no unverified software
//      capability is enabled);
//   4. activate the extension and deploy the version with the granted
//      permissions EXACTLY the kit's per-manifest footprint — the
//      extensions runtime's own install-time grant discipline (W026):
//      the grant is bounded by the manifest's requested ceiling and
//      routed through the W009 authority gate (kind
//      'extension-deployment', level EXECUTE). A gate that WAITS
//      surfaces honestly as `approval_required`; re-invoking after the
//      human decision replays idempotently (the same deploy
//      idempotency keys — no duplicate deployments);
//   5. RECORD the install, the per-manifest grants (with their package
//      bindings) and one append-only lifecycle event freezing the full
//      WHAT (who, when, exactly what was granted through which
//      packages).
//
// UPGRADE is a NEW VERSION INSTALL, never a mutation: the install row
// moves, the grant set is replaced, and BOTH states live on in the
// append-only event trail (from-version → to-version, with both grant
// snapshots recorded at their own events).
//
// REMOVAL removes the kit's grants and package bindings (DELETE — that
// is what removal means) while the append-only events and the immutable
// recipe references survive: a deep-action plan instantiated from a kit
// recipe keeps rendering "this template came from kit vX" AFTER the
// kit is gone — no silent data loss.
//
// THE EDGE PATH IS DECLARED, NEVER CLAIMED: kit definitions carry an
// edgeExecution declaration (validated); every read renders it as the
// single honest status 'pending-w088'. This service contains no edge
// execution code, and no code path may render otherwise.
//
// Dependency posture: this module imports ONLY src/infra ports and
// module contracts — extensions (registry + runtime grant), marketplace
// (the governed catalog through INSTALLABLE). Vertical semantics live
// in the kit DATA (kits.ts) and nowhere else; the code below is
// industry-blind by construction.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  ExtensionsError,
  compareSemver,
  deployExtensionVersion,
  getExtension,
  isSemver,
  listManifests,
  parseSemver,
  registerExtensionManifest,
  runManifestVerification,
  transitionExtension,
  type ExtensionManifestSummary,
  type ExtensionPermission,
} from '@/modules/extensions/contract';
import { listCatalogPackages } from '@/modules/marketplace/contract';
import { KIT_REGISTRY } from './kits';
import { VerticalKitsError } from './errors';
import {
  EDGE_EXECUTION_STATUS,
  VERTICAL_KIT_EVENT_TYPES,
  type InstallVerticalKitInput,
  type InstallVerticalKitResult,
  type KitEdgeExecutionInfo,
  type ListRecipeReferencesQuery,
  type ListVerticalKitEventsQuery,
  type RecordRecipeUseInput,
  type RemoveVerticalKitInput,
  type RemoveVerticalKitResult,
  type VerticalKitDefinition,
  type VerticalKitEvent,
  type VerticalKitEventType,
  type VerticalKitInstall,
  type VerticalKitRecipeReference,
  type VerticalKitSummary,
} from './types';
import {
  isVerticalKitKey,
  kitManifestSubject,
  normalizeKitManifest,
  validateKitDefinition,
} from './validation';

// re-exported through the contract for consumers/tests
export { KIT_REGISTRY } from './kits';

// ---------------------------------------------------------------------------
// Authority claim
// ---------------------------------------------------------------------------

/** The claim that manages a tenant's vertical-kit lifecycle. */
export const VERTICAL_KITS_AUTHORITY_ADMINISTER = 'vertical-kits:administer';

function canAdminister(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(VERTICAL_KITS_AUTHORITY_ADMINISTER);
}

function administerForbidden(operation: string): never {
  throw new VerticalKitsError(
    'forbidden',
    `${operation} requires the '${VERTICAL_KITS_AUTHORITY_ADMINISTER}' authority claim`,
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The house context guard (the marketplace's discipline). */
export function assertVerticalKitsTenantContext(ctx: TenantContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.tenantId !== 'string' ||
    !UUID_PATTERN.test(ctx.tenantId) ||
    typeof ctx.principalId !== 'string' ||
    !UUID_PATTERN.test(ctx.principalId) ||
    !Array.isArray(ctx.authority)
  ) {
    throw new VerticalKitsError('invalid_context', 'a valid TenantContext is required');
  }
}

// ---------------------------------------------------------------------------
// Kit resolution (the validated data records, served generically)
// ---------------------------------------------------------------------------

/** The registry's versions of one kit, newest first (semver order). */
function kitVersionsOf(kitKey: string): VerticalKitDefinition[] {
  return KIT_REGISTRY.filter((kit) => kit.kitKey === kitKey).sort(
    (a, b) =>
      -compareSemver(a.versionParts, b.versionParts) ||
      (a.version < b.version ? 1 : a.version > b.version ? -1 : 0),
  );
}

/**
 * Resolve one kit definition: the newest registered version, or an
 * exact one. Every resolve RE-VALIDATES the record (fail-closed — a
 * registry entry that stops satisfying the contracts is refused at
 * read time, exactly as it would be at registration).
 */
export function getKitDefinition(
  kitKey: string,
  version?: string | null,
): VerticalKitDefinition {
  if (!isVerticalKitKey(kitKey)) {
    throw new VerticalKitsError('invalid_input', `kitKey '${String(kitKey)}' is not a kit slug`);
  }
  const versions = kitVersionsOf(kitKey);
  if (versions.length === 0) {
    throw new VerticalKitsError('kit_not_found', `no kit '${kitKey}' is registered`);
  }
  let kit: VerticalKitDefinition | undefined;
  if (version === undefined || version === null) {
    kit = versions[0]!;
  } else {
    if (!isSemver(version)) {
      throw new VerticalKitsError(
        'invalid_input',
        `version must be a release semver MAJOR.MINOR.PATCH (got '${version}')`,
      );
    }
    kit = versions.find((candidate) => candidate.version === version);
  }
  if (kit === undefined) {
    throw new VerticalKitsError(
      'kit_not_found',
      `no kit '${kitKey}' version '${String(version)}' is registered`,
    );
  }
  validateKitDefinition(kit);
  return kit;
}

/** The honest edge-execution posture of a kit (never an execution claim). */
export function edgeExecutionInfoOf(kit: VerticalKitDefinition): KitEdgeExecutionInfo {
  return {
    recipes: [...kit.edgeExecution.recipeKeys],
    status: EDGE_EXECUTION_STATUS,
    note: kit.edgeExecution.note,
  };
}

/** The kit catalog: every registered kit, validated, edge posture rendered. */
export function listKitCatalog(): VerticalKitSummary[] {
  const kitsByLatest = new Map<string, VerticalKitDefinition>();
  for (const kit of KIT_REGISTRY) {
    validateKitDefinition(kit);
    const existing = kitsByLatest.get(kit.kitKey);
    if (
      existing === undefined ||
      compareSemver(kit.versionParts, existing.versionParts) > 0
    ) {
      kitsByLatest.set(kit.kitKey, kit);
    }
  }
  return [...kitsByLatest.values()].map((kit) => ({
    ...kit,
    edgeExecutionInfo: edgeExecutionInfoOf(kit),
  }));
}

// ---------------------------------------------------------------------------
// Rows + mapping
// ---------------------------------------------------------------------------

interface InstallRow extends DbRow {
  id: string;
  tenant_id: string;
  kit_key: string;
  kit_version: string;
  version_major: number;
  version_minor: number;
  version_patch: number;
  installed_by: string;
  installed_at: Date | string;
  updated_at: Date | string;
}

interface GrantRow extends DbRow {
  id: string;
  tenant_id: string;
  install_id: string;
  kit_key: string;
  extension_key: string;
  extension_version: string;
  package_id: string;
  package_key: string;
  granted_permissions: unknown;
  deployed_at: Date | string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  kit_key: string;
  event_type: string;
  from_version: string | null;
  to_version: string | null;
  actor: string;
  occurred_at: Date | string;
  detail: unknown;
}

interface RecipeReferenceRow extends DbRow {
  id: string;
  tenant_id: string;
  kit_key: string;
  kit_version: string;
  recipe_key: string;
  reference: string;
  recorded_by: string;
  recorded_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function permissionsOf(value: unknown): ExtensionPermission[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ExtensionPermission => typeof entry === 'string');
}

function detailGrantsOf(value: unknown): VerticalKitEvent['detail']['grants'] {
  if (typeof value !== 'object' || value === null) return { grants: [] }['grants'];
  const grants = (value as { grants?: unknown }).grants;
  if (!Array.isArray(grants)) return [];
  const out: VerticalKitEvent['detail']['grants'] = [];
  for (const entry of grants) {
    if (typeof entry !== 'object' || entry === null) continue;
    const grant = entry as Record<string, unknown>;
    out.push({
      extensionKey: String(grant['extensionKey'] ?? ''),
      extensionVersion: String(grant['extensionVersion'] ?? ''),
      packageId: String(grant['packageId'] ?? ''),
      packageKey: String(grant['packageKey'] ?? ''),
      grantedPermissions: permissionsOf(grant['grantedPermissions']),
    });
  }
  return out;
}

async function findInstallRow(
  ctx: TenantContext,
  kitKey: string,
): Promise<InstallRow | null> {
  const rows = await getDb().query<InstallRow>(
    `SELECT * FROM vertical_kit_installs
       WHERE tenant_id = $1 AND kit_key = $2`,
    [ctx.tenantId, kitKey],
  );
  return rows.rows[0] ?? null;
}

async function grantRowsOf(ctx: TenantContext, installId: string): Promise<GrantRow[]> {
  const rows = await getDb().query<GrantRow>(
    `SELECT * FROM vertical_kit_grants
       WHERE tenant_id = $1 AND install_id = $2
       ORDER BY extension_key ASC`,
    [ctx.tenantId, installId],
  );
  return rows.rows;
}

function installOf(
  row: InstallRow,
  grants: GrantRow[],
  kit: VerticalKitDefinition,
): VerticalKitInstall {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kitKey: row.kit_key,
    kitVersion: row.kit_version,
    installedBy: row.installed_by,
    installedAt: iso(row.installed_at),
    updatedAt: iso(row.updated_at),
    grants: grants.map((grant) => ({
      id: grant.id,
      tenantId: grant.tenant_id,
      installId: grant.install_id,
      kitKey: grant.kit_key,
      extensionKey: grant.extension_key,
      extensionVersion: grant.extension_version,
      packageId: grant.package_id,
      packageKey: grant.package_key,
      grantedPermissions: permissionsOf(grant.granted_permissions),
      deployedAt: iso(grant.deployed_at),
    })),
    edgeExecutionInfo: edgeExecutionInfoOf(kit),
  };
}

// ---------------------------------------------------------------------------
// Input validation (the service-side guards)
// ---------------------------------------------------------------------------

interface ValidatedInstallInput {
  kitKey: string;
  version: string | null;
}

function validateInstallInput(input: InstallVerticalKitInput): ValidatedInstallInput {
  if (typeof input !== 'object' || input === null) {
    throw new VerticalKitsError('invalid_input', 'the install input must be an object');
  }
  const kitKey = (input as { kitKey?: unknown }).kitKey;
  if (!isVerticalKitKey(kitKey)) {
    throw new VerticalKitsError('invalid_input', `kitKey '${String(kitKey)}' is not a kit slug`);
  }
  const version = (input as { version?: unknown }).version ?? null;
  if (version !== null && (typeof version !== 'string' || !isSemver(version))) {
    throw new VerticalKitsError(
      'invalid_input',
      `version must be null or a release semver (got '${String(version)}')`,
    );
  }
  return { kitKey, version };
}

function validateLimit(limit: unknown, fallback: number, max: number): number {
  if (limit === undefined || limit === null) return fallback;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new VerticalKitsError(
      'invalid_input',
      `limit must be an integer between 1 and ${max} (got '${String(limit)}')`,
    );
  }
  return limit;
}

// ---------------------------------------------------------------------------
// The marketplace-package-driven install composition
// ---------------------------------------------------------------------------

/** Deep-equal comparison of a kit's manifest subject vs a frozen package subject. */
function subjectMatches(
  kitSubject: Record<string, unknown>,
  frozen: Record<string, unknown>,
): boolean {
  return JSON.stringify(sortDeep(kitSubject)) === JSON.stringify(sortDeep(frozen));
}

/** Deterministic canonical JSON (key order normalized, recursively). */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) out[key] = sortDeep(entry);
    return out;
  }
  return value;
}

interface ResolvedPackageBinding {
  extensionKey: string;
  extensionVersion: string;
  packageId: string;
  packageKey: string;
  grantedPermissions: ExtensionPermission[];
}

/**
 * Resolve every kit manifest to its INSTALLABLE marketplace package,
 * fail-closed on content drift (the W028 discipline consumed through
 * the marketplace contract only).
 */
async function resolvePackageBindings(
  ctx: TenantContext,
  kit: VerticalKitDefinition,
): Promise<Map<string, ResolvedPackageBinding>> {
  const catalog = await listCatalogPackages(ctx, { kind: 'extension' });
  const installable = catalog.filter((pkg) => pkg.state === 'INSTALLABLE');
  const bindings = new Map<string, ResolvedPackageBinding>();
  for (const spec of kit.extensionManifests) {
    const normalized = normalizeKitManifest(spec.manifest);
    const subject = kitManifestSubject(spec.manifest);
    const candidates = installable.filter(
      (pkg) =>
        pkg.kind === 'extension' &&
        (pkg.payload as { extensionKey?: string }).extensionKey === normalized.extensionKey &&
        pkg.version === normalized.version,
    );
    const matched = candidates.find((pkg) => {
      const payload = pkg.payload as { subject?: Record<string, unknown> };
      return (
        typeof payload.subject === 'object' &&
        payload.subject !== null &&
        subjectMatches(subject as unknown as Record<string, unknown>, payload.subject)
      );
    });
    if (matched === undefined) {
      if (candidates.length > 0) {
        throw new VerticalKitsError(
          'package_mismatch',
          `the catalog's package for '${normalized.extensionKey}' ${normalized.version} does not match the kit's frozen declaration — refusing to bind a drifted artifact`,
        );
      }
      throw new VerticalKitsError(
        'kit_not_available',
        `no INSTALLABLE marketplace package exists for '${normalized.extensionKey}' ${normalized.version} — the kit cannot be installed until its manifests are platform-approved and installable`,
      );
    }
    bindings.set(normalized.extensionKey, {
      extensionKey: normalized.extensionKey,
      extensionVersion: normalized.version,
      packageId: matched.id,
      packageKey: matched.packageKey,
      grantedPermissions: [...normalized.requestedPermissions],
    });
  }
  return bindings;
}

/** Does the tenant registry already hold this exact manifest declaration? */
function registryManifestMatches(
  existing: ExtensionManifestSummary,
  spec: VerticalKitDefinition['extensionManifests'][number],
): boolean {
  const normalized = normalizeKitManifest(spec.manifest);
  return (
    existing.manifestSchemaVersion === spec.manifest.manifestSchemaVersion &&
    JSON.stringify(sortDeep(existing.requestedPermissions)) ===
      JSON.stringify(sortDeep(normalized.requestedPermissions)) &&
    JSON.stringify(sortDeep(existing.capabilities as unknown)) ===
      JSON.stringify(sortDeep(normalized.capabilities as unknown)) &&
    JSON.stringify(sortDeep(existing.quotas as unknown)) ===
      JSON.stringify(sortDeep(normalized.quotas as unknown)) &&
    JSON.stringify(sortDeep(existing.hostCompatibility as unknown)) ===
      JSON.stringify(sortDeep(normalized.hostCompatibility as unknown))
  );
}

/**
 * Ensure every kit manifest is registered, VERIFIED, ACTIVE and
 * DEPLOYED in the tenant's own extensions registry with the kit's
 * exact per-manifest grant — all through the extensions contract.
 */
async function ensureDeployedThroughExtensions(
  ctx: TenantContext,
  kit: VerticalKitDefinition,
): Promise<Map<string, ResolvedPackageBinding>> {
  const bindings = await resolvePackageBindings(ctx, kit);

  for (const spec of kit.extensionManifests) {
    const normalized = normalizeKitManifest(spec.manifest);
    let manifestId: string;

    // (a) the manifest exists in the tenant registry — or is registered now.
    const existing = await listManifests(ctx, { extensionKey: normalized.extensionKey, limit: 500 });
    const already = existing.find((manifest) => manifest.version === normalized.version);
    if (already !== undefined) {
      if (!registryManifestMatches(already, spec)) {
        throw new VerticalKitsError(
          'kit_conflict',
          `the tenant registry already holds a different declaration for '${normalized.extensionKey}' ${normalized.version} — manifests are immutable; refusing to install over it`,
        );
      }
      manifestId = already.id;
    } else {
      try {
        const registered = await registerExtensionManifest(ctx, spec.manifest);
        manifestId = registered.manifest.id;
      } catch (error) {
        if (error instanceof ExtensionsError) {
          if (error.code === 'forbidden') {
            throw new VerticalKitsError(
              'forbidden',
              `installing a kit composes the tenant's extensions registry — the caller must also hold the 'extensions:administer' claim`,
            );
          }
          if (error.code === 'version_conflict') {
            throw new VerticalKitsError(
              'kit_conflict',
              `the tenant registry conflicted on '${normalized.extensionKey}' ${normalized.version}: ${error.message}`,
            );
          }
          throw new VerticalKitsError('invalid_kit', error.message);
        }
        throw error;
      }
    }

    // (b) the registry's own deterministic verification must be VERIFIED.
    const verification = await runManifestVerification(ctx, { manifestId });
    if (verification.state !== 'VERIFIED') {
      throw new VerticalKitsError(
        'kit_not_available',
        `the extensions registry's verification refused '${normalized.extensionKey}' ${normalized.version} (${verification.state}) — no unverified software capability is enabled`,
      );
    }

    // (c) the extension must be ACTIVE (activate/resume idempotently).
    const extension = await getExtension(ctx, { extensionKey: normalized.extensionKey });
    if (extension.lifecycleState === 'DEPRECATED') {
      throw new VerticalKitsError(
        'kit_conflict',
        `extension '${normalized.extensionKey}' is DEPRECATED in this tenant — retirement is terminal; the kit cannot install over it`,
      );
    }
    if (extension.lifecycleState !== 'ACTIVE') {
      const transition = extension.lifecycleState === 'SUSPENDED' ? 'resume' : 'activate';
      const moved = await transitionExtension(ctx, {
        extensionId: extension.id,
        transition,
        idempotencyKey: `vertical-kit:${kit.kitKey}:${kit.version}:${transition}:${normalized.extensionKey}`,
      });
      if (!moved.applied) {
        throw new VerticalKitsError(
          'approval_required',
          `the authority gate holds the ${transition} of '${normalized.extensionKey}' pending a human decision — re-invoke the kit install after the decision to complete it`,
        );
      }
    }

    // (d) deploy the version with EXACTLY the kit's grant (the manifest's
    // requested set — the runtime bounds it by the same ceiling).
    const deployed = await deployExtensionVersion(ctx, {
      extensionKey: normalized.extensionKey,
      version: normalized.version,
      installKey: 'default',
      grantedPermissions: [...normalized.requestedPermissions],
      idempotencyKey: `vertical-kit:${kit.kitKey}:${kit.version}:deploy:${normalized.extensionKey}`,
    });
    if (!deployed.applied || deployed.deployment === null) {
      if (deployed.gate.status === 'pending') {
        throw new VerticalKitsError(
          'approval_required',
          `the authority gate holds the deployment of '${normalized.extensionKey}' ${normalized.version} pending a human decision — re-invoke the kit install after the decision to complete it (already-applied deployments replay idempotently)`,
        );
      }
      throw new VerticalKitsError(
        'forbidden',
        `tenant policy refused the deployment of '${normalized.extensionKey}' ${normalized.version} (${deployed.gate.status})`,
      );
    }
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// Install / upgrade / remove (the five acceptance clauses)
// ---------------------------------------------------------------------------

async function appendEvent(
  ctx: TenantContext,
  kitKey: string,
  eventType: VerticalKitEventType,
  fromVersion: string | null,
  toVersion: string | null,
  detail: VerticalKitEvent['detail'],
): Promise<void> {
  if (!(VERTICAL_KIT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new VerticalKitsError('invalid_input', `unknown kit event type '${String(eventType)}'`);
  }
  await getDb().query(
    `INSERT INTO vertical_kit_events
        (id, tenant_id, kit_key, event_type, from_version, to_version, actor, occurred_at, detail)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      ctx.tenantId,
      kitKey,
      eventType,
      fromVersion,
      toVersion,
      ctx.principalId,
      now(),
      JSON.stringify(detail),
    ],
  );
}

function eventDetailOf(bindings: Map<string, ResolvedPackageBinding>): VerticalKitEvent['detail'] {
  return {
    grants: [...bindings.values()]
      .sort((a, b) => (a.extensionKey < b.extensionKey ? -1 : 1))
      .map((binding) => ({
        extensionKey: binding.extensionKey,
        extensionVersion: binding.extensionVersion,
        packageId: binding.packageId,
        packageKey: binding.packageKey,
        grantedPermissions: [...binding.grantedPermissions],
      })),
  };
}

/**
 * Install one kit version into the tenant — the marketplace-package-
 * driven composition above, recorded idempotently (a replay of the same
 * version returns the recorded install, `created: false`, and appends
 * nothing).
 */
export async function installVerticalKit(
  ctx: TenantContext,
  input: InstallVerticalKitInput,
): Promise<InstallVerticalKitResult> {
  assertVerticalKitsTenantContext(ctx);
  if (!canAdminister(ctx.authority)) administerForbidden('installVerticalKit');
  const valid = validateInstallInput(input);

  const kit = getKitDefinition(valid.kitKey, valid.version);

  // Idempotent replay: the same version already installed returns the
  // recorded install without re-composing anything.
  const existingRow = await findInstallRow(ctx, valid.kitKey);
  if (existingRow !== null) {
    if (existingRow.kit_version === kit.version) {
      const grants = await grantRowsOf(ctx, existingRow.id);
      return { install: installOf(existingRow, grants, kit), created: false };
    }
    throw new VerticalKitsError(
      'kit_conflict',
      `kit '${valid.kitKey}' is installed at ${existingRow.kit_version} — installing ${kit.version} is an UPGRADE (upgradeVerticalKit); installs never silently mutate a recorded version`,
    );
  }

  const bindings = await ensureDeployedThroughExtensions(ctx, kit);

  const timestamp = now();
  const installId = await getDb().transaction(async (tx) => {
    const inserted = await tx.query<InstallRow>(
      `INSERT INTO vertical_kit_installs
          (id, tenant_id, kit_key, kit_version, version_major, version_minor, version_patch,
           installed_by, installed_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING *`,
      [
        ctx.tenantId,
        kit.kitKey,
        kit.version,
        kit.versionParts.major,
        kit.versionParts.minor,
        kit.versionParts.patch,
        ctx.principalId,
        timestamp,
      ],
    );
    const row = inserted.rows[0]!;
    for (const binding of bindings.values()) {
      await tx.query(
        `INSERT INTO vertical_kit_grants
            (id, tenant_id, install_id, kit_key, extension_key, extension_version,
             package_id, package_key, granted_permissions, deployed_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          ctx.tenantId,
          row.id,
          kit.kitKey,
          binding.extensionKey,
          binding.extensionVersion,
          binding.packageId,
          binding.packageKey,
          JSON.stringify(binding.grantedPermissions),
          timestamp,
        ],
      );
    }
    return row.id;
  });

  await appendEvent(ctx, kit.kitKey, 'install', null, kit.version, eventDetailOf(bindings));

  const grants = await grantRowsOf(ctx, installId);
  const row = (await findInstallRow(ctx, kit.kitKey))!;
  return { install: installOf(row, grants, kit), created: true };
}

/**
 * Upgrade an installed kit to a STRICTLY GREATER version — a new
 * version install, never a mutation: the grant set is replaced (the
 * old grants are removed, the new grants recorded) and BOTH states
 * live on in the append-only event trail.
 */
export async function upgradeVerticalKit(
  ctx: TenantContext,
  input: InstallVerticalKitInput,
): Promise<InstallVerticalKitResult> {
  assertVerticalKitsTenantContext(ctx);
  if (!canAdminister(ctx.authority)) administerForbidden('upgradeVerticalKit');
  const valid = validateInstallInput(input);
  if (valid.version === null) {
    throw new VerticalKitsError(
      'invalid_input',
      'upgradeVerticalKit requires an explicit target version',
    );
  }

  const kit = getKitDefinition(valid.kitKey, valid.version);

  const existingRow = await findInstallRow(ctx, valid.kitKey);
  if (existingRow === null) {
    throw new VerticalKitsError(
      'kit_not_installed',
      `kit '${valid.kitKey}' is not installed — install it before upgrading`,
    );
  }
  const existingParts = parseSemver(existingRow.kit_version)!;
  const order = compareSemver(kit.versionParts, existingParts);
  if (order === 0) {
    throw new VerticalKitsError(
      'kit_conflict',
      `kit '${valid.kitKey}' is already installed at ${kit.version} — a same-version re-install is the idempotent install path, not an upgrade`,
    );
  }
  if (order < 0) {
    throw new VerticalKitsError(
      'kit_conflict',
      `kit '${valid.kitKey}' is installed at ${existingRow.kit_version} — downgrades are refused (installed at a newer version than ${kit.version})`,
    );
  }

  const bindings = await ensureDeployedThroughExtensions(ctx, kit);

  const timestamp = now();
  await getDb().transaction(async (tx) => {
    await tx.query(
      `UPDATE vertical_kit_installs
          SET kit_version = $3, version_major = $4, version_minor = $5, version_patch = $6,
              updated_at = $7
        WHERE tenant_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        existingRow.id,
        kit.version,
        kit.versionParts.major,
        kit.versionParts.minor,
        kit.versionParts.patch,
        timestamp,
      ],
    );
    await tx.query(
      `DELETE FROM vertical_kit_grants WHERE tenant_id = $1 AND install_id = $2`,
      [ctx.tenantId, existingRow.id],
    );
    for (const binding of bindings.values()) {
      await tx.query(
        `INSERT INTO vertical_kit_grants
            (id, tenant_id, install_id, kit_key, extension_key, extension_version,
             package_id, package_key, granted_permissions, deployed_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          ctx.tenantId,
          existingRow.id,
          kit.kitKey,
          binding.extensionKey,
          binding.extensionVersion,
          binding.packageId,
          binding.packageKey,
          JSON.stringify(binding.grantedPermissions),
          timestamp,
        ],
      );
    }
  });

  await appendEvent(
    ctx,
    kit.kitKey,
    'upgrade',
    existingRow.kit_version,
    kit.version,
    eventDetailOf(bindings),
  );

  const row = (await findInstallRow(ctx, kit.kitKey))!;
  const grants = await grantRowsOf(ctx, row.id);
  return { install: installOf(row, grants, kit), created: true };
}

/**
 * Remove an installed kit: the grants and package bindings are DELETED
 * (that is what removal means), one append-only remove event freezes
 * what was removed, and the recipe references survive — the returned
 * list is the honest "these plans came from kit vX" trail.
 */
export async function removeVerticalKit(
  ctx: TenantContext,
  input: RemoveVerticalKitInput,
): Promise<RemoveVerticalKitResult> {
  assertVerticalKitsTenantContext(ctx);
  if (!canAdminister(ctx.authority)) administerForbidden('removeVerticalKit');
  if (typeof input !== 'object' || input === null || !isVerticalKitKey(input.kitKey)) {
    throw new VerticalKitsError('invalid_input', 'kitKey must be a kit slug');
  }
  const kitKey = input.kitKey;

  const existingRow = await findInstallRow(ctx, kitKey);
  if (existingRow === null) {
    throw new VerticalKitsError('kit_not_installed', `kit '${kitKey}' is not installed`);
  }

  const grants = await grantRowsOf(ctx, existingRow.id);
  const removedDetail: VerticalKitEvent['detail'] = {
    grants: grants.map((grant) => ({
      extensionKey: grant.extension_key,
      extensionVersion: grant.extension_version,
      packageId: grant.package_id,
      packageKey: grant.package_key,
      grantedPermissions: permissionsOf(grant.granted_permissions),
    })),
  };

  await getDb().transaction(async (tx) => {
    await tx.query(
      `DELETE FROM vertical_kit_grants WHERE tenant_id = $1 AND install_id = $2`,
      [ctx.tenantId, existingRow.id],
    );
    await tx.query(
      `DELETE FROM vertical_kit_installs WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, existingRow.id],
    );
  });

  await appendEvent(ctx, kitKey, 'remove', existingRow.kit_version, null, removedDetail);

  const survivingReferences = await listVerticalKitRecipeReferences(ctx, { kitKey });
  return { survivingReferences };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One tenant's current install of one kit (with grants + edge posture). */
export async function getVerticalKitInstall(
  ctx: TenantContext,
  query: { kitKey: string },
): Promise<VerticalKitInstall> {
  assertVerticalKitsTenantContext(ctx);
  if (!isVerticalKitKey(query?.kitKey)) {
    throw new VerticalKitsError('invalid_input', 'kitKey must be a kit slug');
  }
  const row = await findInstallRow(ctx, query.kitKey);
  if (row === null) {
    throw new VerticalKitsError(
      'kit_not_installed',
      `kit '${query.kitKey}' is not installed in this tenant`,
    );
  }
  const kit = getKitDefinition(query.kitKey, row.kit_version);
  const grants = await grantRowsOf(ctx, row.id);
  return installOf(row, grants, kit);
}

/** Every kit this tenant currently has installed. */
export async function listVerticalKitInstalls(ctx: TenantContext): Promise<VerticalKitInstall[]> {
  assertVerticalKitsTenantContext(ctx);
  const rows = await getDb().query<InstallRow>(
    `SELECT * FROM vertical_kit_installs WHERE tenant_id = $1 ORDER BY kit_key ASC`,
    [ctx.tenantId],
  );
  const out: VerticalKitInstall[] = [];
  for (const row of rows.rows) {
    const kit = getKitDefinition(row.kit_key, row.kit_version);
    const grants = await grantRowsOf(ctx, row.id);
    out.push(installOf(row, grants, kit));
  }
  return out;
}

/** The append-only lifecycle audit (install/upgrade/remove). */
export async function listVerticalKitEvents(
  ctx: TenantContext,
  query: ListVerticalKitEventsQuery,
): Promise<VerticalKitEvent[]> {
  assertVerticalKitsTenantContext(ctx);
  const kitKey = query?.kitKey ?? null;
  if (kitKey !== null && !isVerticalKitKey(kitKey)) {
    throw new VerticalKitsError('invalid_input', 'kitKey must be a kit slug or null');
  }
  const limit = validateLimit(query?.limit, 50, 500);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM vertical_kit_events
       WHERE tenant_id = $1 AND ($2::text IS NULL OR kit_key = $2::text)
       ORDER BY occurred_at DESC, id DESC
       LIMIT $3`,
    [ctx.tenantId, kitKey, limit],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    kitKey: row.kit_key,
    eventType: row.event_type as VerticalKitEventType,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    actor: row.actor,
    occurredAt: iso(row.occurred_at),
    detail: { grants: detailGrantsOf(row.detail) },
  }));
}

// ---------------------------------------------------------------------------
// Recipe references (the honest removal trail)
// ---------------------------------------------------------------------------

/** Record that a kit recipe template was instantiated (immutable). */
export async function recordVerticalKitRecipeUse(
  ctx: TenantContext,
  input: RecordRecipeUseInput,
): Promise<VerticalKitRecipeReference> {
  assertVerticalKitsTenantContext(ctx);
  if (!canAdminister(ctx.authority)) administerForbidden('recordVerticalKitRecipeUse');
  if (typeof input !== 'object' || input === null || !isVerticalKitKey(input.kitKey)) {
    throw new VerticalKitsError('invalid_input', 'kitKey must be a kit slug');
  }
  const reference = input.reference;
  if (typeof reference !== 'string' || reference.trim().length === 0 || reference.length > 200) {
    throw new VerticalKitsError(
      'invalid_input',
      'reference must be a non-empty string of at most 200 characters (the opaque external reference)',
    );
  }
  const recipeKey = input.recipeKey;
  if (typeof recipeKey !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(recipeKey)) {
    throw new VerticalKitsError('invalid_input', `recipeKey '${String(recipeKey)}' is not a slug`);
  }

  const version = input.version ?? null;
  let kit: VerticalKitDefinition;
  if (version === null) {
    const row = await findInstallRow(ctx, input.kitKey);
    if (row === null) {
      throw new VerticalKitsError(
        'kit_not_installed',
        `kit '${input.kitKey}' is not installed — record the recipe use with an explicit version, or install the kit first`,
      );
    }
    kit = getKitDefinition(input.kitKey, row.kit_version);
  } else {
    kit = getKitDefinition(input.kitKey, version);
  }
  if (!kit.deepActionRecipes.some((recipe) => recipe.recipeKey === recipeKey)) {
    throw new VerticalKitsError(
      'invalid_input',
      `recipe '${recipeKey}' is not a recipe of kit '${kit.kitKey}'`,
    );
  }

  await getDb().query(
    `INSERT INTO vertical_kit_recipe_references
        (id, tenant_id, kit_key, kit_version, recipe_key, reference, recorded_by, recorded_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, kit_key, recipe_key, reference) DO NOTHING`,
    [ctx.tenantId, kit.kitKey, kit.version, recipeKey, reference, ctx.principalId, now()],
  );

  const recorded = await listVerticalKitRecipeReferences(ctx, {
    kitKey: kit.kitKey,
    limit: 500,
  });
  const found = recorded.find(
    (entry) => entry.recipeKey === recipeKey && entry.reference === reference,
  );
  return found!;
}

/**
 * The recorded recipe uses — readable forever, including AFTER kit
 * removal (`kitRemoved: true` renders the honest "this template came
 * from kit vX, which is no longer installed").
 */
export async function listVerticalKitRecipeReferences(
  ctx: TenantContext,
  query: ListRecipeReferencesQuery,
): Promise<VerticalKitRecipeReference[]> {
  assertVerticalKitsTenantContext(ctx);
  const kitKey = query?.kitKey ?? null;
  if (kitKey !== null && !isVerticalKitKey(kitKey)) {
    throw new VerticalKitsError('invalid_input', 'kitKey must be a kit slug or null');
  }
  const limit = validateLimit(query?.limit, 50, 500);
  const rows = await getDb().query<RecipeReferenceRow>(
    `SELECT * FROM vertical_kit_recipe_references
       WHERE tenant_id = $1 AND ($2::text IS NULL OR kit_key = $2::text)
       ORDER BY recorded_at DESC, id DESC
       LIMIT $3`,
    [ctx.tenantId, kitKey, limit],
  );
  const installedKeys = new Set(
    (
      await getDb().query<{ kit_key: string }>(
        `SELECT kit_key FROM vertical_kit_installs WHERE tenant_id = $1`,
        [ctx.tenantId],
      )
    ).rows.map((row) => row.kit_key),
  );
  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    kitKey: row.kit_key,
    kitVersion: row.kit_version,
    recipeKey: row.recipe_key,
    reference: row.reference,
    recordedBy: row.recorded_by,
    recordedAt: iso(row.recorded_at),
    kitRemoved: !installedKeys.has(row.kit_key),
  }));
}
