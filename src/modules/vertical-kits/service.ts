// Implementation of the vertical-kits module's public operations (see
// contract.ts). W092 — Vertical Extension Starter Kits.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by `newId()` where
// the id is needed before the insert; timestamps come from the
// injectable clock and are never caller-supplied; every statement is
// scoped by the explicit TenantContext (ADR-0001) — cross-tenant access
// is indistinguishable from a missing record (`installation_not_found` /
// `kit_version_not_found`), no existence leak.
//
// W092 acceptance — "each pack is installable, permission-scoped,
// versioned, auditable and removable; core modules remain
// industry-independent" — is carried by these deliberate properties,
// all tested:
//
//   1. INSTALLABLE THROUGH A GOVERNED LIFECYCLE: installKit freezes the
//      verified version's required-capability snapshot and routes the
//      tenant's grant review through the actions module's authority gate
//      (W009, kind 'vertical-kit-deployment' × EXECUTE). The built-in
//      default matrix waits for a human decision; tenant policy may
//      auto-allow or forbid. The human decision (decideKitReview)
//      delegates to decideApproval — the approve claim, separation of
//      duties and first-decision-wins are enforced THERE.
//
//   2. PERMISSION-SCOPED, NOT FORKED: the kit grant model follows the
//      capability-grants pattern (W083), kit-scoped — approval mints
//      EXACTLY the declared capabilities as active grants; rejection
//      mints nothing (denial stops the kit); every invocation consults
//      the gate and every verdict (allowed or denied) lands in the
//      append-only invocation ledger with its deterministic,
//      task-grounded denial reason; removal revokes every grant (no
//      orphaned authority).
//
//   3. VERSIONED AND SIGNED: kit versions are immutable, strictly
//      increasing release semvers per kit key (numeric order), each
//      carrying the sha-256 digest of the canonical JSON of its frozen
//      manifest; verification re-derives the digest over the STORED
//      bytes, so a row edited outside the service fails loudly.
//
//   4. AUDITABLE: every install/review/activation/suspension/resume/
//      removal and every minted/revoked grant is an append-only event;
//      the events, invocations and verification runs are append-only at
//      the storage level (triggers refuse UPDATE/DELETE/TRUNCATE).
//
//   5. THE EDGE SEAM IS HONEST: the deep-integration execution path
//      calls the VerticalKitEdge port and NOTHING is wired by default —
//      inspect/execute fail explicitly with `edge_unavailable`
//      (DEFERRED-ON-W088: the Edge Connector work item is the future
//      implementor; it will compose onto the W084 deep-action pipeline
//      through brokered connections and progressive grants). The module
//      never fakes success, never stubs Edge internals and never guesses
//      W088's API. A wired edge's results are canonicalized and
//      validated — a provider object cannot cross the kit runtime
//      (lock 16); the only provider-minted values persisted are OPAQUE
//      strings (receipt ids, the edge's own wiring identity).
//
//   6. CORE STAYS INDUSTRY-INDEPENDENT: every vertical word lives in
//      kit manifests (data), never in this module's code or schema —
//      the two shipped starter kits are the only place vertical
//      vocabulary exists, and they are content, not schema.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  ActionsError,
  authorizeAction,
  decideApproval,
  getActionRequest,
  type ActionRequest,
} from '@/modules/actions/contract';
import { compareSemver, parseSemver, type SemverParts } from '@/modules/extensions/contract';
import { VerticalKitsError } from './errors';
import {
  canTransitionInstallation,
  targetInstallationState,
  type KitInstallationLifecycleState,
} from './lifecycle';
import {
  buildInactiveInstallationReason,
  buildMissingGrantReason,
  clampDetail,
} from './reason';
import { verifyKitManifest } from './verification';
import {
  assertVerticalKitsTenantContext,
  validateDecideKitReviewInput,
  validateExecuteKitIntegrationInput,
  validateGetInstallationQuery,
  validateGetKitVersionQuery,
  validateInstallKitInput,
  validateInspectKitIntegrationInput,
  validateInstallationTargetInput,
  validateInvokeKitCapabilityInput,
  validateListInstallationRecordsQuery,
  validateListKitInstallationsQuery,
  validateListKitVersionsQuery,
  validateRegisterKitVersionInput,
  validateSuspendedRemovalInput,
} from './validation';
import type {
  DecideKitReviewInput,
  ExecuteKitIntegrationInput,
  ExecuteKitIntegrationResult,
  GetInstallationQuery,
  GetKitVersionQuery,
  InstallKitInput,
  InspectKitIntegrationInput,
  InspectKitIntegrationResult,
  InvokeKitCapabilityInput,
  KitCapabilityDeclaration,
  KitCapabilityGrant,
  KitCapabilityInvocation,
  KitComponentStatus,
  KitEdgeAction,
  KitEdgeIntegrationDeclaration,
  KitInstallation,
  KitInstallationDetail,
  KitInstallationEvent,
  KitIntegrationReadiness,
  KitInvocationBasis,
  KitStatusReport,
  KitTaskContext,
  ListInstallationRecordsQuery,
  ListKitInstallationsQuery,
  ListKitVersionsQuery,
  RegisterKitVersionInput,
  RegisterKitVersionResult,
  SuspendedRemovalInput,
  VerticalKitEdge,
  VerticalKitEdgeState,
  VerticalKitManifest,
  VerticalKitVerification,
  VerticalKitVersion,
  VerticalKitVersionSummary,
  VerticalKitVersionWithVerification,
} from './types';
import {
  MAX_RECEIPT_DETAIL_LENGTH,
  MAX_RECEIPT_ID_LENGTH,
  MAX_VALUE_BYTES,
} from './validation';

// ---------------------------------------------------------------------------
// Module-owned constants
// ---------------------------------------------------------------------------

/** The authority claim this module's administrative surface checks. */
export const VERTICAL_KITS_AUTHORITY_ADMINISTER = 'vertical-kits:administer';

/** The canonical W009 action kind of a kit install grant review. */
export const VERTICAL_KIT_ACTION_KIND = 'vertical-kit-deployment';

/** The human-readable prefix of the DEFERRED-ON-W088 refusal. */
const EDGE_UNAVAILABLE_MESSAGE =
  'no system-of-record edge is wired — the kit runtime refuses to fake success; ' +
  'the deep-integration execution path is DEFERRED-ON-W088 (the Edge Connector work item will implement the VerticalKitEdge port)';

// ---------------------------------------------------------------------------
// The edge port wiring (infrastructure, not domain state)
// ---------------------------------------------------------------------------

let wiredEdge: VerticalKitEdge | null = null;

/** Wires (or clears) the system-of-record edge — the DEFERRED-ON-W088 seam. */
export function setVerticalKitEdge(edge: VerticalKitEdge | null): void {
  wiredEdge = edge;
}

/** The currently wired edge (null = none; every deep path refuses then). */
export function getVerticalKitEdge(): VerticalKitEdge | null {
  return wiredEdge;
}

function requireEdge(): VerticalKitEdge {
  if (wiredEdge === null) {
    throw new VerticalKitsError('edge_unavailable', EDGE_UNAVAILABLE_MESSAGE);
  }
  return wiredEdge;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface VersionRow extends DbRow {
  id: string;
  tenant_id: string;
  kit_key: string;
  version: string;
  version_major: number;
  version_minor: number;
  version_patch: number;
  kit_schema_version: number;
  vertical_key: string;
  display_name: string;
  description: string;
  manifest: VerticalKitManifest;
  manifest_digest: string;
  capability_count: number;
  extension_count: number;
  agent_count: number;
  integration_count: number;
  created_by: string;
  created_at: Date;
}

interface VerificationRow extends DbRow {
  id: string;
  tenant_id: string;
  kit_version_id: string;
  position: number;
  outcome: 'verified' | 'failed';
  checks: { check: string; passed: boolean; detail: string | null }[];
  summary: string;
  verifier: string;
  ran_at: Date;
}

interface InstallationRow extends DbRow {
  id: string;
  tenant_id: string;
  kit_key: string;
  kit_version: string;
  kit_version_id: string;
  status: string;
  required_capabilities: KitCapabilityDeclaration[];
  action_request_id: string;
  installed_by: string;
  installed_at: Date;
  reviewed_at: Date | null;
  activated_at: Date | null;
  suspended_at: Date | null;
  removed_at: Date | null;
  removal_reason: string | null;
}

interface GrantRow extends DbRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  capability_key: string;
  label: string;
  data_categories: string[];
  status: 'active' | 'revoked';
  granted_by: string;
  granted_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_reason: string | null;
}

interface InvocationRow extends DbRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  capability_key: string;
  outcome: 'allowed' | 'denied';
  basis: KitInvocationBasis;
  denial_reason: string | null;
  task_context: KitTaskContext;
  invoked_by: string;
  invoked_at: Date;
}

interface EdgeActionRow extends DbRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  integration_key: string;
  capability_key: string;
  invocation_id: string;
  receipt_status: 'accepted' | 'rejected' | 'failed';
  receipt_id: string | null;
  receipt_detail: string | null;
  edge_id: string;
  executed_by: string;
  executed_at: Date;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  installation_id: string;
  position: number;
  event: string;
  detail: string | null;
  recorded_by: string;
  recorded_at: Date;
}

// ---------------------------------------------------------------------------
// Row mappers (snake_case storage → the public surface)
// ---------------------------------------------------------------------------

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function mapVersion(row: VersionRow): VerticalKitVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kitKey: row.kit_key,
    version: row.version,
    kitSchemaVersion: row.kit_schema_version,
    verticalKey: row.vertical_key,
    displayName: row.display_name,
    description: row.description,
    manifest: row.manifest,
    manifestDigest: row.manifest_digest,
    registeredBy: row.created_by,
    registeredAt: row.created_at.toISOString(),
  };
}

function mapVerification(row: VerificationRow): VerticalKitVerification {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kitVersionId: row.kit_version_id,
    outcome: row.outcome,
    checks: row.checks,
    summary: row.summary,
    verifier: row.verifier,
    ranAt: row.ran_at.toISOString(),
  };
}

function mapInstallation(row: InstallationRow): KitInstallation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kitKey: row.kit_key,
    kitVersion: row.kit_version,
    kitVersionId: row.kit_version_id,
    status: row.status as KitInstallation['status'],
    actionRequestId: row.action_request_id,
    installedBy: row.installed_by,
    installedAt: row.installed_at.toISOString(),
    reviewedAt: iso(row.reviewed_at),
    activatedAt: iso(row.activated_at),
    suspendedAt: iso(row.suspended_at),
    removedAt: iso(row.removed_at),
    removalReason: row.removal_reason,
  };
}

function mapGrant(row: GrantRow): KitCapabilityGrant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    capabilityKey: row.capability_key,
    label: row.label,
    dataCategories: row.data_categories,
    status: row.status,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at.toISOString(),
    revokedAt: iso(row.revoked_at),
    revokedBy: row.revoked_by,
    revocationReason: row.revocation_reason,
  };
}

function mapInvocation(row: InvocationRow): KitCapabilityInvocation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    capabilityKey: row.capability_key,
    outcome: row.outcome,
    basis: row.basis,
    denialReason: row.denial_reason,
    taskContext: row.task_context,
    invokedBy: row.invoked_by,
    invokedAt: row.invoked_at.toISOString(),
  };
}

function mapEdgeAction(row: EdgeActionRow): KitEdgeAction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    integrationKey: row.integration_key,
    capabilityKey: row.capability_key,
    invocationId: row.invocation_id,
    receiptStatus: row.receipt_status,
    receiptId: row.receipt_id,
    receiptDetail: row.receipt_detail,
    edgeId: row.edge_id,
    executedBy: row.executed_by,
    executedAt: row.executed_at.toISOString(),
  };
}

function mapEvent(row: EventRow): KitInstallationEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    installationId: row.installation_id,
    position: row.position,
    event: row.event,
    detail: row.detail,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function versionPartsOf(row: VersionRow): SemverParts {
  return {
    major: row.version_major,
    minor: row.version_minor,
    patch: row.version_patch,
  };
}

// ---------------------------------------------------------------------------
// Authority claim gate
// ---------------------------------------------------------------------------

function requireAdminister(ctx: TenantContext, operation: string): void {
  if (!ctx.authority.includes(VERTICAL_KITS_AUTHORITY_ADMINISTER)) {
    throw new VerticalKitsError(
      'forbidden',
      `${operation} requires the '${VERTICAL_KITS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared finds (tenant-scoped; cross-tenant = not found)
// ---------------------------------------------------------------------------

async function findVersionRow(
  db: Queryable,
  ctx: TenantContext,
  kitVersionId: string,
): Promise<VersionRow | null> {
  const result = await db.query<VersionRow>(
    `SELECT * FROM vertical_kit_versions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, kitVersionId],
  );
  return result.rows[0] ?? null;
}

async function findVersionRowByKey(
  db: Queryable,
  ctx: TenantContext,
  kitKey: string,
  version: string,
): Promise<VersionRow | null> {
  const result = await db.query<VersionRow>(
    `SELECT * FROM vertical_kit_versions WHERE tenant_id = $1 AND kit_key = $2 AND version = $3`,
    [ctx.tenantId, kitKey, version],
  );
  return result.rows[0] ?? null;
}

async function findLatestVersionRow(
  db: Queryable,
  ctx: TenantContext,
  kitKey: string,
): Promise<VersionRow | null> {
  const result = await db.query<VersionRow>(
    `SELECT * FROM vertical_kit_versions
       WHERE tenant_id = $1 AND kit_key = $2
       ORDER BY version_major DESC, version_minor DESC, version_patch DESC, created_at DESC
       LIMIT 1`,
    [ctx.tenantId, kitKey],
  );
  return result.rows[0] ?? null;
}

async function findInstallationRow(
  db: Queryable,
  ctx: TenantContext,
  installationId: string,
): Promise<InstallationRow | null> {
  const result = await db.query<InstallationRow>(
    `SELECT * FROM vertical_kit_installations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, installationId],
  );
  return result.rows[0] ?? null;
}

async function requireInstallationRow(
  db: Queryable,
  ctx: TenantContext,
  installationId: string,
): Promise<InstallationRow> {
  const row = await findInstallationRow(db, ctx, installationId);
  if (row === null) {
    throw new VerticalKitsError(
      'installation_not_found',
      `no kit installation '${installationId}' exists in this tenant`,
    );
  }
  return row;
}

async function findLatestVerificationRow(
  db: Queryable,
  ctx: TenantContext,
  kitVersionId: string,
): Promise<VerificationRow | null> {
  const result = await db.query<VerificationRow>(
    `SELECT * FROM vertical_kit_verifications
       WHERE tenant_id = $1 AND kit_version_id = $2
       ORDER BY position DESC
       LIMIT 1`,
    [ctx.tenantId, kitVersionId],
  );
  return result.rows[0] ?? null;
}

async function verificationStateOf(
  db: Queryable,
  ctx: TenantContext,
  kitVersionId: string,
): Promise<'unverified' | 'verified' | 'failed'> {
  const latest = await findLatestVerificationRow(db, ctx, kitVersionId);
  if (latest === null) return 'unverified';
  return latest.outcome;
}

async function appendEvent(
  db: Queryable,
  ctx: TenantContext,
  installationId: string,
  event: string,
  detail: string | null,
): Promise<void> {
  const positionResult = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next
       FROM vertical_kit_events
       WHERE tenant_id = $1 AND installation_id = $2`,
    [ctx.tenantId, installationId],
  );
  await db.query(
    `INSERT INTO vertical_kit_events
       (id, tenant_id, installation_id, position, event, detail, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newId(),
      ctx.tenantId,
      installationId,
      positionResult.rows[0]?.next ?? 1,
      event,
      detail === null ? null : clampDetail(detail, 500),
      ctx.principalId,
      now(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Registry — registerKitVersion / runKitVerification / reads
// ---------------------------------------------------------------------------

export async function registerKitVersion(
  ctx: TenantContext,
  input: RegisterKitVersionInput,
): Promise<RegisterKitVersionResult> {
  assertVerticalKitsTenantContext(ctx);
  requireAdminister(ctx, 'registering a kit version');
  const valid = validateRegisterKitVersionInput(input);
  const parts = parseSemver(valid.manifest.version)!;
  const manifest = valid.manifest;
  const at = now();

  const db = getDb();
  const id = newId();

  await db.transaction(async (tx) => {
    // Strictly increasing versions per kit key (numeric semver order —
    // the parsed columns, never text order; the extensions module's
    // manifest discipline).
    const latest = await findLatestVersionRow(tx, ctx, manifest.kitKey);
    if (latest !== null && compareSemver(parts, versionPartsOf(latest)) <= 0) {
      throw new VerticalKitsError(
        'version_not_monotonic',
        `version ${manifest.version} does not come after the latest registered version ` +
          `${latest.version} of kit '${manifest.kitKey}' — versions must strictly increase`,
      );
    }
    await tx.query(
      `INSERT INTO vertical_kit_versions (
         id, tenant_id, kit_key, version,
         version_major, version_minor, version_patch,
         kit_schema_version, vertical_key, display_name, description,
         manifest, manifest_digest,
         capability_count, extension_count, agent_count, integration_count,
         created_by, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        id,
        ctx.tenantId,
        manifest.kitKey,
        manifest.version,
        parts.major,
        parts.minor,
        parts.patch,
        manifest.kitSchemaVersion,
        manifest.verticalKey,
        manifest.displayName,
        manifest.description,
        JSON.stringify(manifest),
        valid.digest,
        manifest.requiredCapabilities.length,
        manifest.extensionDefinitions.length,
        manifest.agentDefinitions.length,
        manifest.edgeIntegrations.length,
        ctx.principalId,
        at,
      ],
    );
  });

  const stored = await findVersionRow(db, ctx, id);
  return { version: mapVersion(stored!) };
}

export async function runKitVerification(
  ctx: TenantContext,
  query: GetKitVersionQuery,
): Promise<VerticalKitVerification> {
  assertVerticalKitsTenantContext(ctx);
  requireAdminister(ctx, 'running kit verification');
  const valid = validateGetKitVersionQuery(query);
  const db = getDb();

  const version = await findVersionRow(db, ctx, valid.kitVersionId);
  if (version === null) {
    throw new VerticalKitsError(
      'kit_version_not_found',
      `no kit version '${valid.kitVersionId}' exists in this tenant`,
    );
  }

  // The deterministic checks re-examine the STORED manifest, including
  // the signed-manifest integrity check (recomputed digest vs the
  // recorded one — a row edited outside the service fails loudly; drift
  // is a new failed run, never a rewrite).
  const outcome = verifyKitManifest(version.manifest, version.manifest_digest);

  const id = newId();
  await db.transaction(async (tx) => {
    const positionResult = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(position), 0) + 1 AS next
         FROM vertical_kit_verifications
         WHERE tenant_id = $1 AND kit_version_id = $2`,
      [ctx.tenantId, valid.kitVersionId],
    );
    await tx.query(
      `INSERT INTO vertical_kit_verifications
         (id, tenant_id, kit_version_id, position, outcome, checks, summary, verifier, ran_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        ctx.tenantId,
        valid.kitVersionId,
        positionResult.rows[0]?.next ?? 1,
        outcome.outcome,
        JSON.stringify(outcome.checks),
        clampDetail(outcome.summary, 2000),
        ctx.principalId,
        now(),
      ],
    );
  });

  const stored = await db.query<VerificationRow>(
    `SELECT * FROM vertical_kit_verifications WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, id],
  );
  return mapVerification(stored.rows[0]!);
}

export async function getKitVersion(
  ctx: TenantContext,
  query: GetKitVersionQuery,
): Promise<VerticalKitVersionWithVerification> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateGetKitVersionQuery(query);
  const db = getDb();
  const version = await findVersionRow(db, ctx, valid.kitVersionId);
  if (version === null) {
    throw new VerticalKitsError(
      'kit_version_not_found',
      `no kit version '${valid.kitVersionId}' exists in this tenant`,
    );
  }
  const latest = await findLatestVerificationRow(db, ctx, valid.kitVersionId);
  return {
    ...mapVersion(version),
    verification: {
      state: latest === null ? 'unverified' : latest.outcome,
      latestRun: latest === null ? null : mapVerification(latest),
    },
  };
}

export async function listKitVersions(
  ctx: TenantContext,
  query: ListKitVersionsQuery,
): Promise<VerticalKitVersionSummary[]> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateListKitVersionsQuery(query);
  const db = getDb();
  const rows =
    valid.kitKey === null
      ? await db.query<VersionRow>(
          `SELECT * FROM vertical_kit_versions
             WHERE tenant_id = $1
             ORDER BY kit_key ASC, version_major DESC, version_minor DESC, version_patch DESC`,
          [ctx.tenantId],
        )
      : await db.query<VersionRow>(
          `SELECT * FROM vertical_kit_versions
             WHERE tenant_id = $1 AND kit_key = $2
             ORDER BY version_major DESC, version_minor DESC, version_patch DESC`,
          [ctx.tenantId, valid.kitKey],
        );
  const summaries: VerticalKitVersionSummary[] = [];
  for (const row of rows.rows) {
    const latest = await findLatestVerificationRow(db, ctx, row.id);
    summaries.push({
      ...mapVersion(row),
      verificationState: latest === null ? 'unverified' : latest.outcome,
    });
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Install lifecycle — installKit / decideKitReview / activate / suspend /
// resume / remove / reads
// ---------------------------------------------------------------------------

export async function installKit(
  ctx: TenantContext,
  input: InstallKitInput,
): Promise<KitInstallationDetail> {
  assertVerticalKitsTenantContext(ctx);
  requireAdminister(ctx, 'installing a kit');
  const valid = validateInstallKitInput(input);
  const db = getDb();

  const version = await findVersionRowByKey(db, ctx, valid.kitKey, valid.version);
  if (version === null) {
    throw new VerticalKitsError(
      'kit_version_not_found',
      `no kit '${valid.kitKey}' version '${valid.version}' is registered in this tenant`,
    );
  }
  // Install requires a VERIFIED version (the marketplace's
  // AUTOMATED_VERIFICATION discipline: nothing unverified installs).
  const state = await verificationStateOf(db, ctx, version.id);
  if (state !== 'verified') {
    throw new VerticalKitsError(
      'kit_not_verified',
      `kit '${valid.kitKey}' version '${valid.version}' is '${state}' — only a verified version can be installed`,
    );
  }
  // One live lifecycle per kit per tenant (the partial unique index is
  // the storage-level backstop of this check).
  const live = await db.query<{ id: string }>(
    `SELECT id FROM vertical_kit_installations
       WHERE tenant_id = $1 AND kit_key = $2 AND status <> 'removed'
       LIMIT 1`,
    [ctx.tenantId, valid.kitKey],
  );
  if (live.rows.length > 0) {
    throw new VerticalKitsError(
      'kit_already_installed',
      `kit '${valid.kitKey}' already has a live installation ('${live.rows[0]!.id}') — remove it before installing again`,
    );
  }

  // The tenant's grant review: the kit's EXACT declared capabilities ride
  // the W009 gate (kind 'vertical-kit-deployment' × EXECUTE). Under the
  // built-in default matrix the request waits for a human decision;
  // tenant policy may auto-allow (grants minted at once) or forbid (the
  // install is refused — the gate's own verdict, recorded not swallowed).
  const actionRequest = await authorizeAction(ctx, {
    actionKind: VERTICAL_KIT_ACTION_KIND,
    authorityLevel: 'EXECUTE',
    payload: {
      operation: 'install-vertical-kit',
      kitKey: version.kit_key,
      kitVersion: version.version,
      verticalKey: version.vertical_key,
      displayName: version.display_name,
      requiredCapabilities: version.manifest.requiredCapabilities,
      componentCounts: {
        extensions: version.extension_count,
        agents: version.agent_count,
        edgeIntegrations: version.integration_count,
      },
    },
    justification:
      valid.justification === null
        ? `install vertical kit '${version.kit_key}' ${version.version} and grant its declared capabilities`
        : valid.justification,
  });

  const installationId = newId();
  const at = now();
  const grantReviewStatus =
    actionRequest.status === 'pending'
      ? 'pending-review'
      : actionRequest.status === 'approved'
        ? 'granted'
        : 'rejected';

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO vertical_kit_installations (
         id, tenant_id, kit_key, kit_version, kit_version_id, status,
         required_capabilities, action_request_id,
         installed_by, installed_at, reviewed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        installationId,
        ctx.tenantId,
        version.kit_key,
        version.version,
        version.id,
        grantReviewStatus,
        JSON.stringify(version.manifest.requiredCapabilities),
        actionRequest.id,
        ctx.principalId,
        at,
        actionRequest.status === 'pending' ? null : at,
      ],
    );
    await appendEvent(
      tx,
      ctx,
      installationId,
      'installed',
      `kit '${version.kit_key}' ${version.version} — gate ${actionRequest.status}`,
    );
    if (grantReviewStatus === 'granted') {
      await appendEvent(tx, ctx, installationId, 'review-approved', 'policy auto-allow');
      await mintGrants(tx, ctx, installationId, version.manifest.requiredCapabilities, at);
    } else if (grantReviewStatus === 'rejected') {
      await appendEvent(
        tx,
        ctx,
        installationId,
        'review-rejected',
        'policy forbids vertical-kit-deployment',
      );
    }
  });

  return readInstallationDetail(ctx, { installationId });
}

/** Mint exactly the declared capabilities as active kit grants. */
async function mintGrants(
  tx: Queryable,
  ctx: TenantContext,
  installationId: string,
  capabilities: readonly KitCapabilityDeclaration[],
  at: Date,
): Promise<void> {
  for (const capability of capabilities) {
    await tx.query(
      `INSERT INTO vertical_kit_grants (
         id, tenant_id, installation_id, capability_key, label, data_categories,
         status, granted_by, granted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
      [
        newId(),
        ctx.tenantId,
        installationId,
        capability.key,
        capability.label,
        JSON.stringify(capability.dataCategories),
        ctx.principalId,
        at,
      ],
    );
    await appendEvent(
      tx,
      ctx,
      installationId,
      'grant-minted',
      `capability '${capability.key}' (${capability.mode})`,
    );
  }
}

export async function decideKitReview(
  ctx: TenantContext,
  input: DecideKitReviewInput,
): Promise<KitInstallationDetail> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateDecideKitReviewInput(input);
  const db = getDb();

  const installation = await requireInstallationRow(db, ctx, valid.installationId);
  if (installation.status !== 'pending-review') {
    throw new VerticalKitsError(
      'installation_not_pending_review',
      `kit installation '${valid.installationId}' is '${installation.status}' — only a pending review can be decided`,
    );
  }

  let actionRequest: ActionRequest;
  try {
    // The human decision itself flows through the actions contract: the
    // approve claim, the separation of duties (the requester never
    // decides its own request) and first-decision-wins are enforced
    // THERE (W009).
    actionRequest = await decideApproval(ctx, {
      requestId: installation.action_request_id,
      decision: valid.decision,
      note: valid.note,
    });
  } catch (error) {
    if (error instanceof ActionsError && error.code === 'not_pending') {
      // Crash-recovery sync: the request was already decided (a prior
      // decide succeeded but our state update was interrupted, or another
      // approver won the race). Re-read the authoritative request state
      // and sync onto it — first decision wins, always.
      actionRequest = await getActionRequest(ctx, { requestId: installation.action_request_id });
      if (actionRequest.status === 'pending') throw error;
    } else {
      throw error;
    }
  }

  const decidedStatus =
    actionRequest.status === 'approved' ? 'granted' : actionRequest.status === 'rejected' ? 'rejected' : null;
  if (decidedStatus === null) {
    // The gate is somehow still pending (a replayed not_pending error);
    // leave the installation pending — the decision can be re-delivered.
    return readInstallationDetail(ctx, { installationId: valid.installationId });
  }

  const at = now();
  await db.transaction(async (tx) => {
    const updated = await tx.query<InstallationRow>(
      `UPDATE vertical_kit_installations
         SET status = $3, reviewed_at = $4
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending-review'
         RETURNING *`,
      [ctx.tenantId, valid.installationId, decidedStatus, actionRequest.decidedAt ?? at],
    );
    if (updated.rows[0] === undefined) {
      // Someone else synced first — first decision wins, nothing to do.
      return;
    }
    if (decidedStatus === 'granted') {
      await appendEvent(
        tx,
        ctx,
        valid.installationId,
        'review-approved',
        `gate request ${actionRequest.id} approved`,
      );
      // Approval mints the grant: exactly the frozen required-capability
      // snapshot, linked to the gate record's chain.
      await mintGrants(tx, ctx, valid.installationId, updated.rows[0].required_capabilities, at);
    } else {
      // Rejection mints NOTHING — the kit holds no authority (denial
      // stops the kit).
      await appendEvent(
        tx,
        ctx,
        valid.installationId,
        'review-rejected',
        `gate request ${actionRequest.id} rejected`,
      );
    }
  });

  return readInstallationDetail(ctx, { installationId: valid.installationId });
}

export async function activateKit(
  ctx: TenantContext,
  query: GetInstallationQuery,
): Promise<KitInstallationDetail> {
  return applyLifecycleTransition(ctx, query, 'activate');
}

export async function suspendKit(
  ctx: TenantContext,
  input: SuspendedRemovalInput,
): Promise<KitInstallationDetail> {
  // Suspend carries an optional reason — validate the wider shape here,
  // then run the shared transition path.
  assertVerticalKitsTenantContext(ctx);
  const valid = validateSuspendedRemovalInput(input);
  return applyLifecycleTransition(
    ctx,
    { installationId: valid.installationId },
    'suspend',
    valid.reason,
  );
}

export async function resumeKit(
  ctx: TenantContext,
  query: GetInstallationQuery,
): Promise<KitInstallationDetail> {
  return applyLifecycleTransition(ctx, query, 'resume');
}

export async function removeKit(
  ctx: TenantContext,
  input: SuspendedRemovalInput,
): Promise<KitInstallationDetail> {
  assertVerticalKitsTenantContext(ctx);
  requireAdminister(ctx, 'removing a kit installation');
  const valid = validateSuspendedRemovalInput(input);
  const db = getDb();
  const installation = await requireInstallationRow(db, ctx, valid.installationId);

  const transition = 'remove' as const;
  if (!canTransitionInstallation(installation.status as KitInstallationLifecycleState, transition)) {
    throw new VerticalKitsError(
      'installation_not_lifecycle_state',
      `kit installation '${valid.installationId}' is '${installation.status}' — ${transition} is not a legal transition`,
    );
  }

  const at = now();
  const reason = valid.reason ?? null;
  await db.transaction(async (tx) => {
    const updated = await tx.query<InstallationRow>(
      `UPDATE vertical_kit_installations
         SET status = 'removed', removed_at = $3, removal_reason = $4
         WHERE tenant_id = $1 AND id = $2 AND status <> 'removed'
         RETURNING *`,
      [ctx.tenantId, valid.installationId, at, reason],
    );
    if (updated.rows[0] === undefined) {
      return;
    }
    // EVERY active grant is revoked with the kit — no orphaned authority.
    // (Revocation of already-revoked rows is a no-op: the trail stays.)
    const revoked = await tx.query<GrantRow>(
      `UPDATE vertical_kit_grants
         SET status = 'revoked', revoked_at = $3, revoked_by = $4, revocation_reason = $5
         WHERE tenant_id = $1 AND installation_id = $2 AND status = 'active'
         RETURNING *`,
      [ctx.tenantId, valid.installationId, at, ctx.principalId, reason ?? 'kit removed'],
    );
    for (const grant of revoked.rows) {
      await appendEvent(
        tx,
        ctx,
        valid.installationId,
        'grant-revoked',
        `capability '${grant.capability_key}'`,
      );
    }
    await appendEvent(
      tx,
      ctx,
      valid.installationId,
      'removed',
      reason === null ? `kit '${installation.kit_key}' removed` : clampDetail(reason, 500),
    );
  });

  return readInstallationDetail(ctx, { installationId: valid.installationId });
}

/** The shared administrative transition path (activate/suspend/resume). */
async function applyLifecycleTransition(
  ctx: TenantContext,
  query: GetInstallationQuery,
  transition: 'activate' | 'suspend' | 'resume',
  reason: string | null = null,
): Promise<KitInstallationDetail> {
  assertVerticalKitsTenantContext(ctx);
  requireAdminister(ctx, `${transition}ing a kit installation`);
  const valid = validateInstallationTargetInput(query);
  const db = getDb();
  const installation = await requireInstallationRow(db, ctx, valid.installationId);

  if (!canTransitionInstallation(installation.status as KitInstallationLifecycleState, transition)) {
    throw new VerticalKitsError(
      'installation_not_lifecycle_state',
      `kit installation '${valid.installationId}' is '${installation.status}' — ${transition} is not a legal transition`,
    );
  }
  const target = targetInstallationState(transition);
  const at = now();
  await db.transaction(async (tx) => {
    const assignments: string[] = ['status = $3', 'reviewed_at = reviewed_at'];
    const params: unknown[] = [ctx.tenantId, valid.installationId, target];
    if (transition === 'activate') {
      assignments.push(`activated_at = $${params.length + 1}`);
      params.push(at);
    } else if (transition === 'suspend') {
      assignments.push(`suspended_at = $${params.length + 1}`);
      params.push(at);
    } else {
      assignments.push('suspended_at = NULL');
    }
    const updated = await tx.query(
      `UPDATE vertical_kit_installations SET ${assignments.join(', ')}
         WHERE tenant_id = $1 AND id = $2
         RETURNING id`,
      params,
    );
    if (updated.rows[0] === undefined) return;
    await appendEvent(
      tx,
      ctx,
      valid.installationId,
      transition === 'activate' ? 'activated' : transition === 'suspend' ? 'suspended' : 'resumed',
      reason === null ? null : clampDetail(reason, 500),
    );
  });
  return readInstallationDetail(ctx, { installationId: valid.installationId });
}

export async function getKitInstallation(
  ctx: TenantContext,
  query: GetInstallationQuery,
): Promise<KitInstallationDetail> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateGetInstallationQuery(query);
  return readInstallationDetail(ctx, valid);
}

async function readInstallationDetail(
  ctx: TenantContext,
  query: GetInstallationQuery,
): Promise<KitInstallationDetail> {
  const db = getDb();
  const installation = await requireInstallationRow(db, ctx, query.installationId);
  const grants = await db.query<GrantRow>(
    `SELECT * FROM vertical_kit_grants
       WHERE tenant_id = $1 AND installation_id = $2
       ORDER BY granted_at ASC, capability_key ASC`,
    [ctx.tenantId, query.installationId],
  );
  return {
    installation: mapInstallation(installation),
    requiredCapabilities: installation.required_capabilities,
    grants: grants.rows.map(mapGrant),
  };
}

export async function listKitInstallations(
  ctx: TenantContext,
  query: ListKitInstallationsQuery,
): Promise<KitInstallation[]> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateListKitInstallationsQuery(query);
  const db = getDb();
  const rows =
    valid.status === null
      ? await db.query<InstallationRow>(
          `SELECT * FROM vertical_kit_installations
             WHERE tenant_id = $1
             ORDER BY installed_at DESC, id DESC`,
          [ctx.tenantId],
        )
      : await db.query<InstallationRow>(
          `SELECT * FROM vertical_kit_installations
             WHERE tenant_id = $1 AND status = $2
             ORDER BY installed_at DESC, id DESC`,
          [ctx.tenantId, valid.status],
        );
  return rows.rows.map(mapInstallation);
}

// ---------------------------------------------------------------------------
// The kit runtime — the capability gate + the edge paths
// ---------------------------------------------------------------------------

export async function invokeKitCapability(
  ctx: TenantContext,
  input: InvokeKitCapabilityInput,
): Promise<KitCapabilityInvocation> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateInvokeKitCapabilityInput(input);
  return gateKitCapability(ctx, valid.installationId, valid.capabilityKey, valid.taskContext);
}

/**
 * The pre-execution authority gate (the capability-grants pattern,
 * kit-scoped): consults the installation state and the kit's active
 * grants; records EVERY verdict (allowed or denied) in the append-only
 * ledger with the deterministic, task-grounded denial reason. Performs
 * no side effects beyond the ledger row.
 */
async function gateKitCapability(
  ctx: TenantContext,
  installationId: string,
  capabilityKey: string,
  taskContext: KitTaskContext,
): Promise<KitCapabilityInvocation> {
  const db = getDb();
  const installation = await requireInstallationRow(db, ctx, installationId);

  let outcome: 'allowed' | 'denied';
  let basis: KitInvocationBasis;
  let denialReason: string | null = null;

  if (installation.status !== 'active') {
    outcome = 'denied';
    basis = 'installation-inactive';
    denialReason = buildInactiveInstallationReason(installation.status, taskContext);
  } else {
    const grant = await db.query<GrantRow>(
      `SELECT * FROM vertical_kit_grants
         WHERE tenant_id = $1 AND installation_id = $2 AND capability_key = $3 AND status = 'active'
         LIMIT 1`,
      [ctx.tenantId, installationId, capabilityKey],
    );
    if (grant.rows[0] === undefined) {
      const active = await db.query<{ capability_key: string }>(
        `SELECT capability_key FROM vertical_kit_grants
           WHERE tenant_id = $1 AND installation_id = $2 AND status = 'active'
           ORDER BY capability_key ASC`,
        [ctx.tenantId, installationId],
      );
      outcome = 'denied';
      basis = 'grant-missing';
      denialReason = buildMissingGrantReason(
        capabilityKey,
        active.rows.map((row) => row.capability_key),
        installation.status,
        taskContext,
      );
    } else {
      outcome = 'allowed';
      basis = 'kit-grant';
    }
  }

  const id = newId();
  await db.query(
    `INSERT INTO vertical_kit_invocations
       (id, tenant_id, installation_id, capability_key, outcome, basis, denial_reason, task_context, invoked_by, invoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      ctx.tenantId,
      installationId,
      capabilityKey,
      outcome,
      basis,
      denialReason === null ? null : clampDetail(denialReason, 2000),
      JSON.stringify(taskContext),
      ctx.principalId,
      now(),
    ],
  );
  const stored = await db.query<InvocationRow>(
    `SELECT * FROM vertical_kit_invocations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, id],
  );
  return mapInvocation(stored.rows[0]!);
}

// ---------------------------------------------------------------------------
// Edge-result canonicalization (provider objects never cross)
// ---------------------------------------------------------------------------

function isPlainJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (type !== 'object') return false;
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  // A provider object (class instance, symbol-carrying, cycle) never
  // crosses the kit runtime — the prototype must be the plain JSON one.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isPlainJsonValue);
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

function canonicalizeEdgeState(value: unknown): VerticalKitEdgeState {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !isPlainJsonValue(value)
  ) {
    throw new VerticalKitsError(
      'invalid_edge_result',
      'the edge inspect result must be a plain JSON object — provider objects never cross the kit runtime',
    );
  }
  const record = value as { found?: unknown; state?: unknown };
  if (typeof record.found !== 'boolean') {
    throw new VerticalKitsError(
      'invalid_edge_result',
      'the edge inspect result must carry a boolean found',
    );
  }
  if (!isPlainJsonValue(record.state)) {
    throw new VerticalKitsError(
      'invalid_edge_result',
      'the edge inspect state must be plain JSON — a provider object cannot cross the kit runtime',
    );
  }
  if (jsonByteLength(record.state) > MAX_VALUE_BYTES) {
    throw new VerticalKitsError(
      'invalid_edge_result',
      `the edge inspect state exceeds ${MAX_VALUE_BYTES} bytes`,
    );
  }
  return { found: record.found, state: record.state };
}

function canonicalizeEdgeReceipt(value: unknown): {
  status: 'accepted' | 'rejected' | 'failed';
  receiptId: string | null;
  detail: string | null;
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !isPlainJsonValue(value)
  ) {
    throw new VerticalKitsError(
      'invalid_edge_result',
      'the edge execute receipt must be a plain JSON object — provider objects never cross the kit runtime',
    );
  }
  const record = value as { status?: unknown; receiptId?: unknown; detail?: unknown };
  if (
    record.status !== 'accepted' &&
    record.status !== 'rejected' &&
    record.status !== 'failed'
  ) {
    throw new VerticalKitsError(
      'invalid_edge_result',
      "the edge execute receipt status must be 'accepted', 'rejected' or 'failed'",
    );
  }
  if (
    record.receiptId !== undefined &&
    record.receiptId !== null &&
    (typeof record.receiptId !== 'string' || record.receiptId.length < 1 || record.receiptId.length > MAX_RECEIPT_ID_LENGTH)
  ) {
    throw new VerticalKitsError(
      'invalid_edge_result',
      `the edge receipt id must be a string of 1..${MAX_RECEIPT_ID_LENGTH} chars or null`,
    );
  }
  if (
    record.detail !== undefined &&
    record.detail !== null &&
    (typeof record.detail !== 'string' || record.detail.length < 1 || record.detail.length > MAX_RECEIPT_DETAIL_LENGTH)
  ) {
    throw new VerticalKitsError(
      'invalid_edge_result',
      `the edge receipt detail must be a string of 1..${MAX_RECEIPT_DETAIL_LENGTH} chars or null`,
    );
  }
  return {
    status: record.status,
    receiptId: record.receiptId ?? null,
    detail: record.detail ?? null,
  };
}

// ---------------------------------------------------------------------------
// Integration resolution + the edge paths
// ---------------------------------------------------------------------------

interface ResolvedIntegration {
  installation: InstallationRow;
  version: VersionRow;
  integration: KitEdgeIntegrationDeclaration;
}

async function resolveIntegration(
  ctx: TenantContext,
  installationId: string,
  integrationKey: string,
): Promise<ResolvedIntegration> {
  const db = getDb();
  const installation = await requireInstallationRow(db, ctx, installationId);
  if (installation.status !== 'active') {
    throw new VerticalKitsError(
      'installation_not_active',
      `kit installation '${installationId}' is '${installation.status}' — the kit runtime requires an active installation`,
    );
  }
  const version = await findVersionRow(db, ctx, installation.kit_version_id);
  if (version === null) {
    throw new VerticalKitsError(
      'kit_version_not_found',
      `the installed kit version '${installation.kit_version_id}' no longer exists in this tenant`,
    );
  }
  const integration = version.manifest.edgeIntegrations.find(
    (entry) => entry.integrationKey === integrationKey,
  );
  if (integration === undefined) {
    throw new VerticalKitsError(
      'integration_not_found',
      `kit '${installation.kit_key}' declares no edge integration '${integrationKey}'`,
    );
  }
  return { installation, version, integration };
}

export async function inspectKitIntegration(
  ctx: TenantContext,
  input: InspectKitIntegrationInput,
): Promise<InspectKitIntegrationResult> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateInspectKitIntegrationInput(input);
  const { integration } = await resolveIntegration(
    ctx,
    valid.installationId,
    valid.integrationKey,
  );

  // The read path consults the kit capability gate first — a denial
  // stops the inspection and is returned as data (recorded in the
  // invocation ledger).
  const invocation = await gateKitCapability(
    ctx,
    valid.installationId,
    integration.readCapabilityKey,
    valid.taskContext,
  );
  if (invocation.outcome === 'denied') {
    return { invocation, state: null };
  }

  // DEFERRED-ON-W088: the edge port is the only exit seam and nothing is
  // wired by default — the module refuses to fake success.
  const edge = requireEdge();
  const raw = await edge.inspect({
    installationId: valid.installationId,
    integrationKey: valid.integrationKey,
    capabilityKey: integration.readCapabilityKey,
    target: valid.target,
  });
  const state = canonicalizeEdgeState(raw);
  return { invocation, state };
}

export async function executeKitIntegration(
  ctx: TenantContext,
  input: ExecuteKitIntegrationInput,
): Promise<ExecuteKitIntegrationResult> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateExecuteKitIntegrationInput(input);
  const { integration } = await resolveIntegration(
    ctx,
    valid.installationId,
    valid.integrationKey,
  );
  if (integration.writeCapabilityKey === null) {
    throw new VerticalKitsError(
      'integration_read_only',
      `edge integration '${valid.integrationKey}' is read-only — it declares no write capability`,
    );
  }

  // DENIAL STOPS THE WRITE: the write path consults the kit capability
  // gate first; a denied invocation is returned as data (recorded in the
  // invocation ledger) and the edge is never called.
  const invocation = await gateKitCapability(
    ctx,
    valid.installationId,
    integration.writeCapabilityKey,
    valid.taskContext,
  );
  if (invocation.outcome === 'denied') {
    return { invocation, receipt: null };
  }

  // DEFERRED-ON-W088: the edge port is the only exit seam and nothing is
  // wired by default — the module refuses to fake success.
  const edge = requireEdge();
  const raw = await edge.execute({
    installationId: valid.installationId,
    integrationKey: valid.integrationKey,
    capabilityKey: integration.writeCapabilityKey,
    target: valid.target,
    payload: valid.payload,
  });
  const receipt = canonicalizeEdgeReceipt(raw);

  const db = getDb();
  const id = newId();
  await db.query(
    `INSERT INTO vertical_kit_edge_actions
       (id, tenant_id, installation_id, integration_key, capability_key, invocation_id,
        receipt_status, receipt_id, receipt_detail, edge_id, executed_by, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      ctx.tenantId,
      valid.installationId,
      valid.integrationKey,
      integration.writeCapabilityKey,
      invocation.id,
      receipt.status,
      receipt.receiptId,
      receipt.detail,
      edge.edgeId,
      ctx.principalId,
      now(),
    ],
  );
  const stored = await db.query<EdgeActionRow>(
    `SELECT * FROM vertical_kit_edge_actions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, id],
  );
  return { invocation, receipt: mapEdgeAction(stored.rows[0]!) };
}

// ---------------------------------------------------------------------------
// Ledger + status reads
// ---------------------------------------------------------------------------

export async function listKitInvocations(
  ctx: TenantContext,
  query: ListInstallationRecordsQuery,
): Promise<KitCapabilityInvocation[]> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateListInstallationRecordsQuery(query);
  await requireInstallationRow(getDb(), ctx, valid.installationId);
  const rows = await getDb().query<InvocationRow>(
    `SELECT * FROM vertical_kit_invocations
       WHERE tenant_id = $1 AND installation_id = $2
       ORDER BY invoked_at DESC, id DESC
       LIMIT $3`,
    [ctx.tenantId, valid.installationId, valid.limit],
  );
  return rows.rows.map(mapInvocation);
}

export async function listKitEdgeActions(
  ctx: TenantContext,
  query: ListInstallationRecordsQuery,
): Promise<KitEdgeAction[]> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateListInstallationRecordsQuery(query);
  await requireInstallationRow(getDb(), ctx, valid.installationId);
  const rows = await getDb().query<EdgeActionRow>(
    `SELECT * FROM vertical_kit_edge_actions
       WHERE tenant_id = $1 AND installation_id = $2
       ORDER BY executed_at DESC, id DESC
       LIMIT $3`,
    [ctx.tenantId, valid.installationId, valid.limit],
  );
  return rows.rows.map(mapEdgeAction);
}

export async function listKitEvents(
  ctx: TenantContext,
  query: ListInstallationRecordsQuery,
): Promise<KitInstallationEvent[]> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateListInstallationRecordsQuery(query);
  await requireInstallationRow(getDb(), ctx, valid.installationId);
  const rows = await getDb().query<EventRow>(
    `SELECT * FROM vertical_kit_events
       WHERE tenant_id = $1 AND installation_id = $2
       ORDER BY recorded_at DESC, position DESC
       LIMIT $3`,
    [ctx.tenantId, valid.installationId, valid.limit],
  );
  return rows.rows.map(mapEvent);
}

export async function getKitStatus(
  ctx: TenantContext,
  query: GetInstallationQuery,
): Promise<KitStatusReport> {
  assertVerticalKitsTenantContext(ctx);
  const valid = validateGetInstallationQuery(query);
  const db = getDb();
  const installation = await requireInstallationRow(db, ctx, valid.installationId);
  const version = await findVersionRow(db, ctx, installation.kit_version_id);
  if (version === null) {
    throw new VerticalKitsError(
      'kit_version_not_found',
      `the installed kit version '${installation.kit_version_id}' no longer exists in this tenant`,
    );
  }

  const grants = await db.query<{ status: string; capability_key: string }>(
    `SELECT status, capability_key FROM vertical_kit_grants
       WHERE tenant_id = $1 AND installation_id = $2`,
    [ctx.tenantId, valid.installationId],
  );
  const invocationCounts = await db.query<{ outcome: string; count: string }>(
    `SELECT outcome, COUNT(*)::text AS count FROM vertical_kit_invocations
       WHERE tenant_id = $1 AND installation_id = $2
       GROUP BY outcome`,
    [ctx.tenantId, valid.installationId],
  );
  const events = await db.query<EventRow>(
    `SELECT * FROM vertical_kit_events
       WHERE tenant_id = $1 AND installation_id = $2
       ORDER BY recorded_at DESC, position DESC
       LIMIT 10`,
    [ctx.tenantId, valid.installationId],
  );

  // Honest component states: starter definitions inside the kit, NOT
  // deployed software — materialization into the extension/agent
  // registries follows those modules' own governed lifecycles downstream.
  const extensions: KitComponentStatus[] = version.manifest.extensionDefinitions.map(
    (definition) => ({
      definitionKey: definition.definitionKey,
      displayName: definition.displayName,
      state: 'defined' as const,
    }),
  );
  const agents: KitComponentStatus[] = version.manifest.agentDefinitions.map(
    (definition) => ({
      definitionKey: definition.definitionKey,
      displayName: definition.displayName,
      state: 'defined' as const,
    }),
  );

  // Honest integration readiness: the deep-integration paths wait on the
  // Edge Connector (W088) behind the VerticalKitEdge seam. Only a wired
  // edge reports 'ready' — with its opaque identity, never a claim of
  // execution that is not happening.
  const wired = getVerticalKitEdge();
  const integrations: KitIntegrationReadiness[] = version.manifest.edgeIntegrations.map(
    (integration) => ({
      integrationKey: integration.integrationKey,
      systemLabel: integration.systemLabel,
      readiness: wired === null ? ('deferred-on-w088' as const) : ('ready' as const),
      edgeId: wired === null ? null : wired.edgeId,
    }),
  );

  const allowed = Number(invocationCounts.rows.find((row) => row.outcome === 'allowed')?.count ?? 0);
  const denied = Number(invocationCounts.rows.find((row) => row.outcome === 'denied')?.count ?? 0);

  return {
    installationId: installation.id,
    kitKey: installation.kit_key,
    kitVersion: installation.kit_version,
    status: installation.status as KitInstallation['status'],
    grants: {
      active: grants.rows.filter((row) => row.status === 'active').length,
      revoked: grants.rows.filter((row) => row.status === 'revoked').length,
    },
    extensions,
    agents,
    integrations,
    edgeWired: wired === null ? null : wired.edgeId,
    invocations: { allowed, denied },
    recentEvents: events.rows.map(mapEvent),
  };
}
