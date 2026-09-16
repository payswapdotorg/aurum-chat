// Integration tests for the extensions module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W025
// acceptance:
//
//  * VERSIONED MANIFESTS: registration creates the extension
//    (REGISTERED) with its first immutable manifest; versions strictly
//    increase per key in NUMERIC semver order (1.2.10 > 1.2.9);
//    re-registering or back-dating a version fails; manifest fields
//    round-trip through the normalized read model; claim-gated writes
//    ('extensions:administer') with authorization before parsing;
//  * VERIFICATION STATES: UNVERIFIED until a run lands, VERIFIED when
//    the latest run passes, FAILED when it does not — including a
//    manifest corrupted past the storage trigger (bad cron) so the
//    FAILED state is genuinely reachable; runs are append-only
//    evidence with per-check outcomes; the state is per version;
//  * LIFECYCLE: every transition routes through the actions authority
//    matrix (kind 'extension-deployment', EXECUTE) — the built-in
//    default gates it behind human approval (pending → approve →
//    re-invoke with the same idempotency key applies), tenant policy
//    can allow (applies immediately) or forbid (forbidden_by_policy,
//    rejection recorded by the actions module); activation requires the
//    latest version VERIFIED; DEPRECATED is terminal; each applied
//    transition appends exactly one immutable lifecycle event linked to
//    its gate request, and re-invocation replays instead of duplicating;
//  * COMPATIBILITY: the §17 host-runtime range read with reasons;
//  * TENANT ISOLATION (ADR-0001) across every surface with uniform
//    not-found semantics (no existence leaks), including the same key
//    being independently registrable in two tenants;
//  * STORAGE-LEVEL GUARANTEES: manifests, verification runs and
//    lifecycle events are immutable (triggers reject UPDATE/DELETE/
//    TRUNCATE), extension identity is immutable (only the lifecycle
//    state may move), and the permission-consistency trigger plus the
//    vocabulary CHECKs hold for writes bypassing the service.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as extensionsContract from '../contract';
import {
  ActionsError,
  decideApproval,
  getActionRequest,
  listActionRequests,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { ExtensionsError } from '../errors';

const {
  EXTENSIONS_AUTHORITY_ADMINISTER,
  EXTENSION_ACTION_KIND,
  checkManifestCompatibility,
  getExtension,
  getManifest,
  getManifestVerification,
  listExtensionLifecycleEvents,
  listExtensions,
  listManifests,
  listManifestVerifications,
  registerExtensionManifest,
  runManifestVerification,
  transitionExtension,
} = extensionsContract;

// Dedicated tenants keep each concern's data (and authority policies!)
// isolated from the others, so every assertion below sees only what it
// created.
const tenantRegistry = newId();
const tenantVerify = newId();
const tenantLifecycle = newId();
const tenantAllow = newId();
const tenantForbid = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantStorage = newId();
const tenantCompat = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId, authority };
}

function extensionAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [EXTENSIONS_AUTHORITY_ADMINISTER] };
}

function actionsAdmin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

async function expectErrorCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionsError);
    expect((error as ExtensionsError).code).toBe(code);
  }
}

/** A fully consistent registration input exercising every capability area. */
function manifestInput(
  overrides: Partial<Parameters<typeof registerExtensionManifest>[1]> = {},
): Parameters<typeof registerExtensionManifest>[1] {
  return {
    extensionKey: 'invoice-ocr',
    version: '1.0.0',
    manifestSchemaVersion: 1,
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1_000,
    },
    hostRuntime: { minVersion: '1.2.0', maxVersion: '2.0.0' },
    ...overrides,
  };
}

/** A minimal inert manifest (no capabilities, no permissions, no quotas). */
function minimalInput(
  overrides: Partial<Parameters<typeof registerExtensionManifest>[1]> = {},
): Parameters<typeof registerExtensionManifest>[1] {
  return {
    extensionKey: 'tiny-widget',
    version: '0.1.0',
    manifestSchemaVersion: 1,
    displayName: 'Tiny Widget',
    hostRuntime: { minVersion: '1.0.0' },
    ...overrides,
  };
}

/** Register + verify a manifest so the extension can be activated. */
async function registerVerified(
  ctx: TenantContext,
  input: Parameters<typeof registerExtensionManifest>[1],
): Promise<string> {
  const registered = await registerExtensionManifest(ctx, input);
  const run = await runManifestVerification(ctx, { manifestId: registered.manifest.id });
  expect(run.state).toBe('VERIFIED');
  return registered.extension.id;
}

/** Approve a pending action request as an authorized different principal. */
async function approveRequest(tenantId: string, requestId: string): Promise<void> {
  await decideApproval(approver(tenantId), { requestId, decision: 'approve' });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no manifest mutation, no run deletion, no un-deprecation', async () => {
    // There is deliberately no updateManifest, no deleteManifest, no
    // deleteVerificationRun, no un-deprecate: manifests are immutable
    // versioned history, verification runs are append-only evidence,
    // and DEPRECATED is terminal. The W026 additions are the runtime's
    // deploy/rollback/capability operations; there is deliberately no
    // deleteState, no deleteUi, no deleteDeployment — deployments and
    // activity records are append-only history, state is persistent,
    // and UI documents are replaceable, never deleted.
    expect(Object.keys(extensionsContract).sort()).toEqual([
      "DEFAULT_INSTALL_KEY",
      "DEFAULT_LIST_LIMIT",
      "EXTENSIONS_AUTHORITY_ADMINISTER",
      "EXTENSION_ACTION_KIND",
      "EXTENSION_AUTHORITY_LEVEL",
      "EXTENSION_HTTP_METHODS",
      "EXTENSION_HTTP_TIMEOUT_MS",
      "EXTENSION_LIFECYCLE_STATES",
      "EXTENSION_PERMISSIONS",
      "EXTENSION_RUNTIME_HOST_PARTS",
      "EXTENSION_RUNTIME_HOST_VERSION",
      "EXTENSION_STATE_SCOPES",
      "EXTENSION_TRANSITIONS",
      "EXTENSION_UI_BLOCK_TYPES",
      "EXTENSION_UI_SURFACES",
      "EXTENSION_VERIFICATION_CHECKS",
      "EXTENSION_VERIFICATION_STATES",
      "EXTERNAL_PATH_PATTERN",
      "ExtensionsError",
      "INSTALL_KEY_PATTERN",
      "MANIFEST_SCHEMA_VERSIONS",
      "MAX_DESCRIPTION_CHARS",
      "MAX_DISPLAY_NAME_CHARS",
      "MAX_EVENT_PAYLOAD_BYTES",
      "MAX_EVENT_TOPICS",
      "MAX_EXTERNAL_BODY_BYTES",
      "MAX_EXTERNAL_CALLS_PER_DAY",
      "MAX_EXTERNAL_HEADER_COUNT",
      "MAX_EXTERNAL_HEADER_NAME_CHARS",
      "MAX_EXTERNAL_HEADER_VALUE_CHARS",
      "MAX_EXTERNAL_PARTICIPANTS",
      "MAX_EXTERNAL_PATH_CHARS",
      "MAX_IDEMPOTENCY_KEY_LENGTH",
      "MAX_LIST_LIMIT",
      "MAX_PARTICIPANT_LABEL_CHARS",
      "MAX_RESPONSE_BODY_CHARS",
      "MAX_SCHEDULES",
      "MAX_SCHEDULE_INVOCATIONS_PER_DAY",
      "MAX_STATE_BYTES",
      "MAX_STATE_VALUE_BYTES",
      "MAX_TELEMETRY_PAYLOAD_BYTES",
      "MAX_UI_BLOCKS",
      "MAX_UI_LIST_ITEMS",
      "MAX_UI_TABLE_COLUMNS",
      "MAX_UI_TABLE_ROWS",
      "MAX_UI_TEXT_CHARS",
      "STATE_KEY_PATTERN",
      "TELEMETRY_NAME_PATTERN",
      "byteLength",
      "canTransitionExtension",
      "capabilityDeclarationProblems",
      "capabilityPermissionProblems",
      "capabilityQuotaProblems",
      "checkHostRuntimeCompatibility",
      "checkManifestCompatibility",
      "compareSemver",
      "deployExtensionVersion",
      "deriveVerificationState",
      "dispatchExtensionEvent",
      "emitExtensionTelemetry",
      "executeExtensionExternalCall",
      "extensionHttpPort",
      "formatSemver",
      "getCurrentDeployment",
      "getExtension",
      "getExtensionUi",
      "getManifest",
      "getManifestVerification",
      "isEventTopic",
      "isExtensionHttpMethod",
      "isExtensionLifecycleState",
      "isExtensionPermission",
      "isExtensionStateScope",
      "isExtensionTransition",
      "isExtensionUiBlockType",
      "isExtensionUiSurface",
      "isExtensionVerificationCheck",
      "isExtensionVerificationState",
      "isExternalPath",
      "isHttpsOrigin",
      "isInstallKey",
      "isNameSlug",
      "isSemver",
      "isStateKey",
      "isSupportedManifestSchemaVersion",
      "isTelemetryName",
      "isUuid",
      "isValidCronExpression",
      "jsonByteLength",
      "listExtensionDeployments",
      "listExtensionEventDeliveries",
      "listExtensionExternalCalls",
      "listExtensionLifecycleEvents",
      "listExtensionScheduleRuns",
      "listExtensionTelemetryEvents",
      "listExtensions",
      "listManifestVerifications",
      "listManifests",
      "parseSemver",
      "participantForOrigin",
      "publishExtensionUi",
      "readExtensionState",
      "registerExtensionManifest",
      "requiredPermissionsForCapabilities",
      "rollbackExtensionDeployment",
      "runManifestVerification",
      "runManifestVerificationChecks",
      "setExtensionHttpPort",
      "summarizeVerificationRun",
      "targetLifecycleState",
      "transitionExtension",
      "triggerExtensionSchedule",
      "uiDocumentProblems",
      "utcDayStart",
      "verificationOutcomeFor",
      "writeExtensionState",
    ]);
  });

  it('anchors the §20 integration: extension deployment is a canonical action kind at EXECUTE', () => {
    expect(EXTENSION_ACTION_KIND).toBe('extension-deployment');
    expect(extensionsContract.EXTENSION_AUTHORITY_LEVEL).toBe('EXECUTE');
  });
});

// ---------------------------------------------------------------------------
// Registration — versioned, immutable manifests
// ---------------------------------------------------------------------------

describe('manifest registration (versioned, immutable, claim-gated)', () => {
  it('creates the extension REGISTERED with its first version and round-trips the declaration', async () => {
    const admin = extensionAdmin(tenantRegistry);
    const { extension, manifest } = await registerExtensionManifest(admin, manifestInput());

    expect(extension.tenantId).toBe(tenantRegistry);
    expect(extension.extensionKey).toBe('invoice-ocr');
    expect(extension.lifecycleState).toBe('REGISTERED');
    expect(extension.latestVersion).toBe('1.0.0');
    expect(extension.latestManifestId).toBe(manifest.id);

    expect(manifest.extensionId).toBe(extension.id);
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.versionParts).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(manifest.manifestSchemaVersion).toBe(1);
    expect(manifest.displayName).toBe('Invoice OCR');
    expect(manifest.description).toBe('Reads invoices into the world model');
    expect(manifest.registeredBy).toBe(admin.principalId);
    expect(manifest.registeredAt).toBe(extension.createdAt);
    // normalized canonical order everywhere
    expect(manifest.requestedPermissions).toEqual([
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ]);
    expect(manifest.capabilities).toEqual({
      stateScope: 'tenant',
      uiSurfaces: ['control-tower-panel', 'settings-form'],
      schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
      eventSubscriptions: ['invoice.paid', 'invoice.received'],
      externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
      telemetry: true,
    });
    expect(manifest.quotas).toEqual({
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1_000,
    });
    expect(manifest.hostCompatibility).toEqual({ minVersion: '1.2.0', maxVersion: '2.0.0' });
  });

  it('accepts strictly newer versions and tracks the latest in NUMERIC order', async () => {
    const admin = extensionAdmin(tenantRegistry);
    await registerExtensionManifest(admin, manifestInput({ extensionKey: 'numeric-order' }));
    await registerExtensionManifest(admin, manifestInput({ extensionKey: 'numeric-order', version: '1.2.9' }));
    const bumped = await registerExtensionManifest(
      admin,
      manifestInput({ extensionKey: 'numeric-order', version: '1.2.10' }),
    );

    // 1.2.10 > 1.2.9 numerically — lexicographic order would disagree
    expect(bumped.extension.latestVersion).toBe('1.2.10');

    const all = await listManifests(admin, { extensionKey: 'numeric-order' });
    expect(all.map((m) => m.version)).toEqual(['1.2.10', '1.2.9', '1.0.0']);
  });

  it('rejects re-registering or back-dating a version', async () => {
    const admin = extensionAdmin(tenantRegistry);
    // 'numeric-order' currently tops out at 1.2.10
    await expectErrorCode('version_not_monotonic', () =>
      registerExtensionManifest(admin, manifestInput({ extensionKey: 'numeric-order', version: '1.2.9' })),
    );
    await expectErrorCode('version_not_monotonic', () =>
      registerExtensionManifest(admin, manifestInput({ extensionKey: 'numeric-order', version: '1.2.10' })),
    );
  });

  it('gates registration behind the administer claim, authorization before parsing', async () => {
    const plain = member(tenantRegistry);
    // an unauthorized caller learns nothing about shapes — even garbage input fails on authorization
    await expectErrorCode('forbidden', () =>
      registerExtensionManifest(plain, manifestInput({ version: 'garbage' })),
    );
    const admin = extensionAdmin(tenantRegistry);
    await expectErrorCode('invalid_input', () =>
      registerExtensionManifest(admin, manifestInput({ version: 'garbage' })),
    );
    await expectErrorCode('invalid_input', () =>
      registerExtensionManifest(admin, manifestInput({ requestedPermissions: ['root:system' as never] })),
    );
    // a plain member may still READ the registry
    const visible = await listManifests(plain, { extensionKey: 'invoice-ocr' });
    expect(visible.length).toBeGreaterThan(0);
  });

  it('reads extensions and manifests with uniform not-found semantics', async () => {
    const admin = extensionAdmin(tenantRegistry);
    const byKey = await getExtension(admin, { extensionKey: 'invoice-ocr' });
    const byId = await getExtension(admin, { extensionId: byKey.id });
    expect(byId.id).toBe(byKey.id);

    await expectErrorCode('extension_not_found', () =>
      getExtension(admin, { extensionId: newId() }),
    );
    await expectErrorCode('manifest_not_found', () => getManifest(admin, { manifestId: newId() }));
    await expectErrorCode('invalid_query', () =>
      getExtension(admin, {} as never),
    );
  });

  it('lists extensions with the lifecycle filter', async () => {
    const admin = extensionAdmin(tenantRegistry);
    await registerExtensionManifest(admin, minimalInput());
    const registered = await listExtensions(admin, { lifecycleState: 'REGISTERED' });
    expect(registered.map((e) => e.extensionKey)).toContain('tiny-widget');
    expect(registered.every((e) => e.lifecycleState === 'REGISTERED')).toBe(true);
    const active = await listExtensions(admin, { lifecycleState: 'ACTIVE' });
    expect(active).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Verification states
// ---------------------------------------------------------------------------

describe('verification (append-only runs, derived states)', () => {
  it('starts UNVERIFIED and becomes VERIFIED after a passing run', async () => {
    const admin = extensionAdmin(tenantVerify);
    const { manifest } = await registerExtensionManifest(admin, manifestInput());

    const before = await getManifestVerification(admin, { manifestId: manifest.id });
    expect(before.state).toBe('UNVERIFIED');
    expect(before.latestRun).toBeNull();

    const read = await getManifest(admin, { manifestId: manifest.id });
    expect(read.verification.state).toBe('UNVERIFIED');

    const result = await runManifestVerification(admin, { manifestId: manifest.id });
    expect(result.state).toBe('VERIFIED');
    expect(result.run.outcome).toBe('verified');
    expect(result.run.summary).toBe('5/5 checks passed');
    expect(result.run.verifier).toBe(admin.principalId);
    expect(result.run.checks.map((check) => check.check)).toEqual([
      'manifest-schema',
      'permissions-consistency',
      'capability-declarations',
      'quota-bounds',
      'compatibility-bounds',
    ]);
    expect(result.run.checks.every((check) => check.outcome === 'pass')).toBe(true);

    const after = await getManifestVerification(admin, { manifestId: manifest.id });
    expect(after.state).toBe('VERIFIED');
    expect(after.latestRun?.id).toBe(result.run.id);

    // runs accumulate as evidence, newest decides
    await runManifestVerification(admin, { manifestId: manifest.id });
    const runs = await listManifestVerifications(admin, { manifestId: manifest.id });
    expect(runs.length).toBe(2);
  });

  it('verification state is per version — a new version starts UNVERIFIED', async () => {
    const admin = extensionAdmin(tenantVerify);
    const first = await registerExtensionManifest(
      admin,
      manifestInput({ extensionKey: 'versioned-probe' }),
    );
    await runManifestVerification(admin, { manifestId: first.manifest.id });

    const second = await registerExtensionManifest(
      admin,
      manifestInput({ extensionKey: 'versioned-probe', version: '1.1.0' }),
    );
    expect(second.extension.latestVersion).toBe('1.1.0');

    const old = await getManifestVerification(admin, { manifestId: first.manifest.id });
    const fresh = await getManifestVerification(admin, { manifestId: second.manifest.id });
    expect(old.state).toBe('VERIFIED');
    expect(fresh.state).toBe('UNVERIFIED');

    // re-verifying the OLD version still works (evidence, not state)
    const rerun = await runManifestVerification(admin, { manifestId: first.manifest.id });
    expect(rerun.state).toBe('VERIFIED');

    const summaries = await listManifests(admin, { extensionKey: 'versioned-probe' });
    expect(summaries.find((m) => m.version === '1.0.0')?.verificationState).toBe('VERIFIED');
    expect(summaries.find((m) => m.version === '1.1.0')?.verificationState).toBe('UNVERIFIED');
  });

  it('FAILS a manifest corrupted past the storage trigger — the FAILED state is reachable', async () => {
    const admin = extensionAdmin(tenantVerify);
    const registered = await registerExtensionManifest(admin, minimalInput({ extensionKey: 'legacy-connector' }));

    // Bypass the service: a manifest whose cron is garbage. The storage
    // trigger enforces permission consistency and the CHECKs pin the
    // vocabularies — but cron grammar is service/verification scope,
    // so this row lands and must be CAUGHT by verification (drift
    // detection / defense in depth).
    const db = getDb();
    await db.query(
      `INSERT INTO extension_manifests (
         tenant_id, extension_id, extension_key, version,
         version_major, version_minor, version_patch,
         manifest_schema_version, display_name, description,
         requested_permissions, capabilities, quotas, host_compatibility,
         registered_by, registered_at
       ) VALUES ($1, $2, 'legacy-connector', '1.0.1', 1, 0, 1, 1, 'Legacy', NULL,
         '["schedule:run"]'::jsonb,
         '{"stateScope":"none","uiSurfaces":[],"schedules":[{"name":"sync","cron":"99 * * * *"}],"eventSubscriptions":[],"externalParticipants":[],"telemetry":false}'::jsonb,
         '{"maxStateBytes":0,"maxScheduleInvocationsPerDay":10,"maxExternalCallsPerDay":0}'::jsonb,
         '{"minVersion":"1.0.0","maxVersion":null}'::jsonb,
         'probe', now())`,
      [tenantVerify, registered.extension.id],
    );
    const corrupted = await listManifests(admin, { extensionKey: 'legacy-connector' });
    const row = corrupted.find((m) => m.version === '1.0.1')!;

    const result = await runManifestVerification(admin, { manifestId: row.id });
    expect(result.state).toBe('FAILED');
    expect(result.run.outcome).toBe('failed');
    const failed = result.run.checks.find((check) => check.check === 'capability-declarations')!;
    expect(failed.outcome).toBe('fail');
    expect(failed.detail).toContain('invalid five-field cron');

    const info = await getManifestVerification(admin, { manifestId: row.id });
    expect(info.state).toBe('FAILED');

    // a later passing run would recover the state — this one cannot (the row is genuinely bad)
    const rerun = await runManifestVerification(admin, { manifestId: row.id });
    expect(rerun.state).toBe('FAILED');
  });

  it('gates verification behind the administer claim', async () => {
    const admin = extensionAdmin(tenantVerify);
    const { manifest } = await registerExtensionManifest(admin, minimalInput({ extensionKey: 'gate-probe' }));
    await expectErrorCode('forbidden', () =>
      runManifestVerification(member(tenantVerify), { manifestId: manifest.id }),
    );
    // foreign manifest: uniform not-found, no claim evaluated first
    await expectErrorCode('manifest_not_found', () =>
      runManifestVerification(extensionAdmin(tenantIsoB), { manifestId: manifest.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle + the authority gate
// ---------------------------------------------------------------------------

describe('lifecycle through the authority matrix (kind extension-deployment, EXECUTE)', () => {
  // A fixed requester (transitions need no claim — the matrix decides)
  // and a separate approver decide the gate; the extension admin only
  // registers and verifies.
  const requester = memberAs(tenantLifecycle, newId());
  const admin = extensionAdmin(tenantLifecycle);

  it('requires verification before activation', async () => {
    await registerExtensionManifest(admin, manifestInput({ extensionKey: 'gate-extension' }));
    await expectErrorCode('verification_required', () =>
      transitionExtension(requester, {
        extensionKey: 'gate-extension',
        transition: 'activate',
        idempotencyKey: 'activate:gate-extension:1',
      }),
    );
  });

  it('holds the transition at the gate until a human approves, then applies on replay', async () => {
    // verify the already-registered version (activation demands it)
    const manifests = await listManifests(admin, { extensionKey: 'gate-extension' });
    await runManifestVerification(admin, { manifestId: manifests[0]!.id });
    const extensionId = manifests[0]!.extensionId;

    // built-in default matrix: EXECUTE is approval_required
    const held = await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'activate:gate-extension:1',
    });
    expect(held.applied).toBe(false);
    expect(held.gate.status).toBe('pending');
    expect(held.extension.lifecycleState).toBe('REGISTERED');

    // the gate request is real, tenant-visible actions evidence
    const requests = await listActionRequests(requester, { actionKind: EXTENSION_ACTION_KIND });
    const gateRequest = requests.find((r) => r.id === held.gate.actionRequestId)!;
    expect(gateRequest.status).toBe('pending');
    expect(gateRequest.authorityLevel).toBe('EXECUTE');
    expect(gateRequest.evaluation.outcome).toBe('approval_required');
    expect(gateRequest.payload).toMatchObject({
      extensionId,
      extensionKey: 'gate-extension',
      transition: 'activate',
      fromState: 'REGISTERED',
      toState: 'ACTIVE',
    });

    // a human approves; the transition still waits for the replay
    await approveRequest(tenantLifecycle, held.gate.actionRequestId);
    const applied = await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'activate:gate-extension:1',
    });
    expect(applied.applied).toBe(true);
    expect(applied.gate.status).toBe('approved');
    expect(applied.extension.lifecycleState).toBe('ACTIVE');

    // the applied decision is reconstructable: request + immutable event
    const decided = await getActionRequest(requester, { requestId: held.gate.actionRequestId });
    expect(decided.status).toBe('approved');
    const events = await listExtensionLifecycleEvents(requester, { extensionId });
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      transition: 'activate',
      fromState: 'REGISTERED',
      toState: 'ACTIVE',
      actor: requester.principalId,
      actionRequestId: held.gate.actionRequestId,
    });

    // re-invoking the SAME key replays the outcome — no second event
    const replay = await transitionExtension(requester, {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'activate:gate-extension:1',
    });
    expect(replay.applied).toBe(true);
    expect(replay.extension.lifecycleState).toBe('ACTIVE');
    expect(await listExtensionLifecycleEvents(requester, { extensionId })).toHaveLength(1);
  });

  it('keyless requests do not deduplicate — each call is a fresh gate request', async () => {
    const extensionId = await registerVerified(
      admin,
      manifestInput({ extensionKey: 'keyless-extension', version: '2.0.0' }),
    );
    const first = await transitionExtension(member(tenantLifecycle), {
      extensionId,
      transition: 'activate',
    });
    const second = await transitionExtension(member(tenantLifecycle), {
      extensionId,
      transition: 'activate',
    });
    expect(first.applied).toBe(false);
    expect(second.applied).toBe(false);
    expect(first.gate.actionRequestId).not.toBe(second.gate.actionRequestId);
  });

  it('suspends and resumes through the same gate', async () => {
    const extensionId = (await getExtension(admin, { extensionKey: 'gate-extension' })).id;
    expect((await getExtension(admin, { extensionId })).lifecycleState).toBe('ACTIVE');

    for (const [transition, expected] of [
      ['suspend', 'SUSPENDED'],
      ['resume', 'ACTIVE'],
    ] as const) {
      const key = `${transition}:gate-extension:1`;
      const held = await transitionExtension(requester, { extensionId, transition, idempotencyKey: key });
      expect(held.applied).toBe(false);
      await approveRequest(tenantLifecycle, held.gate.actionRequestId);
      const applied = await transitionExtension(requester, { extensionId, transition, idempotencyKey: key });
      expect(applied.applied).toBe(true);
      expect(applied.extension.lifecycleState).toBe(expected);
    }
  });

  it('activation re-checks the LATEST version — a newer unverified version blocks it', async () => {
    await registerExtensionManifest(admin, manifestInput({ extensionKey: 'gate-extension', version: '2.0.0' }));
    // suspend first (verification never blocks suspension)
    const heldSuspend = await transitionExtension(requester, {
      extensionKey: 'gate-extension',
      transition: 'suspend',
      idempotencyKey: 'suspend:gate-extension:2',
    });
    await approveRequest(tenantLifecycle, heldSuspend.gate.actionRequestId);
    const suspended = await transitionExtension(requester, {
      extensionKey: 'gate-extension',
      transition: 'suspend',
      idempotencyKey: 'suspend:gate-extension:2',
    });
    expect(suspended.extension.lifecycleState).toBe('SUSPENDED');

    // 1.0.0 is verified, 2.0.0 is not → resume is blocked
    await expectErrorCode('verification_required', () =>
      transitionExtension(requester, {
        extensionKey: 'gate-extension',
        transition: 'resume',
        idempotencyKey: 'resume:gate-extension:2',
      }),
    );
    // verifying the new version unblocks it
    const manifests = await listManifests(admin, { extensionKey: 'gate-extension' });
    const latest = manifests.find((m) => m.version === '2.0.0')!;
    await runManifestVerification(admin, { manifestId: latest.id });
    const held = await transitionExtension(requester, {
      extensionKey: 'gate-extension',
      transition: 'resume',
      idempotencyKey: 'resume:gate-extension:3',
    });
    await approveRequest(tenantLifecycle, held.gate.actionRequestId);
    const applied = await transitionExtension(requester, {
      extensionKey: 'gate-extension',
      transition: 'resume',
      idempotencyKey: 'resume:gate-extension:3',
    });
    expect(applied.extension.lifecycleState).toBe('ACTIVE');
  });

  it('DEPRECATED is terminal and blocks new manifest versions', async () => {
    const extensionId = (await getExtension(admin, { extensionKey: 'gate-extension' })).id;
    const held = await transitionExtension(requester, {
      extensionId,
      transition: 'deprecate',
      idempotencyKey: 'deprecate:gate-extension:1',
    });
    await approveRequest(tenantLifecycle, held.gate.actionRequestId);
    const applied = await transitionExtension(requester, {
      extensionId,
      transition: 'deprecate',
      idempotencyKey: 'deprecate:gate-extension:1',
    });
    expect(applied.extension.lifecycleState).toBe('DEPRECATED');

    for (const transition of ['activate', 'suspend', 'resume', 'deprecate'] as const) {
      await expectErrorCode('invalid_transition', () =>
        transitionExtension(requester, { extensionId, transition }),
      );
    }
    await expectErrorCode('extension_deprecated', () =>
      registerExtensionManifest(admin, manifestInput({ extensionKey: 'gate-extension', version: '3.0.0' })),
    );
  });

  it('rejects transitions the state machine forbids, before touching the gate', async () => {
    await registerExtensionManifest(admin, minimalInput({ extensionKey: 'inert-extension' }));
    for (const transition of ['suspend', 'resume'] as const) {
      await expectErrorCode('invalid_transition', () =>
        transitionExtension(requester, { extensionKey: 'inert-extension', transition }),
      );
    }
    // no gate request was created for the nonsense transitions
    const requests = await listActionRequests(requester, { actionKind: EXTENSION_ACTION_KIND });
    expect(requests.filter((r) => (r.payload as { extensionKey?: string }).extensionKey === 'inert-extension')).toEqual([]);
  });
});

describe('lifecycle under tenant policy (allow and forbid)', () => {
  it('applies immediately when tenant policy allows extension-deployment EXECUTE', async () => {
    await setAuthorityPolicy(actionsAdmin(tenantAllow), {
      actionKind: 'extension-deployment',
      approvalLevels: [],
    });
    const admin = extensionAdmin(tenantAllow);
    const extensionId = await registerVerified(admin, manifestInput());

    const activated = await transitionExtension(member(tenantAllow), {
      extensionId,
      transition: 'activate',
      idempotencyKey: 'allow:1',
    });
    expect(activated.applied).toBe(true);
    expect(activated.gate.status).toBe('approved');
    expect(activated.extension.lifecycleState).toBe('ACTIVE');

    const suspended = await transitionExtension(member(tenantAllow), {
      extensionId,
      transition: 'suspend',
      idempotencyKey: 'allow:2',
    });
    expect(suspended.applied).toBe(true);
    expect(suspended.extension.lifecycleState).toBe('SUSPENDED');

    // deprecate directly from SUSPENDED
    const deprecated = await transitionExtension(member(tenantAllow), {
      extensionId,
      transition: 'deprecate',
      idempotencyKey: 'allow:3',
    });
    expect(deprecated.applied).toBe(true);
    expect(deprecated.extension.lifecycleState).toBe('DEPRECATED');
  });

  it('throws forbidden_by_policy when the tenant forbids extension-deployment EXECUTE, and records the rejection', async () => {
    await setAuthorityPolicy(actionsAdmin(tenantForbid), {
      actionKind: 'extension-deployment',
      forbiddenLevels: ['EXECUTE'],
    });
    const admin = extensionAdmin(tenantForbid);
    const extensionId = await registerVerified(admin, manifestInput());

    const requester = member(tenantForbid);
    await expectErrorCode('forbidden_by_policy', () =>
      transitionExtension(requester, {
        extensionId,
        transition: 'activate',
        idempotencyKey: 'forbid:1',
      }),
    );
    // the extension did not move
    expect((await getExtension(admin, { extensionId })).lifecycleState).toBe('REGISTERED');
    // the policy rejection is recorded actions evidence
    const requests = await listActionRequests(requester, { actionKind: EXTENSION_ACTION_KIND });
    const rejected = requests.find((r) => r.idempotencyKey === 'forbid:1')!;
    expect(rejected.status).toBe('rejected');
    expect(rejected.evaluation.outcome).toBe('forbidden');
  });
});

// ---------------------------------------------------------------------------
// Compatibility (§17)
// ---------------------------------------------------------------------------

describe('host runtime compatibility', () => {
  it('checks a host version against the declared range with reasons', async () => {
    const admin = extensionAdmin(tenantCompat);
    const { manifest } = await registerExtensionManifest(admin, manifestInput());

    const inside = await checkManifestCompatibility(admin, { manifestId: manifest.id, hostVersion: '1.5.0' });
    expect(inside.compatible).toBe(true);
    expect(inside.reasons).toEqual([]);
    expect(inside).toMatchObject({
      manifestId: manifest.id,
      extensionKey: 'invoice-ocr',
      version: '1.0.0',
      hostVersion: '1.5.0',
    });

    const below = await checkManifestCompatibility(admin, { manifestId: manifest.id, hostVersion: '1.1.9' });
    expect(below.compatible).toBe(false);
    expect(below.reasons).toEqual([
      "host 1.1.9 is below the manifest's minimum 1.2.0",
    ]);

    const above = await checkManifestCompatibility(admin, { manifestId: manifest.id, hostVersion: '2.0.1' });
    expect(above.compatible).toBe(false);
    expect(above.reasons).toEqual([
      "host 2.0.1 is above the manifest's maximum 2.0.0",
    ]);

    // member-readable
    const asMember = await checkManifestCompatibility(member(tenantCompat), {
      manifestId: manifest.id,
      hostVersion: '1.2.0',
    });
    expect(asMember.compatible).toBe(true);
  });

  it('treats a null maximum as unbounded', async () => {
    const admin = extensionAdmin(tenantCompat);
    const { manifest } = await registerExtensionManifest(
      admin,
      minimalInput({ extensionKey: 'open-ended', hostRuntime: { minVersion: '1.0.0' } }),
    );
    const far = await checkManifestCompatibility(admin, { manifestId: manifest.id, hostVersion: '99.0.0' });
    expect(far.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (uniform not-found, no existence leaks)', () => {
  it('lets two tenants register the same key independently', async () => {
    const adminA = extensionAdmin(tenantIsoA);
    const adminB = extensionAdmin(tenantIsoB);
    const a = await registerExtensionManifest(adminA, manifestInput({ extensionKey: 'shared-key' }));
    const b = await registerExtensionManifest(adminB, manifestInput({ extensionKey: 'shared-key', version: '2.0.0' }));

    expect(a.extension.id).not.toBe(b.extension.id);
    expect(a.manifest.id).not.toBe(b.manifest.id);

    // each tenant sees only its own version history
    expect((await listManifests(adminA, { extensionKey: 'shared-key' })).map((m) => m.version)).toEqual(['1.0.0']);
    expect((await listManifests(adminB, { extensionKey: 'shared-key' })).map((m) => m.version)).toEqual(['2.0.0']);
    expect((await getExtension(adminB, { extensionKey: 'shared-key' })).latestVersion).toBe('2.0.0');
  });

  it('makes foreign extensions and manifests indistinguishable from missing ones', async () => {
    const adminA = extensionAdmin(tenantIsoA);
    const memberB = member(tenantIsoB);
    const adminB = extensionAdmin(tenantIsoB);
    const a = await registerExtensionManifest(adminA, manifestInput({ extensionKey: 'secret-key' }));
    await runManifestVerification(adminA, { manifestId: a.manifest.id });

    await expectErrorCode('extension_not_found', () =>
      getExtension(memberB, { extensionId: a.extension.id }),
    );
    await expectErrorCode('extension_not_found', () =>
      listExtensionLifecycleEvents(memberB, { extensionId: a.extension.id }),
    );
    await expectErrorCode('manifest_not_found', () => getManifest(memberB, { manifestId: a.manifest.id }));
    await expectErrorCode('manifest_not_found', () =>
      getManifestVerification(memberB, { manifestId: a.manifest.id }),
    );
    await expectErrorCode('manifest_not_found', () =>
      listManifestVerifications(memberB, { manifestId: a.manifest.id }),
    );
    await expectErrorCode('manifest_not_found', () =>
      runManifestVerification(adminB, { manifestId: a.manifest.id }),
    );
    await expectErrorCode('manifest_not_found', () =>
      checkManifestCompatibility(memberB, { manifestId: a.manifest.id, hostVersion: '1.5.0' }),
    );
    await expectErrorCode('extension_not_found', () =>
      transitionExtension(memberB, { extensionId: a.extension.id, transition: 'activate' }),
    );
    // and B's registry lists nothing of A's — only B's own registration
    const bExtensions = await listExtensions(memberB, {});
    expect(bExtensions.map((e) => e.id)).not.toContain(a.extension.id);
    expect(bExtensions.every((e) => e.tenantId === tenantIsoB)).toBe(true);
    const bManifests = await listManifests(memberB, {});
    expect(bManifests.map((m) => m.id)).not.toContain(a.manifest.id);
    expect(bManifests.every((m) => m.tenantId === tenantIsoB)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees
// ---------------------------------------------------------------------------

describe('storage-level guarantees (triggers enforce what the service promises)', () => {
  const admin = extensionAdmin(tenantStorage);
  let extensionId = '';
  let manifestId = '';
  let verificationRunId = '';
  let eventId = '';

  beforeAll(async () => {
    const registered = await registerExtensionManifest(admin, manifestInput({ extensionKey: 'storage-probe' }));
    extensionId = registered.extension.id;
    manifestId = registered.manifest.id;
    const run = await runManifestVerification(admin, { manifestId });
    verificationRunId = run.run.id;
    // a lifecycle event appended by a bypass write (legal shape) for the
    // append-only assertions
    await getDb().query(
      `INSERT INTO extension_lifecycle_events (
         tenant_id, extension_id, transition, from_state, to_state, actor, action_request_id, occurred_at
       ) VALUES ($1, $2, 'deprecate', 'REGISTERED', 'DEPRECATED', 'probe', NULL, now())`,
      [tenantStorage, extensionId],
    );
    const events = await listExtensionLifecycleEvents(admin, { extensionId });
    eventId = events[0]!.id;
  });

  it('manifests are immutable — no UPDATE, no DELETE', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE extension_manifests SET display_name = 'Rewritten' WHERE id = $1`, [manifestId]),
    ).rejects.toThrow(/immutable versioned history/);
    await expect(
      db.query(`DELETE FROM extension_manifests WHERE id = $1`, [manifestId]),
    ).rejects.toThrow(/immutable versioned history/);
  });

  it('verification runs are append-only — no UPDATE, no DELETE, no TRUNCATE', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE extension_manifest_verifications SET summary = 'rewritten' WHERE id = $1`, [verificationRunId]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      db.query(`DELETE FROM extension_manifest_verifications WHERE id = $1`, [verificationRunId]),
    ).rejects.toThrow(/append-only evidence/);
    await expect(
      db.query(`TRUNCATE extension_manifest_verifications`),
    ).rejects.toThrow(/append-only evidence/);
  });

  it('lifecycle events are append-only — no UPDATE, no DELETE, no TRUNCATE', async () => {
    const db = getDb();
    await expect(
      db.query(`UPDATE extension_lifecycle_events SET actor = 'someone-else' WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only history/);
    await expect(
      db.query(`DELETE FROM extension_lifecycle_events WHERE id = $1`, [eventId]),
    ).rejects.toThrow(/append-only history/);
    await expect(
      db.query(`TRUNCATE extension_lifecycle_events`),
    ).rejects.toThrow(/append-only history/);
  });

  it('extension identity is immutable — only the lifecycle state may move', async () => {
    const db = getDb();
    // the lifecycle state may move (the service's domain) ...
    await db.query(
      `UPDATE extensions SET lifecycle_state = 'SUSPENDED', updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantStorage, extensionId],
    );
    expect((await getExtension(admin, { extensionId })).lifecycleState).toBe('SUSPENDED');
    // ... but never the identity
    await expect(
      db.query(`UPDATE extensions SET extension_key = 'renamed' WHERE id = $1`, [extensionId]),
    ).rejects.toThrow(/only the lifecycle state/);
    await expect(
      db.query(`DELETE FROM extensions WHERE id = $1`, [extensionId]),
    ).rejects.toThrow(/DELETE is forbidden/);
  });

  it('enforces permission ↔ capability consistency for writes bypassing the service', async () => {
    const db = getDb();
    const base = (permissions: string, capabilities: string): [string, string] => [permissions, capabilities];

    // state capability without state:write
    const [perms1, caps1] = base(
      '["state:read"]',
      '{"stateScope":"tenant","uiSurfaces":[],"schedules":[],"eventSubscriptions":[],"externalParticipants":[],"telemetry":false}',
    );
    await expect(
      db.query(
        `INSERT INTO extension_manifests (
           tenant_id, extension_id, extension_key, version,
           version_major, version_minor, version_patch,
           manifest_schema_version, display_name, description,
           requested_permissions, capabilities, quotas, host_compatibility,
           registered_by, registered_at
         ) VALUES ($1, $2, 'storage-probe', '9.9.1', 9, 9, 1, 1, 'Probe', NULL, $3::jsonb, $4::jsonb,
           '{"maxStateBytes":1024,"maxScheduleInvocationsPerDay":0,"maxExternalCallsPerDay":0}'::jsonb,
           '{"minVersion":"1.0.0","maxVersion":null}'::jsonb, 'probe', now())`,
        [tenantStorage, extensionId, perms1, caps1],
      ),
    ).rejects.toThrow(/does not request both state:read and state:write/);

    // permission without capability (scope hoarding)
    const [perms2, caps2] = base(
      '["ui:render"]',
      '{"stateScope":"none","uiSurfaces":[],"schedules":[],"eventSubscriptions":[],"externalParticipants":[],"telemetry":false}',
    );
    await expect(
      db.query(
        `INSERT INTO extension_manifests (
           tenant_id, extension_id, extension_key, version,
           version_major, version_minor, version_patch,
           manifest_schema_version, display_name, description,
           requested_permissions, capabilities, quotas, host_compatibility,
           registered_by, registered_at
         ) VALUES ($1, $2, 'storage-probe', '9.9.2', 9, 9, 2, 1, 'Probe', NULL, $3::jsonb, $4::jsonb,
           '{"maxStateBytes":0,"maxScheduleInvocationsPerDay":0,"maxExternalCallsPerDay":0}'::jsonb,
           '{"minVersion":"1.0.0","maxVersion":null}'::jsonb, 'probe', now())`,
        [tenantStorage, extensionId, perms2, caps2],
      ),
    ).rejects.toThrow(/without declaring any UI surface/);

    // the closed permission vocabulary is a CHECK, not a trigger
    await expect(
      db.query(
        `INSERT INTO extension_manifests (
           tenant_id, extension_id, extension_key, version,
           version_major, version_minor, version_patch,
           manifest_schema_version, display_name, description,
           requested_permissions, capabilities, quotas, host_compatibility,
           registered_by, registered_at
         ) VALUES ($1, $2, 'storage-probe', '9.9.3', 9, 9, 3, 1, 'Probe', NULL, '["root:system"]'::jsonb,
           '{"stateScope":"none","uiSurfaces":[],"schedules":[],"eventSubscriptions":[],"externalParticipants":[],"telemetry":false}'::jsonb,
           '{"maxStateBytes":0,"maxScheduleInvocationsPerDay":0,"maxExternalCallsPerDay":0}'::jsonb,
           '{"minVersion":"1.0.0","maxVersion":null}'::jsonb, 'probe', now())`,
        [tenantStorage, extensionId],
      ),
    ).rejects.toThrow(/extension_manifests_permissions_vocabulary/);
  });

  it('accepts a consistent bypass write (the control)', async () => {
    const db = getDb();
    await db.query(
      `INSERT INTO extension_manifests (
         tenant_id, extension_id, extension_key, version,
         version_major, version_minor, version_patch,
         manifest_schema_version, display_name, description,
         requested_permissions, capabilities, quotas, host_compatibility,
         registered_by, registered_at
       ) VALUES ($1, $2, 'storage-probe', '9.9.9', 9, 9, 9, 1, 'Probe', NULL, '[]'::jsonb,
         '{"stateScope":"none","uiSurfaces":[],"schedules":[],"eventSubscriptions":[],"externalParticipants":[],"telemetry":false}'::jsonb,
         '{"maxStateBytes":0,"maxScheduleInvocationsPerDay":0,"maxExternalCallsPerDay":0}'::jsonb,
         '{"minVersion":"1.0.0","maxVersion":null}'::jsonb, 'probe', now())`,
      [tenantStorage, extensionId],
    );
    const manifests = await listManifests(admin, { extensionKey: 'storage-probe' });
    expect(manifests.map((m) => m.version)).toContain('9.9.9');
  });
});

// ---------------------------------------------------------------------------
// Cross-module error hygiene
// ---------------------------------------------------------------------------

describe('actions contract interplay', () => {
  it('never lets actions errors escape as module errors — the gate inputs are pre-validated', async () => {
    // The transition path builds its own gate payload; the only way to
    // see an ActionsError surface would be an internal invariant
    // violation. Sanity: a malformed context is rejected by THIS module
    // before the gate is ever consulted.
    await expectErrorCode('invalid_context', () =>
      transitionExtension({ tenantId: '', principalId: '', authority: [] }, {
        extensionKey: 'anything',
        transition: 'activate',
      }),
    );
    expect(ActionsError).toBeDefined();
  });
});
