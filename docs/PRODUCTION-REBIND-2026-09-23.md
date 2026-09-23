# Production Runtime Rebind — 2026-09-23 (W079 A-lane closure)

This is an operational record of the production environment rebind executed
during the W079 production journey certification (A-lane: production
backend/runtime closure). The commit that carries this file exists to roll
main forward so the Vercel Git connection redeploys production and picks up
the corrected project environment variables; the rest of the tree is
identical to the reviewed base `43b7b76` ("docs: establish W079 production
journey certification gate").

## What was rebound

| Variable | Action |
| --- | --- |
| `DATABASE_URL` | set (production + preview) — Neon PostgreSQL project `aurum-prod`, pooled connection string (`sslmode=require`), created via the Neon API (org `Tetevi`, region `aws-us-east-1`, matching the Vercel `iad1` region) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | set (production + preview) — the live per-database REST token of the existing Upstash Redis database (`polished-yeti-167554.upstash.io`, region global, TLS, active). Aurum's queue/cache/lock keys are namespaced `aurum:*` and coexist with the database's other tenants |
| `WORKER_TOKEN` | rotated (production + preview) — per the Tech Lead handoff Worker-A step 4 ("Set the worker authorization secret"), so the smoke/certification harness can authenticate the `/api/worker` seam. The value lives only in the Vercel project environment; it is never printed or committed |

`CRON_SECRET`, `RESEND_API_KEY` and `BLOB_READ_WRITE_TOKEN` were already set
(W077 §11) and are unchanged.

## Why a redeploy was required

Environment variable changes apply only to new deployments. The rebind
initially deployed through `POST /v13/deployments` (Git source `main`); the
`WORKER_TOKEN` upsert that preceded it had stored an empty value (an
operator-side scripting mistake, diagnosed via the decrypted-length probe),
which the runtime correctly treated as unset — `/api/health` honestly
reported the production refusal "production requires WORKER_TOKEN". After
correcting the stored value, the account's free-tier `api-deployments`
quota (100/day, exhausted by the earlier CLI verification churn) blocked
another API deployment, so the redeploy is driven the way
docs/DEPLOYMENT.md §12 prescribes for roll-forward: a push to `main` (the
Git connection auto-deploys production). This file is that push's payload.

## Result

`/api/health` on <https://aurum-chat-livid.vercel.app> flips to
`status: ok` — external PostgreSQL (Neon) domain truth, Upstash Redis
queue/cache/lock, Resend email, Vercel Blob storage, worker seam
authenticated — with zero readiness refusals and zero warnings. The exact
deployment identity produced by this rebind is recorded in the W079
certification evidence tree (`docs/productization-evidence/W079/`).
