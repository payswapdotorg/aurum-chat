// Product surface (W064) — API request handling for
// /api/product/marketplace/**.
//
// The same thin-adapter discipline the tower and the W057 shell follow
// (IMPLEMENTATION-STACK §5): resolve the explicit tenant context from
// headers/query (the documented development seam), delegate to module
// contracts and the install composition, map errors to HTTP-ish
// outcomes. No handler logic lives in the route.ts files themselves, so
// the whole write surface is testable without booting Next.js.
//
// WRITES EXPOSED (each maps to exactly one contract operation or one
// install composition — nothing else):
//   package  : submit | verify | review | publish | make-installable | install
//   extension: deploy | rollback | activate | suspend | resume | deprecate
//   developer: create-extension-package | create-agent-package |
//              request-build | advance-build | cancel-build
//
// The read side is the server pages themselves (view builders above);
// these handlers are the product's ONLY write surface for the area.

import type { TenantContext } from '@/infra/tenant';
import { resolveSessionRequest } from '@/app/lib/session';
import { ExtensionsError } from '@/modules/extensions/contract';
import {
  cancelExtensionBuild,
  deployExtensionVersion,
  isExtensionPermission,
  requestExtensionBuild,
  rollbackExtensionDeployment,
  runExtensionBuild,
  transitionExtension,
} from '@/modules/extensions/contract';
import type { ExtensionBuildPhase, ExtensionTransition } from '@/modules/extensions/contract';
import { AgentsError, isAgentPermissionScope, isAgentRuntimeProvider } from '@/modules/agents/contract';
import { MarketplaceError } from '@/modules/marketplace/contract';
import {
  createPackage,
  getPackage,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} from '@/modules/marketplace/contract';
import { installPackage } from './install';
import type { InstallReport } from './install';

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult =
  | { status: 200; body: Record<string, unknown> }
  | ApiError;

function apiError(status: ApiErrorStatus, error: string, message: string): ApiError {
  return { status, body: { error, message } };
}

/** Map a session-resolution failure to its API outcome (W058). */
function marketplaceContextError(failure: string, detail: string): ApiError {
  if (failure === 'unauthenticated') return apiError(401, failure, detail);
  return apiError(409, failure, detail);
}

// ---------------------------------------------------------------------------
// Context resolution for this surface
// ---------------------------------------------------------------------------

export type MarketplaceContextResolution =
  | { ok: true; context: TenantContext }
  | { ok: false; failure: string; detail: string };

/**
 * Resolve the context for a WRITE (W058: from the session cookie — the
 * header/query seam is gone). Writes always need a real caller: an
 * anonymous request cannot write anything, and a session without an
 * active company has no scope to write within (the public browsing
 * context of the catalog pages is read-only by construction).
 */
export async function writeContextFromRequest(
  request: Request,
): Promise<MarketplaceContextResolution> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return { ok: false, failure: 'unauthenticated', detail: 'no session for this request' };
  }
  if (resolution.status === 'no-company') {
    return {
      ok: false,
      failure: 'no_active_company',
      detail: 'the session has no active company — complete onboarding first',
    };
  }
  return { ok: true, context: resolution.context };
}

// ---------------------------------------------------------------------------
// Body parsing (pure, unit-testable)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a permission list from a body value (string[] or missing → null). */
export function parsePermissionList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '' && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

export type ParsedPackageReviewBody =
  | { ok: true; decision: 'approve' | 'reject'; reason: string | null }
  | { ok: false; error: string };

/** The review decision body: decision required; reason required on reject. */
export function parseReviewBody(body: unknown): ParsedPackageReviewBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const decision = body['decision'];
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, error: "'decision' must be 'approve' or 'reject'" };
  }
  const reason = body['reason'];
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return { ok: false, error: "'reason' must be a string or null" };
  }
  const reasonText = (reason as string | null | undefined) ?? null;
  if (decision === 'reject' && (reasonText === null || reasonText.trim() === '')) {
    return { ok: false, error: 'a rejection requires a reason — record why the platform refused' };
  }
  return { ok: true, decision, reason: reasonText };
}

export type ParsedCreateExtensionPackageBody =
  | { ok: true; manifestId: string; packageKey: string | null }
  | { ok: false; error: string };

/** The extension-package publish body: manifestId required, key optional. */
export function parseCreateExtensionPackageBody(body: unknown): ParsedCreateExtensionPackageBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const manifestId = body['manifestId'];
  if (typeof manifestId !== 'string' || manifestId.trim() === '') {
    return { ok: false, error: "'manifestId' is required — the manifest version to freeze" };
  }
  const packageKey = body['packageKey'];
  if (packageKey !== undefined && packageKey !== null && typeof packageKey !== 'string') {
    return { ok: false, error: "'packageKey' must be a string or null" };
  }
  const key = (packageKey as string | null | undefined) ?? null;
  if (key !== null && key.trim() === '') {
    return { ok: false, error: "'packageKey' cannot be empty — omit it to use the extension key" };
  }
  return { ok: true, manifestId, packageKey: key };
}

export type ParsedCreateAgentPackageBody =
  | {
      ok: true;
      packageKey: string;
      version: string;
      displayName: string;
      description: string | null;
      role: string;
      instructions: string;
      provider: string;
      permissions: string[];
    }
  | { ok: false; error: string };

/** The agent-package publish body (the whole blueprint). */
export function parseCreateAgentPackageBody(body: unknown): ParsedCreateAgentPackageBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const strings: Record<string, string> = {};
  for (const key of ['packageKey', 'version', 'displayName', 'role', 'instructions', 'provider']) {
    const value = body[key];
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: `'${key}' is required` };
    }
    strings[key] = value;
  }
  const description = body['description'];
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return { ok: false, error: "'description' must be a string or null" };
  }
  const permissions = parsePermissionList(body['permissions']);
  if (permissions === null || permissions.length === 0) {
    return { ok: false, error: "'permissions' must be a non-empty list of agent permission scopes" };
  }
  return {
    ok: true,
    packageKey: strings['packageKey']!,
    version: strings['version']!,
    displayName: strings['displayName']!,
    description: (description as string | null | undefined) ?? null,
    role: strings['role']!,
    instructions: strings['instructions']!,
    provider: strings['provider']!,
    permissions,
  };
}

export type ParsedRequestBuildBody =
  | { ok: true; extensionKey: string; version: string; brief: string; agentId: string }
  | { ok: false; error: string };

/** The builder request body. */
export function parseRequestBuildBody(body: unknown): ParsedRequestBuildBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const strings: Record<string, string> = {};
  for (const key of ['extensionKey', 'version', 'brief', 'agentId']) {
    const value = body[key];
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: `'${key}' is required` };
    }
    strings[key] = value;
  }
  return {
    ok: true,
    extensionKey: strings['extensionKey']!,
    version: strings['version']!,
    brief: strings['brief']!,
    agentId: strings['agentId']!,
  };
}

export type ParsedIdBody =
  | { ok: true; id: string }
  | { ok: false; error: string };

/** A body that is just one required id (buildId / packageId / manifestId). */
export function parseIdBody(body: unknown, field: string): ParsedIdBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `'${field}' is required` };
  }
  return { ok: true, id: value };
}

export type ParsedDeployBody =
  | { ok: true; manifestId: string | null; version: string | null; installKey: string; grantedPermissions: string[] | null }
  | { ok: false; error: string };

/** The deploy body: manifestId or version, optional install + grant. */
export function parseDeployBody(body: unknown): ParsedDeployBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const manifestId = body['manifestId'];
  const version = body['version'];
  const manifestOk = manifestId === undefined || manifestId === null || typeof manifestId === 'string';
  const versionOk = version === undefined || version === null || typeof version === 'string';
  if (!manifestOk || !versionOk) {
    return { ok: false, error: "'manifestId' and 'version' must be strings or null" };
  }
  const manifestIdText = (manifestId as string | null | undefined)?.trim() || null;
  const versionText = (version as string | null | undefined)?.trim() || null;
  if (manifestIdText === null && versionText === null) {
    return { ok: false, error: "one of 'manifestId' or 'version' is required" };
  }
  const installKey = body['installKey'];
  if (installKey !== undefined && installKey !== null && typeof installKey !== 'string') {
    return { ok: false, error: "'installKey' must be a string or null" };
  }
  const granted = body['grantedPermissions'];
  if (granted !== undefined && granted !== null && !Array.isArray(granted)) {
    return { ok: false, error: "'grantedPermissions' must be an array or null" };
  }
  return {
    ok: true,
    manifestId: manifestIdText,
    version: versionText,
    installKey: (installKey as string | null | undefined) ?? 'default',
    grantedPermissions: parsePermissionList(granted),
  };
}

export type ParsedRollbackBody =
  | { ok: true; targetDeploymentId: string; installKey: string }
  | { ok: false; error: string };

/** The rollback body: the recorded deployment to roll back TO. */
export function parseRollbackBody(body: unknown): ParsedRollbackBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const target = body['targetDeploymentId'];
  if (typeof target !== 'string' || target.trim() === '') {
    return { ok: false, error: "'targetDeploymentId' is required — the recorded deployment to restore" };
  }
  const installKey = body['installKey'];
  if (installKey !== undefined && installKey !== null && typeof installKey !== 'string') {
    return { ok: false, error: "'installKey' must be a string or null" };
  }
  return {
    ok: true,
    targetDeploymentId: target,
    installKey: (installKey as string | null | undefined) ?? 'default',
  };
}

export type ParsedCancelBody =
  | { ok: true; reason: string }
  | { ok: false; error: string };

/** The cancel-build body: a reason is required (recorded on the session). */
export function parseCancelBody(body: unknown): ParsedCancelBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const reason = body['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { ok: false, error: "'reason' is required — a cancellation records why" };
  }
  return { ok: true, reason };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Map a module error to an API outcome (code-carrying errors only). */
export function marketplaceApiError(error: unknown): ApiError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error ? error.message : 'unexpected marketplace failure';
  if (code === null) {
    return apiError(500, 'internal', message);
  }
  if (code === 'forbidden' || code === 'unauthorized') {
    return apiError(403, code, message);
  }
  if (
    code === 'invalid_transition' ||
    code === 'conflict' ||
    code === 'separation_of_duties' ||
    code === 'not_pending' ||
    code === 'not_runnable' ||
    code === 'not_cancellable' ||
    code === 'version_not_monotonic' ||
    code === 'invalid_rollback' ||
    code === 'grant_exceeds_ceiling' ||
    code === 'verification_required'
  ) {
    return apiError(409, code, message);
  }
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  return apiError(400, code, message);
}

// ---------------------------------------------------------------------------
// POST /api/product/marketplace/package/<id>/<action>
// ---------------------------------------------------------------------------

export const PACKAGE_ACTIONS = [
  'submit',
  'verify',
  'review',
  'publish',
  'make-installable',
  'install',
] as const;

export type PackageAction = (typeof PACKAGE_ACTIONS)[number];

export function isPackageAction(value: string): value is PackageAction {
  return (PACKAGE_ACTIONS as readonly string[]).includes(value);
}

/** Handle one package governance action. */
export async function handlePackageAction(
  request: Request,
  packageId: string,
  action: PackageAction,
  body: unknown,
): Promise<ApiResult> {
  const context = await writeContextFromRequest(request);
  if (!context.ok) {
    return marketplaceContextError(context.failure, context.detail);
  }
  const ctx = context.context;

  try {
    switch (action) {
      case 'submit': {
        const pkg = await submitPackage(ctx, { packageId });
        return { status: 200, body: { action, ok: true, package: pkg } };
      }
      case 'verify': {
        const result = await runAutomatedVerification(ctx, { packageId });
        return { status: 200, body: { action, ok: true, package: result.package, run: result.run } };
      }
      case 'review': {
        const parsed = parseReviewBody(body);
        if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
        const result = await reviewPackage(ctx, {
          packageId,
          decision: parsed.decision,
          reason: parsed.reason,
        });
        return {
          status: 200,
          body: { action, ok: true, package: result.package, review: result.review },
        };
      }
      case 'publish': {
        const pkg = await publishPackage(ctx, { packageId });
        return { status: 200, body: { action, ok: true, package: pkg } };
      }
      case 'make-installable': {
        const pkg = await makePackageInstallable(ctx, { packageId });
        return { status: 200, body: { action, ok: true, package: pkg } };
      }
      case 'install': {
        // Installing composes the contract operations (see install.ts):
        // the package must exist and be visible first, then the
        // composition's own rules decide each step's honesty.
        const granted = parsePermissionList(
          isRecord(body) ? body['grantedPermissions'] : undefined,
        );
        const pkg = await getPackage(ctx, { packageId });
        if (pkg.state !== 'INSTALLABLE') {
          return apiError(
            409,
            'not_installable',
            `package '${packageId}' is ${pkg.state} — only INSTALLABLE packages can be installed`,
          );
        }
        const report: InstallReport = await installPackage(ctx, pkg, granted);
        return {
          status: 200,
          body: {
            action,
            ok: report.outcome !== 'failed',
            outcome: report.outcome,
            report,
          },
        };
      }
    }
  } catch (error) {
    if (
      error instanceof MarketplaceError ||
      error instanceof ExtensionsError ||
      error instanceof AgentsError
    ) {
      return marketplaceApiError(error);
    }
    return marketplaceApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/marketplace/extension/<key>/<action>
// ---------------------------------------------------------------------------

export const EXTENSION_ACTIONS = [
  'deploy',
  'rollback',
  'activate',
  'suspend',
  'resume',
  'deprecate',
] as const;

export type ExtensionAction = (typeof EXTENSION_ACTIONS)[number];

export function isExtensionAction(value: string): value is ExtensionAction {
  return (EXTENSION_ACTIONS as readonly string[]).includes(value);
}

const TRANSITION_ACTIONS: Record<
  Exclude<ExtensionAction, 'deploy' | 'rollback'>,
  ExtensionTransition
> = {
  activate: 'activate',
  suspend: 'suspend',
  resume: 'resume',
  deprecate: 'deprecate',
};

/** Handle one extension lifecycle/runtime action. */
export async function handleExtensionAction(
  request: Request,
  extensionKey: string,
  action: ExtensionAction,
  body: unknown,
): Promise<ApiResult> {
  const context = await writeContextFromRequest(request);
  if (!context.ok) {
    return marketplaceContextError(context.failure, context.detail);
  }
  const ctx = context.context;

  try {
    if (action === 'deploy') {
      const parsed = parseDeployBody(body);
      if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
      const result = await deployExtensionVersion(ctx, {
        extensionKey,
        manifestId: parsed.manifestId ?? undefined,
        version: parsed.version ?? undefined,
        installKey: parsed.installKey,
        // The user-narrowed grant: only keys from the closed vocabulary
        // pass (the runtime enforces the manifest ceiling regardless).
        grantedPermissions:
          parsed.grantedPermissions === null
            ? undefined
            : parsed.grantedPermissions.filter(isExtensionPermission),
        idempotencyKey: null,
      });
      return {
        status: 200,
        body: {
          action,
          ok: result.applied,
          applied: result.applied,
          deployment: result.deployment,
          gate: result.gate,
        },
      };
    }
    if (action === 'rollback') {
      const parsed = parseRollbackBody(body);
      if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
      const result = await rollbackExtensionDeployment(ctx, {
        extensionKey,
        targetDeploymentId: parsed.targetDeploymentId,
        installKey: parsed.installKey,
        idempotencyKey: null,
      });
      return {
        status: 200,
        body: {
          action,
          ok: result.applied,
          applied: result.applied,
          deployment: result.deployment,
          gate: result.gate,
        },
      };
    }
    const transition = TRANSITION_ACTIONS[action];
    const result = await transitionExtension(ctx, {
      extensionKey,
      transition,
      idempotencyKey: null,
    });
    return {
      status: 200,
      body: {
        action,
        ok: result.applied,
        applied: result.applied,
        extension: result.extension,
        gate: result.gate,
      },
    };
  } catch (error) {
    return marketplaceApiError(error);
  }
}

// ---------------------------------------------------------------------------
// POST /api/product/marketplace/developer/<action>
// ---------------------------------------------------------------------------

export const DEVELOPER_ACTIONS = [
  'create-extension-package',
  'create-agent-package',
  'request-build',
  'advance-build',
  'cancel-build',
] as const;

export type DeveloperAction = (typeof DEVELOPER_ACTIONS)[number];

export function isDeveloperAction(value: string): value is DeveloperAction {
  return (DEVELOPER_ACTIONS as readonly string[]).includes(value);
}

/** Handle one developer/builder action. */
export async function handleDeveloperAction(
  request: Request,
  action: DeveloperAction,
  body: unknown,
): Promise<ApiResult> {
  const context = await writeContextFromRequest(request);
  if (!context.ok) {
    return marketplaceContextError(context.failure, context.detail);
  }
  const ctx = context.context;

  try {
    switch (action) {
      case 'create-extension-package': {
        const parsed = parseCreateExtensionPackageBody(body);
        if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
        const pkg = await createPackage(ctx, {
          kind: 'extension',
          manifestId: parsed.manifestId,
          packageKey: parsed.packageKey ?? undefined,
        });
        return { status: 200, body: { action, ok: true, package: pkg } };
      }
      case 'create-agent-package': {
        const parsed = parseCreateAgentPackageBody(body);
        if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
        if (!isAgentRuntimeProvider(parsed.provider)) {
          return apiError(
            400,
            'invalid_body',
            `'${parsed.provider}' is not a known agent runtime provider`,
          );
        }
        const scopes = parsed.permissions.filter(isAgentPermissionScope);
        if (scopes.length !== parsed.permissions.length) {
          return apiError(
            400,
            'invalid_body',
            "'permissions' contains keys outside the closed agent scope vocabulary",
          );
        }
        const pkg = await createPackage(ctx, {
          kind: 'agent',
          packageKey: parsed.packageKey,
          version: parsed.version,
          displayName: parsed.displayName,
          description: parsed.description,
          role: parsed.role,
          instructions: parsed.instructions,
          provider: parsed.provider,
          permissions: scopes,
        });
        return { status: 200, body: { action, ok: true, package: pkg } };
      }
      case 'request-build': {
        const parsed = parseRequestBuildBody(body);
        if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
        const build = await requestExtensionBuild(ctx, {
          extensionKey: parsed.extensionKey,
          version: parsed.version,
          brief: parsed.brief,
          agentId: parsed.agentId,
        });
        return { status: 200, body: { action, ok: true, build } };
      }
      case 'advance-build': {
        const parsed = parseIdBody(body, 'buildId');
        if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
        const build = await runExtensionBuild(ctx, { buildId: parsed.id });
        const phase: ExtensionBuildPhase = build.phase;
        return {
          status: 200,
          body: { action, ok: true, build, terminal: phase === 'deployed' || phase === 'failed' || phase === 'cancelled' },
        };
      }
      case 'cancel-build': {
        const parsedId = parseIdBody(body, 'buildId');
        if (!parsedId.ok) return apiError(400, 'invalid_body', parsedId.error);
        const parsedReason = parseCancelBody(body);
        if (!parsedReason.ok) return apiError(400, 'invalid_body', parsedReason.error);
        const build = await cancelExtensionBuild(ctx, {
          buildId: parsedId.id,
          reason: parsedReason.reason,
        });
        return { status: 200, body: { action, ok: true, build } };
      }
    }
  } catch (error) {
    return marketplaceApiError(error);
  }
}
