// Company query plane (W126) — the company API surface
// (/api/product/company/**).
//
// The thin-adapter discipline the shell, tower, intelligence and chat all
// follow (IMPLEMENTATION-STACK §5): every handler resolves its EXPLICIT
// TenantContext from the session cookie (W058 — never from headers or
// query parameters), delegates to the company-query module contract only,
// and maps code-carrying errors to HTTP-ish outcomes. No handler logic
// lives in the route.ts files, so the whole surface is testable without
// booting Next.js.
//
//   POST /api/product/company/query
//        — run one company query and return the two-layer response
//          (Answer + CoverageContext) as structured JSON. The request body
//          is { question: string, surfaces?: string[] }; validation and
//          tenant scoping happen inside the module contract. The response
//          is capability-shaped (the two-layer query types), never raw
//          persistence: no table rows, provider objects or another
//          tenant's anything cross this boundary.

import { resolveSessionRequest } from '@/app/lib/session';
import type { TenantContext } from '@/infra/tenant';
import { runCompanyQuery } from '@/modules/company-query/contract';
import { CompanyQueryError } from '@/modules/company-query/contract';
import type { CompanyQueryInput } from '@/modules/company-query/contract';

export interface ApiOk {
  status: 200;
  body: Record<string, unknown>;
}

export type ApiErrorStatus = 400 | 401 | 403 | 409 | 500;

export interface ApiError {
  status: ApiErrorStatus;
  body: { error: string; message: string };
}

export type ApiResult = ApiOk | ApiError;

function apiError(
  status: ApiErrorStatus,
  error: string,
  message: string,
): ApiError {
  return { status, body: { error, message } };
}

type SessionFailure =
  | { ok: false; status: 401 | 409; error: string; message: string }
  | { ok: true; context: TenantContext };

/** Resolve the session into the company surface's scope. */
async function companySession(request: Request): Promise<SessionFailure> {
  const resolution = await resolveSessionRequest(request);
  if (resolution.status === 'anonymous') {
    return {
      ok: false,
      status: 401,
      error: 'unauthenticated',
      message: 'no session for this request',
    };
  }
  if (resolution.status === 'no-company') {
    return {
      ok: false,
      status: 409,
      error: 'no_active_company',
      message: 'the session has no active company — complete onboarding first',
    };
  }
  return { ok: true, context: resolution.context };
}

/** Read (and lightly guard) the JSON body of the query POST. */
async function readQueryBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** POST /api/product/company/query — run one company query. */
export async function handleCompanyQueryPost(request: Request): Promise<ApiResult> {
  const session = await companySession(request);
  if (!session.ok) {
    return apiError(session.status, session.error, session.message);
  }

  const body = await readQueryBody(request);
  if (body === null || typeof body !== 'object') {
    return apiError(400, 'invalid_body', 'the request body must be a JSON object');
  }

  try {
    const response = await runCompanyQuery(session.context, body as CompanyQueryInput);
    return {
      status: 200,
      body: {
        company: 'query',
        tenantId: session.context.tenantId,
        ...response,
      },
    };
  } catch (error) {
    if (error instanceof CompanyQueryError) {
      if (error.code === 'invalid_query' || error.code === 'invalid_context') {
        return apiError(400, error.code, error.message);
      }
      if (error.code === 'audit_failed') {
        return apiError(500, error.code, error.message);
      }
      return apiError(500, error.code, error.message);
    }
    const message = error instanceof Error ? error.message : 'unexpected query failure';
    return apiError(500, 'internal', message);
  }
}
