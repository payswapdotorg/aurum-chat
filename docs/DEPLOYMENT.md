# Aurum Deployment Runbook (W069)

This is the operator runbook for the free-tier dogfood deployment profile
(plan §7 Profile A) and its promotion path to the commercial profile
(Profile B). The implementation is provider-neutral: every external
service is an environment-selected adapter behind an infra port, so the
domain architecture never changes when a provider changes.

> **Non-commercial dogfood notice (binding).** While the web surface runs
> on the Vercel Hobby tier, this deployment is internal/non-commercial
> dogfood. `/api/health` surfaces this notice, `AURUM_COMMERCIAL=1` marks
> the switch to the commercial profile.

## 1. Stack (Profile A — free-tier dogfood)

| Concern          | Provider (free tier)       | Adapter / port                          | Selected by               |
| ---------------- | -------------------------- | --------------------------------------- | ------------------------- |
| Web + API host   | Vercel Hobby               | Next.js App Router (`src/app`)          | —                         |
| Domain truth     | Neon PostgreSQL            | `src/infra/db.ts` (node-postgres Pool)  | `DATABASE_URL`            |
| Queue/cache/lock | Upstash Redis              | `src/infra/{queue,cache,lock}.ts`       | `REDIS_URL`               |
| Cognition worker | Vercel cron + HTTP seam    | `src/infra/worker.ts` + `/api/worker`   | —                         |
| Object storage   | Vercel Blob                | `src/infra/blob.ts` (@vercel/blob SDK)  | `BLOB_READ_WRITE_TOKEN`   |
| Email            | Resend                     | `src/infra/email.ts` (REST via fetch)   | `RESEND_API_KEY`          |
| CI               | GitHub Actions             | `.github/workflows/ci.yml`              | —                         |

Unset variables degrade to the built-in dev/test runtimes (embedded
PGlite, in-process memory queue/cache/lock/email/blob). That is legal
for development; production enforces the important ones (§6).

## 2. The execution seam (worker)

The architecture charters a cognition worker consuming queue jobs
(IMPLEMENTATION-STACK §5, lock 36). W069 delivers it as ONE core with
TWO drivable surfaces:

- **`scripts/worker.ts`** — the resident process (dev, self-hosted,
  Profile B):

  ```bash
  bun run worker                # continuous poll loop
  bun run worker --once         # drain one guarded batch, then exit
  bun run worker --batch 25 --interval 5000
  ```

- **`POST/GET /api/worker`** — the HTTP execution seam (serverless
  hosts have no resident process):
  - `POST` with no body: pull one guarded batch from the queue (cron /
    manual sweep).
  - `POST` with `{"jobs": [...]}`: process pushed deliveries — the shape
    a platform queue consumer (e.g. Vercel Queues) delivers; every job
    runs through the identical core path.
  - `GET`: observability snapshot (metrics, queue depth, deployment
    profile); `GET ?sweep=1` drains one batch first.

One job = ONE bounded canonical stage of ONE cognitive execution,
advanced through the frozen W013 contract (`runNextStage`). The worker
performs no reasoning and writes no domain state — PostgreSQL remains
the only source of domain truth. Delivery semantics:

- **Idempotent duplicates**: the queue is at-least-once; a redelivered
  job whose stage already advanced fails `stage_mismatch` and is
  acknowledged (no retry storm, no double step).
- **Retry**: transient failures (db/network/provider) re-enqueue with
  attempt+1 up to `AURUM_WORKER_MAX_ATTEMPTS` (default 5), then
  dead-letter to the `cognition-dead` queue for inspection.
- **Dead-letter**: deterministic contract rejections (bad input,
  unreadable references) skip retrying — retrying cannot change them.
- **Suspensions**: `awaiting_approval` / `awaiting_input` are persisted
  domain state; the job is consumed, and a NEW job for the same stage
  resumes the execution after the human decision / acquisition outcome —
  in this process or any other (restarts lose nothing).

On Vercel Hobby, cron triggers are limited to once per day, so
`vercel.json` schedules a daily 03:00 UTC sweep of `/api/worker`
(authenticated by `CRON_SECRET` or `WORKER_TOKEN`). For latency-sensitive
dogfood pumping, drive `POST /api/worker` from any scheduler (including
an external cron) — the seam is the stable contract.

## 3. Environment separation (preview / staging / production)

`src/infra/deployment.ts` resolves the environment:

1. `DEPLOYMENT_ENV` (explicit; must be exactly
   `development|preview|staging|production` — anything else is a hard
   misconfiguration);
2. else `VERCEL_ENV` on the platform (`production` / `preview`);
3. else `NODE_ENV`.

Vercel has no native staging environment: staging is a dedicated
**branch deployment** (`staging` branch) or a second project with
`DEPLOYMENT_ENV=staging` set, wired to a separate Neon database and a
separate Upstash/Resend/Blob set. Recommended matrix:

| Environment | Vercel project/branch     | Neon              | Upstash         | Resend         | Blob           |
| ----------- | ------------------------- | ----------------- | --------------- | -------------- | -------------- |
| preview     | every PR (automatic)      | Neon branch DB    | dev redis       | test key       | dev token      |
| staging     | `staging` branch / proj B | `aurum-staging`   | `aurum-staging` | staging key    | staging token  |
| production  | `main` (proj A)           | `aurum-prod`      | `aurum-prod`    | prod key       | prod token     |

Neon supports database branching — preview deployments may point at a
branch of staging for cheap per-PR isolation. Migrations run at build
time (below), are idempotent, and are safe on every deployment.

## 4. Provisioning walkthrough (Profile A)

1. **Neon**: create the project (`aurum`), copy the pooled connection
   string (`...sslmode=require`), keep it for `DATABASE_URL`. Neon Free
   autosuspends after inactivity — the first connection after a pause
   takes a few seconds (health checks tolerate it; worker retries cover
   it).
2. **Upstash**: create a Redis database in the same region as the Vercel
   project (`iad1` in `vercel.json`); copy the `redis://` URL (the
   ioredis-compatible protocol) for `REDIS_URL`.
3. **Vercel**: import the GitHub repo; the framework (Next.js) and
   `vercel.json` apply (build command `bun run vercel:build` = migrate
   + next build; region `iad1`; daily worker cron). Set the environment
   variables from §6 per environment.
4. **Resend**: add + verify the sending domain; the free From address
   `onboarding@resend.dev` works for dogfood without verification.
   `EMAIL_FROM` overrides it.
5. **Vercel Blob**: create the store; copy the read-write token for
   `BLOB_READ_WRITE_TOKEN`.
6. **Secrets**: generate `WORKER_TOKEN` (any long random string) and set
   `CRON_SECRET` on Vercel (Settings → Cron Jobs) so platform cron
   deliveries authenticate to `/api/worker`.
7. Verify `/api/health` (§7) — `status: ok`, migration count present.

## 5. Migrations

- Source of record: `src/modules/<m>/migrations/NNN-*.sql`, applied in
  module-dependency order by `scripts/migrate.ts` (idempotent — safe to
  re-run on every deploy).
- Build command (`bun run vercel:build`) applies migrations before
  `next build`, so every preview/staging/production deployment migrates
  its own database as part of the build.
- CI runs a migration smoke against a real postgres:16 service container
  (`.github/workflows/ci.yml`), then the real-provider integration
  suite (real PostgreSQL + real Redis) — the same backends production
  uses.
- Locally: `bun run migrate` with `DATABASE_URL` set (e.g. against a
  Neon branch); `bun run db:dev` boots the embedded dev database.

## 6. Environment variables

See `.env.example` for the annotated list. Production essentials:

| Variable                | Purpose                                                | Enforced                                  |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `DATABASE_URL`          | external PostgreSQL (Neon) — domain truth              | **refusal** to serve production without  |
| `REDIS_URL`             | Upstash redis (queue/cache/lock)                       | warning when missing (memory fallback)   |
| `RESEND_API_KEY`        | transactional email                                    | warning when missing (memory fallback)   |
| `BLOB_READ_WRITE_TOKEN`| object storage                                         | warning when missing (memory fallback)   |
| `WORKER_TOKEN`          | auth for `/api/worker`                                 | **refusal** to serve production without  |
| `CRON_SECRET`           | auth for Vercel cron deliveries                        | optional                                  |
| `DEPLOYMENT_ENV`        | explicit environment separation                        | validated                                 |
| `AURUM_COMMERCIAL`      | `1` marks Profile B                                    | informational                             |

Usage guardrails (defaults are the free-tier budgets; clamped env
overrides): `AURUM_WORKER_MAX_ATTEMPTS` (5), `AURUM_WORKER_BATCH_LIMIT`
(10), `AURUM_WORKER_POLL_INTERVAL_MS` (2000), `AURUM_EMAIL_DAILY_LIMIT`
(100 — the Resend Free daily allowance; 0 disables),
`AURUM_BLOB_MAX_BYTES` (8 MiB per object), `AURUM_DB_POOL_MAX` (5 —
Neon Free connection budget).

## 7. Health / readiness / observability

`GET /api/health` (unauthenticated, `cache-control: no-store`, no tenant
data):

- `status: ok` — db answers (`SELECT 1`) and the schema is applied
  (`_migrations` count), no readiness notes;
- `status: degraded` — serving, but readiness notes exist (production
  warnings like a missing `REDIS_URL`);
- `status: error` + HTTP 503 — the database is unreachable or the
  schema is not applied: not ready to serve traffic.

The response also reports every component backend label, the guardrail
configuration, the dogfood notice and the worker metrics registry
(process-local counters: enqueued/processed/suspended/duplicate/
conflict/not-found/retried/dead-lettered jobs, batches, last activity).
`GET /api/worker` (token-gated) exposes the same metrics plus queue
depth. The worker logs one JSON line per lifecycle event (`component:
aurum-worker`) with execution id, stage, attempt and §25 correlation id —
the free-tier observability trail.

## 8. CI

`.github/workflows/ci.yml` runs on every pull request and push:

1. the four repository gates (`typecheck`, `lint`, `arch`, `test`);
2. a migration smoke against a real postgres service container;
3. the real-provider integration suite (real PostgreSQL + real Redis),
   which skips automatically when the URLs are absent (local runs need
   no servers).

Browser E2E joins the pipeline with W070 (the plan assigns the journey
matrix there).

## 9. Local real-provider verification

The real-provider tests activate with:

```bash
AURUM_TEST_DATABASE_URL=postgres://... AURUM_TEST_REDIS_URL=redis://... bun run test
```

A quick manual end-to-end against real servers:

```bash
DATABASE_URL=postgres://... REDIS_URL=redis://... bun run migrate
DATABASE_URL=postgres://... REDIS_URL=redis://... bun run worker --once
```

## 10. Promotion to Profile B (commercial)

1. Replace the Hobby host with a paid tier (or another host — the Next
   app is portable; run `next start` or the worker resident where you
   like).
2. Keep the same adapters: managed PostgreSQL with backups, managed
   Redis, durable object storage, transactional email with a real
   sending domain.
3. Set `AURUM_COMMERCIAL=1` (turns off the dogfood notice) and raise the
   guardrails to the paid budgets (`AURUM_EMAIL_DAILY_LIMIT`,
   `AURUM_BLOB_MAX_BYTES`, …).
4. Nothing in the domain architecture changes: PostgreSQL stays the only
   domain truth (lock 35), the worker seam and contracts are untouched
   (lock 36).
