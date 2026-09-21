// The HTTP worker execution seam (W069 — plan §7 "Worker deployment
// requirement": "creating the actual worker/HTTP execution seam").
//
// A serverless host (Vercel Hobby, plan §7 Profile A) has no resident
// process, so the SAME worker core that `scripts/worker.ts` runs as a
// poll loop is exposed here over HTTP. This route is deployment
// infrastructure, not a product surface: it is token-gated, carries no
// tenant data of its own, and delegates every domain write to the W013
// contract through src/infra/worker.ts.
//
//   POST /api/worker          — process one bounded batch:
//        * with a JSON body `{ "jobs": [...] }`: process the supplied
//          jobs as pushed deliveries (the shape a platform queue
//          consumer — e.g. Vercel Queues — delivers to this seam; each
//          job is validated and run through the exact same core path);
//        * with no body: pull up to the batch guardrail from the queue
//          port (the cron/manual sweep mode).
//   GET  /api/worker          — observability snapshot (metrics + queue
//        depth + deployment profile). With ?sweep=1 (and valid auth) it
//        first drains one batch — this is what the vercel.json daily
//        cron hits.
//
// AUTH (guardrail): WORKER_TOKEN (or CRON_SECRET for Vercel cron
// deliveries) via `Authorization: Bearer <t>` or the `x-worker-token`
// header. With NO token configured the seam refuses to serve production
// (fail closed) and stays open for local development/preview exercise.
//
// The route stays a thin adapter; the handling logic lives in lib.ts and
// is tested directly without booting Next.js (the same discipline the
// tower and product APIs follow). The responses never carry tenant
// content: outcomes hold execution ids, lifecycle states and counters.

import { NextResponse } from 'next/server';
import { handleWorkerGet, handleWorkerPost } from './lib';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const result = await handleWorkerPost(request);
  return NextResponse.json(result.body, { status: result.status });
}

export async function GET(request: Request): Promise<NextResponse> {
  const result = await handleWorkerGet(request);
  return NextResponse.json(result.body, { status: result.status });
}
