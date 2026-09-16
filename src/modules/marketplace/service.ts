// Implementation of the marketplace module's public operations (see
// contract.ts). W028 — Marketplace Governance.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and
// are never caller-supplied. The marketplace's tables are platform-level
// (see migrations/001), so tenancy is enforced here as an explicit
// VISIBILITY discipline on every statement: a package below PUBLISHED is
// visible only to its vendor tenant and platform operators, and for
// every other tenant reads AND writes are uniformly `package_not_found`
// (ADR-0001's no-leak rule, applied to the platform catalog).
//
// W028 acceptance is carried by these deliberate properties, all tested:
//
//   1. THE GOVERNED CHAIN: exactly
//      DRAFT → SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW →
//      APPROVED/REJECTED → PUBLISHED → INSTALLABLE (lifecycle.ts; the
//      storage direction CHECK re-pins every legal triple). Illegal
//      transitions are `invalid_transition`; no operation skips a state.
//   2. PLATFORM APPROVAL IS MANDATORY (lock 27 / GOVERNANCE.md
//      "marketplace submissions cannot bypass platform approval"):
//      PENDING_REVIEW → APPROVED happens ONLY through `reviewPackage`,
//      which requires the 'marketplace:administer' claim AND separation
//      of duties — the reviewer is neither the vendor principal nor the
//      vendor tenant, so a vendor can never approve its own package even
//      with a mis-granted claim (the storage trigger makes the bad row
//      unrepresentable). PUBLISHED and INSTALLABLE are reachable only
//      through APPROVED: no path bypasses the platform decision.
//   3. AUTOMATED_VERIFICATION RUNS BEFORE REVIEW: the deterministic
//      checks (the extensions module's own five for extension packages —
//      one semantics with the registry and the builder; the marketplace's
//      agent-package four, pinned to the agents module's exported closed
//      vocabularies) decide PENDING_REVIEW vs REJECTED atomically with
//      the run's append-only evidence. No LLM participates.
//   4. TENANT ISOLATION ON A PLATFORM CATALOG: the public catalog
//      (listCatalogPackages) exposes exactly PUBLISHED and INSTALLABLE
//      versions — publication never implies tenant installation or
//      activation (lock 26; this module deliberately stops at
//      INSTALLABLE, the W026/W047 hand-off point).
//   5. APPEND-ONLY GOVERNANCE EVIDENCE: verification runs, review
//      decisions and lifecycle events are immutable (storage triggers);
//      the package payload is frozen at creation (only state and
//      updated_at may move — storage trigger). A rejected version is
//      evidence; the fixed artifact ships as a NEW strictly-increasing
//      version per (kind, key).
//
// Dependency posture (MODULE-DEPENDENCY-MAP.md: `agents + extensions →
// marketplace`): this module imports ONLY the src/infra ports and the
// agents + extensions contracts. The one validated cross-module read is
// `getManifest` (extensions contract) under the VENDOR's own tenant
// context at creation time — the marketplace never reads another
// tenant's registry; the manifest content is frozen into the platform
// artifact and everything after creation is platform-scope.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  compareSemver,
  ExtensionsError,
  getManifest,
  runManifestVerificationChecks,
  type ExtensionManifestWithVerification,
  type SemverParts,
} from '@/modules/extensions/contract';
import { MarketplaceError } from './errors';
import {
  canTransitionPackage,
  MARKETPLACE_PUBLIC_STATES,
  MARKETPLACE_REVIEW_QUEUE_STATES,
  targetPackageState,
  type MarketplacePackageState,
  type MarketplacePackageTransition,
} from './lifecycle';
import {
  AGENT_PACKAGE_CHECKS,
  EXTENSION_PACKAGE_CHECKS,
  packageVerificationOutcomeFor,
  runAgentPackageVerificationChecks,
  summarizePackageVerificationRun,
  type PackageVerificationCheck,
  type PackageVerificationCheckResult,
} from './verification';
import {
  assertMarketplaceTenantContext,
  validateCreatePackageInput,
  validateEvidenceQuery,
  validateGetPackageQuery,
  validateGetPackageVerificationQuery,
  validateListKindQuery,
  validateListPackagesQuery,
  validateMakePackageInstallableInput,
  validatePublishPackageInput,
  validateReviewPackageInput,
  validateRunPackageVerificationInput,
  validateSubmitPackageInput,
  type ValidatedCreateInput,
} from './validation';
import type {
  AgentPackagePayload,
  CreatePackageInput,
  ExtensionPackagePayload,
  GetPackageQuery,
  GetPackageVerificationQuery,
  ListCatalogPackagesQuery,
  ListPackageLifecycleEventsQuery,
  ListPackageReviewsQuery,
  ListPackageVerificationsQuery,
  ListPackagesQuery,
  ListReviewQueueQuery,
  MarketplacePackage,
  MakePackageInstallableInput,
  PackageLifecycleEvent,
  PackageReview,
  PackageVerificationInfo,
  PackageVerificationRun,
  PublishPackageInput,
  ReviewPackageInput,
  ReviewPackageResult,
  RunPackageVerificationInput,
  RunPackageVerificationResult,
  SubmitPackageInput,
} from './types';

/** The closed check-name vocabulary a stored run may carry (both kinds). */
const KNOWN_CHECKS: ReadonlySet<string> = new Set<string>([
  ...EXTENSION_PACKAGE_CHECKS,
  ...AGENT_PACKAGE_CHECKS,
]);

// ---------------------------------------------------------------------------
// Authority claims
// ---------------------------------------------------------------------------

/** Vendor-side claim: create and submit marketplace packages. */
export const MARKETPLACE_AUTHORITY_SUBMIT = 'marketplace:submit';

/** Platform-side claim: run verification, review, publish, make installable. */
export const MARKETPLACE_AUTHORITY_ADMINISTER = 'marketplace:administer';

function canSubmitPackages(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(MARKETPLACE_AUTHORITY_SUBMIT);
}

function canAdministerMarketplace(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(MARKETPLACE_AUTHORITY_ADMINISTER);
}

// ---------------------------------------------------------------------------
// Rows + mapping
// ---------------------------------------------------------------------------

interface PackageRow extends DbRow {
  id: string;
  package_kind: string;
  package_key: string;
  version: string;
  version_major: number;
  version_minor: number;
  version_patch: number;
  display_name: string;
  description: string | null;
  payload: unknown;
  vendor_tenant: string;
  vendor_principal: string;
  state: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VerificationRow extends DbRow {
  id: string;
  package_id: string;
  outcome: string;
  checks: unknown;
  summary: string;
  ran_by_tenant: string;
  ran_by_principal: string;
  ran_at: Date | string;
}

interface ReviewRow extends DbRow {
  id: string;
  package_id: string;
  decision: string;
  reason: string | null;
  reviewed_by_tenant: string;
  reviewed_by_principal: string;
  reviewed_at: Date | string;
}

interface LifecycleEventRow extends DbRow {
  id: string;
  package_id: string;
  transition: string;
  from_state: string;
  to_state: string;
  actor_tenant: string;
  actor: string;
  occurred_at: Date | string;
}

const PACKAGE_COLUMNS = `id, package_kind, package_key, version,
  version_major, version_minor, version_patch,
  display_name, description, payload,
  vendor_tenant, vendor_principal, state, created_at, updated_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function versionPartsOf(row: PackageRow): SemverParts {
  return {
    major: Number(row.version_major),
    minor: Number(row.version_minor),
    patch: Number(row.version_patch),
  };
}

/**
 * Parse a stored jsonb payload into its typed shape. The shape floor is
 * pinned by the migration's CHECK constraints; everything deeper is
 * re-validated by the AUTOMATED_VERIFICATION checks (the extensions
 * module's posture: map the row, let the checks be the runtime guards).
 */
function parsePayload(
  kind: string,
  payload: unknown,
): ExtensionPackagePayload | AgentPackagePayload {
  const record = (payload ?? {}) as Record<string, unknown>;
  if (kind === 'extension') {
    return {
      manifestId: String(record.manifestId ?? ''),
      extensionKey: String(record.extensionKey ?? ''),
      subject: (record.subject ?? {}) as ExtensionPackagePayload['subject'],
    };
  }
  return {
    role: String(record.role ?? ''),
    instructions: String(record.instructions ?? ''),
    provider: record.provider as AgentPackagePayload['provider'],
    permissions: (record.permissions ?? []) as AgentPackagePayload['permissions'],
  };
}

function mapPackage(row: PackageRow): MarketplacePackage {
  return {
    id: row.id,
    kind: row.package_kind as MarketplacePackage['kind'],
    packageKey: row.package_key,
    version: row.version,
    versionParts: versionPartsOf(row),
    displayName: row.display_name,
    description: row.description,
    state: row.state as MarketplacePackageState,
    payload: parsePayload(row.package_kind, row.payload),
    vendorTenant: row.vendor_tenant,
    vendorPrincipal: row.vendor_principal,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Parse stored per-check outcomes with runtime guards (a bypass write cannot forge shapes). */
function parseChecks(checks: unknown): PackageVerificationCheckResult[] {
  if (!Array.isArray(checks)) return [];
  const out: PackageVerificationCheckResult[] = [];
  for (const entry of checks) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.check !== 'string' || !KNOWN_CHECKS.has(record.check)) continue;
    const outcome = record.outcome === 'pass' ? 'pass' : record.outcome === 'fail' ? 'fail' : null;
    if (outcome === null) continue;
    out.push({
      check: record.check as PackageVerificationCheck,
      outcome,
      detail: typeof record.detail === 'string' ? record.detail : null,
    });
  }
  return out;
}

function mapVerification(row: VerificationRow): PackageVerificationRun {
  return {
    id: row.id,
    packageId: row.package_id,
    outcome: row.outcome as PackageVerificationRun['outcome'],
    checks: parseChecks(row.checks),
    summary: row.summary,
    ranByTenant: row.ran_by_tenant,
    ranByPrincipal: row.ran_by_principal,
    ranAt: iso(row.ran_at),
  };
}

function mapReview(row: ReviewRow): PackageReview {
  return {
    id: row.id,
    packageId: row.package_id,
    decision: row.decision as PackageReview['decision'],
    reason: row.reason,
    reviewedByTenant: row.reviewed_by_tenant,
    reviewedByPrincipal: row.reviewed_by_principal,
    reviewedAt: iso(row.reviewed_at),
  };
}

function mapLifecycleEvent(row: LifecycleEventRow): PackageLifecycleEvent {
  return {
    id: row.id,
    packageId: row.package_id,
    transition: row.transition as MarketplacePackageTransition,
    fromState: row.from_state as MarketplacePackageState,
    toState: row.to_state as MarketplacePackageState,
    actorTenant: row.actor_tenant,
    actor: row.actor,
    occurredAt: iso(row.occurred_at),
  };
}

/** The Postgres duplicate-key constraint name behind an error, if any (the extensions module's helper). */
function duplicateConstraint(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'constraint' in error) {
    const constraint = (error as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Visibility (tenant isolation on the platform catalog)
// ---------------------------------------------------------------------------

/**
 * May this caller see this package? The vendor tenant always sees its
 * own packages; platform operators (the administer claim) see the whole
 * governed pipeline; every other tenant sees exactly the public states.
 */
function canSeePackage(
  ctx: TenantContext,
  row: Pick<PackageRow, 'vendor_tenant' | 'state'>,
): boolean {
  if (row.vendor_tenant === ctx.tenantId) return true;
  if (canAdministerMarketplace(ctx.authority)) return true;
  return (MARKETPLACE_PUBLIC_STATES as readonly string[]).includes(row.state);
}

/**
 * Load a package row the caller may see — the uniform not-found
 * discipline: a package that is not the caller's own and not yet public
 * is indistinguishable from a missing one, on reads AND writes.
 */
async function findVisiblePackage(
  db: Queryable,
  ctx: TenantContext,
  packageId: string,
): Promise<PackageRow> {
  const result = await db.query<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS} FROM marketplace_packages WHERE id = $1`,
    [packageId],
  );
  const row = result.rows[0] ?? null;
  if (row === null || !canSeePackage(ctx, row)) {
    throw new MarketplaceError(
      'package_not_found',
      `no marketplace package '${packageId}' is visible to this caller`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// The apply-time transition core (legality re-checked inside the write)
// ---------------------------------------------------------------------------

/**
 * A stamp strictly later than `prev` for a `candidate` — the per-package
 * monotonic-time discipline: when the wall clock is coarser than the
 * transition cadence (several operations inside one millisecond, common
 * under the embedded database), each recorded timestamp still advances,
 * so a package's trail and updated_at are STRICTLY ordered and the
 * newest-first reads are deterministic. Pure.
 */
function monotonicAfter(prev: Date | string, candidate: Date): Date {
  const prevMs = prev instanceof Date ? prev.getTime() : new Date(prev).getTime();
  return candidate.getTime() > prevMs ? candidate : new Date(prevMs + 1);
}

/**
 * Apply one legal lifecycle transition inside `tx`: re-check legality
 * (the state may have moved while the caller was assembling input),
 * move state + updated_at, and append the immutable trail event. The
 * storage direction CHECK and the append-only triggers back every step
 * for writes bypassing the service.
 */
async function applyTransition(
  tx: Queryable,
  row: PackageRow,
  transition: MarketplacePackageTransition,
  ctx: TenantContext,
  timestamp: Date,
): Promise<PackageRow> {
  const from = row.state as MarketplacePackageState;
  if (!canTransitionPackage(from, transition)) {
    throw new MarketplaceError(
      'invalid_transition',
      `package '${row.id}' (${row.package_key} ${row.version}) is ${from}; the '${transition}' transition is not legal from there`,
    );
  }
  const to = targetPackageState(transition);
  const stampedAt = monotonicAfter(row.updated_at, timestamp);
  await tx.query(
    `UPDATE marketplace_packages SET state = $1, updated_at = $2 WHERE id = $3`,
    [to, stampedAt, row.id],
  );
  await tx.query(
    `INSERT INTO marketplace_package_lifecycle_events (
       package_id, transition, from_state, to_state, actor_tenant, actor, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.id, transition, from, to, ctx.tenantId, ctx.principalId, stampedAt],
  );
  return { ...row, state: to, updated_at: stampedAt };
}

// ---------------------------------------------------------------------------
// createPackage — the vendor freezes one artifact version (DRAFT)
// ---------------------------------------------------------------------------

export async function createPackage(
  ctx: TenantContext,
  input: CreatePackageInput,
): Promise<MarketplacePackage> {
  assertMarketplaceTenantContext(ctx);
  // Offering software into the platform catalog is a vendor-side
  // management action (the extensions registration precedent:
  // authorization before input parsing — unauthorized callers learn
  // nothing about shapes).
  if (!canSubmitPackages(ctx.authority)) {
    throw new MarketplaceError(
      'forbidden',
      `this operation requires the '${MARKETPLACE_AUTHORITY_SUBMIT}' authority claim`,
    );
  }
  const valid: ValidatedCreateInput = validateCreatePackageInput(input);
  const timestamp = now();

  if (valid.kind === 'agent') {
    return insertPackage(
      ctx,
      'agent',
      valid.packageKey,
      valid.version,
      valid.versionParts,
      valid.displayName,
      valid.description,
      {
        role: valid.role,
        instructions: valid.instructions,
        provider: valid.provider,
        permissions: valid.permissions,
      },
      timestamp,
    );
  }

  // Extension package: freeze the manifest content ONCE through the
  // extensions contract under the VENDOR's own tenant context (the one
  // validated cross-module read; a missing, malformed or foreign-tenant
  // manifest id is uniformly invalid_manifest_ref — no existence leak).
  let manifest: ExtensionManifestWithVerification;
  try {
    manifest = await getManifest(ctx, { manifestId: valid.manifestId });
  } catch (error) {
    if (error instanceof ExtensionsError) {
      throw new MarketplaceError(
        'invalid_manifest_ref',
        `no extension manifest '${valid.manifestId}' is readable in this tenant`,
      );
    }
    throw error;
  }
  const packageKey = valid.packageKey ?? manifest.extensionKey;
  return insertPackage(
    ctx,
    'extension',
    packageKey,
    manifest.version,
    manifest.versionParts,
    manifest.displayName,
    manifest.description,
    {
      manifestId: manifest.id,
      extensionKey: manifest.extensionKey,
      subject: {
        manifestSchemaVersion: manifest.manifestSchemaVersion,
        requestedPermissions: manifest.requestedPermissions,
        capabilities: manifest.capabilities,
        quotas: manifest.quotas,
        hostCompatibility: manifest.hostCompatibility,
      },
    },
    timestamp,
  );
}

async function insertPackage(
  ctx: TenantContext,
  kind: 'extension' | 'agent',
  packageKey: string,
  version: string,
  versionParts: SemverParts,
  displayName: string,
  description: string | null,
  payload: ExtensionPackagePayload | AgentPackagePayload,
  timestamp: Date,
): Promise<MarketplacePackage> {
  return getDb().transaction(async (tx) => {
    // Strictly increasing versions per (kind, key) — numeric semver
    // order (the parsed columns, never text order), regardless of state:
    // an in-flight or rejected older version never blocks a newer one
    // (the extensions module's manifest rule, applied to the catalog).
    const latest = await tx.query<PackageRow>(
      `SELECT ${PACKAGE_COLUMNS} FROM marketplace_packages
         WHERE package_kind = $1 AND package_key = $2
         ORDER BY version_major DESC, version_minor DESC, version_patch DESC
         LIMIT 1`,
      [kind, packageKey],
    );
    const latestRow = latest.rows[0] ?? null;
    if (latestRow !== null && compareSemver(versionParts, versionPartsOf(latestRow)) <= 0) {
      throw new MarketplaceError(
        'package_conflict',
        `version ${version} does not come after the latest package version ${latestRow.version} of '${packageKey}' — package versions must strictly increase`,
      );
    }

    let packageId: string;
    try {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO marketplace_packages (
           package_kind, package_key, version,
           version_major, version_minor, version_patch,
           display_name, description, payload,
           vendor_tenant, vendor_principal, state, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 'DRAFT', $12, $12)
         RETURNING id`,
        [
          kind,
          packageKey,
          version,
          versionParts.major,
          versionParts.minor,
          versionParts.patch,
          displayName,
          description,
          JSON.stringify(payload),
          ctx.tenantId,
          ctx.principalId,
          timestamp,
        ],
      );
      packageId = result.rows[0]!.id;
    } catch (error) {
      if (duplicateConstraint(error) === 'marketplace_packages_kind_key_version_unique') {
        throw new MarketplaceError(
          'package_conflict',
          `version ${version} of package '${packageKey}' already exists in the catalog — package versions are immutable; a changed artifact is a new version`,
        );
      }
      throw error;
    }

    const row = await tx.query<PackageRow>(
      `SELECT ${PACKAGE_COLUMNS} FROM marketplace_packages WHERE id = $1`,
      [packageId],
    );
    return mapPackage(row.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// submitPackage — DRAFT → SUBMITTED (the vendor's hand-off)
// ---------------------------------------------------------------------------

export async function submitPackage(
  ctx: TenantContext,
  input: SubmitPackageInput,
): Promise<MarketplacePackage> {
  assertMarketplaceTenantContext(ctx);
  if (!canSubmitPackages(ctx.authority)) {
    throw new MarketplaceError(
      'forbidden',
      `this operation requires the '${MARKETPLACE_AUTHORITY_SUBMIT}' authority claim`,
    );
  }
  const valid = validateSubmitPackageInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    // The vendor hand-off is the OWNER's move: a foreign tenant's draft
    // is indistinguishable from missing (platform operators see it but
    // may not submit on the vendor's behalf — the pipeline keeps the
    // submitter and the reviewer provably distinct).
    const row = await findVendorPackage(tx, ctx, valid.packageId);
    return mapPackage(await applyTransition(tx, row, 'submit', ctx, timestamp));
  });
}

/** Load a package that must belong to the caller's own tenant (the vendor view). */
async function findVendorPackage(
  db: Queryable,
  ctx: TenantContext,
  packageId: string,
): Promise<PackageRow> {
  const result = await db.query<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS} FROM marketplace_packages
       WHERE id = $1 AND vendor_tenant = $2`,
    [packageId, ctx.tenantId],
  );
  const row = result.rows[0] ?? null;
  if (row === null) {
    throw new MarketplaceError(
      'package_not_found',
      `no marketplace package '${packageId}' belongs to this tenant`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// runAutomatedVerification — SUBMITTED → AUTOMATED_VERIFICATION →
// PENDING_REVIEW | REJECTED (the deterministic platform phase)
// ---------------------------------------------------------------------------

export async function runAutomatedVerification(
  ctx: TenantContext,
  input: RunPackageVerificationInput,
): Promise<RunPackageVerificationResult> {
  assertMarketplaceTenantContext(ctx);
  if (!canAdministerMarketplace(ctx.authority)) {
    throw new MarketplaceError(
      'forbidden',
      `this operation requires the '${MARKETPLACE_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateRunPackageVerificationInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    const row = await findVisiblePackage(tx, ctx, valid.packageId);
    if (row.state !== 'SUBMITTED') {
      throw new MarketplaceError(
        'invalid_transition',
        `package '${row.id}' (${row.package_key} ${row.version}) is ${row.state}; the automated verification phase runs on SUBMITTED packages`,
      );
    }

    // The phase is observable in the trail even though it completes
    // atomically: enter AUTOMATED_VERIFICATION, run the deterministic
    // checks over the frozen artifact, then land in PENDING_REVIEW or
    // REJECTED with the run as evidence.
    const verifying = await applyTransition(tx, row, 'verify', ctx, timestamp);

    const checks = runChecksFor(verifying);
    const outcome = packageVerificationOutcomeFor(checks);
    const summary = summarizePackageVerificationRun(checks);

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO marketplace_package_verifications (
         package_id, outcome, checks, summary, ran_by_tenant, ran_by_principal, ran_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       RETURNING id`,
      [verifying.id, outcome, JSON.stringify(checks), summary, ctx.tenantId, ctx.principalId, timestamp],
    );
    const runId = inserted.rows[0]!.id;

    const finalRow = await applyTransition(
      tx,
      verifying,
      outcome === 'verified' ? 'verification-passed' : 'verification-failed',
      ctx,
      timestamp,
    );

    const runRow = await tx.query<VerificationRow>(
      `SELECT id, package_id, outcome, checks, summary, ran_by_tenant, ran_by_principal, ran_at
         FROM marketplace_package_verifications WHERE id = $1`,
      [runId],
    );
    return { package: mapPackage(finalRow), run: mapVerification(runRow.rows[0]!) };
  });
}

/**
 * Run the kind's deterministic check set over the frozen payload:
 * extension packages get the extensions module's own five checks (one
 * semantics with the registry and the builder); agent packages get the
 * marketplace's four, pinned to the agents module's exported closed
 * vocabularies.
 */
function runChecksFor(row: PackageRow): PackageVerificationCheckResult[] {
  const payload = parsePayload(row.package_kind, row.payload);
  if ('manifestId' in payload) {
    return runManifestVerificationChecks(payload.subject);
  }
  return runAgentPackageVerificationChecks(payload);
}

// ---------------------------------------------------------------------------
// reviewPackage — PENDING_REVIEW → APPROVED | REJECTED (the mandatory
// platform decision, with separation of duties)
// ---------------------------------------------------------------------------

export async function reviewPackage(
  ctx: TenantContext,
  input: ReviewPackageInput,
): Promise<ReviewPackageResult> {
  assertMarketplaceTenantContext(ctx);
  if (!canAdministerMarketplace(ctx.authority)) {
    throw new MarketplaceError(
      'forbidden',
      `this operation requires the '${MARKETPLACE_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateReviewPackageInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    const row = await findVisiblePackage(tx, ctx, valid.packageId);
    if (row.state !== 'PENDING_REVIEW') {
      throw new MarketplaceError(
        'invalid_transition',
        `package '${row.id}' (${row.package_key} ${row.version}) is ${row.state}; only PENDING_REVIEW packages receive platform review decisions`,
      );
    }
    // Separation of duties (the actions module's decideApproval
    // discipline, applied to the platform catalog): the vendor that
    // offered the package — principal OR tenant — can never be the
    // platform reviewer. The storage trigger pins the same rule.
    if (row.vendor_tenant === ctx.tenantId || row.vendor_principal === ctx.principalId) {
      throw new MarketplaceError(
        'separation_of_duties',
        'the platform reviewer must be a different tenant and principal than the package vendor',
      );
    }

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO marketplace_package_reviews (
         package_id, decision, reason, reviewed_by_tenant, reviewed_by_principal, reviewed_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [row.id, valid.decision, valid.reason, ctx.tenantId, ctx.principalId, timestamp],
    );
    const reviewId = inserted.rows[0]!.id;

    const finalRow = await applyTransition(
      tx,
      row,
      valid.decision === 'approve' ? 'approve' : 'reject',
      ctx,
      timestamp,
    );

    const reviewRow = await tx.query<ReviewRow>(
      `SELECT id, package_id, decision, reason, reviewed_by_tenant, reviewed_by_principal, reviewed_at
         FROM marketplace_package_reviews WHERE id = $1`,
      [reviewId],
    );
    return { package: mapPackage(finalRow), review: mapReview(reviewRow.rows[0]!) };
  });
}

// ---------------------------------------------------------------------------
// publishPackage / makePackageInstallable — the platform's publication
// and installation-gating decisions (both claim-gated, both reachable
// only through APPROVED — platform approval is structurally mandatory)
// ---------------------------------------------------------------------------

export async function publishPackage(
  ctx: TenantContext,
  input: PublishPackageInput,
): Promise<MarketplacePackage> {
  assertMarketplaceTenantContext(ctx);
  if (!canAdministerMarketplace(ctx.authority)) {
    throw new MarketplaceError(
      'forbidden',
      `this operation requires the '${MARKETPLACE_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validatePublishPackageInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    const row = await findVisiblePackage(tx, ctx, valid.packageId);
    return mapPackage(await applyTransition(tx, row, 'publish', ctx, timestamp));
  });
}

export async function makePackageInstallable(
  ctx: TenantContext,
  input: MakePackageInstallableInput,
): Promise<MarketplacePackage> {
  assertMarketplaceTenantContext(ctx);
  if (!canAdministerMarketplace(ctx.authority)) {
    throw new MarketplaceError(
      'forbidden',
      `this operation requires the '${MARKETPLACE_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateMakePackageInstallableInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    const row = await findVisiblePackage(tx, ctx, valid.packageId);
    return mapPackage(await applyTransition(tx, row, 'make-installable', ctx, timestamp));
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPackage(
  ctx: TenantContext,
  query: GetPackageQuery,
): Promise<MarketplacePackage> {
  assertMarketplaceTenantContext(ctx);
  const valid = validateGetPackageQuery(query);
  const row = await findVisiblePackage(getDb(), ctx, valid.packageId);
  return mapPackage(row);
}

export async function listPackages(
  ctx: TenantContext,
  query: ListPackagesQuery,
): Promise<MarketplacePackage[]> {
  assertMarketplaceTenantContext(ctx);
  const valid = validateListPackagesQuery(query);
  const rows = await getDb().query<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS} FROM marketplace_packages
       WHERE vendor_tenant = $1
         AND ($2::text IS NULL OR package_kind = $2::text)
         AND ($3::text[] IS NULL OR state = ANY($3::text[]))
       ORDER BY package_kind ASC, package_key ASC,
         version_major DESC, version_minor DESC, version_patch DESC
       LIMIT $4`,
    [ctx.tenantId, valid.kind, valid.states, valid.limit],
  );
  return rows.rows.map(mapPackage);
}

export async function listCatalogPackages(
  ctx: TenantContext,
  query: ListCatalogPackagesQuery,
): Promise<MarketplacePackage[]> {
  assertMarketplaceTenantContext(ctx);
  const valid = validateListKindQuery(query);
  const rows = await getDb().query<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS} FROM marketplace_packages
       WHERE state = ANY($1::text[])
         AND ($2::text IS NULL OR package_kind = $2::text)
       ORDER BY package_kind ASC, package_key ASC,
         version_major DESC, version_minor DESC, version_patch DESC
       LIMIT $3`,
    [[...MARKETPLACE_PUBLIC_STATES], valid.kind, valid.limit],
  );
  return rows.rows.map(mapPackage);
}

export async function listReviewQueue(
  ctx: TenantContext,
  query: ListReviewQueueQuery,
): Promise<MarketplacePackage[]> {
  assertMarketplaceTenantContext(ctx);
  if (!canAdministerMarketplace(ctx.authority)) {
    throw new MarketplaceError(
      'forbidden',
      `this operation requires the '${MARKETPLACE_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid = validateListKindQuery(query);
  const rows = await getDb().query<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS} FROM marketplace_packages
       WHERE state = ANY($1::text[])
         AND ($2::text IS NULL OR package_kind = $2::text)
       ORDER BY updated_at ASC, id ASC
       LIMIT $3`,
    [[...MARKETPLACE_REVIEW_QUEUE_STATES], valid.kind, valid.limit],
  );
  return rows.rows.map(mapPackage);
}

export async function getPackageVerification(
  ctx: TenantContext,
  query: GetPackageVerificationQuery,
): Promise<PackageVerificationInfo> {
  assertMarketplaceTenantContext(ctx);
  const valid = validateGetPackageVerificationQuery(query);
  const db = getDb();
  // Visibility is checked against the package row first (uniform
  // not-found for non-public packages of other tenants).
  const row = await findVisiblePackage(db, ctx, valid.packageId);
  const latest = await findLatestVerification(db, row.id);
  return {
    packageId: row.id,
    outcome: latest === null ? 'unverified' : (latest.outcome as 'verified' | 'failed'),
    latestRun: latest === null ? null : mapVerification(latest),
  };
}

async function findLatestVerification(
  db: Queryable,
  packageId: string,
): Promise<VerificationRow | null> {
  const result = await db.query<VerificationRow>(
    `SELECT id, package_id, outcome, checks, summary, ran_by_tenant, ran_by_principal, ran_at
       FROM marketplace_package_verifications
       WHERE package_id = $1
       ORDER BY ran_at DESC, id DESC
       LIMIT 1`,
    [packageId],
  );
  return result.rows[0] ?? null;
}

export async function listPackageVerifications(
  ctx: TenantContext,
  query: ListPackageVerificationsQuery,
): Promise<PackageVerificationRun[]> {
  assertMarketplaceTenantContext(ctx);
  const valid = validateEvidenceQuery(query);
  const db = getDb();
  await findVisiblePackage(db, ctx, valid.packageId);
  const rows = await db.query<VerificationRow>(
    `SELECT id, package_id, outcome, checks, summary, ran_by_tenant, ran_by_principal, ran_at
       FROM marketplace_package_verifications
       WHERE package_id = $1
       ORDER BY ran_at DESC, id DESC
       LIMIT $2`,
    [valid.packageId, valid.limit],
  );
  return rows.rows.map(mapVerification);
}

export async function listPackageReviews(
  ctx: TenantContext,
  query: ListPackageReviewsQuery,
): Promise<PackageReview[]> {
  assertMarketplaceTenantContext(ctx);
  const valid = validateEvidenceQuery(query);
  const db = getDb();
  await findVisiblePackage(db, ctx, valid.packageId);
  const rows = await db.query<ReviewRow>(
    `SELECT id, package_id, decision, reason, reviewed_by_tenant, reviewed_by_principal, reviewed_at
       FROM marketplace_package_reviews
       WHERE package_id = $1
       ORDER BY reviewed_at DESC, id DESC
       LIMIT $2`,
    [valid.packageId, valid.limit],
  );
  return rows.rows.map(mapReview);
}

export async function listPackageLifecycleEvents(
  ctx: TenantContext,
  query: ListPackageLifecycleEventsQuery,
): Promise<PackageLifecycleEvent[]> {
  assertMarketplaceTenantContext(ctx);
  const valid = validateEvidenceQuery(query);
  const db = getDb();
  await findVisiblePackage(db, ctx, valid.packageId);
  const rows = await db.query<LifecycleEventRow>(
    `SELECT id, package_id, transition, from_state, to_state, actor_tenant, actor, occurred_at
       FROM marketplace_package_lifecycle_events
       WHERE package_id = $1
       ORDER BY occurred_at DESC, id DESC
       LIMIT $2`,
    [valid.packageId, valid.limit],
  );
  return rows.rows.map(mapLifecycleEvent);
}
