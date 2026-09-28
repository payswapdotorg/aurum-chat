# W110 — Real Browser / Computer-Use Driver Composition — Delivery Record

**Work item:** W110 (spec/WORK-ITEM-CATALOG.md §W110)
**Base SHA:** `53bd2711982a7016fc36e1376e375d7551142652`
**Branch:** `work/w110-real-browser-driver`
**Delivery type:** DELIVERED — with the REAL-BROWSER leg **REAL-PROVEN** (executed in this repository's sandbox against real chromium; the evidence is committed here, not asserted).

---

## 1. What was delivered

1. **THE REAL BROWSER ADAPTER** (`src/modules/computer-use/adapters/playwright-driver.ts`):
   Playwright OSS — the repository's already-reviewed browser runtime
   (`@playwright/test` 1.57.0, the engine the W076 journey suite runs on;
   `playwright` added as a direct pinned dependency at the identical version,
   so the installed tree does not change) — behind the **unchanged** W093
   `BrowserDriver` port. The adapter is constructed from a CONFIGURATION
   OBJECT with four injectable seams (the W108 adapter discipline):
   - `launcher` — the browser engine (default: real `chromium.launch`; a
     single explicit, documented vendor edge adapts Playwright's handle to
     the seam's narrow structural shape);
   - `credentials` — resolves the OPAQUE `credentialRef` into field values
     DRIVER-SIDE ONLY (default: the `BROWSER_CREDENTIALS` environment JSON —
     env is the only credential channel, never hardcoded; a malformed
     document fails loudly);
   - `artifacts` — stores the per-step evidence bytes (screenshot PNG +
     DOM-snapshot HTML) behind opaque, content-addressed refs
     (`computer-use-playwright://<kind>/<sha256-16>`; the sha256 rides in
     the action trace so the bytes are provable);
   - `profiles` — persists the per-(tenant,task) browser storage state
     between disposable sessions (hashed filename; the TASK record, never
     this file, is the durable resume truth).
   **Playwright objects never cross the port**: every vendor interaction is
   composed inside the adapter from the canonical action envelope, and
   every result is normalized to the port's own shapes before it returns
   (the service's canonicalization rejects provider objects loudly —
   `invalid_driver_result`; the composition suite runs the adapter through
   that canonicalization end-to-end).

2. **THE ENV-DRIVEN WIRING** (`src/modules/computer-use/wiring.ts`): the
   W108 cellular reference pattern (globalThis-guarded, once per process,
   machine-readable report, honest partial posture):
   - `BROWSER_DRIVER=playwright` → the real adapter is wired;
   - `BROWSER_DRIVER=deterministic` → the scripted fixture double (NOT a
     real browser; local composition/demos only);
   - unset / `none` / unknown → **nothing wired** (the pre-W110 honest
     `driver_unavailable` posture, unchanged);
   - an EXPLICIT `setBrowserDriver` always takes precedence (test overrides
     are never clobbered).
   Exported through the module contract (`ensureBrowserDriverWired`,
   `resetBrowserDriverWiring`) for every future production entry point
   (the API/worker pump composition is the W112 frontier — no production
   route invokes it yet, which keeps the default unwired posture honest).

3. **CONTRACT SURFACE** (`src/modules/computer-use/contract.ts`): the
   adapter factory, its configuration types, the pure
   `canonicalSelectorKey` helper, and the wiring functions are exported
   through the module's ONLY public surface (the first-party-double
   precedent). `types.ts`/`contract.ts` header docs updated to state that
   the repository now ships a real adapter while the deterministic double
   remains the test-suite default. **No shape changed** — the port, the
   receipt taxonomy, the observed-state shape and the evidence model are
   untouched.

4. **TESTS** (deterministic — NO browser, NO network in the suites; the
   deterministic double stays the default and is not weakened):
   - `tests/playwright-fake.ts` — the shared deterministic fake of the
     Playwright surface (seeded tiny site, forms, submits, one-shot
     network failures, strict-mode violations) injected at the vendor
     seam;
   - `tests/computer-use-playwright.test.ts` (15) — the vendor-shape
     layer: port conformance, plain-JSON canonical results, the
     driver-side allowlist copy (URL + verb refusals, no bypass),
     credential materialization/isolation/redaction (secret-field marker,
     password-input marker, unresolved-field permanent refusal),
     idempotent replay (exactly-once at the vendor layer), the
     driver-level outcome mapping (net failure → transient `failed`;
     strict-mode violation → permanent `rejected`), submit form
     semantics, click effects, navigation-if-needed, disposable
     sessions, profile continuity + isolation, selector
     canonicalization;
   - `tests/computer-use-playwright-composition.test.ts` (5) — the real
     adapter composed through the EXISTING service lifecycle against the
     embedded PostgreSQL: fully-verified completion with per-step
     evidence + the unchanged audit-feed shape; the credentials SQL
     opacity sweep; transient failure → resumable park → fresh-session
     resume (verified steps never re-dispatched, exactly-once at the
     vendor layer, session 2 continues on the same isolated profile);
     the dispatch-time allowlist blocking a corrupted step with the
     driver never seeing it; the mismatch path ending `mismatched` with
     the existing W084-diff + attention-unknown + failure-bundle shape;
   - `tests/computer-use-wiring.test.ts` (9) — the env → driver mapping,
     the honest unset/unknown posture, the explicit-set precedence, the
     per-process idempotence, the reset.

5. **THE REAL-BROWSER EVIDENCE RUN** (this directory):
   `run-real-browser-task.ts` — executed for real on 2026-09-28 against
   real chromium `143.0.7499.4` (headless) through the PRODUCTION wiring
   path (`BROWSER_DRIVER=playwright` + `ensureBrowserDriverWired`) and the
   EXISTING W093 lifecycle, against a tiny LOCAL HTTP fixture site
   (127.0.0.1:3117 — real form POSTs, cookies, redirects, a protected
   page, a click-driven DOM mutation, and an ARMED MID-RESPONSE SOCKET
   DEATH for the transient). Outputs committed here:
   `report.json` (machine-readable) + `artifacts/` (8 PNG screenshots +
   5 DOM-snapshot HTMLs, content-addressed, sha256-pinned in the report).

## 2. The real run — what was proven (REAL-PROVEN)

Re-run with: `./node_modules/.bin/tsx docs/productization-evidence/W110/run-real-browser-task.ts`
(exit 0; every assertion inside the runner is a gate — a wrong outcome fails the run).

| Scenario | Plan | Real outcome | Proof in `report.json` |
| --- | --- | --- | --- |
| **happy-path** | 7 steps, all five verbs (goto → type literal → type OPAQUE credential field → submit → goto → read → click) | `completed`, 7/7 steps `verified`, 1 disposable session, `stepsExecuted: 7` | every step: `receiptId: playwright-rcpt-*`, observed state, screenshot ref, redacted trace; `exactlyOnce` all `1`; events feed = `created, started, (step-executed, step-verified)×7, completed` |
| **transient-failure-resume** | 5 steps (through `goto-app`); the fixture dies MID-RESPONSE on the first `/app` navigation | session 1: steps 1–4 verified, `goto-app` receipt `failed` (transient), task `failed`, bundle `step-failed`; **resume**: session 2 (`stepsExecuted: 1`) completes the task | the checkpoint steps were NEVER re-dispatched (`resumeDispatches = [goto-app]`); `exactlyOnce` deltas all `1` — the login steps executed exactly once ACROSS BOTH SESSIONS; the resumed session continued on the SAME isolated profile (the login cookie survived through the profile store) |
| **wrong-credentials-mismatch** | 4 steps with a second OPAQUE ref carrying wrong credentials | steps 1–3 verified; `submit-login` executed + accepted, observed state DIVERGED (the real server bounced to `/login?error=1`); task `mismatched` (terminal) | the W084 diff with REAL observed values: `url` (`/login?error=1` vs `/welcome`), `title` (`Vendor portal` vs `Welcome`), `heading` (`Sign-in failed` vs `Signed in`); mismatch evidence observation + attention unknown ids on the step; bundle `mismatch` |
| **secrets sweep** | — | SQL sweep over `browser_tasks`, `browser_task_steps`, `browser_sessions`, `browser_task_events`, `browser_task_idempotency`, `observations`: **0 hits**; byte-level sweep over all 13 evidence artifacts: **0 hits** | `sweeps.sql.result` / `sweeps.artifacts.result` |

Observed-state proof examples (from `report.json`): the login step observed
`{"url":"http://127.0.0.1:3117/login","title":"Vendor portal","heading":"Sign in","#username":"","#password":"<redacted password input>","#submit":""}`
and the click step observed `"[name=\"tick\"]":"refreshed"` — real DOM
state, read through the port, redacted where a secret could echo, and
verified against the frozen expectation before it counted.

## 3. How the W093 lifecycle is reused (nothing re-implemented)

The adapter implements ONLY the three port methods
(`startSession`/`performAction`/`endSession`). Frozen-plan creation,
creation-time allowlist validation, the disposable-session run loop, the
dispatch-time allowlist re-check, evidence-ledger observations, the W084
`reconcileOperation` verification, mismatch attention unknowns, failure
bundles, the suspend/park path, and resume-from-the-checkpoint are the
EXISTING service machinery — this work item added no second
evidence/reconciliation model and changed no service line. Driver-level
outcomes map into the existing taxonomy: vendor timeout/network error →
transient `failed` (resumable); strict-mode violation (ambiguous plan
selector), driver-side allowlist refusal, and unresolved credential field
→ permanent `rejected`; everything else → `accepted` WITH the observed
state (an unobserved action is never a result).

## 4. Allowlist enforcement points (all hit, no bypass)

1. Creation — the whole plan must be allowlist-conformant (existing
   validation; unchanged, exercised by every test's `createBrowserTask`);
2. Dispatch — the service re-checks every step (existing
   `allowlistDecisionFor`; proven again in the composition suite with a
   storage-corrupted step: `aborted`, decision as evidence, and the
   driver's `performRequests` stayed EMPTY);
3. Driver-side copy — the adapter re-checks the frozen allowlist it
   received at session start BEFORE any vendor interaction, on every
   action (proven in the vendor-shape suite: URL-glob refusal, verb
   refusal, zero vendor executions on refusal).

## 5. Credentials — isolated and opaque (unweakened)

The task carries only the OPAQUE `credentialRef`. The adapter materializes
the reference's fields ONCE per isolated per-(tenant,task) profile,
driver-side; values never cross back. A secret-typing step records only
`{kind:'secret-field', field, redacted:true}` in its trace and observes
the redaction marker `<redacted secret field '…'>`; every password-type
input is observed as `<redacted password input>` regardless of how it was
filled; the DOM-snapshot artifact is secret-free because Playwright sets
typed text as the element's live VALUE PROPERTY while HTML serialization
writes ATTRIBUTES (verified against real chromium; proven by the
byte-level artifact sweep above). The real run's credential VALUES exist
only in the environment (`BROWSER_CREDENTIALS`) and the driver's in-memory
profile store — the SQL + artifact sweeps are committed in `report.json`.

## 6. Gates (run at the delivery commit)

```
bun run typecheck   → PASS (exit 0)
bun run lint        → PASS (exit 0)
bun run arch        → PASS ("module files: 682, app/mcp files: 308, tables checked: 249")
bun run test -- computer → 6 files / 70 tests PASS, 0 failed
                      (exact filter: `computer` — vitest `run computer`;
                       matches the 4 computer-use suites + the W044
                       tenant-isolation computer-use sweep; the touched
                       module has no other consumers — no file outside
                       src/modules/computer-use/** imports its contract)
```

The deterministic double remains the default for the existing suites:
`computer-use-service.test.ts` (17) and `computer-use-unit.test.ts` (21)
are untouched and green, and they still wire the scripted double
explicitly (no suite depends on a browser or this sandbox's binaries).

## 7. Ownership + out-of-boundary touches

Owned and touched: `src/modules/computer-use/adapters/playwright-driver.ts`
(new), `src/modules/computer-use/wiring.ts` (new),
`src/modules/computer-use/contract.ts` (doc + exports),
`src/modules/computer-use/types.ts` (doc only), the four files under
`src/modules/computer-use/tests/` (three new suites + the shared fake),
and this directory. **Out-of-boundary touches:** `package.json`
(adds `playwright: 1.57.0` as a direct pinned dependency — required by the
adapter's runtime import; version-identical to the transitive copy already
installed, so the resolved tree is unchanged) and `bun.lock` (the
lockfile's marker for the new direct dependency). NO database migrations,
no EXPECTED_TABLE_CENSUS/schema-reconciliation pins, no changes to
vertical-kits/meetings/realtime/cellular/edge-connector/infra.

## 8. Frontier notes (for W112 certification)

- No production route or worker pump invokes `ensureBrowserDriverWired()`
  yet — the honest default (unwired → `driver_unavailable`) stands until
  the W112 composition decides the entry point(s).
- `BROWSER_DRIVER`/`BROWSER_*` env names are documented in
  `wiring.ts`/`adapters/playwright-driver.ts` headers and here;
  `docs/DEPLOYMENT.md` §6 and `.env.example` are NOT touched (outside
  this item's ownership) — the TL may fold the names in at integration.
- The adapter's observation reads canonical form fields (`#id` /
  `[name="…"]`) plus url/title/first-h1; richer page-reading surfaces
  (tables, lists, text extraction) are an additive future step behind
  the same port.
- The real-browser leg is deliberately a RECORDED EVIDENCE RUN, not a
  test-suite dependency: CI environments without browser binaries stay
  green on the deterministic suites, and the real leg is re-runnable by
  one command from this directory.
