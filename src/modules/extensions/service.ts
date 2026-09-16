// Implementation of the extensions module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and
// are never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`extension_not_found` / `manifest_not_found`),
// no existence leak.
//
// W025 acceptance — "versioned extension manifests, permissions,
// lifecycle and verification states" — is carried by these deliberate
// properties, all tested:
//   1. VERSIONED MANIFESTS: one immutable row per (tenant, extension
//      key, version); versions strictly increase per extension (numeric
//      semver order — 1.2.10 > 1.2.9); the manifest FORMAT itself is
//      versioned (manifestSchemaVersion). A changed declaration is a
//      NEW version; storage triggers forbid UPDATE/DELETE/TRUNCATE;
//   2. PERMISSIONS: a closed vocabulary bound to the §17 capability
//      model; the requested set must be EXACTLY what the declared
//      capabilities require (both directions), enforced at validation,
//      by a storage trigger, and re-examined by the verification checks
//      — one rule set (manifest-rules.ts), three enforcers;
//   3. LIFECYCLE: REGISTERED → ACTIVE ⇄ SUSPENDED → DEPRECATED
//      (terminal) through a pure state machine; every transition is
//      authorized through the actions module's authority matrix (kind
//      'extension-deployment', level EXECUTE — §20's uniform gate for
//      extension deployment), legality is re-checked at apply time, and
//      each applied transition appends one immutable lifecycle event
//      linking the gate request (one event per gate request,
//      storage-enforced). Activation additionally requires the
//      latest manifest version to be VERIFIED — no unverified software
//      capability is enabled. A stable idempotency key makes the flow
//      crash-safe: a pending transition is completed by re-invoking
//      after the human decision, and a retry after an applied commit
//      replays the recorded outcome;
//   4. VERIFICATION STATES: deterministic static verification runs —
//      append-only evidence with per-check outcomes — and the derived
//      state (UNVERIFIED/VERIFIED/FAILED) folded from them. Runs never
//      mutate, so rule evolution is visible as new runs (drift
//      detection), never as rewrites.
//
// Claim-gated writes: registering a manifest version and running a
// verification require 'extensions:administer' — attaching
// software-capability definitions and verification evidence to a tenant
// is a management action (the llm/notifications precedent). Lifecycle
// transitions are NOT claim-gated: they are consequential operations
// routed through the authority matrix, exactly like notification
// delivery and LLM invocation — any member may bring a transition to
// the gate; tenant policy and its approvers decide.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { ActionsError, authorizeAction, type ActionRequest } from '@/modules/actions/contract';
import { ExtensionsError } from './errors';
import { canTransitionExtension, type ExtensionLifecycleState } from './lifecycle';
import type { ExtensionPermission } from './manifest-rules';
import {
  runManifestVerificationChecks,
  summarizeVerificationRun,
  verificationOutcomeFor,
  type ExtensionVerificationCheckResult,
  type ExtensionVerificationState,
  type ManifestVerificationSubject,
} from './verification';
import { checkHostRuntimeCompatibility, compareSemver, parseSemver, type SemverParts } from './semver';
import {
  assertExtensionsTenantContext,
  validateCheckManifestCompatibilityQuery,
  validateGetExtensionQuery,
  validateGetManifestQuery,
  validateListExtensionLifecycleEventsQuery,
  validateListExtensionsQuery,
  validateListManifestsQuery,
  validateListManifestVerificationsQuery,
  validateRegisterExtensionManifestInput,
  validateRunManifestVerificationQuery,
  validateTransitionExtensionInput,
  type ValidatedRegisterInput,
} from './validation';
import type {
  CompatibilityReport,
  Extension,
  ExtensionLifecycleEvent,
  ExtensionManifest,
  ExtensionManifestSummary,
  ExtensionManifestVerification,
  ExtensionManifestWithVerification,
  ExtensionQuotas,
  ExtensionCapabilities,
  ListExtensionLifecycleEventsQuery,
  ListExtensionsQuery,
  ListManifestsQuery,
  ListManifestVerificationsQuery,
  ManifestVerificationInfo,
  RegisterExtensionManifestInput,
  RegisterExtensionManifestResult,
  RunManifestVerificationResult,
  TransitionExtensionInput,
  TransitionExtensionResult,
  GetExtensionQuery,
  GetManifestQuery,
  RunManifestVerificationQuery,
  CheckManifestCompatibilityQuery,
} from './types';

/** Authority claim that manages the tenant's extension registry (definitions + verification evidence). */
export const EXTENSIONS_AUTHORITY_ADMINISTER = 'extensions:administer';

/** The action kind every extension lifecycle transition is gated under (§20). */
export const EXTENSION_ACTION_KIND = 'extension-deployment';

/** The authority level lifecycle transitions request — consequential (§20). */
export const EXTENSION_AUTHORITY_LEVEL = 'EXECUTE' as const;

function canAdminister(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(EXTENSIONS_AUTHORITY_ADMINISTER);
}

// ---------------------------------------------------------------------------
// Rows + mapping
// ---------------------------------------------------------------------------

interface ExtensionRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_key: string;
  lifecycle_state: ExtensionLifecycleState;
  created_at: Date | string;
  updated_at: Date | string;
  latest_version: string | null;
  latest_manifest_id: string | null;
}

interface ManifestRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  extension_key: string;
  version: string;
  version_major: number;
  version_minor: number;
  version_patch: number;
  manifest_schema_version: number;
  display_name: string;
  description: string | null;
  requested_permissions: ExtensionPermission[];
  capabilities: ExtensionCapabilities;
  quotas: ExtensionQuotas;
  host_compatibility: { minVersion: string; maxVersion: string | null };
  registered_by: string;
  registered_at: Date | string;
  verification_outcome: string | null;
}

interface VerificationRow extends DbRow {
  id: string;
  tenant_id: string;
  manifest_id: string;
  outcome: 'verified' | 'failed';
  checks: ExtensionVerificationCheckResult[];
  summary: string;
  verifier: string;
  ran_at: Date | string;
}

interface LifecycleEventRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  transition: 'activate' | 'suspend' | 'resume' | 'deprecate';
  from_state: ExtensionLifecycleState;
  to_state: ExtensionLifecycleState;
  actor: string;
  action_request_id: string | null;
  occurred_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

const EXTENSION_COLUMNS = `e.id, e.tenant_id, e.extension_key, e.lifecycle_state, e.created_at, e.updated_at,
  (SELECT m.version FROM extension_manifests m
     WHERE m.tenant_id = e.tenant_id AND m.extension_id = e.id
     ORDER BY m.version_major DESC, m.version_minor DESC, m.version_patch DESC
     LIMIT 1) AS latest_version,
  (SELECT m.id FROM extension_manifests m
     WHERE m.tenant_id = e.tenant_id AND m.extension_id = e.id
     ORDER BY m.version_major DESC, m.version_minor DESC, m.version_patch DESC
     LIMIT 1) AS latest_manifest_id`;

function mapExtension(row: ExtensionRow): Extension {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionKey: row.extension_key,
    lifecycleState: row.lifecycle_state,
    latestVersion: row.latest_version ?? null,
    latestManifestId: row.latest_manifest_id ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function versionPartsOf(row: ManifestRow): SemverParts {
  return { major: row.version_major, minor: row.version_minor, patch: row.version_patch };
}

function mapManifest(row: ManifestRow): ExtensionManifest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    extensionKey: row.extension_key,
    version: row.version,
    versionParts: versionPartsOf(row),
    manifestSchemaVersion: row.manifest_schema_version as ExtensionManifest['manifestSchemaVersion'],
    displayName: row.display_name,
    description: row.description,
    requestedPermissions: [...(row.requested_permissions ?? [])],
    capabilities: row.capabilities,
    quotas: row.quotas,
    hostCompatibility: {
      minVersion: row.host_compatibility.minVersion,
      maxVersion: row.host_compatibility.maxVersion ?? null,
    },
    registeredBy: row.registered_by,
    registeredAt: toIso(row.registered_at),
  };
}

function stateForOutcome(outcome: string | null): ExtensionVerificationState {
  if (outcome === 'verified') return 'VERIFIED';
  if (outcome === 'failed') return 'FAILED';
  return 'UNVERIFIED';
}

function mapVerification(row: VerificationRow): ExtensionManifestVerification {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    manifestId: row.manifest_id,
    outcome: row.outcome,
    checks: [...(row.checks ?? [])],
    summary: row.summary,
    verifier: row.verifier,
    ranAt: toIso(row.ran_at),
  };
}

function mapLifecycleEvent(row: LifecycleEventRow): ExtensionLifecycleEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    transition: row.transition,
    fromState: row.from_state,
    toState: row.to_state,
    actor: row.actor,
    actionRequestId: row.action_request_id,
    occurredAt: toIso(row.occurred_at),
  };
}

/** The unique-constraint name inside a PostgreSQL duplicate-key error, if any. */
function duplicateConstraint(error: unknown): string | null {
  if (!(error instanceof Error) || !/duplicate key value/i.test(error.message)) return null;
  const match = /constraint "([^"]+)"/.exec(error.message);
  return match === null ? '' : match[1]!;
}

// ---------------------------------------------------------------------------
// Lookups (tenant-scoped; null when absent or foreign — uniform not-found)
// ---------------------------------------------------------------------------

async function findExtensionRow(
  db: Queryable,
  ctx: TenantContext,
  selector: { extensionId: string | null; extensionKey: string | null },
): Promise<ExtensionRow | null> {
  const rows =
    selector.extensionId !== null
      ? await db.query<ExtensionRow>(
          `SELECT ${EXTENSION_COLUMNS} FROM extensions e
             WHERE e.tenant_id = $1 AND e.id = $2`,
          [ctx.tenantId, selector.extensionId],
        )
      : await db.query<ExtensionRow>(
          `SELECT ${EXTENSION_COLUMNS} FROM extensions e
             WHERE e.tenant_id = $1 AND e.extension_key = $2`,
          [ctx.tenantId, selector.extensionKey],
        );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

async function findManifestRow(
  db: Queryable,
  ctx: TenantContext,
  manifestId: string,
): Promise<ManifestRow | null> {
  const rows = await db.query<ManifestRow>(
    `SELECT m.*,
       (SELECT v.outcome FROM extension_manifest_verifications v
          WHERE v.tenant_id = m.tenant_id AND v.manifest_id = m.id
          ORDER BY v.ran_at DESC, v.id DESC LIMIT 1) AS verification_outcome
       FROM extension_manifests m
       WHERE m.tenant_id = $1 AND m.id = $2`,
    [ctx.tenantId, manifestId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

/** The latest (newest semver) manifest row of an extension; null when none. */
async function findLatestManifestRow(
  db: Queryable,
  ctx: TenantContext,
  extensionId: string,
): Promise<ManifestRow | null> {
  const rows = await db.query<ManifestRow>(
    `SELECT m.*,
       (SELECT v.outcome FROM extension_manifest_verifications v
          WHERE v.tenant_id = m.tenant_id AND v.manifest_id = m.id
          ORDER BY v.ran_at DESC, v.id DESC LIMIT 1) AS verification_outcome
       FROM extension_manifests m
       WHERE m.tenant_id = $1 AND m.extension_id = $2
       ORDER BY m.version_major DESC, m.version_minor DESC, m.version_patch DESC
       LIMIT 1`,
    [ctx.tenantId, extensionId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

async function findLatestVerificationRow(
  db: Queryable,
  ctx: TenantContext,
  manifestId: string,
): Promise<VerificationRow | null> {
  const rows = await db.query<VerificationRow>(
    `SELECT * FROM extension_manifest_verifications
       WHERE tenant_id = $1 AND manifest_id = $2
       ORDER BY ran_at DESC, id DESC
       LIMIT 1`,
    [ctx.tenantId, manifestId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

// ---------------------------------------------------------------------------
// Manifest registration (versioned, immutable)
// ---------------------------------------------------------------------------

export async function registerExtensionManifest(
  ctx: TenantContext,
  input: RegisterExtensionManifestInput,
): Promise<RegisterExtensionManifestResult> {
  assertExtensionsTenantContext(ctx);
  // The registry is the tenant's capability-definition surface: only
  // holders of the administer claim may register manifest versions
  // (authorization before input parsing — unauthorized callers learn
  // nothing about shapes).
  if (!canAdminister(ctx.authority)) {
    throw new ExtensionsError(
      'forbidden',
      `this operation requires the '${EXTENSIONS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid: ValidatedRegisterInput = validateRegisterExtensionManifestInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    const existing = await findExtensionRow(tx, ctx, {
      extensionId: null,
      extensionKey: valid.extensionKey,
    });

    if (existing !== null) {
      if (existing.lifecycle_state === 'DEPRECATED') {
        throw new ExtensionsError(
          'extension_deprecated',
          `extension '${valid.extensionKey}' is DEPRECATED — a retired extension accepts no new manifest versions`,
        );
      }
      // Strictly increasing versions per extension (numeric semver
      // order — the parsed columns, never text order).
      const latest = await findLatestManifestRow(tx, ctx, existing.id);
      if (latest !== null && compareSemver(valid.versionParts, versionPartsOf(latest)) <= 0) {
        throw new ExtensionsError(
          'version_not_monotonic',
          `version ${valid.version} does not come after the latest registered version ${latest.version} of extension '${valid.extensionKey}' — versions must strictly increase`,
        );
      }
    }

    let extensionId: string;
    if (existing === null) {
      const insertedExtension = await tx.query<{ id: string }>(
        `INSERT INTO extensions (tenant_id, extension_key, lifecycle_state, created_at, updated_at)
           VALUES ($1, $2, 'REGISTERED', $3, $3)
           RETURNING id`,
        [ctx.tenantId, valid.extensionKey, timestamp],
      );
      extensionId = insertedExtension.rows[0]!.id;
    } else {
      extensionId = existing.id;
    }

    let manifestId: string;
    try {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO extension_manifests (
           tenant_id, extension_id, extension_key, version,
           version_major, version_minor, version_patch,
           manifest_schema_version, display_name, description,
           requested_permissions, capabilities, quotas, host_compatibility,
           registered_by, registered_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16)
         RETURNING id`,
        [
          ctx.tenantId,
          extensionId,
          valid.extensionKey,
          valid.version,
          valid.versionParts.major,
          valid.versionParts.minor,
          valid.versionParts.patch,
          valid.manifestSchemaVersion,
          valid.displayName,
          valid.description,
          JSON.stringify(valid.requestedPermissions),
          JSON.stringify(valid.capabilities),
          JSON.stringify(valid.quotas),
          JSON.stringify(valid.hostCompatibility),
          ctx.principalId,
          timestamp,
        ],
      );
      manifestId = result.rows[0]!.id;
    } catch (error) {
      const constraint = duplicateConstraint(error);
      if (constraint === 'extension_manifests_tenant_key_version_unique') {
        throw new ExtensionsError(
          'version_conflict',
          `version ${valid.version} of extension '${valid.extensionKey}' already exists in this tenant — manifests are immutable; a changed declaration is a new version`,
        );
      }
      if (constraint === 'extensions_tenant_key_unique') {
        throw new ExtensionsError(
          'version_conflict',
          `extension '${valid.extensionKey}' was created concurrently; retry the registration`,
        );
      }
      throw error;
    }

    const manifestRow = await findManifestRow(tx, ctx, manifestId);
    const extensionRow = await findExtensionRow(tx, ctx, {
      extensionId: null,
      extensionKey: valid.extensionKey,
    });
    return {
      extension: mapExtension(extensionRow!),
      manifest: mapManifest(manifestRow!),
    };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getExtension(ctx: TenantContext, query: GetExtensionQuery): Promise<Extension> {
  assertExtensionsTenantContext(ctx);
  const valid = validateGetExtensionQuery(query);
  const row = await findExtensionRow(getDb(), ctx, valid);
  if (row === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  return mapExtension(row);
}

export async function listExtensions(ctx: TenantContext, query: ListExtensionsQuery): Promise<Extension[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateListExtensionsQuery(query);
  const rows =
    valid.lifecycleState === null
      ? await getDb().query<ExtensionRow>(
          `SELECT ${EXTENSION_COLUMNS} FROM extensions e
             WHERE e.tenant_id = $1
             ORDER BY e.extension_key ASC
             LIMIT $2`,
          [ctx.tenantId, valid.limit],
        )
      : await getDb().query<ExtensionRow>(
          `SELECT ${EXTENSION_COLUMNS} FROM extensions e
             WHERE e.tenant_id = $1 AND e.lifecycle_state = $2
             ORDER BY e.extension_key ASC
             LIMIT $3`,
          [ctx.tenantId, valid.lifecycleState, valid.limit],
        );
  return rows.rows.map(mapExtension);
}

export async function getManifest(
  ctx: TenantContext,
  query: GetManifestQuery,
): Promise<ExtensionManifestWithVerification> {
  assertExtensionsTenantContext(ctx);
  const valid = validateGetManifestQuery(query);
  const row = await findManifestRow(getDb(), ctx, valid.manifestId);
  if (row === null) {
    throw new ExtensionsError(
      'manifest_not_found',
      `no extension manifest '${valid.manifestId}' exists in this tenant`,
    );
  }
  const latestRun = await findLatestVerificationRow(getDb(), ctx, valid.manifestId);
  const manifest = mapManifest(row);
  return {
    ...manifest,
    verification: {
      state: stateForOutcome(row.verification_outcome),
      latestRun: latestRun === null ? null : mapVerification(latestRun),
    },
  };
}

export async function listManifests(
  ctx: TenantContext,
  query: ListManifestsQuery,
): Promise<ExtensionManifestSummary[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateListManifestsQuery(query);

  const conditions: string[] = ['m.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.extensionId !== null) {
    params.push(valid.extensionId);
    conditions.push(`m.extension_id = $${params.length}`);
  }
  if (valid.extensionKey !== null) {
    params.push(valid.extensionKey);
    conditions.push(`m.extension_key = $${params.length}`);
  }
  params.push(valid.limit);

  const rows = await getDb().query<ManifestRow>(
    `SELECT m.*,
       (SELECT v.outcome FROM extension_manifest_verifications v
          WHERE v.tenant_id = m.tenant_id AND v.manifest_id = m.id
          ORDER BY v.ran_at DESC, v.id DESC LIMIT 1) AS verification_outcome
       FROM extension_manifests m
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.extension_key ASC, m.version_major DESC, m.version_minor DESC, m.version_patch DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map((row) => ({
    ...mapManifest(row),
    verificationState: stateForOutcome(row.verification_outcome),
  }));
}

export async function getManifestVerification(
  ctx: TenantContext,
  query: GetManifestQuery,
): Promise<ManifestVerificationInfo> {
  assertExtensionsTenantContext(ctx);
  const valid = validateGetManifestQuery(query);
  const manifest = await findManifestRow(getDb(), ctx, valid.manifestId);
  if (manifest === null) {
    throw new ExtensionsError(
      'manifest_not_found',
      `no extension manifest '${valid.manifestId}' exists in this tenant`,
    );
  }
  const latestRun = await findLatestVerificationRow(getDb(), ctx, valid.manifestId);
  return {
    manifestId: valid.manifestId,
    state: stateForOutcome(manifest.verification_outcome),
    latestRun: latestRun === null ? null : mapVerification(latestRun),
  };
}

export async function listManifestVerifications(
  ctx: TenantContext,
  query: ListManifestVerificationsQuery,
): Promise<ExtensionManifestVerification[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateListManifestVerificationsQuery(query);
  const manifest = await findManifestRow(getDb(), ctx, valid.manifestId);
  if (manifest === null) {
    throw new ExtensionsError(
      'manifest_not_found',
      `no extension manifest '${valid.manifestId}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<VerificationRow>(
    `SELECT * FROM extension_manifest_verifications
       WHERE tenant_id = $1 AND manifest_id = $2
       ORDER BY ran_at ASC, id ASC
       LIMIT $3`,
    [ctx.tenantId, valid.manifestId, valid.limit],
  );
  return rows.rows.map(mapVerification);
}

export async function listExtensionLifecycleEvents(
  ctx: TenantContext,
  query: ListExtensionLifecycleEventsQuery,
): Promise<ExtensionLifecycleEvent[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateListExtensionLifecycleEventsQuery(query);
  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<LifecycleEventRow>(
    `SELECT * FROM extension_lifecycle_events
       WHERE tenant_id = $1 AND extension_id = $2
       ORDER BY occurred_at ASC, id ASC
       LIMIT $3`,
    [ctx.tenantId, extension.id, valid.limit],
  );
  return rows.rows.map(mapLifecycleEvent);
}

// ---------------------------------------------------------------------------
// Compatibility (§17)
// ---------------------------------------------------------------------------

export async function checkManifestCompatibility(
  ctx: TenantContext,
  query: CheckManifestCompatibilityQuery,
): Promise<CompatibilityReport> {
  assertExtensionsTenantContext(ctx);
  const valid = validateCheckManifestCompatibilityQuery(query);
  const row = await findManifestRow(getDb(), ctx, valid.manifestId);
  if (row === null) {
    throw new ExtensionsError(
      'manifest_not_found',
      `no extension manifest '${valid.manifestId}' exists in this tenant`,
    );
  }
  const min = parseSemver(row.host_compatibility.minVersion);
  const max =
    row.host_compatibility.maxVersion === null || row.host_compatibility.maxVersion === undefined
      ? null
      : parseSemver(row.host_compatibility.maxVersion);
  const verdict = checkHostRuntimeCompatibility(valid.hostVersion, {
    minVersion: min ?? { major: 0, minor: 0, patch: 0 },
    maxVersion: max,
  });
  const reasonText: Record<string, string> = {
    host_below_minimum: `host ${valid.hostVersion} is below the manifest's minimum ${row.host_compatibility.minVersion}`,
    host_above_maximum: `host ${valid.hostVersion} is above the manifest's maximum ${row.host_compatibility.maxVersion}`,
    malformed_host_version: `host version '${valid.hostVersion}' is not a release semver`,
  };
  return {
    manifestId: row.id,
    extensionKey: row.extension_key,
    version: row.version,
    hostVersion: valid.hostVersion,
    compatible: verdict.compatible,
    reasons: verdict.reasons.map((reason) => reasonText[reason] ?? reason),
  };
}

// ---------------------------------------------------------------------------
// Verification runs (append-only evidence)
// ---------------------------------------------------------------------------

export async function runManifestVerification(
  ctx: TenantContext,
  query: RunManifestVerificationQuery,
): Promise<RunManifestVerificationResult> {
  assertExtensionsTenantContext(ctx);
  // Verification evidence is registry data: the administer claim gates
  // who may append runs (the marketplace's automated verifier and the
  // builder will hold it through their own integration paths).
  if (!canAdminister(ctx.authority)) {
    throw new ExtensionsError(
      'forbidden',
      `this operation requires the '${EXTENSIONS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateRunManifestVerificationQuery(query);

  const row = await findManifestRow(getDb(), ctx, valid.manifestId);
  if (row === null) {
    throw new ExtensionsError(
      'manifest_not_found',
      `no extension manifest '${valid.manifestId}' exists in this tenant`,
    );
  }

  // The deterministic static examination — pure functions of the
  // stored manifest, never of the caller, clock or LLM.
  const subject: ManifestVerificationSubject = {
    manifestSchemaVersion: row.manifest_schema_version,
    requestedPermissions: [...(row.requested_permissions ?? [])],
    capabilities: row.capabilities,
    quotas: row.quotas,
    hostCompatibility: {
      minVersion: row.host_compatibility.minVersion,
      maxVersion: row.host_compatibility.maxVersion ?? null,
    },
  };
  const checks = runManifestVerificationChecks(subject);
  const outcome = verificationOutcomeFor(checks);
  const summary = summarizeVerificationRun(checks);

  const inserted = await getDb().query<VerificationRow>(
    `INSERT INTO extension_manifest_verifications (
       tenant_id, manifest_id, outcome, checks, summary, verifier, ran_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING *`,
    [ctx.tenantId, valid.manifestId, outcome, JSON.stringify(checks), summary, ctx.principalId, now()],
  );

  return {
    manifestId: valid.manifestId,
    run: mapVerification(inserted.rows[0]!),
    state: outcome === 'verified' ? 'VERIFIED' : 'FAILED',
  };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (the authority-gated state machine)
// ---------------------------------------------------------------------------

/** The applied lifecycle event of an authority-gate request, if any. */
async function findEventByRequestId(
  db: Queryable,
  ctx: TenantContext,
  actionRequestId: string,
): Promise<LifecycleEventRow | null> {
  const rows = await db.query<LifecycleEventRow>(
    `SELECT * FROM extension_lifecycle_events
       WHERE tenant_id = $1 AND action_request_id = $2`,
    [ctx.tenantId, actionRequestId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

/**
 * Bring one lifecycle transition to the actions authority gate (kind
 * 'extension-deployment', level EXECUTE). The gate inputs are built
 * here and pre-validated, so an ActionsError contradicts the actions
 * contract — stay loud rather than silently unmoved.
 */
async function authorizeGate(
  ctx: TenantContext,
  extension: ExtensionRow,
  valid: { transition: string; targetState: string; idempotencyKey: string | null },
): Promise<ActionRequest> {
  try {
    return await authorizeAction(ctx, {
      actionKind: EXTENSION_ACTION_KIND,
      authorityLevel: EXTENSION_AUTHORITY_LEVEL,
      payload: {
        extensionId: extension.id,
        extensionKey: extension.extension_key,
        transition: valid.transition,
        fromState: extension.lifecycle_state,
        toState: valid.targetState,
      },
      justification: `${valid.transition} extension '${extension.extension_key}' (${extension.lifecycle_state} → ${valid.targetState})`,
      idempotencyKey: valid.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      throw new Error(
        `the authority gate rejected a pre-validated extension transition authorization (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function transitionExtension(
  ctx: TenantContext,
  input: TransitionExtensionInput,
): Promise<TransitionExtensionResult> {
  assertExtensionsTenantContext(ctx);
  const valid = validateTransitionExtensionInput(input);

  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }

  // Fail fast on nonsense (the pure state machine), re-checked at apply
  // time inside the transaction.
  if (!canTransitionExtension(extension.lifecycle_state, valid.transition)) {
    // One caller error is NOT nonsense: an idempotent RETRY of a
    // transition that already applied (a crash between commit and
    // response must replay the recorded outcome, not fail). Such a
    // retry finds the extension already at the transition's target and
    // a lifecycle event linked to the replayed gate request. Anything
    // else — keyless, or a state the transition cannot explain — is a
    // genuine state error.
    if (valid.idempotencyKey !== null && extension.lifecycle_state === valid.targetState) {
      const replayRequest = await authorizeGate(ctx, extension, valid);
      const applied = await findEventByRequestId(getDb(), ctx, replayRequest.id);
      if (applied !== null) {
        return {
          extension: mapExtension(extension),
          applied: true,
          gate: { actionRequestId: replayRequest.id, status: replayRequest.status },
        };
      }
    }
    throw new ExtensionsError(
      'invalid_transition',
      `cannot ${valid.transition} extension '${extension.extension_key}' from ${extension.lifecycle_state}`,
    );
  }

  // Activation demands verification: no unverified software capability
  // is enabled. The check targets the LATEST registered version.
  if (valid.targetState === 'ACTIVE') {
    const latest = await findLatestManifestRow(getDb(), ctx, extension.id);
    const state =
      latest === null ? 'UNVERIFIED' : stateForOutcome(latest.verification_outcome);
    if (state !== 'VERIFIED') {
      throw new ExtensionsError(
        'verification_required',
        latest === null
          ? `extension '${extension.extension_key}' has no manifest to verify`
          : `extension '${extension.extension_key}' cannot become ACTIVE: its latest version ${latest.version} is ${state} — run a verification that passes first`,
      );
    }
  }

  // The authority gate (§20, uniform): every lifecycle transition is an
  // 'extension-deployment' EXECUTE. allowed → policy auto-approval,
  // approval_required → the transition waits for a human decision (the
  // caller re-invokes with the same idempotency key to complete it),
  // forbidden → policy rejection, recorded by the actions module.
  const fromState = extension.lifecycle_state;
  const request = await authorizeGate(ctx, extension, valid);

  if (request.status === 'rejected') {
    throw new ExtensionsError(
      'forbidden_by_policy',
      `the tenant's authority policy forbids ${valid.transition} of extension '${extension.extension_key}' (action request ${request.id})`,
    );
  }

  if (request.status === 'pending') {
    // The gate holds the transition. The extension is unchanged; the
    // gate request id is returned so the caller (or a future pump)
    // re-invokes with the same idempotency key once a human decides.
    return {
      extension: mapExtension(extension),
      applied: false,
      gate: { actionRequestId: request.id, status: 'pending' },
    };
  }

  const appliedAt = now();
  return getDb().transaction(async (tx) => {
    // First-apply wins: the guarded UPDATE requires the extension to
    // still be in the state the gate evaluated.
    const updated = await tx.query<ExtensionRow>(
      `UPDATE extensions
         SET lifecycle_state = $3, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND lifecycle_state = $5
       RETURNING id`,
      [ctx.tenantId, extension.id, valid.targetState, appliedAt, fromState],
    );
    if (updated.rows.length === 0) {
      // Either a concurrent caller applied first, or this is a replay of
      // a transition whose gate request already applied — distinguish
      // by the request-linked event before reporting a state race.
      const current = await findExtensionRow(tx, ctx, { extensionId: extension.id, extensionKey: null });
      if (current !== null && current.lifecycle_state === valid.targetState) {
        const appliedEvent = await findEventByRequestId(tx, ctx, request.id);
        if (appliedEvent !== null) {
          // Idempotent replay: the original outcome stands.
          return {
            extension: mapExtension(current),
            applied: true,
            gate: { actionRequestId: request.id, status: 'approved' as const },
          };
        }
      }
      const state = current?.lifecycle_state ?? fromState;
      throw new ExtensionsError(
        'invalid_transition',
        `cannot ${valid.transition} extension '${extension.extension_key}' from ${state} — the state moved while the transition was at the gate`,
      );
    }

    await tx.query(
      `INSERT INTO extension_lifecycle_events (
         tenant_id, extension_id, transition, from_state, to_state, actor, action_request_id, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ctx.tenantId,
        extension.id,
        valid.transition,
        fromState,
        valid.targetState,
        ctx.principalId,
        request.id,
        appliedAt,
      ],
    );

    const refreshed = await findExtensionRow(tx, ctx, { extensionId: extension.id, extensionKey: null });
    return {
      extension: mapExtension(refreshed!),
      applied: true,
      gate: { actionRequestId: request.id, status: 'approved' as const },
    };
  });
}
