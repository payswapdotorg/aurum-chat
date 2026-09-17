// The request kernel of the v1 public API (W038): the framework-free
// pipeline every public request flows through. Next.js route handlers
// under src/app/api/v1/** do nothing but translate HTTP into an ApiRequest
// and hand it here (IMPLEMENTATION-STACK §5: "thin adapters that
// authenticate, scope tenant, delegate to module contracts, audit").
//
// The pipeline, in order (locks 31/32, ADR-0005):
//   1. VERSION + ROUTE: the path must live under /api/v1 and match the
//      route table (routes.ts); unknown paths 404, known paths with a wrong
//      method 405 (with Allow).
//   2. AUTHENTICATION: `Authorization: Bearer aurum_…` resolves onto
//      exactly one ACTIVE tenant-scoped api key (sha-256 lookup, the
//      identity module's constant-time discipline). Malformed, unknown and
//      revoked keys are uniformly `unauthenticated` — no leak.
//   3. TENANT SCOPE: the key's tenant/principal become the EXPLICIT
//      TenantContext every contract call receives (no ambient globals),
//      and membership is re-verified through the organizations contract on
//      EVERY request — a principal removed from the tenant kills its keys
//      immediately.
//   4. PERMISSION: the route's capability scope must be covered by the
//      key's grant; the authority claims the key carries flow downstream
//      so the domain modules' own gates (e.g. 'actions:approve') apply
//      unchanged — the API never bypasses them.
//   5. DELEGATION: the matched operation handler (operations.ts) calls the
//      owning module's contract. No handler touches SQL of another module
//      (lock 31).
//   6. AUDIT: one immutable `api.operation` event per authenticated
//      operation (success OR failure) through the events contract, actor =
//      the key's principal, source = 'api', correlation = the request id.
//      A successful operation whose audit append fails is a hard 500 —
//      lock 32 is not best-effort.
//   7. FANOUT: the audit event fans out to the tenant's matching webhook
//      subscriptions (best-effort — delivery is the pump's concern).

import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { ApiError, mapDomainError } from './errors';
import { OPERATIONS } from './operations';
import { buildDiscoveryDocument, matchApiRoute, splitApiPath, type ApiRouteSpec } from './routes';
import { hasScope } from './scopes';
import {
  auditApiOperation,
  enqueueDeliveriesForEvent,
  mapApiKey,
  requirePrincipalMembership,
  touchApiKey,
  verifyApiKey,
  type ApiKeyRow,
} from './service';
import { API_VERSION, type ApiKey, type ApiRequest, type ApiResponse } from './types';

const VERSION_HEADER: Record<string, string> = { 'x-aurum-api-version': API_VERSION };

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function extractBearerKey(headers: Record<string, string>): string | null {
  const header = headers?.['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const key = match[1]!.trim();
  return key.length === 0 ? null : key;
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError('internal_error', 'unexpected server error');
}

/**
 * Handle one public-API request end to end. Never throws — every failure
 * surfaces as an ApiResponse (the HTTP adapter's only job is framing).
 */
export async function handleApiRequest(request: ApiRequest): Promise<ApiResponse> {
  const method = (request?.method ?? 'GET').toUpperCase();
  const path = typeof request?.path === 'string' && request.path !== '' ? request.path : '/';
  const requestId = newId();

  const respond = (status: number, body: unknown, extra?: Record<string, string>): ApiResponse => ({
    status,
    body,
    headers: { ...VERSION_HEADER, ...extra },
  });

  // 1. version + route -------------------------------------------------------
  const segments = splitApiPath(path);
  if (segments === null) {
    return respond(404, errorBody('route_not_found', `no public api surface at '${path}'`));
  }
  const match = matchApiRoute(method, segments);
  if (match.kind === 'not_found') {
    return respond(404, errorBody('route_not_found', `no v1 operation at '${method} ${path}'`));
  }
  if (match.kind === 'method_not_allowed') {
    const allow = match.allowed.join(', ');
    return respond(
      405,
      errorBody('method_not_allowed', `method ${method} is not allowed here (allowed: ${allow})`),
      { allow },
    );
  }
  const spec: ApiRouteSpec = match.spec;
  const params = match.params;

  // The unauthenticated surface: the static, tenant-free discovery doc.
  if (spec.scope === null) {
    return respond(200, buildDiscoveryDocument());
  }

  // 2. authentication ---------------------------------------------------------
  const rawKey = extractBearerKey(request?.headers ?? {});
  if (rawKey === null) {
    return respond(401, errorBody('unauthenticated', 'a bearer api key is required'));
  }
  const record: ApiKeyRow | null = await verifyApiKey(rawKey);
  if (record === null) {
    return respond(401, errorBody('unauthenticated', 'the presented api key is not valid'));
  }

  // 3. tenant scope: the explicit context every contract call receives ------
  const ctx: TenantContext = {
    tenantId: record.tenant_id,
    principalId: record.principal_id,
    authority: [...(record.authority ?? [])],
  };
  const key: ApiKey = mapApiKey(record);
  await touchApiKey(record.id).catch(() => undefined);

  // 6+7. audit (+ fanout) wrapper, shared by every outcome below -----------
  const finish = async (status: number, response: ApiResponse): Promise<ApiResponse> => {
    try {
      const event = await auditApiOperation(ctx, {
        operation: spec.operation,
        method,
        path,
        status,
        keyId: record.id,
        requestId,
      });
      try {
        await enqueueDeliveriesForEvent(ctx, event);
      } catch {
        // Fanout is delivery plumbing, not the operation's outcome.
      }
    } catch {
      // Lock 32 is not best-effort for successful operations; an
      // already-failing outcome wins over the audit failure.
      if (status >= 400) return response;
      return respond(500, errorBody('audit_unavailable', 'the operation could not be audited'));
    }
    return response;
  };

  // 3b. membership gate -------------------------------------------------------
  let gate: ApiError | null = null;
  try {
    await requirePrincipalMembership(ctx, ctx.principalId);
  } catch (error) {
    gate = asApiError(error);
  }
  // 4. capability-scope gate --------------------------------------------------
  if (gate === null && !hasScope(record.scopes ?? [], spec.scope)) {
    gate = new ApiError(
      'missing_scope',
      `this key lacks the '${spec.scope}' scope required by '${spec.operation}'`,
    );
  }
  if (gate !== null) {
    return finish(gate.status, respond(gate.status, errorBody(gate.code, gate.message)));
  }

  // 5. delegation ---------------------------------------------------------------
  const handler = OPERATIONS[spec.operation];
  if (handler === undefined) {
    return respond(500, errorBody('internal_error', `operation '${spec.operation}' is not wired`));
  }
  let result: unknown;
  try {
    result = await handler({
      ctx,
      key,
      params,
      query: request?.query ?? {},
      body: request?.body,
    });
  } catch (error) {
    const mapped = mapDomainError(error);
    const response =
      mapped === null
        ? respond(500, errorBody('internal_error', 'unexpected server error'))
        : respond(mapped.status, errorBody(mapped.code, mapped.message));
    return finish(response.status, response);
  }

  const status = spec.successStatus ?? 200;
  const body = Array.isArray(result) ? { items: result } : (result ?? null);
  return finish(status, respond(status, body));
}
