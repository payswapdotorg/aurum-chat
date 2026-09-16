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
//
// W026 acceptance — "persistent scoped state, declarative UI,
// schedules, event subscriptions, scoped external participation,
// quotas, isolation, deployment, rollback and telemetry" — is carried
// by the runtime operations below, all tested:
//   * DEPLOYMENT/ROLLBACK: one append-only record per applied
//     deployment or rollback, authorized through the SAME §20 gate as
//     the lifecycle (kind 'extension-deployment', EXECUTE), with the
//     effective GRANT bounded by the deployed manifest's requested
//     ceiling (storage trigger as defense in depth). Preconditions
//     re-checked at apply time: extension ACTIVE (disablement),
//     manifest VERIFIED (no unverified software runs), host
//     compatibility against EXTENSION_RUNTIME_HOST_VERSION. The
//     current deployment is a fold over history (latest seq), never a
//     mutable pointer; a stable idempotency key replays the recorded
//     outcome (one applied deployment per gate request,
//     storage-enforced);
//   * STATE: tenant namespace (install_key NULL) or install namespace
//     (install_key slug) — upserts with revision +1, quota-checked
//     against the deployed manifest's maxStateBytes (SUM(bytes) per
//     namespace), identity immutable, DELETE/TRUNCATE forbidden at the
//     storage layer (persistence), grant-gated per direction
//     (state:read / state:write);
//   * UI: closed-vocabulary declarative documents per (extension,
//     surface), replaceable, never deleted, grant-gated (ui:render) —
//     the host renders data, the extension ships no code;
//   * SCHEDULES: declared-name triggers append immutable run records,
//     quota-checked per (tenant, extension, install, UTC day);
//   * EVENTS: dispatch fans one topic out to every subscribed install,
//     appending one delivery record per install (delivered /
//     not_granted — a grant downgrade is evidence, never silence);
//   * EXTERNAL PARTICIPATION: calls restricted to the EXACT declared
//     participant origins, quota-checked per UTC day, executed through
//     the injectable http port, outcomes recorded append-only
//     (succeeded / http_error / failed) — bodies and headers never
//     become evidence;
//   * TELEMETRY: extension-emitted bounded events, capability- and
//     grant-gated, append-only.
// Isolation (ADR-0001 + §17): every operation above is tenant-scoped
// SQL (foreign records indistinguishable from missing ones), every
// state read/write is extension-scoped, install namespaces never
// overlap, grants bound capabilities, and egress is origin-scoped.

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
  DEFAULT_INSTALL_KEY,
  EXTENSION_RUNTIME_HOST_VERSION,
  participantForOrigin,
  utcDayStart,
  type ExtensionHttpMethod,
} from './runtime';
import { extensionHttpPort } from './http';
import {
  assertExtensionsTenantContext,
  validateCheckManifestCompatibilityQuery,
  validateDeployExtensionVersionInput,
  validateDeploymentQuery,
  validateDispatchExtensionEventInput,
  validateEmitExtensionTelemetryInput,
  validateExecuteExtensionExternalCallInput,
  validateGetExtensionQuery,
  validateGetExtensionUiQuery,
  validateGetManifestQuery,
  validateListExtensionDeploymentsQuery,
  validateListExtensionLifecycleEventsQuery,
  validateListExtensionsQuery,
  validateListManifestsQuery,
  validateListManifestVerificationsQuery,
  validatePublishExtensionUiInput,
  validateReadExtensionStateQuery,
  validateRegisterExtensionManifestInput,
  validateRollbackExtensionDeploymentInput,
  validateRunManifestVerificationQuery,
  validateTransitionExtensionInput,
  validateTriggerExtensionScheduleInput,
  validateWriteExtensionStateInput,
  validateActivityListQuery,
  type ValidatedRegisterInput,
} from './validation';
import type {
  CompatibilityReport,
  DeployExtensionVersionInput,
  DeployExtensionVersionResult,
  DeploymentQuery,
  DispatchExtensionEventInput,
  DispatchExtensionEventResult,
  EmitExtensionTelemetryInput,
  ExecuteExtensionExternalCallInput,
  Extension,
  ExtensionDeployment,
  ExtensionEventDelivery,
  ExtensionExternalCall,
  ExtensionLifecycleEvent,
  ExtensionManifest,
  ExtensionManifestSummary,
  ExtensionManifestVerification,
  ExtensionManifestWithVerification,
  ExtensionQuotas,
  ExtensionCapabilities,
  ExtensionScheduleRun,
  ExtensionStateEntry,
  ExtensionTelemetryEvent,
  ExtensionUiDeclaration,
  ListExtensionDeploymentsQuery,
  ListExtensionEventDeliveriesQuery,
  ListExtensionExternalCallsQuery,
  ListExtensionLifecycleEventsQuery,
  ListExtensionScheduleRunsQuery,
  ListExtensionTelemetryEventsQuery,
  ListExtensionsQuery,
  ListManifestsQuery,
  ListManifestVerificationsQuery,
  ManifestVerificationInfo,
  PublishExtensionUiInput,
  ReadExtensionStateQuery,
  RegisterExtensionManifestInput,
  RegisterExtensionManifestResult,
  RollbackExtensionDeploymentInput,
  RollbackExtensionDeploymentResult,
  RunManifestVerificationResult,
  TransitionExtensionInput,
  TransitionExtensionResult,
  TriggerExtensionScheduleInput,
  WriteExtensionStateInput,
  GetExtensionQuery,
  GetExtensionUiQuery,
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

// ===========================================================================
// W026 — General-Purpose Extension Runtime
//
// Deployment/rollback (matrix-gated, append-only history, derived
// current), persistent scoped state, declarative UI, schedules, event
// subscriptions, scoped external participation, quotas, telemetry.
// Every operation resolves the CURRENT deployment first: the extension
// must be ACTIVE (disablement — a suspended extension is fully inert)
// and a deployment must exist; capabilities come from the DEPLOYED
// manifest, authorization from the deployment's GRANT.
// ===========================================================================

interface DeploymentRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  extension_key: string;
  install_key: string;
  manifest_id: string;
  version: string;
  operation: 'deploy' | 'rollback';
  replaces_deployment_id: string | null;
  granted_permissions: ExtensionPermission[];
  deployed_by: string;
  deployed_at: Date | string;
  action_request_id: string | null;
  seq: string | number;
}

interface StateRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  install_key: string | null;
  state_key: string;
  value: unknown;
  bytes: number;
  revision: number;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UiRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  extension_key: string;
  surface: string;
  document: { title?: unknown; blocks?: unknown };
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ScheduleRunRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  extension_key: string;
  install_key: string;
  schedule_name: string;
  cron: string;
  invoked_by: string;
  invoked_at: Date | string;
}

interface DeliveryRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  extension_key: string;
  install_key: string;
  topic: string;
  payload: unknown;
  outcome: 'delivered' | 'not_granted';
  delivered_at: Date | string;
}

interface ExternalCallRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  extension_key: string;
  install_key: string;
  origin: string;
  method: ExtensionHttpMethod;
  path: string;
  request_body_bytes: number;
  outcome: 'succeeded' | 'http_error' | 'failed';
  response_status: number | null;
  detail: string | null;
  requested_by: string;
  requested_at: Date | string;
}

interface TelemetryRow extends DbRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  extension_key: string;
  install_key: string;
  name: string;
  payload: unknown;
  emitted_by: string;
  emitted_at: Date | string;
}

function mapDeployment(row: DeploymentRow): ExtensionDeployment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    extensionKey: row.extension_key,
    installKey: row.install_key,
    manifestId: row.manifest_id,
    version: row.version,
    operation: row.operation,
    replacesDeploymentId: row.replaces_deployment_id ?? null,
    grantedPermissions: [...(row.granted_permissions ?? [])],
    deployedBy: row.deployed_by,
    deployedAt: toIso(row.deployed_at),
    seq: Number(row.seq),
  };
}

function mapStateEntry(row: StateRow): ExtensionStateEntry {
  return {
    key: row.state_key,
    value: row.value,
    bytes: row.bytes,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
  };
}

function mapUiDeclaration(row: UiRow): ExtensionUiDeclaration {
  return {
    extensionId: row.extension_id,
    extensionKey: row.extension_key,
    surface: row.surface as ExtensionUiDeclaration['surface'],
    document: row.document as ExtensionUiDeclaration['document'],
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at),
  };
}

function mapScheduleRun(row: ScheduleRunRow): ExtensionScheduleRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    extensionKey: row.extension_key,
    installKey: row.install_key,
    scheduleName: row.schedule_name,
    cron: row.cron,
    invokedBy: row.invoked_by,
    invokedAt: toIso(row.invoked_at),
  };
}

function mapDelivery(row: DeliveryRow): ExtensionEventDelivery {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    extensionKey: row.extension_key,
    installKey: row.install_key,
    topic: row.topic,
    payload: row.payload,
    outcome: row.outcome,
    deliveredAt: toIso(row.delivered_at),
  };
}

function mapExternalCall(row: ExternalCallRow): ExtensionExternalCall {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    extensionKey: row.extension_key,
    installKey: row.install_key,
    origin: row.origin,
    method: row.method,
    path: row.path,
    requestBodyBytes: row.request_body_bytes,
    outcome: row.outcome,
    responseStatus: row.response_status ?? null,
    detail: row.detail ?? null,
    requestedBy: row.requested_by,
    requestedAt: toIso(row.requested_at),
  };
}

function mapTelemetry(row: TelemetryRow): ExtensionTelemetryEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    extensionKey: row.extension_key,
    installKey: row.install_key,
    name: row.name,
    payload: row.payload,
    emittedBy: row.emitted_by,
    emittedAt: toIso(row.emitted_at),
  };
}

/** A bounded diagnostic (never a payload firehose). */
function boundedDetail(text: string | null | undefined, maxChars = 256): string | null {
  if (text === null || text === undefined) return null;
  const value = String(text);
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

// ---------------------------------------------------------------------------
// Deployment lookups (tenant-scoped; the current is a fold over history)
// ---------------------------------------------------------------------------

async function findDeploymentRow(
  db: Queryable,
  ctx: TenantContext,
  deploymentId: string,
): Promise<DeploymentRow | null> {
  const rows = await db.query<DeploymentRow>(
    `SELECT * FROM extension_deployments WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, deploymentId],
  );
  return rows.rows[0] ?? null;
}

async function findDeploymentByRequestId(
  db: Queryable,
  ctx: TenantContext,
  actionRequestId: string,
): Promise<DeploymentRow | null> {
  const rows = await db.query<DeploymentRow>(
    `SELECT * FROM extension_deployments WHERE tenant_id = $1 AND action_request_id = $2`,
    [ctx.tenantId, actionRequestId],
  );
  return rows.rows[0] ?? null;
}

async function findCurrentDeploymentRow(
  db: Queryable,
  ctx: TenantContext,
  extensionId: string,
  installKey: string,
): Promise<DeploymentRow | null> {
  const rows = await db.query<DeploymentRow>(
    `SELECT * FROM extension_deployments
       WHERE tenant_id = $1 AND extension_id = $2 AND install_key = $3
       ORDER BY seq DESC
       LIMIT 1`,
    [ctx.tenantId, extensionId, installKey],
  );
  return rows.rows[0] ?? null;
}

async function findManifestRowByVersion(
  db: Queryable,
  ctx: TenantContext,
  extensionId: string,
  version: string,
): Promise<ManifestRow | null> {
  const rows = await db.query<ManifestRow>(
    `SELECT m.*,
       (SELECT v.outcome FROM extension_manifest_verifications v
          WHERE v.tenant_id = m.tenant_id AND v.manifest_id = m.id
          ORDER BY v.ran_at DESC, v.id DESC LIMIT 1) AS verification_outcome
       FROM extension_manifests m
       WHERE m.tenant_id = $1 AND m.extension_id = $2 AND m.version = $3`,
    [ctx.tenantId, extensionId, version],
  );
  return rows.rows[0] ?? null;
}

/** The shared runtime prelude: ACTIVE extension + current deployment + its manifest. */
interface RuntimeSelector {
  extensionId: string | null;
  extensionKey: string | null;
  /** The install whose current deployment governs (default: 'default'). */
  installKey?: string | null;
}

async function resolveRuntimeTarget(
  db: Queryable,
  ctx: TenantContext,
  valid: RuntimeSelector,
): Promise<{ extension: ExtensionRow; deployment: DeploymentRow; manifest: ManifestRow }> {
  const installKey = valid.installKey ?? DEFAULT_INSTALL_KEY;
  const extension = await findExtensionRow(db, ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  if (extension.lifecycle_state !== 'ACTIVE') {
    throw new ExtensionsError(
      'extension_not_active',
      `extension '${extension.extension_key}' is ${extension.lifecycle_state} — the runtime serves only ACTIVE extensions (§17 disablement)`,
    );
  }
  const deployment = await findCurrentDeploymentRow(db, ctx, extension.id, installKey);
  if (deployment === null) {
    throw new ExtensionsError(
      'no_deployment',
      `extension '${extension.extension_key}' has no deployment for install '${installKey}' — deploy a version first`,
    );
  }
  const manifest = await findManifestRow(db, ctx, deployment.manifest_id);
  if (manifest === null) {
    // The composite foreign key guarantees the manifest exists; a miss
    // means internal corruption — stay loud rather than silently wrong.
    throw new Error(
      `the current deployment of extension '${extension.extension_key}' references a manifest that does not exist (internal invariant violation)`,
    );
  }
  return { extension, deployment, manifest };
}

/** The grant gate of every runtime capability operation. */
function requireGrant(deployment: DeploymentRow, permission: ExtensionPermission): void {
  if (!(deployment.granted_permissions ?? []).includes(permission)) {
    throw new ExtensionsError(
      'permission_not_granted',
      `the current deployment of '${deployment.extension_key}' (version ${deployment.version}, install '${deployment.install_key}') does not grant '${permission}' — redeploy with the permission granted`,
    );
  }
}

/**
 * The deploy-time preconditions shared by deployment and rollback: the
 * manifest is VERIFIED and the runtime's host version is inside the
 * manifest's declared range (§17 "compatibility"). Pure of the caller.
 */
function assertManifestDeployable(extension: ExtensionRow, manifest: ManifestRow): void {
  const state = stateForOutcome(manifest.verification_outcome);
  if (state !== 'VERIFIED') {
    throw new ExtensionsError(
      'verification_required',
      `version ${manifest.version} of extension '${extension.extension_key}' is ${state} — only VERIFIED manifest versions may be deployed`,
    );
  }
  const min = parseSemver(manifest.host_compatibility.minVersion);
  const max =
    manifest.host_compatibility.maxVersion === null || manifest.host_compatibility.maxVersion === undefined
      ? null
      : parseSemver(manifest.host_compatibility.maxVersion);
  const verdict = checkHostRuntimeCompatibility(EXTENSION_RUNTIME_HOST_VERSION, {
    minVersion: min ?? { major: 0, minor: 0, patch: 0 },
    maxVersion: max,
  });
  if (!verdict.compatible) {
    throw new ExtensionsError(
      'incompatible_host',
      `the extension runtime ${EXTENSION_RUNTIME_HOST_VERSION} is outside version ${manifest.version} of '${extension.extension_key}''s declared host range [${manifest.host_compatibility.minVersion}, ${manifest.host_compatibility.maxVersion ?? '∞'}]`,
    );
  }
}

/** Bring one deployment/rollback to the §20 authority gate (the W025 discipline). */
async function gateRuntimeDeployment(
  ctx: TenantContext,
  payload: Record<string, unknown>,
  justification: string,
  idempotencyKey: string | null,
): Promise<ActionRequest> {
  try {
    return await authorizeAction(ctx, {
      actionKind: EXTENSION_ACTION_KIND,
      authorityLevel: EXTENSION_AUTHORITY_LEVEL,
      payload,
      justification,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof ActionsError) {
      throw new Error(
        `the authority gate rejected a pre-validated deployment authorization (internal invariant violation): ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Everything an apply transaction needs to append one deployment record. */
interface DeploymentPlan {
  extension: ExtensionRow;
  manifest: ManifestRow;
  installKey: string;
  operation: 'deploy' | 'rollback';
  grantedPermissions: ExtensionPermission[];
  replacesDeploymentId: string | null;
}

/**
 * Append one deployment record inside a transaction, re-checking the
 * apply-time preconditions (W025 discipline: the extension may have
 * been suspended and the manifest FAILED while the gate was pending).
 * A duplicate on the request-unique constraint is an idempotent
 * replay: the originally applied deployment stands.
 */
async function applyDeployment(
  ctx: TenantContext,
  request: ActionRequest,
  plan: DeploymentPlan,
): Promise<DeployExtensionVersionResult> {
  const appliedAt = now();
  return getDb().transaction(async (tx) => {
    const locked = await tx.query<{ lifecycle_state: ExtensionLifecycleState }>(
      `SELECT lifecycle_state FROM extensions WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, plan.extension.id],
    );
    const state = locked.rows[0]?.lifecycle_state;
    if (state !== 'ACTIVE') {
      throw new ExtensionsError(
        'extension_not_active',
        `extension '${plan.extension.extension_key}' moved to ${state ?? 'unknown state'} while the deployment was at the gate — deployable extensions must be ACTIVE at apply time`,
      );
    }
    // Re-read the manifest's DERIVED verification state at apply time.
    const fresh = await findManifestRow(tx, ctx, plan.manifest.id);
    if (fresh === null) {
      throw new Error(
        `deployment references a manifest that no longer exists (internal invariant violation)`,
      );
    }
    assertManifestDeployable(plan.extension, fresh);

    // Idempotent replay: a deployment already recorded for this gate
    // request stands — checked BEFORE the insert so the request-unique
    // constraint is the storage floor, not the control flow (a failed
    // statement would abort the transaction).
    const replayed = await findDeploymentByRequestId(tx, ctx, request.id);
    if (replayed !== null) {
      return {
        deployment: mapDeployment(replayed),
        applied: true,
        gate: { actionRequestId: request.id, status: 'approved' as const },
      };
    }

    const inserted = await tx.query<DeploymentRow>(
      `INSERT INTO extension_deployments (
         tenant_id, extension_id, extension_key, install_key, manifest_id, version,
         operation, replaces_deployment_id, granted_permissions, deployed_by, deployed_at, action_request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
       RETURNING *`,
      [
        ctx.tenantId,
        plan.extension.id,
        plan.extension.extension_key,
        plan.installKey,
        fresh.id,
        fresh.version,
        plan.operation,
        plan.replacesDeploymentId,
        JSON.stringify(plan.grantedPermissions),
        ctx.principalId,
        appliedAt,
        request.id,
      ],
    );
    return {
      deployment: mapDeployment(inserted.rows[0]!),
      applied: true,
      gate: { actionRequestId: request.id, status: 'approved' as const },
    };
  });
}

// ---------------------------------------------------------------------------
// Deployment and rollback
// ---------------------------------------------------------------------------

export async function deployExtensionVersion(
  ctx: TenantContext,
  input: DeployExtensionVersionInput,
): Promise<DeployExtensionVersionResult> {
  assertExtensionsTenantContext(ctx);
  const valid = validateDeployExtensionVersionInput(input);

  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  if (extension.lifecycle_state !== 'ACTIVE') {
    throw new ExtensionsError(
      'extension_not_active',
      `extension '${extension.extension_key}' is ${extension.lifecycle_state} — only ACTIVE extensions accept deployments`,
    );
  }

  const manifest =
    valid.manifestId !== null
      ? await findManifestRow(getDb(), ctx, valid.manifestId)
      : await findManifestRowByVersion(getDb(), ctx, extension.id, valid.version!);
  if (manifest === null || manifest.extension_id !== extension.id) {
    throw new ExtensionsError(
      'manifest_not_found',
      `no manifest ${valid.manifestId !== null ? `'${valid.manifestId}'` : `version ${valid.version}`} of extension '${extension.extension_key}' exists in this tenant`,
    );
  }
  assertManifestDeployable(extension, manifest);

  // The effective grant: the requested ceiling by default, or the
  // caller's narrowed subset (least privilege is a redeploy, never a
  // mutation of history; the storage trigger enforces the subset rule
  // even for writes bypassing the service).
  const granted =
    valid.grantedPermissions === null
      ? [...(manifest.requested_permissions ?? [])]
      : [...valid.grantedPermissions];
  const ceiling = new Set<string>(manifest.requested_permissions ?? []);
  for (const permission of granted) {
    if (!ceiling.has(permission)) {
      throw new ExtensionsError(
        'grant_exceeds_ceiling',
        `permission '${permission}' is not in version ${manifest.version} of '${extension.extension_key}''s requested permissions — grants are bounded by the manifest ceiling`,
      );
    }
  }

  const current = await findCurrentDeploymentRow(getDb(), ctx, extension.id, valid.installKey);
  const request = await gateRuntimeDeployment(
    ctx,
    {
      operation: 'deploy',
      extensionId: extension.id,
      extensionKey: extension.extension_key,
      installKey: valid.installKey,
      manifestId: manifest.id,
      version: manifest.version,
      fromVersion: current?.version ?? null,
      grantedPermissions: granted,
    },
    `deploy version ${manifest.version} of extension '${extension.extension_key}' to install '${valid.installKey}'`,
    valid.idempotencyKey,
  );

  if (request.status === 'rejected') {
    throw new ExtensionsError(
      'forbidden_by_policy',
      `the tenant's authority policy forbids deploying extension '${extension.extension_key}' (action request ${request.id})`,
    );
  }
  if (request.status === 'pending') {
    // The gate holds the deployment. Nothing is applied; the caller
    // re-invokes with the same idempotency key after the human decision.
    return {
      deployment: null,
      applied: false,
      gate: { actionRequestId: request.id, status: 'pending' },
    };
  }

  return applyDeployment(ctx, request, {
    extension,
    manifest,
    installKey: valid.installKey,
    operation: 'deploy',
    grantedPermissions: granted,
    replacesDeploymentId: current?.id ?? null,
  });
}

export async function rollbackExtensionDeployment(
  ctx: TenantContext,
  input: RollbackExtensionDeploymentInput,
): Promise<RollbackExtensionDeploymentResult> {
  assertExtensionsTenantContext(ctx);
  const valid = validateRollbackExtensionDeploymentInput(input);

  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  if (extension.lifecycle_state !== 'ACTIVE') {
    throw new ExtensionsError(
      'extension_not_active',
      `extension '${extension.extension_key}' is ${extension.lifecycle_state} — only ACTIVE extensions accept rollbacks`,
    );
  }

  const target = await findDeploymentRow(getDb(), ctx, valid.targetDeploymentId);
  if (target === null) {
    throw new ExtensionsError(
      'deployment_not_found',
      `no deployment '${valid.targetDeploymentId}' exists in this tenant`,
    );
  }
  if (target.extension_id !== extension.id || target.install_key !== valid.installKey) {
    throw new ExtensionsError(
      'invalid_rollback',
      `deployment '${valid.targetDeploymentId}' belongs to a different extension or install — rollback targets a recorded deployment of extension '${extension.extension_key}' install '${valid.installKey}'`,
    );
  }
  const current = await findCurrentDeploymentRow(getDb(), ctx, extension.id, valid.installKey);
  if (current === null || current.id === target.id) {
    throw new ExtensionsError(
      'invalid_rollback',
      `deployment '${valid.targetDeploymentId}' is the current deployment of install '${valid.installKey}' — rollback targets a superseded deployment`,
    );
  }

  const manifest = await findManifestRow(getDb(), ctx, target.manifest_id);
  if (manifest === null) {
    throw new Error(
      `the recorded deployment references a manifest that no longer exists (internal invariant violation)`,
    );
  }
  // Preconditions re-checked against TODAY's state: the target's
  // manifest may have FAILED verification (drift) since it ran, and the
  // runtime host version is whatever THIS runtime is now.
  assertManifestDeployable(extension, manifest);

  // A rollback re-activates the target's recorded grant — the grant of
  // the deployment being restored, never a fresh negotiation.
  const granted = [...(target.granted_permissions ?? [])];

  const request = await gateRuntimeDeployment(
    ctx,
    {
      operation: 'rollback',
      extensionId: extension.id,
      extensionKey: extension.extension_key,
      installKey: valid.installKey,
      manifestId: manifest.id,
      version: manifest.version,
      fromVersion: current.version,
      targetDeploymentId: target.id,
      grantedPermissions: granted,
    },
    `rollback install '${valid.installKey}' of extension '${extension.extension_key}' from version ${current.version} to the recorded version ${manifest.version}`,
    valid.idempotencyKey,
  );

  if (request.status === 'rejected') {
    throw new ExtensionsError(
      'forbidden_by_policy',
      `the tenant's authority policy forbids rolling back extension '${extension.extension_key}' (action request ${request.id})`,
    );
  }
  if (request.status === 'pending') {
    return {
      deployment: null,
      applied: false,
      gate: { actionRequestId: request.id, status: 'pending' },
    };
  }

  return applyDeployment(ctx, request, {
    extension,
    manifest,
    installKey: valid.installKey,
    operation: 'rollback',
    grantedPermissions: granted,
    replacesDeploymentId: current.id,
  });
}

export async function getCurrentDeployment(
  ctx: TenantContext,
  query: DeploymentQuery,
): Promise<ExtensionDeployment | null> {
  assertExtensionsTenantContext(ctx);
  const valid = validateDeploymentQuery(query);
  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  const current = await findCurrentDeploymentRow(getDb(), ctx, extension.id, valid.installKey);
  return current === null ? null : mapDeployment(current);
}

export async function listExtensionDeployments(
  ctx: TenantContext,
  query: ListExtensionDeploymentsQuery,
): Promise<ExtensionDeployment[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateListExtensionDeploymentsQuery(query);
  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<DeploymentRow>(
    `SELECT * FROM extension_deployments
       WHERE tenant_id = $1 AND extension_id = $2 AND install_key = $3
       ORDER BY seq ASC
       LIMIT $4`,
    [ctx.tenantId, extension.id, valid.installKey, valid.limit],
  );
  return rows.rows.map(mapDeployment);
}

// ---------------------------------------------------------------------------
// Persistent scoped state
// ---------------------------------------------------------------------------

/**
 * The state namespace of the current deployment: 'tenant' scope folds
 * to the shared (install_key NULL) namespace and rejects a supplied
 * install key (the scope ignores installs by design — loud, not
 * silent); 'install' scope folds to the given install ('default' when
 * none was supplied).
 */
function stateNamespaceKey(
  extension: ExtensionRow,
  stateScope: ExtensionCapabilities['stateScope'],
  installKeyGiven: string | null,
): string | null {
  if (stateScope === 'none') {
    throw new ExtensionsError(
      'state_not_declared',
      `version-declared capabilities of extension '${extension.extension_key}' include no persistent state (stateScope is none)`,
    );
  }
  if (stateScope === 'tenant') {
    if (installKeyGiven !== null) {
      throw new ExtensionsError(
        'scope_mismatch',
        `the current deployment of '${extension.extension_key}' declares tenant-scoped state — install-scoped keys do not apply`,
      );
    }
    return null;
  }
  return installKeyGiven ?? 'default';
}

export async function readExtensionState(
  ctx: TenantContext,
  query: ReadExtensionStateQuery,
): Promise<ExtensionStateEntry | null> {
  assertExtensionsTenantContext(ctx);
  const valid = validateReadExtensionStateQuery(query);
  const target = await resolveRuntimeTarget(getDb(), ctx, valid);
  // Capability shape first (does the extension have state at all, and in
  // which namespace?), then the grant — the most informative refusal
  // wins: an extension that never asked for state is told that, not
  // that its grant is narrow.
  const namespace = stateNamespaceKey(
    target.extension,
    target.manifest.capabilities.stateScope,
    valid.installKeyGiven,
  );
  requireGrant(target.deployment, 'state:read');
  const rows = await getDb().query<StateRow>(
    `SELECT * FROM extension_state
       WHERE tenant_id = $1 AND extension_id = $2 AND install_key IS NOT DISTINCT FROM $3 AND state_key = $4`,
    [ctx.tenantId, target.extension.id, namespace, valid.key],
  );
  const row = rows.rows[0];
  return row === undefined ? null : mapStateEntry(row);
}

export async function writeExtensionState(
  ctx: TenantContext,
  input: WriteExtensionStateInput,
): Promise<ExtensionStateEntry> {
  assertExtensionsTenantContext(ctx);
  const valid = validateWriteExtensionStateInput(input);
  const db = getDb();
  const target = await resolveRuntimeTarget(db, ctx, valid);
  // Capability shape first, then the grant (see readExtensionState).
  const namespace = stateNamespaceKey(
    target.extension,
    target.manifest.capabilities.stateScope,
    valid.installKeyGiven,
  );
  requireGrant(target.deployment, 'state:write');
  const quota = target.manifest.quotas.maxStateBytes;

  const timestamp = now();
  return db.transaction(async (tx) => {
    // Quota accounting: the namespace's current bytes, minus what the
    // key being written already occupies, plus the incoming value.
    const existing = await tx.query<StateRow>(
      `SELECT * FROM extension_state
         WHERE tenant_id = $1 AND extension_id = $2 AND install_key IS NOT DISTINCT FROM $3 AND state_key = $4`,
      [ctx.tenantId, target.extension.id, namespace, valid.key],
    );
    const existingRow = existing.rows[0] ?? null;
    const usage = await tx.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(bytes), 0) AS total FROM extension_state
         WHERE tenant_id = $1 AND extension_id = $2 AND install_key IS NOT DISTINCT FROM $3`,
      [ctx.tenantId, target.extension.id, namespace],
    );
    const currentBytes = Number(usage.rows[0]?.total ?? 0);
    const projected = currentBytes - (existingRow?.bytes ?? 0) + valid.valueBytes;
    if (projected > quota) {
      throw new ExtensionsError(
        'state_quota_exceeded',
        `writing state key '${valid.key}' would put the namespace at ${projected} bytes, over the declared maxStateBytes quota of ${quota} (currently ${currentBytes})`,
      );
    }

    const upserted = await tx.query<StateRow>(
      `INSERT INTO extension_state (
         tenant_id, extension_id, install_key, state_key, value, bytes, revision, updated_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1, $7, $8, $8)
       ON CONFLICT (tenant_id, extension_id, COALESCE(install_key, ''), state_key)
       DO UPDATE SET
         value = EXCLUDED.value,
         bytes = EXCLUDED.bytes,
         revision = extension_state.revision + 1,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        ctx.tenantId,
        target.extension.id,
        namespace,
        valid.key,
        JSON.stringify(valid.value),
        valid.valueBytes,
        ctx.principalId,
        timestamp,
      ],
    );
    return mapStateEntry(upserted.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// Declarative UI (host-rendered)
// ---------------------------------------------------------------------------

export async function publishExtensionUi(
  ctx: TenantContext,
  input: PublishExtensionUiInput,
): Promise<ExtensionUiDeclaration> {
  assertExtensionsTenantContext(ctx);
  const valid = validatePublishExtensionUiInput(input);
  const target = await resolveRuntimeTarget(getDb(), ctx, valid);
  // Capability first (is the surface declared?), then the grant.
  if (!(target.manifest.capabilities.uiSurfaces ?? []).includes(valid.surface)) {
    throw new ExtensionsError(
      'surface_not_declared',
      `version ${target.manifest.version} of '${target.extension.extension_key}' declares no '${valid.surface}' UI surface`,
    );
  }
  requireGrant(target.deployment, 'ui:render');
  const timestamp = now();
  const upserted = await getDb().query<UiRow>(
    `INSERT INTO extension_ui (
       tenant_id, extension_id, extension_key, surface, document, updated_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)
     ON CONFLICT (tenant_id, extension_id, surface) DO UPDATE SET
       document = EXCLUDED.document,
       updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      ctx.tenantId,
      target.extension.id,
      target.extension.extension_key,
      valid.surface,
      JSON.stringify(valid.document),
      ctx.principalId,
      timestamp,
    ],
  );
  return mapUiDeclaration(upserted.rows[0]!);
}

export async function getExtensionUi(
  ctx: TenantContext,
  query: GetExtensionUiQuery,
): Promise<ExtensionUiDeclaration | null> {
  assertExtensionsTenantContext(ctx);
  const valid = validateGetExtensionUiQuery(query);
  const target = await resolveRuntimeTarget(getDb(), ctx, valid);
  // Capability first, then the grant: a redeploy without ui:render must
  // make the surface stop rendering — but an undeclared surface is
  // reported as the capability fact it is.
  if (!(target.manifest.capabilities.uiSurfaces ?? []).includes(valid.surface)) {
    throw new ExtensionsError(
      'surface_not_declared',
      `version ${target.manifest.version} of '${target.extension.extension_key}' declares no '${valid.surface}' UI surface`,
    );
  }
  requireGrant(target.deployment, 'ui:render');
  const rows = await getDb().query<UiRow>(
    `SELECT * FROM extension_ui WHERE tenant_id = $1 AND extension_id = $2 AND surface = $3`,
    [ctx.tenantId, target.extension.id, valid.surface],
  );
  const row = rows.rows[0];
  return row === undefined ? null : mapUiDeclaration(row);
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export async function triggerExtensionSchedule(
  ctx: TenantContext,
  input: TriggerExtensionScheduleInput,
): Promise<ExtensionScheduleRun> {
  assertExtensionsTenantContext(ctx);
  const valid = validateTriggerExtensionScheduleInput(input);
  const db = getDb();
  const target = await resolveRuntimeTarget(db, ctx, valid);
  // Capability first (is the schedule declared?), then the grant.
  const schedule = (target.manifest.capabilities.schedules ?? []).find(
    (declared) => declared.name === valid.scheduleName,
  );
  if (schedule === undefined) {
    throw new ExtensionsError(
      'schedule_not_declared',
      `version ${target.manifest.version} of '${target.extension.extension_key}' declares no schedule '${valid.scheduleName}'`,
    );
  }
  requireGrant(target.deployment, 'schedule:run');

  const timestamp = now();
  return db.transaction(async (tx) => {
    // Daily quota per (tenant, extension, install, UTC day).
    const counted = await tx.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM extension_schedule_runs
         WHERE tenant_id = $1 AND extension_id = $2 AND install_key = $3 AND invoked_at >= $4`,
      [ctx.tenantId, target.extension.id, valid.installKey, utcDayStart(timestamp)],
    );
    const used = Number(counted.rows[0]?.count ?? 0);
    if (used >= target.manifest.quotas.maxScheduleInvocationsPerDay) {
      throw new ExtensionsError(
        'schedule_quota_exceeded',
        `schedule invocations for install '${valid.installKey}' of '${target.extension.extension_key}' have reached the declared maxScheduleInvocationsPerDay quota of ${target.manifest.quotas.maxScheduleInvocationsPerDay} today (${used} used)`,
      );
    }
    const inserted = await tx.query<ScheduleRunRow>(
      `INSERT INTO extension_schedule_runs (
         tenant_id, extension_id, extension_key, install_key, schedule_name, cron, invoked_by, invoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        ctx.tenantId,
        target.extension.id,
        target.extension.extension_key,
        valid.installKey,
        schedule.name,
        schedule.cron,
        ctx.principalId,
        timestamp,
      ],
    );
    return mapScheduleRun(inserted.rows[0]!);
  });
}

export async function listExtensionScheduleRuns(
  ctx: TenantContext,
  query: ListExtensionScheduleRunsQuery,
): Promise<ExtensionScheduleRun[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateActivityListQuery(query);
  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<ScheduleRunRow>(
    `SELECT * FROM extension_schedule_runs
       WHERE tenant_id = $1 AND extension_id = $2 AND install_key = $3
       ORDER BY invoked_at ASC, id ASC
       LIMIT $4`,
    [ctx.tenantId, extension.id, valid.installKey, valid.limit],
  );
  return rows.rows.map(mapScheduleRun);
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

export async function dispatchExtensionEvent(
  ctx: TenantContext,
  input: DispatchExtensionEventInput,
): Promise<DispatchExtensionEventResult> {
  assertExtensionsTenantContext(ctx);
  const valid = validateDispatchExtensionEventInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    // Every install of every ACTIVE extension with a current
    // deployment — DISTINCT ON folds to the latest seq per
    // (extension, install). Suspended extensions are disabled: their
    // subscriptions are inert while suspended (§17 disablement), and
    // the dispatch result says so by simply not counting them.
    const currents = await tx.query<
      DeploymentRow & { manifest_capabilities: ExtensionCapabilities | null }
    >(
      `SELECT DISTINCT ON (d.extension_id, d.install_key) d.*, m.capabilities AS manifest_capabilities
         FROM extension_deployments d
         JOIN extension_manifests m ON m.tenant_id = d.tenant_id AND m.id = d.manifest_id
         JOIN extensions e ON e.tenant_id = d.tenant_id AND e.id = d.extension_id AND e.lifecycle_state = 'ACTIVE'
         WHERE d.tenant_id = $1
         ORDER BY d.extension_id, d.install_key, d.seq DESC`,
      [ctx.tenantId],
    );

    const deliveries: ExtensionEventDelivery[] = [];
    for (const current of currents.rows) {
      const capabilities = current.manifest_capabilities;
      if (capabilities === null || typeof capabilities !== 'object') continue;
      if (!(capabilities.eventSubscriptions ?? []).includes(valid.topic)) continue;
      const outcome = (current.granted_permissions ?? []).includes('events:subscribe')
        ? ('delivered' as const)
        : ('not_granted' as const);
      const inserted = await tx.query<DeliveryRow>(
        `INSERT INTO extension_event_deliveries (
           tenant_id, extension_id, extension_key, install_key, topic, payload, outcome, delivered_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING *`,
        [
          ctx.tenantId,
          current.extension_id,
          current.extension_key,
          current.install_key,
          valid.topic,
          JSON.stringify(valid.payload),
          outcome,
          timestamp,
        ],
      );
      deliveries.push(mapDelivery(inserted.rows[0]!));
    }
    return {
      topic: valid.topic,
      delivered: deliveries.filter((delivery) => delivery.outcome === 'delivered').length,
      notGranted: deliveries.filter((delivery) => delivery.outcome === 'not_granted').length,
      deliveries,
    };
  });
}

export async function listExtensionEventDeliveries(
  ctx: TenantContext,
  query: ListExtensionEventDeliveriesQuery,
): Promise<ExtensionEventDelivery[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateActivityListQuery(query);
  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<DeliveryRow>(
    `SELECT * FROM extension_event_deliveries
       WHERE tenant_id = $1 AND extension_id = $2 AND install_key = $3
       ORDER BY delivered_at ASC, id ASC
       LIMIT $4`,
    [ctx.tenantId, extension.id, valid.installKey, valid.limit],
  );
  return rows.rows.map(mapDelivery);
}

// ---------------------------------------------------------------------------
// Scoped external participation
// ---------------------------------------------------------------------------

export async function executeExtensionExternalCall(
  ctx: TenantContext,
  input: ExecuteExtensionExternalCallInput,
): Promise<ExtensionExternalCall> {
  assertExtensionsTenantContext(ctx);
  const valid = validateExecuteExtensionExternalCallInput(input);
  const db = getDb();
  const target = await resolveRuntimeTarget(db, ctx, valid);
  // The sandbox boundary first: EXACT origin equality against the
  // declared participants of the deployed manifest — never prefix
  // matching — then the grant.
  const participant = participantForOrigin(target.manifest.capabilities, valid.origin);
  if (participant === null) {
    throw new ExtensionsError(
      'origin_not_declared',
      `origin '${valid.origin}' is not a declared external participant of version ${target.manifest.version} of '${target.extension.extension_key}'`,
    );
  }
  requireGrant(target.deployment, 'external:participate');

  const timestamp = now();
  return db.transaction(async (tx) => {
    // Daily quota per (tenant, extension, install, UTC day).
    const counted = await tx.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM extension_external_calls
         WHERE tenant_id = $1 AND extension_id = $2 AND install_key = $3 AND requested_at >= $4`,
      [ctx.tenantId, target.extension.id, valid.installKey, utcDayStart(timestamp)],
    );
    const used = Number(counted.rows[0]?.count ?? 0);
    if (used >= target.manifest.quotas.maxExternalCallsPerDay) {
      throw new ExtensionsError(
        'external_quota_exceeded',
        `external calls for install '${valid.installKey}' of '${target.extension.extension_key}' have reached the declared maxExternalCallsPerDay quota of ${target.manifest.quotas.maxExternalCallsPerDay} today (${used} used)`,
      );
    }

    // Execute through the injectable egress port. The outcome vocabulary
    // is total: 2xx → succeeded, any other answer → http_error, a port
    // throw → failed. Headers pass through; they are never recorded.
    let outcome: 'succeeded' | 'http_error' | 'failed';
    let responseStatus: number | null;
    let detail: string | null;
    try {
      const response = await extensionHttpPort()({
        url: `${valid.origin}${valid.path}`,
        method: valid.method,
        headers: valid.headers,
        body: valid.bodyText,
      });
      responseStatus = response.status;
      if (response.status >= 200 && response.status <= 299) {
        outcome = 'succeeded';
        detail = null;
      } else {
        outcome = 'http_error';
        detail = boundedDetail(`participant answered HTTP ${response.status}`);
      }
    } catch (error) {
      outcome = 'failed';
      responseStatus = null;
      detail = boundedDetail(
        `egress failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const inserted = await tx.query<ExternalCallRow>(
      `INSERT INTO extension_external_calls (
         tenant_id, extension_id, extension_key, install_key, origin, method, path,
         request_body_bytes, outcome, response_status, detail, requested_by, requested_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        ctx.tenantId,
        target.extension.id,
        target.extension.extension_key,
        valid.installKey,
        valid.origin,
        valid.method,
        valid.path,
        valid.bodyBytes,
        outcome,
        responseStatus,
        detail,
        ctx.principalId,
        timestamp,
      ],
    );
    return mapExternalCall(inserted.rows[0]!);
  });
}

export async function listExtensionExternalCalls(
  ctx: TenantContext,
  query: ListExtensionExternalCallsQuery,
): Promise<ExtensionExternalCall[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateActivityListQuery(query);
  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<ExternalCallRow>(
    `SELECT * FROM extension_external_calls
       WHERE tenant_id = $1 AND extension_id = $2 AND install_key = $3
       ORDER BY requested_at ASC, id ASC
       LIMIT $4`,
    [ctx.tenantId, extension.id, valid.installKey, valid.limit],
  );
  return rows.rows.map(mapExternalCall);
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export async function emitExtensionTelemetry(
  ctx: TenantContext,
  input: EmitExtensionTelemetryInput,
): Promise<ExtensionTelemetryEvent> {
  assertExtensionsTenantContext(ctx);
  const valid = validateEmitExtensionTelemetryInput(input);
  const target = await resolveRuntimeTarget(getDb(), ctx, valid);
  // Capability first, then the grant.
  if (target.manifest.capabilities.telemetry !== true) {
    throw new ExtensionsError(
      'telemetry_not_declared',
      `version ${target.manifest.version} of '${target.extension.extension_key}' declares no telemetry capability`,
    );
  }
  requireGrant(target.deployment, 'telemetry:emit');
  const timestamp = now();
  const inserted = await getDb().query<TelemetryRow>(
    `INSERT INTO extension_telemetry_events (
       tenant_id, extension_id, extension_key, install_key, name, payload, emitted_by, emitted_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING *`,
    [
      ctx.tenantId,
      target.extension.id,
      target.extension.extension_key,
      valid.installKey,
      valid.name,
      JSON.stringify(valid.payload),
      ctx.principalId,
      timestamp,
    ],
  );
  return mapTelemetry(inserted.rows[0]!);
}

export async function listExtensionTelemetryEvents(
  ctx: TenantContext,
  query: ListExtensionTelemetryEventsQuery,
): Promise<ExtensionTelemetryEvent[]> {
  assertExtensionsTenantContext(ctx);
  const valid = validateActivityListQuery(query);
  const extension = await findExtensionRow(getDb(), ctx, valid);
  if (extension === null) {
    throw new ExtensionsError(
      'extension_not_found',
      `no extension '${valid.extensionId ?? valid.extensionKey}' exists in this tenant`,
    );
  }
  const rows = await getDb().query<TelemetryRow>(
    `SELECT * FROM extension_telemetry_events
       WHERE tenant_id = $1 AND extension_id = $2 AND install_key = $3
       ORDER BY emitted_at ASC, id ASC
       LIMIT $4`,
    [ctx.tenantId, extension.id, valid.installKey, valid.limit],
  );
  return rows.rows.map(mapTelemetry);
}
