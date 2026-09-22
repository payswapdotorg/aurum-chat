# W078 — Post-Deployment Smoke and Operations Proof — Evidence & Operations Report

**Work item:** W078 (post-W070 hardening, frozen plan §5; catalog:
"Prove the hosted dogfood environment through real authentication,
onboarding, chat, seeded journeys, durable execution retry/idempotency,
health/readiness, queue/worker observability and release/rollback
checks.")
**Branch:** `work/w078-deployment-smoke-ops`
**Base:** `0616cdb5ee2444bf4ccd526a4616f4fe78ee8f3a`
**The one command:** `bun run smoke:dogfood -- --target <url> --profile full …`

---

## 1. What this delivery is

W076 proved the repository's journeys in a real browser; W077
instantiated the hosted dogfood environment. W078 adds the layer that
proves the DEPLOYED SYSTEM itself, repeatably, from outside:

| Piece | Path | Role |
| --- | --- | --- |
| Smoke module | `src/modules/deployment-smoke/` | the typed check catalog (every W078 acceptance bullet → machine-checkable checks), the pure expectation evaluators (health contract, worker dispositions, chat/session/routing), the repo-surface checks (rollback runbook, CI gates, deployment config, demo gate, environment matrix), the HTTP driver (`runDeploymentSmoke`) and the report model (pass/fail/blocked/skipped + JSON/markdown) |
| Gates-time proof | `tests/e2e/deployment-smoke/smoke.e2e.test.ts` | the FULL matrix, green, over real HTTP (node:http on an ephemeral port) against the REAL handler libraries, the REAL page components (the W070 SSR machinery) and the REAL W068 demo world — 0 fail, 0 blocked |
| Operator CLI | `scripts/deployment-smoke.ts` (`bun run smoke:dogfood`) | runs the driver against any hosted target; writes evidence JSON+markdown; exit codes 0 green / 1 failures / 2 blocked-attention |
| Runbook | `docs/DEPLOYMENT.md` §13 | the operator-facing smoke workflow (this file's users) |
| Evidence | `docs/productization-evidence/W078/**` (this tree) | the committed runs: live production dogfood + the deployment artifact (twice) |

**Verdict discipline (the honesty rule).** PASS = observed as specified.
FAIL = the target violated its own contract. BLOCKED = a documented
external precondition is missing — the target's OWN health endpoint must
be reporting the gap honestly for a check to be blocked (never a way to
launder a violation). SKIP = not applicable to this target/profile.

## 2. The evidence runs (2026-09-22, this branch's tree)

### 2.1 The hosted production dogfood — the honest state today

```bash
bun run smoke:dogfood -- \
  --target https://aurum-chat-livid.vercel.app \
  --profile full --expect-environment production --quick-sign-in off \
  --label production-dogfood
```

**Verdict: 18 passed · 0 failed · 22 blocked · 0 skipped (exit 2).**
Full report: `production-dogfood/smoke-report.md`.

What PASSED against the live production deployment:

- liveness + the full routing gate chain (`/`, `/chat`, `/onboarding`
  anonymous → 307 `/signin?next=…`; `/signin` renders real HTML; the
  referenced `/_next/static` CSS chunk serves 200);
- the health/readiness CONTRACT (exact shape, `cache-control: no-store`,
  HTTP-code ⇄ status consistency, all component backend labels, the
  worker metrics registry, the guardrails);
- **the honest fail-closed refusal** (lock 35): production without
  `DATABASE_URL` answers 503 `status: error` with the precise
  "production requires the external PostgreSQL backend" refusal — the
  deployment refuses to serve on the embedded runtime, exactly as
  designed (W077 §11);
- the worker seam's fail-closed auth: 401 without a token, 401 with a
  bad token;
- environment separation observed on the hosted target: the health
  environment label is `production`, and `/api/auth/quick-sign-in`
  correctly answers 404 `not_available` (demo credentials are OFF in a
  production runtime);
- the repo-layer release checks (below).

What is BLOCKED (all 22, with the same precise reason recorded per
check): the journey layer — real authentication, onboarding, chat,
seeded journeys, worker execution dispositions, counter advancement —
plus `health.green` and the token-authenticated observability snapshot.
The blocker is the W077 §11 documented operator gap (Neon `DATABASE_URL`
— an account-owner consent step no API path reachable to a deployment
worker can perform), which the target's own `/api/health` reports
honestly (`db: embedded`, `ENOENT … mkdir '.data'` on the serverless
filesystem). The token-gated snapshot additionally needs `WORKER_TOKEN`
(a value that lives only in the Vercel project environment).

**The moment the operator completes the §11 steps and redeploys, the
identical command goes green** (the artifact runs below are that same
matrix, fully green, on the same code).

### 2.2 The deployment artifact — the full matrix, green

The real Vercel build command, the real production server, a
preview-profile environment (the legal non-production runtime for the
embedded database — the demo world may never be seeded into production
backends, W068's gate):

```bash
rm -rf .data
bun run vercel:build            # = bun run migrate && next build  → exit 0
bun run seed:demo               # the deterministic W068 demo world  → exit 0
DEPLOYMENT_ENV=preview WORKER_TOKEN=<local> bun run start -- -p 3130
# /api/health → 200 status ok, environment preview, 91 migrations

bun run smoke:dogfood -- \
  --target http://localhost:3130 --profile full \
  --expect-environment preview --worker-token <local> \
  --quick-sign-in off --label deployment-artifact-preview
```

**Verdict: 39 passed · 0 failed · 0 blocked · 1 skipped (exit 0).**
Full report: `deployment-artifact-preview/smoke-report.md`.

The matrix proven over real HTTP on the built artifact:

- **Real authentication:** a fresh visitor registers through
  `/api/auth/sign-up` (no quick-access panel, no shortcuts), receives
  the hardened session cookie (`HttpOnly; SameSite=Lax; Path=/`), the
  session reports the honest `no-company` state, chat refuses it with
  409 `no_active_company`, onboarding creates the company and selects
  the tenant, sign-out revokes the session (401 after).
- **Chat is the primary root:** an authenticated session is routed from
  `/` to `/chat` (307); the composer turn runs the real workflow and
  returns the reply with the cognition `executionId` (durable execution
  behind the turn); the turn persists into the thread.
- **Seeded demo journeys:** the seeded manager persona signs in through
  the REAL password path (the manifest's fragment-assembled demo
  password); the seeded conversation `Wholesale freshness — Aurum` is in
  the chat list; the thread opens with its recorded turns; the attention
  turn surfaces the seeded pending approval as a chat card
  (`decision.requestId`, status `pending`); the approval is decided
  INLINE through the chat approvals API and the timeline re-read shows
  the decision (`approved`) — Journey E, chat-first, on the deployed
  artifact.
- **Durable execution semantics (the worker push seam):** a redelivered
  stale-stage job for the completed turn execution is ACKNOWLEDGED as an
  idempotent `duplicate` (persisted execution state is the idempotency
  authority — no double step); an invalid envelope is `dead_letter`ed
  with the precise reason (`invalid job envelope: …`) and never
  retried; a well-formed job for an unknown execution is consumed as
  `not_found` (never retried); a pull-mode sweep of the drained queue
  reports `idle` honestly.
- **Health/readiness:** `status: ok`, db answers, schema applied
  (91 migrations), zero refusals.
- **Observability:** `GET /api/worker` exposes `queueDepth` and the full
  metrics registry; the counters ADVANCE with the observed dispositions
  (duplicate ≥ 1, not-found ≥ 1, batches ≥ 1, `lastActivityAt` set);
  the health and worker surfaces report the SAME counters.
- **Release/rollback (repo layer):** the rollback runbook documents all
  four recovery cases; a known-good deployment uid (`dpl_…`, READY) is
  recorded as the promote target; CI runs the four gates; the deployment
  config migrates before build and sweeps `/api/worker` daily
  (`0 3 * * *`); the W076 browser suite is registered and evidenced.
- **Environment separation:** the artifact reports `preview` (vs the
  hosted target's `production` — two distinct labels observed over HTTP
  in the same evidence tree); quick-sign-in is OFF in the
  `NODE_ENV=production` server runtime; the demo seed gate refuses
  production runtimes, server databases and `AURUM_DB=postgres` while
  allowing the isolated memory test mode.
- The single SKIP is `health.honest-refusal` — a healthy target has no
  refusal state to observe (that check is proven live in §2.1).

### 2.3 The deterministic re-run (redeploy/rollback rehearsal)

```bash
pkill the server; rm -rf .data
bun run migrate                  # → "applied 91 migration(s), skipped 0"
bun run seed:demo                # fresh demo world (fresh ids)
DEPLOYMENT_ENV=preview WORKER_TOKEN=<local> bun run start -- -p 3130
bun run smoke:dogfood -- … --label deployment-artifact-preview-rerun
```

**Verdict: 39 passed · 0 failed · 0 blocked · 1 skipped (exit 0)** —
identical to the first artifact run. Same build, fresh database, second
server process: re-deploying the same revision reproduces the
known-good state bit for bit (the W076 reset-and-reseed discipline,
applied to the deployment artifact).

**Migration idempotency** (the property that makes every redeploy safe):
re-running the migration set on the already-migrated artifact database
is a recorded no-op — `applied 0 migration(s), skipped 91` (transcript
in §2.3's command sequence; the runner records applied/skipped counts).

## 3. The browser-journey layer on production dogfood (honest status)

"Browser journeys pass on production dogfood" requires hosted
authentication to work, which requires the Neon `DATABASE_URL` step
(§2.1's blocker). The repository carries the full browser layer —
`bun run browser:journeys` (W076's Playwright suite, desktop 1280×800 +
mobile 390×844/touch, evidenced in
`docs/productization-evidence/W076/`) — and the smoke's repo check
proves it is registered and evidenced. The post-Neon path is exact:

1. complete the §11 Neon consent + `DATABASE_URL`, redeploy;
2. `bun run smoke:dogfood -- --target <production-url> --profile full
   --worker-token <WORKER_TOKEN> --expect-environment production
   --quick-sign-in off` → green;
3. re-run the W076 browser suite against the hosted target.

## 4. Retry semantics — what is observed where

- **Duplicate delivery (idempotency):** observed LIVE over HTTP on the
  deployed seam (§2.2) — a stale-stage job is acknowledged `duplicate`,
  no side effects, counter advances. This is the at-least-once delivery
  contract of the queue port proven through the production code path.
- **Deterministic rejections:** observed LIVE — invalid envelopes and
  unknown executions are consumed (`dead_letter` / `not_found`) and
  never retried.
- **Transient-failure retry escalation** (attempt+1 up to the
  `workerMaxAttempts` guardrail, then dead-letter): the retry POLICY is
  surfaced and verified on both observability endpoints
  (`worker.retry-policy-surface`), and the escalation behavior itself is
  proven by the repository's worker suites that the four gates run —
  `src/infra/worker-retry.test.ts` (unit, contract-fault injection) and
  the real-provider integration suites (`worker-realredis.test.ts`,
  real PostgreSQL + real Redis in CI) — the same backends production
  uses. Over-the-wire transient faults cannot be injected into a
  healthy hosted deployment without breaking it; the driver observes
  every disposition that CAN be honestly provoked externally.

## 5. Release / rollback checks (what the smoke proves)

1. **Runbook coverage** — `docs/DEPLOYMENT.md` §12 documents all four
   recovery cases (code-level promote-to-production with the
   `vercel redeploy dpl_<uid>` command; environment-variable recovery;
   data/migration recovery via Neon branching; whole-environment
   rebuild from code). Verified programmatically
   (`release.rollback-runbook`).
2. **A known-good promote target exists** — the W077 §11 as-deployed
   record carries the READY production deployment uid
   (`release.known-good-deployment`).
3. **CI gates** — the four repository gates run on every PR/push
   (`release.ci-gates`).
4. **Deploy config** — `vercel:build` migrates before `next build`; the
   daily `0 3 * * *` cron sweeps `/api/worker` (bounded recovery, never
   the primary cognition trigger) (`release.deployment-config`).
5. **Redeploy determinism** — same-revision rebuild + fresh world →
   identical green verdict (§2.3); migrations re-run as a no-op.

## 6. Reproducing everything

```bash
bun install
bun run typecheck && bun run test && bun run arch && bun run lint
bunx vitest run tests/e2e/deployment-smoke   # the gates-time full matrix

# against the hosted dogfood (today: hosted layer green, journey blocked on §11)
bun run smoke:dogfood -- --target https://aurum-chat-livid.vercel.app \
  --profile full --expect-environment production --quick-sign-in off

# against a deployment artifact (full matrix green)
bun run vercel:build && bun run seed:demo
DEPLOYMENT_ENV=preview WORKER_TOKEN=<t> bun run start -- -p 3130
bun run smoke:dogfood -- --target http://localhost:3130 --profile full \
  --expect-environment preview --worker-token <t> --quick-sign-in off
```

(Sandbox note: `DATABASE_URL` must be unset for the embedded-backend
artifact runs — a server database is a different profile, and the demo
seed gate refuses it by design.)
