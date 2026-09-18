// The v1 public API's ONLY HTTP surface (W038 — Public API).
//
// IMPLEMENTATION-STACK §5: "Public API (W038): Next.js App Router route
// handlers under `src/app/api/v1/**` — thin adapters that authenticate,
// scope tenant, delegate to module contracts, audit. No raw persistence
// (lock 31)." This file contains NO routing, authentication,
// authorization, audit or domain logic whatsoever: it translates HTTP into
// the framework-free ApiRequest, hands it to the api module's kernel
// (`handleApiRequest`), and frames the ApiResponse. The optional catch-all
// (`[[...path]]`) mounts the whole versioned surface — including the
// unauthenticated `GET /api/v1` discovery document — under one adapter,
// so a future v2 mounts beside it without touching this file's v1 logic.

import { NextResponse } from 'next/server';
import { handleApiRequest } from '@/modules/api/contract';

function collectQuery(url: URL): Record<string, string | string[] | undefined> {
  const query: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let body: unknown;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text();
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = undefined; // the kernel reports invalid_body uniformly
      }
    }
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const response = await handleApiRequest({
    method: request.method,
    path: url.pathname,
    headers,
    query: collectQuery(url),
    body,
  });
  return NextResponse.json(response.body as never, {
    status: response.status,
    headers: response.headers,
  });
}

export type RouteContext = { params: Promise<{ path?: string[] }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  await context.params;
  return handle(request);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  await context.params;
  return handle(request);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  await context.params;
  return handle(request);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  await context.params;
  return handle(request);
}
