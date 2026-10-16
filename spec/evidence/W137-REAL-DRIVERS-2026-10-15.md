# W137-REAL-DRIVERS — The Real-Driver Upgrade Record (Playwright/Chromium + E2B)

**Delivered:** 2026-10-15/16 (the second post-certification opt-in)
**Owner:** delivery engineer (Z.ai Code), per the W137 real-drivers task
**Base:** certified main `55206bf` (the D1-LIVE merge point)
**Branch:** `work/opt-w137-real-drivers` (wiring `5b532cf` → suites `78ca98a` → evidence)
**Upgrades:** W141 record §5's binding classification — *"Real Playwright/Chromium + E2B
remote-sandbox execution of the W137 adapters: the certified surface is the adapter
contracts + deterministic doubles; real-driver evaluation documented as next steps."*
This record binds that evaluation: both adapter paths now have REAL drivers behind
them, LIVE-proven through the REAL fabric operations.

## 1. Scope

Exactly the two halves the task named, additive wiring only (the frozen SPI, the
adapter contracts, the W131 vocabularies and every existing assertion untouched —
the diff is 4 files, 1509 insertions, 0 deletions: one NEW module file, additive
exports in the module contract, two NEW env-gated suites, this record):

- **Half A — REAL Playwright/Chromium (browser path (b)):** the production wiring
  closure `wirePlaywrightBrowserAdapter` (src/modules/execution-fabric/wiring.ts,
  exported additively through the module contract) injects W110's
  `createPlaywrightBrowserDriver` — real Playwright OSS driving REAL headless
  Chromium — through the browser-adapter's existing `driver: BrowserDriver` port.
  The adapter's public behavior is unchanged; the closure just constructs the port's
  production implementation (the wiring the adapter's own header documents) and
  returns the driver handle so the composition root owns the engine lifetime.
- **Half B — REAL E2B (remote-sandbox path (c)):** the production transport closure
  `createE2BRemoteSandboxTransport` (same file, same additive export) puts the REAL
  E2B REST API behind the adapter's injectable transport port. Every
  vendor-specific adaptation lives in the CLOSURE — the adapter's documented generic
  wire (POST/DELETE `/sandboxes[/{id}]`, GET `/health`) is untouched.

## 2. The REAL wires (mapped in the closures, never in the adapters)

| Generic wire (the adapter's, unchanged) | REAL E2B wire (the closure's) | Observed LIVE |
|---|---|---|
| `GET {apiBaseUrl}/health` | `GET https://api.e2b.app/v2/sandboxes` (`X-API-Key`) — E2B exposes no unauthenticated platform health probe, so the authenticated listing is the honest stand-in: a 200 proves the vendor answers AND the credential authenticates | 200 in 319 ms |
| `POST {apiBaseUrl}/sandboxes` `{}` | `POST https://api.e2b.app/sandboxes` (`X-API-Key`) body `{templateID: "base", timeout: 300}` — the vendor's 201 answer `{sandboxID, envdAccessToken, …}` is rewritten to the adapter's documented `{sandboxId}` shape; the envd access token is retained DRIVER-SIDE (never crosses the port) | 201 in 886 ms |
| `POST {apiBaseUrl}/sandboxes` `{resumeOf}` | `POST https://api.e2b.app/sandboxes/{id}/resume` (`X-API-Key`) — E2B's documented resume semantics (the same id unpauses) | closure-documented, not LIVE-exercised (see §6) |
| `DELETE {apiBaseUrl}/sandboxes/{id}` | `DELETE https://api.e2b.app/sandboxes/{id}` (`X-API-Key`) | 204 in 195 ms |
| (closure-owned extra, no generic-wire counterpart) | `POST https://sandbox.e2b.app/process.Process/Start` — E2B's documented envd Connect protocol (Connect-framed JSON, `X-Access-Token` + `E2b-Sandbox-Id`/`E2b-Sandbox-Port` headers) — `runCommand()` executes ONE command in a sandbox the transport opened, no vendor SDK | 200 in 231 ms, `/bin/echo` exit 0 |

Vendor auth: `E2B_API_KEY` from the environment only (or an explicitly injected
value) — NEVER hardcoded; a keyless construction refuses loudly. The key value
never crosses into the adapter, any domain record, or any log the closure keeps
(its `log` records method/url/status/latency only).

## 3. The LIVE runs

Suites `tests/e2e/certification/w137-real-browser-driver.test.ts` (7 proofs) and
`tests/e2e/certification/w137-real-e2b-transport.test.ts` (5 proofs), executed
with `W137_BROWSER_LIVE=1` + `E2B_API_KEY` present:
**12/12 green in 15.79 s** (A: 7/7 in 5.85 s; B: 5/5 in 6.83 s; one real
Chromium engine, one real E2B sandbox) — the run the committed results
artifacts record — and **re-verified green at the branch tip: 12/12 in
14.76 s** (A: 5.66 s; B: 6.07 s).

### Half A — REAL Playwright/Chromium (Chromium `143.0.7499.4`, Playwright 1.57.0, headless)

| Fabric operation | REAL outcome (this run) |
|---|---|
| probe (the registration handshake) | the honest descriptor: `health: available`; filesystem + commands `supported:false` (the honest-descriptor law, unchanged over the real wiring); vendor identity METADATA only |
| open → `prepareFabricLease` | lease **live**, session id `playwright-session-0001` (the W110 driver's own documented grammar — a double can never mint it honestly), **175 ms**; engine version `143.0.7499.4`; isolated profile key `browser:tenant:57dbf177-…-fd6f4f5d23fb:subject:d892fab3-…-1819596ef64b` (the W093 per-(tenant,subject) discipline); the opaque credential ref handed VERBATIM; the governed allowlist handed at start |
| evidence/checkpoint/artifact | the §24 tails append in order (`evidence`, `artifact`, `checkpoint` events; the rows read back) |
| resume → loss + `recoverFabricLease` | a FRESH session `playwright-session-0002` on the SAME profile key, **38 ms**; `recoveredFromCheckpointRef` = `<session-0001>@w137-real-cursor-1`; both real starts carry the same allowlist |
| close → `releaseFabricLease` | lease terminal (**8 ms**); heartbeat refuses `lease_already_terminal`; the best-effort close of the RESUMED session is refused by the adapter's registry (§6.4) — observed honestly; the DIRECT open→close lease proves the port-level session end: session `playwright-session-0003` ends on the real driver (`endSessions` receipt, **14 ms**) with the release-stamped reason |
| event tail | `acquired, prepared, evidence, artifact, checkpoint, loss, recovery, release` |

### Half B — REAL E2B (api.e2b.app, key fingerprint `…9b35`)

| Fabric operation | REAL outcome (this run) |
|---|---|
| probe (the registration handshake) | the honest descriptor: `health: available` (the REAL vendor answered through the closure — `GET /v2/sandboxes` 200); the adapter's own envelope stays the generic `GET /health` (asserted on the adapter's request log) |
| open → `prepareFabricLease` | lease **live** with the REAL vendor sandbox id `ie2aduy88n3fyx4rm65r2` (the vendor's own 201 answer), **886 ms**; isolated profile key `remote:tenant:5bd25726-…-4dbb159b0694:subject:1633d9f7-…-1b1a4cb5895a` |
| a REAL command | `/bin/echo W137-E2B-LIVE-COMPLETE` INSIDE the sandbox through the envd Connect protocol: exit 0, stdout round-trip `W137-E2B-LIVE-COMPLETE`, **231 ms** — recorded through the documented evidence op (`captureKind: console`, verification `verified`, redaction `applied`) |
| close → `releaseFabricLease` | lease terminal; the REAL sandbox destroyed (`DELETE /sandboxes/ie2aduy88n3fyx4rm65r2` → **204**); the closure's token dropped; heartbeat refuses `lease_already_terminal` |
| event tail | `acquired, prepared, evidence, artifact, checkpoint, release` |
| cleanup | the release destroyed the lease's sandbox; the afterAll `sweepOpenSandboxes` found nothing left (every opened sandbox destroyed) |

**The results artifacts** `test-output/w137-real-browser-driver-results.json` and
`test-output/w137-real-e2b-transport-results.json` (committed as this run's
record) carry the machine-readable evidence — engine version, real session/sandbox
ids, per-round-trip latencies, event tails, verdicts. The in-suite secret guards
re-read the written files: the raw E2B key is ABSENT (fingerprint `…9b35` only),
and the browser artifact carries no credential material at all (the lease rides an
opaque ref; the artifact records none of it).

## 4. Env-gating (the D1-LIVE pattern) + keyless default

| Suite | Env gate | Gated run | Keyless default |
|---|---|---|---|
| `w137-real-browser-driver.test.ts` | `W137_BROWSER_LIVE` | **7/7** | 7 skipped, clean |
| `w137-real-e2b-transport.test.ts` | `E2B_API_KEY` | **5/5** | 5 skipped, clean |

Keyless verified: `vitest run tests/e2e/certification/w137-real` with both vars
absent → **12 skipped (2 files), exit 0, ~3.0 s**. Nothing is wired by default
anywhere in production code — the closures are constructed exactly where a caller
invokes them; the hermetic battery keeps the deterministic doubles.

## 5. What the LIVE run proved about the certified surface (all asserted in-suite)

1. **The vendor-removal clause held under REAL drivers:** each real-driver path
   produced the documented domain shapes through its whole lifecycle — the same
   lease statuses, the same event-tail vocabularies and the same evidence-row
   shapes over the real Chromium engine and the real E2B vendor — and no vendor
   name rode in any lease, event, artifact, evidence or checkpoint row (the W131
   law; vendor identity is metadata on the descriptor only). The rigorous
   same-flow A/B comparison remains the hermetic vendor-removal suite's (which
   stays green and untouched).
2. **The generic wire survived the real vendor:** the adapter's request log shows
   ONLY the documented generic envelopes (`GET /health`, `POST /sandboxes` `{}`,
   `DELETE /sandboxes/{id}`) — every E2B-specific byte (auth header, real URLs,
   `{templateID, timeout}`, the `{sandboxID}`→`{sandboxId}` rewrite, the Connect
   framing) stayed in the closure.
3. **The honest-descriptor law held over the real wiring:** the browser path still
   declares filesystem/commands `supported:false`; the remote path declares
   browser-profile `supported:false`; an answering vendor is `available`, never
   fabricated.
4. **The W082 discipline held on the real path:** the opaque credential ref rode
   the lease and was handed verbatim to the real driver's start; no secret value
   exists anywhere on the browser path, and the E2B key lives only in the
   closure's auth header.
5. **The disposable-session doctrine held on a real engine:** loss → recovery
   minted a FRESH Chromium context on the SAME isolated profile key; the E2B
   sandbox was destroyed on release (204) and swept in afterAll.

## 6. Honest limitations

1. **The remote-sandbox resume mapping is closure-documented but NOT
   LIVE-exercised.** E2B's documented resume semantics (`POST
   /sandboxes/{id}/resume` — the same id unpauses) differ from the generic wire's
   "a fresh sandbox continuing the prior one's paused state"; the closure maps
   `{resumeOf}` to the vendor endpoint, but the LIVE suite proves open /
   command / close / lifecycle only. Lease RECOVERY over the real E2B vendor
   (pause → resume through the fabric) remains composition-era work; the
   hermetic fake-transport recovery proofs stay the certified surface.
2. **E2B create uses the v1 `POST /sandboxes`** (served and documented; the v2
   `POST /v2/sandboxes` is the newer shape that requires secured-access-capable
   template envd). Swapping is a closure-only change (the adapter's generic wire
   is untouched) — recorded as the swap candidate.
3. **No unauthenticated E2B platform health probe exists** — the closure maps the
   generic `GET /health` to the authenticated `GET /v2/sandboxes` (a 200 proves
   the vendor answers AND the credential authenticates). An unauthenticated
   vendor could be probed more cheaply; E2B does not offer one.
4. **The certified browser adapter's best-effort close refuses sessions minted by
   `resume()`:** its session registry tracks only `open()`-minted sessions, so
   the release of a RECOVERED lease refuses the vendor close ('unknown session')
   and the service swallows it (the documented ruling: a vendor close failure
   never resurrects or re-opens a lease) — the resumed Chromium context is reaped
   at engine close. Observed LIVE and asserted honestly; NOT fixed here (the
   frozen-surface law — a behavior change is a composition-era decision). The
   DIRECT open→close lease in the suite proves the port-level session end.
5. **Two PRE-EXISTING full-battery failures at the base commit — both reproduced
   in an isolated worktree AT `55206bf`, neither touched by this diff:**
   - `src/modules/epistemics/tests/epistemics-service.test.ts > evaluates belief
     freshness against tenant stale-after policies…` — date-rotten: the test
     pins `T0 = 2026-09-14T09:15:00Z` ("yesterday" at authoring time) with a
     30-day "generous" policy window that crossed wall-clock
     `2026-10-14T09:15:00Z`; fails at the base commit (verified:
     1 failed | 76 passed at `55206bf`).
   - `src/modules/execution-fabric/tests/execution-fabric-service.test.ts >
     drives the SAME domain flow to IDENTICAL outcomes on both vendor paths` —
     a probabilistic substring lottery in the EXISTING suite: it asserts the
     serialized domain records do not contain `'e2b'`, but the FAKE driver's
     random `newId()` session keys are hex and can contain the substring
     (observed: `brow-9b853c25-1074-4e02-b494-`**`e2b`**`33d880e2a`) — ~1-in-4/5
     runs; reproduced at the base commit (1 of 5 base runs failed identically).
6. **The single-shot `timeout 590 bunx vitest run` gate cannot complete on this
   2-CPU station** (three attempts, exit 124 at roughly a third of the files) —
   the exact station class the repository's own W105 runner documents
   ("the sandbox has 2 CPUs; a single vitest run may exceed the command window",
   scripts/run-suite-chunked.sh). The authoritative full battery therefore ran
   through that sanctioned chunked runner: **328 test files, 6429 passed /
   2 failed / 42 skipped** — the 2 failures being exactly the two pre-existing
   base failures of §6.5. No file this diff touches failed (the
   execution-fabric flake of §6.5 lives in a test file this diff does not modify;
   the module suite also passed 62/62 green on re-runs — the flake is
   intermittent by nature). The TL's integration station re-runs the single-shot
   gate.
7. **Single station, single LIVE run per suite; the vendor answers are
   deterministic** (no inference, no non-determinism to normalize). Cost: two
   E2B `base`-template sandboxes for seconds each (the pre-code wire probe
   `ikuf8fhglsg8x6iepvhcg` — destroyed — and the suite's `ie2aduy88n3fyx4rm65r2`
   — destroyed), plus one Chromium engine per suite process.
8. **Production is not re-certified by this record** (the POST-W123 doctrine):
   this is an opt-in proof layer over the certified release, on a branch off
   certified main.

## 7. Gates (run at the branch tip, in the repo root)

| Gate | Result |
|---|---|
| `timeout 300 bun run typecheck` | **exit 0, zero errors** |
| `timeout 180 bun run arch` | **pass — module files 798 / app+mcp 337 / tables 296** (797 → 798 = the ONE new wiring file; tables unchanged — no new tables) |
| `timeout 240 bun run lint` | **exit 0, zero errors** |
| `timeout 590 bunx vitest run src/modules/execution-fabric` | **exit 0 — 2 files, 62/62 passed** (~8.9 s; the §6.5 pre-existing base flake is intermittent and reproduced at `55206bf` — documented, not introduced here) |
| `E2B_API_KEY=<env> W137_BROWSER_LIVE=1 timeout 590 bunx vitest run tests/e2e/certification/w137-real` | **exit 0 — 12/12 passed in 15.79 s** (7 browser + 5 E2B, all LIVE; re-verified at the branch tip: **exit 0, 12/12 in 14.76 s**) |
| Keyless `vitest run tests/e2e/certification/w137-real` | 12 skipped (2 files), exit 0, ~3.0 s |
| `timeout 590 bunx vitest run` (full battery) | exit 124 on this 2-CPU station (four attempts, the last reaching 219 suite lines at the wall; §6.6) — the sanctioned W105 chunked equivalent completed at the identical tree: **328 files / 6429 passed / 2 failed (both §6.5 pre-existing at `55206bf`) / 42 skipped** (the 12 new LIVE proofs among the skips, keyless) |
