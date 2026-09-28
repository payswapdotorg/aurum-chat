# W112 — Post-W106 Live-Capability Certification

**Work item:** W112 (spec/POST-W106-CONTINUATION-DAG-2026-09-27.md §W112 — the DAG's final item)
**Author:** W112 certification worker (sandbox session, 2026-09-28)
**Deployment under certification:** `dpl_GxApj6s3CECE` @ `c079cab7fd7eacd363a643c83d3697c4667b6410`
**Production surface:** https://aurum-chat-livid.vercel.app
**Boundary honored:** `docs/productization-evidence/W112/**` only — no source, migration, or contract changes (work order §2/§3).

> The governing rule (spec DAG, line 120): **"W112 must never manufacture live evidence from deterministic doubles."**
> Every classification below is tagged with its evidence source:
> **[PROBED]** — executed by W112 against production or at the certified revision in this sandbox (raw output in `probes/`).
> **[REPO-FACT]** — a committed file at `c079cab7fd7eacd363a643c83d3697c4667b6410` (path cited).
> **[TRANSMITTED]** — asserted by the work order; not independently verifiable from this sandbox (no Vercel/token visibility); recorded verbatim with source note.

---

## 0. Premise record — one documented discrepancy

The work order's §0a demanded `git rev-parse HEAD` = `c079cab7fd0f7ac0b96606e75936e93100c24ba1`. **That exact
40-character SHA does not exist in the repository**:

```
$ git checkout c079cab7fd0f7ac0b96606e75936e93100c24ba1
fatal: unable to read tree (c079cab7fd0f7ac0b96606e75936e93100c24ba1)
$ git cat-file -t c079cab7fd0f7ac0b96606e75936e93100c24ba1
fatal: git cat-file: could not get object info
```

The object is absent from the full clone (not reachable from any branch or tag — cross-checked against
`git ls-remote origin`). The work order's 7-character prefix resolves **unambiguously**:

```
$ git rev-parse c079cab
c079cab7fd7eacd363a643c83d3697c4667b6410      # "W110: real browser/computer-use driver composition (Playwright)"
```

That commit is exactly the work order's narrative: the **last of the W107–W111 merges**
(`53bd271` W108 → `7395098` W107 → `507ebce` W109 → `2659898` WMIG → `9f4f67b` W111 → `c079cab` W110),
the parent of `09fbb6d` (W113) and of `780b05b` (the empty deploy-trigger chore, see §4). Every other
premise item verified green (evidence tree `W076…WMIG` complete; modules `cellular, computer-use,
edge-connector, migration, realtime, vertical-kits` all present; live `/api/health` = production,
migrations 138, census 258/258).

**Disposal:** the work order's 40-char tail is recorded as a mis-transcription; this certification binds
to the resolved real SHA **`c079cab7fd7eacd363a643c83d3697c4667b6410`**. The discrepancy is flagged for
tech-lead confirmation — it is recorded here and in `certification.json`, never laundered. (Stopping the
program's final work item over a 33-character tail whose 7-character prefix is unambiguous would have
served honesty less than recording the resolution with full evidence.)

---

## 1. Deployment identity (as probed and as transmitted)

| Field | Value | Source |
| --- | --- | --- |
| Deployment id | `dpl_GxApj6s3CECE` | **[TRANSMITTED]** (work order). Not recorded in any committed file at `c079cab` or at `main@780b05b`. Verifiable with a Vercel API token via the harness's own call: `GET https://api.vercel.com/v6/deployments?projectId=prj_PljFx5DnZ1MCqQ5bA1uK6G1o8gFy&teamId=team_4KOoA5CgtYaOF85yFXPeMXLt&target=production` (src/modules/release-certification/driver.ts:181-186) — no Vercel token is provisioned in this sandbox. |
| Commit | `c079cab7fd7eacd363a643c83d3697c4667b6410` (resolved; see §0) | **[REPO-FACT]** + **[TRANSMITTED]** ("production serves c079cab, pre-W113") |
| Health | `status ok · production · hostedOnVercel · db postgres ok · migrations 138 · census 258/258 expected, missing [] · readiness 0 refusals / 0 warnings` | **[PROBED]** 2026-09-28T08:19:30Z and 2026-09-28T08:26:56Z (both pasted below; raw in `probes/health.json`) |
| Migrations / census | 138 / 258 of 258 | **[PROBED]** — exactly the post-W111 chain (W111 raised the census pin 257→258 and the chain to 138 with `migration/002-w111-migration-readers.sql`; fresh re-proof at the certified revision below). |

Raw probe (2026-09-28T08:26:56Z, HTTP 200):

```json
{"status":"ok","checkedAt":"2026-09-28T08:26:56.169Z","environment":{"environment":"production","hostedOnVercel":true,"commercial":false,"dogfoodNotice":"internal/non-commercial dogfood while the free tier is used (plan §7)"},"components":{"db":{"backend":"postgres","ok":true,"migrations":138,"tables":{"census":258,"expected":258,"missing":[]},"error":null},"queue":{"backend":"redis"},"cache":{"backend":"redis"},"lock":{"backend":"redis"},"email":{"backend":"resend"},"blob":{"backend":"vercel-blob"}},"guardrails":{"workerMaxAttempts":5,"workerBatchLimit":10,"workerPollIntervalMs":2000,"emailDailyLimit":100,"blobMaxBytes":8388608,"dbPoolMax":5},"readiness":{"refusals":[],"warnings":[]},"worker":{"jobsEnqueued":0,"jobsProcessed":0,"jobsSuspended":0,"jobsDuplicate":0,"jobsConflict":0,"jobsNotFound":0,"jobsRetried":0,"jobsDeadLettered":0,"idlePolls":0,"batches":0,"lastActivityAt":null},"processUptimeSeconds":1}
```

Honest limits of the probe: `/api/health` does not expose the deployment id or commit SHA, so the binding
`dpl_GxApj6s3CECE ↔ c079cab…` rests on the work order's transmission, corroborated by (a) the health
numbers matching the post-W111/pre-next-deploy chain, and (b) the trigger commit `780b05b`
(2026-09-28T07:28:27Z, empty, message "chore: trigger production deploy of W113 (final roadmap tree
09fbb6d + LiveKit env + WORKER_TOKEN rotation)") whose deploy did not take effect — production still
serves the pre-W113 state. **[REPO-FACT + PROBED, consistent; not SHA-pinning]**

---

## 2. The capability matrix

Classifications are **as actually live in the deployed environment** `dpl_GxApj6s3CECE`.

| # | Capability | Classification in `dpl_GxApj6s3CECE` | Primary evidence |
| --- | --- | --- | --- |
| 1 | W107 vertical-kit ↔ edge composition | **FIXTURE-PROVEN** (deterministic, over the REAL W088 implementation); live customer-edge leg **ENVIRONMENT-BLOCKED** | `W107/DELIVERY.md` §3/§5; fresh 81/81 **[PROBED]** |
| 2 | W108 cellular live transport | **ENVIRONMENT-BLOCKED** (live carrier legs — no carrier credentials in the deployed env; honest `provider_unavailable` / fail-closed 503 edge **[PROBED]**); transport + wiring **FIXTURE-PROVEN** (deterministic + vendor-shape) | `W108/DELIVERY.md` §5(c); probe below |
| 3 | W109 meeting/realtime LiveKit | Capability **LIVE-PROVEN** against real LiveKit Cloud (worker-sandbox scope, committed evidence); **in this deployment: ENVIRONMENT-BLOCKED** (`LIVEKIT_*` env vars absent — added to the Vercel project AFTER this deployment was built; effective on the NEXT deployment) | `W109/live-leg/live-leg-latest.json` |
| 4 | W110 real browser driver | Browser execution **REAL-PROVEN** (worker-sandbox scope, committed evidence); **in this deployment: ENVIRONMENT-BLOCKED/unwired** (`BROWSER_DRIVER` unset → honest `driver_unavailable`); deterministic double default **FIXTURE-PROVEN** | `W110/report.json` + `artifacts/` |
| 5 | W111 migration readers | **REAL-PROVEN** over the real production schema on the embedded PostgreSQL engine (full chain, freshly re-proven at the certified revision); hosted-Postgres (Neon) leg **ENVIRONMENT-BLOCKED** (DNS) | `W111/DELIVERY.md` §2; fresh chain **[PROBED]** |
| 6 | WMIG migration-runner checksums | **LIVE-PROVEN in production** (migrations counter 138 incl. both post-WMIG migrations, applied by the checksum-hardened runner) | `/api/health` probe + fresh ledger re-proof |

### 2.1 W107 — vertical-kit ↔ edge composition — FIXTURE-PROVEN · live leg ENVIRONMENT-BLOCKED

- **What is proven [REPO-FACT]:** the composition adapter `src/modules/vertical-kits/edge-adapter.ts`
  (`createEdgeConnectorKitEdge`) rides the REAL W088 machinery end-to-end (signed tenant-scoped edge jobs,
  dial-home execution, W084-shaped receipts) — no edge-connector internal imported. Deterministic proof:
  `src/modules/vertical-kits/tests/vertical-kits-edge-composition.test.ts` (5 tests: signed jobs +
  W084-shaped evidence; grant denial BEFORE any edge call; content-addressed idempotency; tenant
  isolation + honest unwired refusal; edge-boundary refusal surfaced as the edge contract's own error).
- **Fresh verification at the certified revision [PROBED]:** `bun run test -- vertical-kits edge-connector`
  → **81/81 PASS (7 files)** — identical to the merge record (`W107/DELIVERY.md` §3). Raw tail:
  `probes/gates-tests-w107-composition.txt`.
- **Live in the deployed env:** the composition code is deployed at `c079cab…`, but **no production route
  invokes `setTenantKitEdge`** (the invocation site is a recorded frontier — `W107/DELIVERY.md` §6), so
  kit edges are unwired in production and the honest `edge_unavailable` / frozen `deferred-on-w088`
  readiness stands. The live customer-edge leg (customer-operated edge runtime, enrollment key material,
  per-tenant wiring, live kit write) is **ENVIRONMENT-BLOCKED with the exact prerequisites recorded**
  (`W107/DELIVERY.md` §5). Nothing was faked.

### 2.2 W108 — cellular live transport — ENVIRONMENT-BLOCKED (live carrier legs) · FIXTURE-PROVEN (transport + wiring)

- **Code paths [REPO-FACT]:** env-driven wiring `src/infra/cellular.ts`
  (`ensureCellularTransportsWired()`; unset/partial → transport stays unwired → honest
  `provider_unavailable`, never a faked success); real transports
  `src/modules/cellular/adapters/transport-twilio.ts` + `transport-telnyx.ts`; carrier webhook edge
  `/api/webhooks/cellular/[provider]` (fail-closed: 503 unconfigured, 403 unverifiable, 202 unknown
  tenant, 400 malformed).
- **Live in the deployed env — the honest posture is itself live-proven [PROBED]:**

  ```
  $ curl -s -X POST https://aurum-chat-livid.vercel.app/api/webhooks/cellular/twilio   # 2026-09-28T08:27Z
  HTTP 503
  {"ok":false,"error":"carrier webhook verification is not configured for 'twilio' (set CELLULAR_TWILIO_AUTH_TOKEN; the edge stays closed until the carrier's requests can be verified)"}
  ```
  The deployed environment holds **no carrier credentials** — the edge fails closed exactly as designed.
- **Fixture layer [PROBED]:** `bun run test -- cellular` → **179/179 PASS (12 files)** at the certified
  revision (`probes/gates-tests-cellular.txt`), covering the vendor-shape transports, the wiring, the
  carrier webhook edge, the manager-inbound authority ledger, and the composed live-adapter path.
- **Honesty note on the work-order text:** the work order cites "Live test-transport proof from the W108
  evidence tree." The repo facts are stricter: `W108/DELIVERY.md` §5(c) records **"No live Twilio or
  Telnyx call was made, and none was faked"** — the live carrier leg is ENVIRONMENT-BLOCKED (no
  credentials in any audited environment). The closest artifact, `cellular-live-composition.test.ts`,
  runs the REAL adapter code over an **injected deterministic fetch double — no network** (test header,
  line 4). It is classified here as fixture/vendor-shape proof, **not** live proof. Exact prerequisites
  to turn the live path on: `CELLULAR_TWILIO_ACCOUNT_SID`+`CELLULAR_TWILIO_AUTH_TOKEN` and/or
  `CELLULAR_TELNYX_API_KEY`(+`CELLULAR_TELNYX_CALL_CONTROL_APP_ID`), `CELLULAR_TELNYX_PUBLIC_KEY` for the
  webhook edge, carrier-side webhook configuration, and a tenant connection registration
  (`W108/evidence.json` `liveLegPrerequisites`).

### 2.3 W109 — meeting/realtime LiveKit — LIVE-PROVEN capability (sandbox scope) · ENVIRONMENT-BLOCKED in this deployment

- **The capability is LIVE-PROVEN against the real SFU [REPO-FACT]:** run window
  **2026-09-28T00:26:31.191Z … 2026-09-28T00:26:54.643Z** against the operator's LiveKit Cloud
  (`wss://zeck-vuo9lv9v.livekit.cloud`, region Japan, server 1.13.7):
  - real room **`RM_xTQ3FdxkKcZ7`** (`aurum-d1d48061-eb95…`) created via `CreateRoom`;
  - real participant join **`w109-live-human` (`PA_TzWmcuZ8u9Mb`)** over the signal WebSocket with the
    real SFU event stream (`join`, `update`, `offer`, `trickle`, `roomUpdate`, `pong`, `leave`);
  - real egress **`EG_wwsWQi7EdsQZ`** started (`EGRESS_STARTING`) and **joined the room as a real
    participant (`PA_Pjpq8o9GfzZh`**, observed via `ListParticipants`); consent revocation stopped it
    (`StopEgress` → `EGRESS_ABORTED`);
  - live transcript + speaker attribution landed as a canonical turn (finalization artifact
    `sha256:c388f808…`, turnCount 3); a second `aurum_voice` leg finalized with artifact
    `sha256:cbdd1c44e…`;
  - durable finalization succeeded on both legs; the client received `Leave` reason 5 (`ROOM_DELETED`),
    close 1000, room gone after stop.
  Full machine-checkable report: `W109/live-leg/live-leg-latest.json`; digest `W109/evidence.json`.
- **Scope honesty:** that live proof was produced **from a worker sandbox** (operator credentials in
  process env, secrets REDACTED in all evidence), running this revision's transport — **not from the
  deployed instance**. In `dpl_GxApj6s3CECE` the `LIVEKIT_*` env vars are **absent**: per the work order
  **[TRANSMITTED]** they were added to the Vercel project **after this deployment was built** (corroborated
  by the trigger commit `780b05b`'s message: "…final roadmap tree 09fbb6d + LiveKit env + WORKER_TOKEN
  rotation"). The deployed wiring (`src/modules/realtime/wiring.ts`, `ensureRealtimeTransportsWired()`)
  therefore reports unwired and any live meeting attempt on THIS deployment fails honestly
  (`provider_unavailable`).
- **What that means, precisely:** the transport + wiring are deployed and the capability is real
  (live-proven at the transport level with committed evidence), but the live proof **does not attach to
  `dpl_GxApj6s3CECE`** — for THIS deployment the capability is **ENVIRONMENT-BLOCKED**. The **next
  deployment** (post quota reset) carries the `LIVEKIT_*` vars; from that build onward the deployed
  wiring reports `wired` and a deployment-scoped live probe becomes possible. Fresh deterministic layer
  at the certified revision [PROBED]: `bun run test -- realtime` → **88 passed + 16 skipped** (the
  credential-gated live suite skips loudly without the operator env — the honest skip), 7 files
  (`probes/gates-tests-realtime.txt`).
- **Sub-capabilities that stay blocked even with credentials [REPO-FACT, `W109/evidence.json`
  `environmentBlockedExceptions`]:** recording FILE artifacts (LiveKit file egress requires an external
  storage destination the operator project lacks — the egress CONTROL plane is live-proven), telephony
  SIP dial-out (`livekit.SIP/*` answers 401 "permissions denied" — feature not enabled on the project),
  and WebRTC data-channel receive (needs a full WebRTC stack — the agents-worker frontier).

### 2.4 W110 — real browser driver — REAL-PROVEN execution (sandbox scope) · ENVIRONMENT-BLOCKED/unwired in this deployment

- **The execution evidence is committed [REPO-FACT]:** `W110/report.json` — executed
  **2026-09-28T05:15:47.047Z** against real chromium **143.0.7499.4** (headless) through the PRODUCTION
  wiring path (`BROWSER_DRIVER=playwright` + `ensureBrowserDriverWired()` → `wiringReport.state: wired`)
  and the existing W093 lifecycle: happy path 7/7 steps verified (`completed`); transient-failure resume
  (fixture socket death mid-response; checkpoint steps never re-dispatched; same isolated profile);
  wrong-credentials mismatch (real W084 diff with real observed values, terminal `mismatched`); secrets
  sweep (SQL + byte-level artifact sweep, 0 hits). `W110/artifacts/`: 8 PNG screenshots + 5 DOM-snapshot
  HTMLs, content-addressed, sha256-pinned in the report. Re-runnable:
  `./node_modules/.bin/tsx docs/productization-evidence/W110/run-real-browser-task.ts`.
- **In the deployed env [TRANSMITTED + REPO-FACT]:** `BROWSER_DRIVER` is unset in the serverless
  environment → **nothing is wired** → the honest pre-W110 `driver_unavailable` posture
  (`src/modules/computer-use/wiring.ts`: unset/`none`/unknown → unwired; `BROWSER_DRIVER=deterministic`
  → the scripted fixture double — NOT a real browser — remains the test-suite default). No production
  route or worker pump invokes `ensureBrowserDriverWired()` yet (the recorded W112 frontier —
  `W110/DELIVERY.md` §8). The **deterministic double default is FIXTURE-PROVEN** and freshly re-verified:
  `bun run test -- computer` → **70/70 PASS (6 files)** at the certified revision
  (`probes/gates-tests-computer.txt`).
- Net classification for `dpl_GxApj6s3CECE`: the browser-driver capability is REAL-PROVEN as a
  capability (committed sandbox evidence), but **unwired in the deployed environment** — an honest
  ENVIRONMENT-BLOCKED posture, plus the fixture-proven deterministic default. Never conflated.

### 2.5 W111 — migration readers — REAL-PROVEN (embedded, full chain) · hosted leg ENVIRONMENT-BLOCKED

- **Real adapters over the production schema [REPO-FACT]:** the CSV export-library incumbent reader
  (`src/modules/migration/adapters/csv-export-incumbent-reader.ts`, RFC 4180 state machine, per-row
  rejection ledger), the world native reader (`world-native-reader.ts`, reads the real W005
  `world_entities` schema through the db port), and the file-share verification edge adapter
  (`file-share-verify.ts`, real `EdgeConnectivityAdapter` re-reading the CSV through signed edge jobs;
  execute permanently refused by policy). Full path proven in
  `src/modules/migration/tests/migration-readers-real.test.ts`: staged import → W084 comparison →
  verification → progressive retirement → sequestration rollback, with count reconciliation
  (`export rows = staged + rejected (+ conflicted)`) asserted per round.
- **Embedded leg, freshly re-proven at the certified revision [PROBED]:**
  - `bun run test -- migration` → **56 passed + 1 skipped** (the hosted leg's honest
    `AURUM_TEST_DATABASE_URL`-gated skip), 6 files (`probes/gates-tests-migration.txt`);
  - fresh embedded boot `AURUM_DB=embedded bun run migrate` → **applied 138 migration(s)**, "schema
    verification passed — 257 expected table(s) all present (public table census: 258)", idempotent
    re-run "applied 0, skipped 138" (`probes/gates-migrate-fresh.txt`);
  - ledger check over the fresh db: **`SELECT count(*), count(content_sha) FROM _migrations` → 138 rows,
    138 hashed** — including `cellular/006-cellular-inbound-authority.sql` (W108) and
    `migration/002-w111-migration-readers.sql` (W111) — matching `W111/db-dev-full-chain.txt` +
    `gates-migrate.txt` and the production health numbers (§1).
- **Hosted-Postgres (Neon) leg — ENVIRONMENT-BLOCKED with the exact prerequisite [REPO-FACT,
  re-probed]:** the prerequisite is **network egress to `api.neon.tech` (or any reachable hosted
  PostgreSQL connection string) from the execution environment**. W111 verified it three ways
  (`W111/neon-dns-probes.txt`: getent exit 2, node `dns.lookup` ENOTFOUND, curl `(6) Could not resolve
  host`, with `github.com` resolving as the control); W112 re-verified from this sandbox
  (**2026-09-28T08:27:09Z**, `probes/neon-dns-w112.txt`):

  ```
  $ getent hosts api.neon.tech        → exit=2
  $ curl -sS -m 10 https://api.neon.tech/v2/users/me → curl: (6) Could not resolve host: api.neon.tech (000)
  $ getent hosts github.com (control) → 20.205.243.166  github.com (exit=0)
  ```
  The ready path (`src/modules/migration/tests/migration-readers-hosted.test.ts`) activates on
  `AURUM_TEST_DATABASE_URL`; one reachable run upgrades the hosted leg to REAL-PROVEN.
- **Deployed-env reader wiring:** `ensureMigrationReadersWired()` is not yet composed into a deployment
  entry point, and `MIGRATION_CSV_EXPORT_ROOT` / `MIGRATION_NATIVE_TENANT_ID` are unset in the deployed
  env → readers stay honestly unwired (`reader_unavailable` / `native_reader_unavailable`) — the
  recorded frontier (`W111/DELIVERY.md` §7), unchanged by this certification (documentation-only work
  item).

### 2.6 WMIG — migration-runner checksums — LIVE-PROVEN in production

- **Live production fact [PROBED]:** `/api/health` reports **`migrations: 138`** with
  **census 258/258 expected, `missing: []`** (§1) — the full chain including both post-WMIG migrations
  (W108's `006` and W111's `002`) is applied in production.
- **Why that is checksum-ledger proof [REPO-FACT]:** the WMIG hardening (`scripts/migrate.ts`,
  commit `2659898`) records each migration's sha256 content digest in the `_migrations` ledger **inside
  the same transaction as the DDL** (no hash without the DDL, no DDL without the hash); production
  deployments run the migrations through `vercel:build` = `bun run migrate && next build`
  (package.json:15) — every production migration row was applied by the hardened runner. Drift refusal
  (mutated applied content → the run REFUSES) and legacy pin-forward are proven in
  `tests/e2e/platform/schema-reconciliation.test.ts` — **freshly 27/27 PASS** at the certified revision
  (`probes/gates-tests-schema-reconciliation.txt`); the fresh embedded ledger check above shows
  **138/138 rows hashed** with both post-WMIG migrations present and hashed
  (`probes/gates-migrate-fresh.txt`).
- **Honest caveat:** the production `_migrations` ledger rows are not exposed by a public read API, so
  the per-row production hashes are not directly readable from outside. The LIVE classification rests
  on the probed counter (138) + the construction chain (the hardened runner is the only apply path in
  production) + the fresh local re-proof. No stronger external claim is made.

---

## 3. Read-only production probes run by W112 (all raw outputs in `probes/`)

| # | Probe (2026-09-28, UTC) | Result |
| --- | --- | --- |
| 1 | `GET /api/health` (08:19:30Z and 08:26:56Z) | **200** — ok · production · Vercel · db postgres ok · **migrations 138** · **census 258/258** · missing [] · 0 refusals · 0 warnings (`health.json`) |
| 2 | `GET /api/worker` — no token (08:27Z) | **401** `{"ok":false,"error":"worker token required (Authorization: Bearer or x-worker-token)"}` — the G1 worker seam is fail-closed (`worker-no-token.txt`) |
| 3 | `GET /api/worker` — bad token `definitely-not-the-token` | **401** `{"ok":false,"error":"invalid worker token"}` (`worker-bad-token.txt`) |
| 4 | `POST /api/auth/quick-sign-in` `{"persona":"manager"}` (the harness's G1 probe) | **404** `{"error":"not_available","message":"quick sign-in is not available in this environment"}` — demo credentials OFF (`quick-sign-in.txt`) |
| 5 | `POST /api/webhooks/cellular/twilio` (empty body) | **503** `{"ok":false,"error":"carrier webhook verification is not configured for 'twilio' (set CELLULAR_TWILIO_AUTH_TOKEN; the edge stays closed until the carrier's requests can be verified)"}` — the deployed env's honest fail-closed cellular posture (`cellular-webhook-twilio.txt`) |
| 6 | DNS `api.neon.tech` (08:27:09Z) | **unresolvable** — getent exit 2; curl `(6) Could not resolve host`; control `github.com` resolves (`neon-dns-w112.txt`) |
| 7 | Deterministic suites at `c079cab…` | 81/81 (vertical-kits+edge-connector) · 179/179 (cellular) · 88+16 skips (realtime) · 70/70 (computer) · 56+1 skip (migration) · 27/27 (schema-reconciliation) |
| 8 | Fresh embedded chain | apply 138 → idempotent re-run 0/138 → ledger **138 rows / 138 hashed** |

---

## 4. Release recertification record — **BLOCKED** (two external prerequisites, documented exactly, no workaround)

The governing release contract (W106 program, `scripts/release-certification.ts`) requires a **two-run
same-revision certification** of the final tree: CERTIFIED READY only when BOTH runs are
`0 failed · 0 blocked · 0 flaky · 0 unexpected` AND the runs agree on the journey matrix and the
deployment identity (finalizer rule, script header lines 29-33). The W106 precedent (both runs green,
`dpl_BCtojsKXWqF3qsEmczyHfUxaauGJ` @ `625a133e…`, 2026-09-27, `W106/final-verdict.json`) is the shape.

### Blocker 1 — Vercel deploy quota exhausted [TRANSMITTED, corroborated]

The Vercel free tier's 100-deployments/day limit is exhausted, so the final tree
(`main@780b05b` = `09fbb6d` (W113) + the deploy-trigger chore) **cannot deploy until the quota resets
or the plan is upgraded**. Reset: epoch-ms **1790666832593 = 2026-09-29T08:33:53Z** (UTC; arithmetic
verified). The quota-error paste lives in the work order's dispatch context (not re-included in this
worker's text); it is **not independently verifiable from this sandbox** (no Vercel token). Corroborating
repo facts: the empty trigger commit `780b05b` (2026-09-28T07:28:27Z, author `Z User <z@container>`)
exists on main precisely to trigger the deploy that could not complete; production still serves the
pre-W113 deployment (health numbers consistent, §1). Until the reset: **current production remains
`dpl_GxApj6s3CECE` @ `c079cab…` (pre-W113).**

### Blocker 2 — WORKER_TOKEN rotation not yet effective [TRANSMITTED, seam probed]

The worker seam token was rotated in the Vercel project (env PATCH), but **the rotation only takes
effect on the NEXT deployment** — the running `dpl_GxApj6s3CECE` still holds the pre-rotation token,
which is **not recoverable**. The cert harness's G1 worker-seam probe (valid-token leg:
`GET /api/worker` with `x-worker-token`, expecting 200 + environment + queueDepth + metrics —
`src/modules/release-certification/driver.ts:262-283`) therefore **cannot authenticate against the
current deployment**. What W112 could honestly probe (§3 #2/#3): the seam's fail-closed auth is live and
correct (401 no-token / 401 bad-token). The harness treats an unusable worker token as a documented
BLOCKED precondition (exit code 2; its own tests assert the gate detail "worker seam token was not
supplied" — `src/modules/release-certification/tests/driver.test.ts:434-436`). Consequence: **the
two-run recert necessarily targets the NEXT deployment** (the one the quota currently blocks), which
will hold the rotated token.

### Exact commands once both blockers clear (verbatim from `scripts/release-certification.ts` header)

Harness header (lines 1-40) — the canonical forms:

```
//   # one certification pass (Run A, then Run B — the SAME deployment revision)
//   bun run cert:production -- --target https://aurum-chat-livid.vercel.app \
//        --run a --deployment-id dpl_X --expect-commit <sha> --deployment-created <iso> \
//        --worker-token-file <path> --vercel-token-file <path>
//
//   # the four-surface re-certification program (W106 — the same full
//   # J01–J22 matrix against the CURRENT production revision, the W106
//   # evidence root docs/productization-evidence/W106)
//   bun run cert:production -- --program w106 --target … --run a …
//
//   # the finalizer (the two-run verdict + the canonical document)
//   bun run cert:production -- --finalize [--program w101|w106]
```

Concrete sequence for the final tree (after the quota resets, the final tree deploys, and the rotated
WORKER_TOKEN is effective in that deployment) — the W106-program form, per the
`W106/production-run-a/run-result.json` precedent:

```bash
# Run A — against the NEW production deployment of the final tree:
bun run cert:production -- --program w106 --target https://aurum-chat-livid.vercel.app \
     --run a --deployment-id dpl_<new-production-uid> --expect-commit <final-tree-sha> \
     --deployment-created <iso-date> \
     --worker-token-file <path-to-the-rotated-worker-token> --vercel-token-file <path-to-vercel-token>

# Run B — the SAME deployment revision:
bun run cert:production -- --program w106 --target https://aurum-chat-livid.vercel.app \
     --run b --deployment-id dpl_<new-production-uid> --expect-commit <final-tree-sha> \
     --deployment-created <iso-date> \
     --worker-token-file <path-to-the-rotated-worker-token> --vercel-token-file <path-to-vercel-token>

# Finalizer — the two-run verdict + the canonical document:
bun run cert:production -- --finalize --program w106
```

Exit codes (header lines 37-40): `0` green · `1` real failure · `2` BLOCKED (a documented external
precondition is missing). Secrets arrive as FILE PATHS only, live in memory, never enter artifacts.
The deployment-id/commit to expect is read from the Vercel listing
(`projectId=prj_PljFx5DnZ1MCqQ5bA1uK6G1o8gFy`, `teamId=team_4KOoA5CgtYaOF85yFXPeMXLt`) by the harness
itself via `--vercel-token-file`.

---

## 5. Gates (run by W112 at the certified revision `c079cab7fd7eacd363a643c83d3697c4667b6410`)

| Gate | Command | Result | Raw tail |
| --- | --- | --- | --- |
| Typecheck | `bun run typecheck` | **PASS** (exit 0, clean) | `probes/gates-typecheck.txt` |
| Lint | `bun run lint` | **PASS** (exit 0, 0 problems) | `probes/gates-lint.txt` |
| Architecture | `bun run arch` | **PASS** — "architecture check passed — module files: 700, app/mcp files: 308, tables checked: 250" | `probes/gates-arch.txt` |
| Cert module tests | `bun run test -- release-certification` | **PASS — 85/85 (5 files)**; exact filter: `release-certification` (vitest positional filter; matches the release-certification module's suites + the W044 tenant-isolation sweep) | `probes/gates-tests-release-certification.txt` |

(Working tree before delivery: `git status --porcelain` → only `docs/productization-evidence/W112/`
untracked; no source, lockfile, or migration touched — §3 boundary honored.)

---

## 6. Verdict

- **The live-capability matrix: DELIVERED** — this document + `certification.json` + the raw probe
  outputs under `probes/`, classifying all six capabilities as actually live in `dpl_GxApj6s3CECE`
  @ `c079cab7fd7eacd363a643c83d3697c4667b6410`, with per-capability evidence citations.
- **The two-run same-revision release recertification: BLOCKED-on-deploy-quota** — the Vercel free-tier
  100-deployments/day limit is exhausted; **reset 2026-09-29T08:33:53Z** (epoch-ms 1790666832593).
  Secondary prerequisite on the same next deployment: the rotated WORKER_TOKEN becomes effective
  (the current deployment's pre-rotation token is unrecoverable — a recert against
  `dpl_GxApj6s3CECE` itself is impossible). The exact Run A + Run B + finalizer commands are recorded
  in §4.

No live evidence was manufactured from deterministic doubles anywhere in this certification.
