// Product surface (W105) — API request handling for the vertical-kit
// half of /api/product/marketplace/**.
//
// The same thin-adapter discipline api.ts follows (IMPLEMENTATION-STACK
// §5): resolve the explicit tenant context from the session (W058),
// delegate to the vertical-kits module contract and the kit install
// composition (kit-flow.ts), map errors to HTTP-ish outcomes. No
// handler logic lives in the route.ts file itself, so the whole write
// surface is testable without booting Next.js.
//
// WRITES EXPOSED (each maps to exactly one contract operation or one
// kit-flow composition — nothing else):
//   kit: install | review | activate | suspend | resume | remove
//
// 'install' composes registerKitVersion → runKitVerification →
// installKit (the vertical-kits lifecycle — NOT the extension install
// flow; kits have their own lifecycle and their own honest report).
// 'review' is the human grant-review decision on a pending install
// (decideKitReview — the actions module's approve claim, separation of
// duties and first-decision-wins are enforced THERE). The lifecycle
// switches (activate/suspend/resume/remove) are the module's own
// claim-gated transitions.

import type { TenantContext } from '@/infra/tenant';
import { VerticalKitsError } from '@/modules/vertical-kits/contract';
import {
  activateKit,
  decideKitReview,
  removeKit,
  resumeKit,
  suspendKit,
} from '@/modules/vertical-kits/contract';
import { installVerticalKit } from './kit-flow';
import type { KitInstallReport } from './kit-flow';
import { marketplaceApiError, parseReviewBody, writeContextFromRequest } from './api';
import type { ApiError, ApiResult } from './api';

function apiError(status: ApiError['status'], error: string, message: string): ApiError {
  return { status, body: { error, message } };
}

/** Map a session-resolution failure to its API outcome (W058). */
function kitContextError(failure: string, detail: string): ApiError {
  if (failure === 'unauthenticated') return apiError(401, failure, detail);
  return apiError(409, failure, detail);
}

// ---------------------------------------------------------------------------
// Body parsing (pure, unit-testable)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ParsedKitInstallBody =
  | { ok: true; justification: string | null }
  | { ok: false; error: string };

/** The kit install body: an optional approver-facing justification. */
export function parseKitInstallBody(body: unknown): ParsedKitInstallBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const justification = body['justification'];
  if (justification !== undefined && justification !== null && typeof justification !== 'string') {
    return { ok: false, error: "'justification' must be a string or null" };
  }
  return { ok: true, justification: (justification as string | null | undefined) ?? null };
}

export type ParsedKitTargetBody =
  | { ok: true; installationId: string; reason: string | null }
  | { ok: false; error: string };

/**
 * The kit lifecycle-target body: the installation id is required; a
 * reason is optional for suspend and REQUIRED for remove (a removal is
 * terminal and revokes every active grant — it records why).
 */
export function parseKitTargetBody(body: unknown, requireReason: boolean): ParsedKitTargetBody {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const installationId = body['installationId'];
  if (typeof installationId !== 'string' || installationId.trim() === '') {
    return { ok: false, error: "'installationId' is required — the kit installation to act on" };
  }
  const reason = body['reason'];
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return { ok: false, error: "'reason' must be a string or null" };
  }
  const reasonText = (reason as string | null | undefined) ?? null;
  if (requireReason && (reasonText === null || reasonText.trim() === '')) {
    return {
      ok: false,
      error: 'a removal requires a reason — record why the kit (and its grants) is being retired',
    };
  }
  return { ok: true, installationId, reason: reasonText };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map a vertical-kits module error to an API outcome. The vocabulary
 * is the module's own error codes — no code is invented here.
 */
export function verticalKitsApiError(error: unknown): ApiError {
  const code =
    error instanceof VerticalKitsError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : null;
  const message = error instanceof Error ? error.message : 'unexpected vertical-kits failure';
  if (code === null) {
    return marketplaceApiError(error);
  }
  if (code === 'forbidden') return apiError(403, code, message);
  if (code === 'invalid_context') return apiError(500, code, message);
  if (code.endsWith('_not_found')) return apiError(404, code, message);
  if (
    code === 'kit_not_verified' ||
    code === 'kit_already_installed' ||
    code === 'installation_not_pending_review' ||
    code === 'installation_not_active' ||
    code === 'installation_not_lifecycle_state' ||
    code === 'version_not_monotonic' ||
    code === 'kit_verification_failed' ||
    code === 'edge_unavailable' ||
    code === 'invalid_edge_result'
  ) {
    return apiError(409, code, message);
  }
  return apiError(400, code, message);
}

// ---------------------------------------------------------------------------
// POST /api/product/marketplace/kit/<kitKey>/<action>
// ---------------------------------------------------------------------------

export const KIT_ACTIONS = [
  'install',
  'review',
  'activate',
  'suspend',
  'resume',
  'remove',
] as const;

export type KitAction = (typeof KIT_ACTIONS)[number];

export function isKitAction(value: string): value is KitAction {
  return (KIT_ACTIONS as readonly string[]).includes(value);
}

/** Handle one vertical-kit lifecycle action. */
export async function handleKitAction(
  request: Request,
  kitKey: string,
  action: KitAction,
  body: unknown,
): Promise<ApiResult> {
  const context = await writeContextFromRequest(request);
  if (!context.ok) {
    return kitContextError(context.failure, context.detail);
  }
  const ctx: TenantContext = context.context;

  try {
    switch (action) {
      case 'install': {
        const parsed = parseKitInstallBody(body);
        if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
        const report: KitInstallReport = await installVerticalKit(ctx, kitKey, parsed.justification);
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
      case 'review': {
        const parsed = parseReviewBody(body);
        if (!parsed.ok) return apiError(400, 'invalid_body', parsed.error);
        const target = parseKitTargetBody(body, false);
        if (!target.ok) return apiError(400, 'invalid_body', target.error);
        const detail = await decideKitReview(ctx, {
          installationId: target.installationId,
          decision: parsed.decision,
          note: parsed.reason,
        });
        return {
          status: 200,
          body: {
            action,
            ok: true,
            installation: detail.installation,
            grants: detail.grants,
          },
        };
      }
      case 'activate': {
        const target = parseKitTargetBody(body, false);
        if (!target.ok) return apiError(400, 'invalid_body', target.error);
        const detail = await activateKit(ctx, { installationId: target.installationId });
        return {
          status: 200,
          body: { action, ok: true, installation: detail.installation, grants: detail.grants },
        };
      }
      case 'suspend': {
        const target = parseKitTargetBody(body, false);
        if (!target.ok) return apiError(400, 'invalid_body', target.error);
        const detail = await suspendKit(ctx, {
          installationId: target.installationId,
          reason: target.reason,
        });
        return {
          status: 200,
          body: { action, ok: true, installation: detail.installation, grants: detail.grants },
        };
      }
      case 'resume': {
        const target = parseKitTargetBody(body, false);
        if (!target.ok) return apiError(400, 'invalid_body', target.error);
        const detail = await resumeKit(ctx, { installationId: target.installationId });
        return {
          status: 200,
          body: { action, ok: true, installation: detail.installation, grants: detail.grants },
        };
      }
      case 'remove': {
        const target = parseKitTargetBody(body, true);
        if (!target.ok) return apiError(400, 'invalid_body', target.error);
        const detail = await removeKit(ctx, {
          installationId: target.installationId,
          reason: target.reason,
        });
        return {
          status: 200,
          body: { action, ok: true, installation: detail.installation, grants: detail.grants },
        };
      }
    }
  } catch (error) {
    return verticalKitsApiError(error);
  }
}
