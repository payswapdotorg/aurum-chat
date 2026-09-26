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
| Queue/cache/lock | Upstash Redis              | `src/infra/{queue,cache,lock}.ts`       | `REDIS_URL`, or the W077 REST seam (`UPSTASH_REDIS_REST_URL`/`_TOKEN`, alias `KV_REST_API_URL`/`_TOKEN`) |
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
   project (`iad1` in `vercel.json`). Either wire works — copy the
   `redis://` URL (the ioredis-compatible protocol) for `REDIS_URL`, or
   the REST endpoint + token for `UPSTASH_REDIS_REST_URL`/
   `UPSTASH_REDIS_REST_TOKEN` (W077's redis-over-HTTP transport — the one
   Upstash per-database tokens expose; also what the Vercel Upstash
   integration names `KV_REST_API_URL`/`KV_REST_API_TOKEN`).
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
- **W102 — schema verification:** after applying (or skipping) the
  migration set, the runner VERIFIES the schema it vouches for — every
  table any migration declares with CREATE TABLE must exist as a public
  BASE TABLE (the `_migrations` ledger records migration NAMES, never
  content, so a name-recorded-but-content-diverged database can carry a
  complete ledger while serving 500s). On mismatch the runner exits
  non-zero with the exact missing-table list, breaking the DEPLOY at
  build time instead of serving 500s at runtime.
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
| `REDIS_URL`             | Upstash redis over the redis protocol (queue/cache/lock) | warning when missing (memory fallback) |
| `UPSTASH_REDIS_REST_URL`/`_TOKEN` | Upstash redis over HTTPS (W077 REST seam; alias `KV_REST_API_URL`/`_TOKEN`) | warning when no redis seam at all (memory fallback) |
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
  (`_migrations` count) AND matches the migration set (the W102 table
  census: the count of public BASE TABLEs plus a small representative
  set — a complete ledger with a diverged schema is NOT ready), no
  readiness notes;
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

The redis-over-HTTP transport has the same opt-in against a live Upstash
REST database:

```bash
AURUM_TEST_REDIS_REST_URL=https://<db>.upstash.io AURUM_TEST_REDIS_REST_TOKEN=... bun run test
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

## 11. W077 instantiation record (as-deployed, 2026-09-22)

The free-tier dogfood environment is instantiated on the connected Vercel
account (Hobby). This section is the as-deployed record — identifiers only,
never secrets; the sections above remain the general runbook.

### Live resources

| Resource | Identifier | State |
| --- | --- | --- |
| Vercel project | `aurum-chat` — `prj_PljFx5DnZ1MCqQ5bA1uK6G1o8gFy` (team `ekonplacidegmailcom's projects`, `team_4KOoA5CgtYaOF85yFXPeMXLt`) | live |
| Git connection | GitHub `payswapdotorg/aurum-chat`, production branch `main` | connected |
| Production deployment | <https://aurum-chat-livid.vercel.app> — `dpl_4CCXFBvoCdDZxsaogF2Av2AY8whV` | READY |
| Vercel Blob store | `aurum-chat-blob` — `store_NMK2PD6WFdeI3khy` (iad1, private) | connected (production + preview) |
| Resend | sending-restricted API key, From `Aurum <onboarding@resend.dev>` | verified with a live delivery (2026-09-22) |
| Cron | `0 3 * * *` → `/api/worker` (daily sweep; platform authenticates with `CRON_SECRET`) | registered against the production deployment |
| CI | `.github/workflows/ci.yml` — gates + migration smoke + real-provider suite | runs on every PR |

Project env vars (all `encrypted`, values live only in the Vercel
environment): `BLOB_READ_WRITE_TOKEN` and `RESEND_API_KEY` and `WORKER_TOKEN`
(production + preview), `CRON_SECRET` (production). Preview deployments were
verified through the CLI pipeline; the project's default preview SSO
protection was lifted (PATCH `ssoProtection: null`) so PR previews are
reachable for journey verification — re-enable it in project settings if
preview traffic should stay Vercel-account-gated.

### Open provider gaps — exact operator steps

Production health is intentionally `status: error` (HTTP 503) until the
domain-truth database exists: the deployment REFUSES to serve on the
embedded runtime (lock 35), by design. Two canonical resources could not be
created through any API path reachable with the provided credentials:

1. **Neon PostgreSQL (production database + preview branches).** No Neon API
   key was provided, and no Neon marketplace integration is configured on
   the Vercel account — creating one is an OAuth consent only the account
   owner can complete.
   *Operator step (~2 minutes):* Vercel dashboard → `aurum-chat` → Storage →
   add a Neon PostgreSQL database (complete the integration consent), create
   the production database, then set `DATABASE_URL` (the pooled connection
   string, `sslmode=require`) for the production target — or hand a Neon API
   key to a deployment worker. Redeploy (`vercel deploy --prod`, or any push
   to `main`): the build command runs the migration runner against the new
   database and `/api/health` flips to `status: ok`. Neon branches for
   preview/staging follow the §3 matrix afterwards.
2. **Upstash Redis (queue/cache/lock).** The REST endpoint provided in the
   W077 packet (`meet-ewe-145933.upstash.io`) does not exist in public DNS —
   NXDOMAIN from the authoritative Upstash nameservers: the database was
   deleted or the URL is mistyped, and a per-database REST token cannot
   provision a replacement. (An Upstash marketplace integration exists on
   the account, but it has no database resource attached and exposes no
   buyer-side creation path.)
   *Operator step (~2 minutes):* create an Upstash Redis (Free) database in
   `iad1` (Upstash console or the Vercel Storage tab), then set
   `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or
   `KV_REST_API_URL` + `KV_REST_API_TOKEN`) for production + preview. No
   code change is needed — W077 landed the full redis-over-HTTP transport
   behind the queue/cache/lock ports (`src/infra/redis-rest.ts` + the REST
   backends); `/api/health` relabels queue/cache/lock to `redis` and the
   durability warning disappears. If the instance also exposes a `redis://`
   URL, `REDIS_URL` selects the same backends over the TCP protocol instead.

While the gaps are open the deployment stays honest: `/api/health` reports
`db: embedded` with the production refusal, queue/cache/lock run on the
legal in-process memory backend with the durability warning, and email
(Resend) plus object storage (Vercel Blob) are real and verified.

Resend free-tier constraint: the provided key is sending-restricted and no
sending domain is verified, so `onboarding@resend.dev` delivers only to the
account owner's address. To send to arbitrary recipients, verify a domain at
resend.com and set `EMAIL_FROM`.

### W102 — production schema reconciliation; preview-database operator action item (2026-09-27)

The W101 final certification caught production serving HTTP 500 on
`/ai/preferences` and `/ai/preferences/advanced` for every tenant while
`/api/health` stayed green. Root cause (verified by direct production
Postgres inspection): the project's `DATABASE_URL` targets
`[production, preview]`, and PREVIEW deployments of superseded
parallel-lineage worker branches had run their build-command migrations
— different DDL under the SAME migration filenames — against the SHARED
production Neon database first; the name-keyed `_migrations` ledger then
skipped the merged generation's identically-named migrations forever.
Production was missing 14 current-generation tables (provider-preferences,
vertical-kits, edge-connector) and carried 12 empty orphan tables of the
superseded generation instead (4 sharing current table names in different
shapes, 8 unambiguous debris).

The repair shipped in two coordinated generations (one repair truth, no
parallel migrations):

1. **PR #122 + #123 (merged, deployed):** the three
   `002-repair-migration-name-collision.sql` migrations — one per module —
   renamed the superseded generation's tables, indexes, triggers and
   constraint-indexes to `__orphaned_pre_w0XX` names (renames only,
   nothing dropped; every orphan verified 0 rows in production), then
   created the current schema with `IF NOT EXISTS`/guarded triggers.
   Production is repaired and `/ai/preferences` answers 200. #123 added
   the guarded renames for orphan constraint-index NAMES that collided
   with the new tables (42P07) — a class the first PGlite simulation
   missed and the W102 simulation suite now pins.
2. **W102 (this delivery):** the three `003-drop-orphaned-debris.sql`
   migrations complete the reconciliation by dropping the preserved
   empty debris (count-guarded: a non-empty orphan is kept and the
   census below then fails LOUDLY instead of destroying data), so the
   production schema census equals every fresh environment. Idempotent
   and a no-op wherever no debris exists.

Two systemic guards now catch this class of divergence:

1. **Build time** — `scripts/migrate.ts` verifies after every run that
   every table any discovered migration declares with `CREATE TABLE`
   exists as a public BASE TABLE, and exits non-zero with the exact
   missing-table list (a drifted database can no longer deploy — the
   incident's complete-ledger/divergent-schema state fails the build).
2. **Runtime** — `/api/health` validates a table census (public BASE
   TABLE count + a representative set) in addition to the ledger count;
   a drifted database reports `status: error` 503 instead of a green
   `ok`.

The simulated-divergence suite
(`tests/e2e/platform/schema-reconciliation.test.ts`) reconstructs the
audited production shape — complete ledger, the 12 orphans in their
audited shapes INCLUDING the constraint-index collisions, the regular
index and trigger namesakes — and proves the drift guard fails on that
state, that taking the colliding index names fails with "already
exists" (the 42P07 class), and that `bun run migrate` converges the
database to the current schema with census parity.

**OPERATOR ACTION ITEM — the durable fix (Vercel project setting, for
the tech lead):** separate the `DATABASE_URL` targets so preview
deployments can never migrate the production database again. In the
Vercel project settings, change `DATABASE_URL` to target `Production`
only, and add a separate `DATABASE_URL` scoped to `Preview` pointing at
an isolated Neon branch database (the §3 matrix) — preview builds then
run their migrations against their own disposable branch. Until this is
done, every branch pushed to the repository still migrates the shared
production database at preview-build time (the reconciliation guards
make that state LOUD rather than silent, but the isolation is the real
fix).

### Execution model as instantiated (the W077 binding correction)

Normal cognition is request/event-driven and already wired that way:
`src/app/(product)/chat/lib/workflow.ts` pumps the bounded W013 stages
inline within the member's send request (`runChatTurn`), persisting every
stage — the daily cron is NOT the cognition trigger. Durable fan-out runs
`event → queue → idempotent consumer`: the queue port (memory until Upstash
lands) plus the `POST /api/worker` push seam, which accepts the
`{"jobs":[...]}` deliveries a platform queue consumer makes and runs them
through the identical core path — verified live on the production
deployment (an invalid envelope is dead-lettered with a precise reason, no
side effects). The `vercel.json` daily 03:00 UTC cron sweep stays as the
bounded, idempotent recovery mechanism (find stuck work, re-enqueue through
the same path) — never a hidden reasoning loop, never domain truth
(`CognitionExecution` + PostgreSQL remain authoritative).

Managed Vercel Queues could not be created through any API path exposed to
the deployment token (`/v1/queues` and variants → 404; the CLI ships no
queue commands) — the consumer seam a managed queue would deliver to is
live and token-authenticated. Vercel Workflows adoption is deliberately
deferred: routing the loop through a workflow engine would touch W013
semantics, and the frozen plan wires them only "where they improve durable
execution" — the queue + inline request-driven pump + cron sweep already
implement the corrected model.

## 12. Rollback

1. **Bad production deployment (code-level):** roll forward with a fix to
   `main` (the Git connection auto-deploys), or promote any earlier READY
   deployment: dashboard → Deployments → ⋯ → *Promote to Production*, or
   `vercel redeploy dpl_<known-good-uid> --token <token>`.
2. **Bad environment variable:** dashboard → project → Settings →
   Environment Variables → edit/remove, then redeploy. The Blob store can
   be detached the same way (Storage → store → Disconnect); its objects are
   disposable artifacts, never domain state.
3. **Bad data/migration:** migrations are additive and idempotent
   (`_migrations`-recorded). For a destructive case, restore the Neon
   database to a branch/snapshot taken before the change (Neon branching is
   the free-tier backup mechanism) and redeploy.
4. **Whole environment:** the project is disposable by design — delete the
   Vercel project (dashboard or `DELETE /v9/projects/{id}`), the Blob store
   (`DELETE /v1/storage/stores/blob/{id}`), and re-run this runbook from
   §4. Nothing in the repository holds provider state: every resource is
   re-creatable from code plus this file.

## 13. Post-deployment smoke (W078)

`bun run smoke:dogfood` is the post-deployment acceptance harness: it
proves the DEPLOYED system over real HTTP — routing gates,
health/readiness, the worker seam's fail-closed auth and its
duplicate/dead-letter/not-found dispositions, queue/worker observability,
real authentication (fresh sign-up → onboarding → company → chat → a full
composer turn), the seeded demo journeys (persona sign-in with the
manifest password, the seeded thread, the pending approval decided
inline), plus the repository's operations surface (this runbook's
rollback cases, the CI gates, the deployment configuration, environment
separation). The typed check catalog, evaluators and driver live in
`src/modules/deployment-smoke/`; the CLI is `scripts/deployment-smoke.ts`.

```bash
# the hosted dogfood (routine post-deploy check)
bun run smoke:dogfood -- \
  --target https://aurum-chat-livid.vercel.app \
  --profile full --expect-environment production --quick-sign-in off

# a preview-profile deployment artifact of this repository
bun run vercel:build && bun run seed:demo
DEPLOYMENT_ENV=preview WORKER_TOKEN=<t> bun run next start -- -p 3130
bun run smoke:dogfood -- \
  --target http://localhost:3130 --profile full --expect-environment preview \
  --worker-token <t> --quick-sign-in off
```

Verdicts per check: **PASS** (observed as specified), **FAIL** (the
target violated its own contract), **BLOCKED** (a documented external
precondition is missing — the §11 operator steps; the target's own health
endpoint must be reporting the gap honestly for a check to be blocked),
**SKIP** (not applicable to this target/profile). Exit codes: `0` green,
`1` failures, `2` blocked-attention (`--allow-blocked` acknowledges a
known gap). Evidence lands in `docs/productization-evidence/W078/<label>/`
(`smoke-report.json` + `smoke-report.md`); the committed runs live there.

Operator notes:

- **Today (Neon gap open):** the full-profile production run passes the
  hosted layer (liveness, routing, the health contract, the honest
  503 refusal, the worker seam's 401s, quick-sign-in correctly off in
  the production runtime) and reports the journey layer BLOCKED with the
  §11 operator steps. Complete the Neon step, redeploy, re-run — the
  same command goes green.
- **Worker token:** the journey-layer worker probes need `WORKER_TOKEN`
  (a production secret — pass `--worker-token` or `AURUM_SMOKE_WORKER_TOKEN`;
  it is never printed or written into the reports).
- **Deterministic re-runs:** the seeded pending approval is one-shot; a
  green re-run of the full matrix needs the demo world reseeded
  (`rm -rf .data && bun run vercel:build && bun run seed:demo`) — the
  same reset-and-reseed discipline the W076 browser suite applies per
  run.
- The suite's own gates-time proof is
  `tests/e2e/deployment-smoke/smoke.e2e.test.ts`: the full matrix, green,
  over real HTTP against the real handler libraries and the real W068
  demo world.
