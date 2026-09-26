# Final Tech Lead Takeover Handoff — Aurum Post-W083

**Repository:** `payswapdotorg/aurum-chat`  
**Current main:** `73d00ecbabc9402dde8374671d18108a2958d2e0` (see §3a and the Wave A/B/D sections — W094 + W100 verified 2026-09-26)  
**Architecture:** v2.1 — FROZEN  
**Program scope:** W080–W101 only  
**Maximum concurrent workers:** 3

## 1. Takeover instruction

The previous Tech Lead is no longer available. This document is the self-contained continuation point.

At takeover, fetch current `main` and compare it with the SHA in this document. Do not assume the SHA is still current if new commits have appeared. Re-run repository inspection before dispatching work.

Repository truth order:

1. source code and committed tests;
2. actual live behavior;
3. committed machine-generated evidence;
4. frozen specification/contracts;
5. worklog/issue prose.

Never inherit a release verdict from an older revision without checking the exact deployed SHA.

## 2. Canonical documents

Read these first:

- `spec/ARCHITECTURE.md`
- `spec/ARCHITECTURE-LOCK.md`
- `spec/GOVERNANCE.md`
- `spec/IMPLEMENTATION-STACK.md`
- `spec/SIMULATION-LEARNING-LOG.md`
- `spec/TECHNOLOGY-RESEARCH-2026-09-23.md`
- `spec/POST-S002-COHERENT-IMPLEMENTATION-PLAN-2026-09-23.md`
- `spec/work-items/WORK-ITEM-CATALOG.md`
- `spec/WORK-ITEM-DEPENDENCY-GRAPH.md`
- `spec/WAVE-0-BASELINE-2026-09-23.md`
- `spec/PRODUCTION-JOURNEY-CERTIFICATION-2026-09-23.md`
- this file

## 3. What is already implemented — verified from repository history

### W080 — Durable Agent Runtime ✅
Commit: `1ee5f0348d8868d1745cbe19632f177fbb7ec610`

Actual implementation includes an Aurum-owned workflow port, PostgreSQL-backed durable state, event/schedule triggers, wait/approval handling, cancellation/resumption, idempotency, bounded pump execution, and kill/restart survival tests.

Do not replace it with a new orchestration model. Any external workflow engine remains an adapter behind the existing port.

### W081 — Integration Intelligence ✅
Commit: `2b76ac75b1b00fa5431aad9c9b9b82d4f786d84a`

Actual implementation includes admin-authorized discovery only, no uncontrolled scanning, tenant-scoped Tool & System Inventory, deterministic why-it-matters explanations, safe read-only recommendations, bulk approval through W009, automatic verification records and crash-recovery tests.

Important: discovery is deliberately authorization-gated. Do not introduce network scanning.

### W082 — Universal Connection Broker ✅
Commit: `7b8387d70ccd96da7bbd7daaa1748419d6f05586`

Actual implementation includes broker-neutral OAuth lifecycle, sync/webhook checkpoints, replay, outage normalization, health state, pluggable brokers, Nango + embedded implementations and hot-swap evidence. W036/W037 source/destination composition is already present.

Important: provider tokens remain opaque credential references.

### W083 — Progressive Capability Grants ✅
Commit: `06422f163e579fc1be26e50ee124a536d6e371d5`

Actual implementation partitions connected capabilities into read floor vs write-gated capabilities, requests only the missing write capability for a concrete task, routes the ask through W009, records allowed/denied invocations and supports revocation.

The latest W083 delivery reports all four repository gates green and `4903 passed / 0 failed / 6 pre-existing skips` at delivery.

### W085 — Meeting Intelligence Gateway ✅
Commit: `0719ce132ded606906f0d0342dffd7d6933d4437`

Actual implementation includes canonical meetings/sessions/transcripts/artifacts, participant registry, native Zoom/Teams/Meet adapter boundary, polling/webhook ingestion, provider access failure records and observation/provenance integration.

Important boundary: W085 is capture/intelligence ingestion. It does not itself provide live two-way realtime participation.

### W086 — Realtime Voice and Meeting Companion ✅
Commit: `2495666f6a5fbb6b6688b21e0fad24e1992691b4`

Actual module exists under `src/modules/realtime` and exposes provider-neutral realtime sessions, LiveKit + OpenAI Realtime adapters, explicit consent/recording ledger, speaker attribution, interruption handling, spoken responses, durable meeting artifact finalization through W080 and provider-swap evidence.

### W087 — Cellular Reachability ✅
Commit: `7eff0b0fdadf92be99c11d7d84da281151caff2d`

Actual implementation under `src/modules/cellular` supports the intended Reach Anyone path: verified phone identity, W009 authority gate, SMS delivery, voice fallback subject to policy, delivery lifecycle, replies, carrier webhooks, retry/recovery and manager-originated SMS requests when the manager has no usable Internet data.

The recipient needs neither Internet nor an Aurum account.

### W089 — Provider Adapter SDK and OSS Registry ✅
Commit: `de7bb3bc323e78de951ca9537bb3269661f4d631`

Actual implementation includes provider lifecycle/error normalization, adapter definition template, conformance kit, hot-swap evidence and a committed technology registry/CLI. OpenAI + Anthropic conform to the SDK's proof path.

### W090 — Aurum Provider Billing Gateway ✅
Commit: `7fcdb33467c8c7b6cd66fad999cac9134e091f66`

Actual implementation includes payment arrangements, usage ledger, budget enforcement/routing, Aurum-mediated settlement with W009 authority, direct-customer fallback, tamper-evident receipts, settlement adapter port and W080 durable settlement workflow binding.

### W098 — Persistent Agent Supervision and Recovery ✅
Commit: `239502a671cd114f39af5243c6115dff3c498119`

Actual implementation is present and delivered as W098.

### 3a. Replay-session reconciliation applied 2026-09-25 (W084 + W095)

The original handoff below was written from `main` only and missed two completed
worker deliveries that lived on **unmerged delivery branches** pushed by replay
sessions whose chat transcripts render empty (the known agent-mode len=0 lie —
lesson family: registry/branch first, message-tree never a verdict):

**W084 — Deep Action Gateway and Reconciliation ✅ (PR #106, squash `f3958e4`)**
- Worker session `cad9ace9` ("Deep Action Gateway Implementation", dispatched 2026-09-25 16:12 UTC).
- Branch `work/w084-deep-action-gateway-reconciliation` @ `8cf6a2be04fec0b41c0f751b35b57908089abeeb` (base `06422f1`).
- New module `src/modules/deep-actions/` (contract exposing the discover→inspect→propose→authorize→execute→verify→reconcile pipeline, DeepActionTransport port, W080 workflow composition bindings, pure reconcile.ts, migrations/001, 26 unit + 16 integration tests) + repo-mandated registrations (journey-proof capability map, e2e instrument list, W044 sweep).
- Integration-station verification (re-run, not inherited): typecheck PASS, lint PASS, arch PASS (module files 610 / tables 214), tests **5034 passed / 0 failed / 6 pre-existing skips** (every test file covered, chunked).
- NOTE: a parallel lineage squash-merged the same branch again as PR #108 (`323efb6`, tree-identical no-op) — coordinate through this file and the PR record; never re-merge an already-merged delivery branch.

**W095 — Unified Cross-Channel / Meeting / Telephony Identity Verification ✅ (PR #107, squash `2f415e3`)**
- Worker session `d6badcd7` ("W095: Identity Verification Implementation", dispatched 2026-09-25 11:05 UTC).
- Branch `work/w095-unified-identity-verification` — worker commit `2600fc5746c63c01dfd770182fa62cc9dd8345ec` (base `7eff0b0`, pre-W083) + reconciliation merge `c7973ba` onto post-W084 main (capability-map conflict resolved by keeping the W083+W084+W095 entries — the established registration-file pattern).
- New module `src/modules/unified-identity/` (modality-scoped identity registry + ambiguity ledger + unified resolution/profile surface; meetings/realtime unification passes over the W085/W086 contracts; claim-gated trust ops reusing identity-module claims; 62 module tests + 4 W044 sweep tests) + registrations.
- Integration-station verification at the exact merged tree: typecheck PASS, lint PASS, arch PASS (module files 618 / tables 217), tests **5100 passed / 0 failed / 6 pre-existing skips**; `2f415e3`'s tree is byte-identical to the verified tree (`ff0fec05`).

**Flake fixed in the same finalization pass:** `contributions-service.test.ts` "validation series ascending" asserted insertion order, but the query orders by `(recorded_at ASC, id ASC)` — same-instant validations tie-break on random uuids (one CI failure observed on PR #107's first run; passed re-run; assertion now order-insensitive).

Both sessions' transcripts, the W090-era "Continue Implementation" corpse and the empty "New Chat" phantoms were audited: no other unpushed delivery exists on any work/ branch as of `2f415e3`.

### Wave A — W088 / W091 / W092 ✅ (PRs #110/#111/#112, 2026-09-26)

**W088 — Aurum Edge Connector ✅ (squash `a385209`)**
- Worker session `w088-edge-connector` (agents tab, GLM-5.3, Full-Stack). Final tip `aa4fb86` (the worker self-integrated a parallel attempt and fixed the integration pins itself).
- New module `src/modules/edge-connector/` (signed tenant-scoped job envelopes, outbound-only claim protocol, local secret handling via opaque credentialRef, twice-checked capability allowlist, heartbeat health/version reporting, result normalization onto the W084 deep-action transport shapes, DeepActionTransport adapter) + migrations + 3 test suites + registrations (discoverability instrument entry, tenant-isolation sweep).
- Integration-station verification at `aa4fb86`: typecheck PASS, lint PASS, arch PASS (629 files/223 tables), full suite 240 files/5158 tests/0 failed.

**W091 — User-Friendly Provider Choice UX ✅ (squash `7b7ff1e`)**
- Worker session `w091-provider-ux`. Final tip `36639d3` (worker merged its parallel delivery as superseded).
- New module `src/modules/provider-preferences/` + product routes `/ai/preferences` (+`/advanced`) riding the llm contract only (no llm internals touched): outcome preference profiles (cost/privacy/quality/speed/policy), jargon-free default surface, explanation rendering from frozen LlmRoutingSnapshot machine reasons, authorization-gated advanced technical override through the existing `UpdateAiProviderAccountInput` path + sweep tests + registrations.
- Reconciled with post-W088 main (union on discoverability); verified at the exact merged tree: typecheck PASS, lint PASS, arch PASS (637/228), full suite 245 files/5247 tests/0 failed.

**W092 — Vertical Extension Starter Kits ✅ (squash `17c7796`)**
- Worker session `w092-vertical-kits`. Final tip `85b49ec` ("delivery" commit).
- New module `src/modules/vertical-kits/` (versioned signed-manifest kit registry, install/uninstall lifecycle with grant review riding the W009 gate, kit-scoped capability grants + invocation ledger, two shipped starter kits — legal case management + accounting ledger ERP — with all vertical semantics in manifests, core stays industry-independent, DEFERRED-ON-W088 VerticalKitEdge seam declared honestly) + sweep tests + registrations.
- Reconciled with post-W091 main (three-way union on discoverability: vertical-kits + provider-preferences + edge-connector); verified at the exact merged tree: typecheck PASS, lint PASS, arch PASS (649/235), full suite 248 files/5283 tests/0 failed.

Final main `17c7796` is byte-identical to the last verified reconciliation tree (empty `git diff`).

### Wave B — W093 / W096 / W097 ✅ (PRs #114/#115/#113, 2026-09-26)

Delivered by the parallel-lead session's workers (the replay-session dispatches of the same work items were destroyed or queue-stalled by the 2026-09-26 05:35–05:55 UTC peak-hours capacity crisis and were voided as duplicates — no duplicate trees, all branch content identical to the work-item contracts below).

**W093 — Browser / Computer-Use Fallback ✅ (squash `737e67e`, PR #114)**
- Branch `work/w093-computer-use-fallback` @ `9eba6d2`, base `b084504`.
- New module `src/modules/computer-use/` (governed last-resort browser executor composed over the deep-actions contract — `reconcileOperation` re-used verbatim, no second evidence model; per-(tenant,task) browser profiles and credential stores via the W082 opaque credentialRef discipline sharpened per task; frozen step allowlist checked at creation/dispatch/driver-side; step budget; disposable resumable sessions checkpointed on verified steps; per-step screenshot/action-trace evidence) + migration 001-computer-use.sql (tenant_id on every table, ADR-0001) + 2 module suites + tenant-isolation sweep + registrations (discoverability instrument entry v5, sweep manifest).
- Integration-station verification at `9eba6d2` (independent re-run): typecheck PASS, lint PASS, arch PASS (658 files/288 app-mcp/240 tables), full suite 251 files/5324 tests/0 failed.

**W096 — Integration Intelligence E2E Fixture ✅ (squash `e37f1d4`, PR #115)**
- Branch `work/w096-integration-intelligence-e2e` @ `5ffeb2c`, base `b084504`.
- Machine-readable fixture suite `tests/e2e/fixtures/integration-intelligence/` (versioned `fixture.schema.json` as the contract of record with a JSON-Schema-subset evaluator that refuses to silently skip keywords; happy-path / provider-failure / denied-scope / tenant-isolation cases) + executor that executes every step against the REAL W081–W084 module services (integration-intelligence, connection-broker, capability-grants, deep-actions) with deterministic provider doubles (ScriptedDirectoryTransport, ScriptedBrokerBackend, ScriptedVerificationTransport, ScriptedDeepActionTransport), verifying durable records (table rows, append-only event ledgers, contract reads, provider-side double state) + the journey suite `tests/e2e/journeys/integration-intelligence.e2e.test.ts`; contract-only import discipline throughout.
- Integration-station verification at `5ffeb2c` (independent re-run): typecheck PASS, lint PASS, arch PASS (649/288/235), full suite 249 files/5294 tests/0 failed.

**W097 — Meeting and Cellular E2E Fixture ✅ (squash `c71f2e2`, PR #113)**
- Branch `work/w097-meeting-cellular-e2e` @ `06b195f`, base `b084504`.
- `tests/e2e/fixtures/meeting-cellular/` (versioned schema `aurum.meeting-cellular-fixture` v1, schema/version-refusing interpreter; real module contracts W085/W086/W087/W095/W002/W009/W031/W029/W004/W080 against embedded PostgreSQL; provider doubles in documented adapter shapes fed through the real webhook/edge seams; consent/policy, provider-failure, ambiguous-identity, recipient-without-Aurum, manager-originated cases; honest machine-readable DEFERRED record for the manager-originated authority-gate contract gap; honest live-vs-fixture labeling — no live telephony credentials in environment) + journey suite + 1427-line fixture runner.
- Integration-station verification at `06b195f` (independent re-run): typecheck PASS, lint PASS, arch PASS (649/288/235), full suite 249 files/5289 tests/0 failed.

Merge wave: PR #113 (08:04 UTC), PR #114 (08:22 UTC), PR #115 (08:40 UTC) — squash-merged sequentially; #115 also carried an order-insensitive flake fix in `src/app/(tower)/tests/tower-integration.test.ts` (same-millisecond `recorded_at` tiebreak, cf. the contributions-service precedent). No conflicts (W096/W097 are pure additions; W093's registration edits are pure additions on the b084504 base).

Final main `e37f1d4` verified at the exact merged tip: typecheck PASS, lint PASS, arch PASS (658/288/240), full suite 253 files/5341 tests/0 failed.

### Wave D — W094 ✅ (PR #117, 2026-09-26)

**W094 — Migration and Dual-Run Continuity ✅ (squash `9f4f15b`, PR #117)**
- Branch `work/w094-migration-dual-run` @ `3507562`, base `b96abde` (the post-Wave-B handoff tip).
- New module `src/modules/migration/` (staged import rounds — snapshot → transform → staged → review → commit, every imported record an evidence-shaped row carrying full provenance with a storage-level payload/provenance immutability trigger, abandoned rounds never become delta bases; the external↔Aurum identifier map per source system preserving natural-key identity within a source, cross-system collisions and ambiguous multi-entity matches raising explicit conflict records that link nothing until resolved — never auto-merged; dual-run as delta import rounds since the last COMMITTED round, NO live two-way sync, the incumbent reader port read-only by contract and unwired by default (`reader_unavailable` rather than a faked snapshot), a deterministic scripted fixture-incumbent double, comparison reports riding the W084 `reconcileOperation` verbatim (no second evidence model); commit-time verification composing the W084 DeepActionTransport port; sequestration rollback that quarantines without deleting; evidence-linked progressive retirement checkpoints dual-running → compare-clean → incumbent-read-only → incumbent-retired) + migrations/001-migration.sql (8 tables, tenant_id on every table) + 2 module suites + the W044 tenant-isolation sweep + registrations (discoverability instrument entry, e2e capability list, sweep manifest v6).
- Naming deviation recorded honestly: the module landed as `src/modules/migration/` (the dispatch prompt's illustrative `migration-continuity` path was not followed literally; scope discipline held — no files outside the module plus the 3 union-additive registration seams).
- Delivered by the parallel-lead session's worker; the replay-session dispatch of the same item was queue-dropped server-side (assistant placeholder len=0, the page's "Thinking…" a stale render) and was voided as a duplicate.
- Integration-station verification at the exact merged tip `9f4f15b` (independent re-run): typecheck PASS, lint PASS, arch PASS (module files 667 / app-mcp 288 / tables 248), full suite **258 tracked test files — 5353 tests passed / 0 failed** (4 environment-gated file-level skips: real-Redis/real-Postgres URL seams unset in the sandbox). W094's own 43 tests green (11 service + 31 unit + 1 sweep).

### Wave E — W100 ✅ (PR #118, 2026-09-26)

**W100 — Longitudinal S003 Conversion Benchmark ✅ (squash `73d00ec`, PR #118)**
- Branch `work/w100-s003-conversion-benchmark` @ `002fa8a`, base `9f4f15b`. Pure additions (19 files, 3663 insertions, all inside `tests/longitudinal/**` — the simulator module itself untouched).
- The S003 harness (`tests/longitudinal/s003-conversion.benchmark.test.ts`, 2606 lines) + the S002 latent-score methodology re-implemented as committed design constants (`s003-model.ts`, 902 lines) + raw results committed with schema headers (`tests/longitudinal/results/s003/**`: summary, per-firm, per-industry, quality payloads, README design record).
- Cohort: 12 firms = 3 industries x 4 sizes (solo/small/mid/large) — legal + accounting ride the two W092 starter kits, logistics is the KIT-LESS CONTROL industry; the mid firm of each industry runs the full W056 attribution trio (experienced/control/cold-start) with raw W055 quality payloads committed.
- The six catalog measurements as pure functions of module-recorded adoption: aurumPrimaryFraction + aurumOnlyFraction (routing bases cite real contracts — kit grants, connection floors/grants, meeting/cellular channel liveness, agent supervision), context switching (adjacent-tool switches per scenario), integration setup effort (MODELED baseline protocol, labeled as such, vs the MEASURED S003 chain of actually-executed W096/W084/W094 contract ops priced by published weights), trust (the frozen 6-action automation portfolio with one DESIGNED honest write-scope denial per firm), realized value (W055 families).
- Determinism: one reproducible seed per firm; dedicated determinism describe; byte-stable artifacts (sorted keys, no uuids/timestamps); `revealGroundTruth` stays evaluation-side with a dedicated no-leakage describe (hidden markers/answers never appear in any tenant's records or traces).
- Headline (baseline → mature, 120 scenario evaluations): Aurum-only 0 → 49.6%, Aurum-primary 14.2% → 90.8%, context switches 2.93 → 0.96/scenario, integration effort 6750 → 906 action-minutes (−86.6%), trust 0/6 → 5/6. Honest findings: baseline not a strawman (~0.14 aurum-primary from the core loop alone), physical/offline steps never convert, solo-firm size effects preserved, kit-less logistics converts entries but fewer full workflows (the honest measure of what vertical kits add), every provider seam on deterministic in-suite doubles. Synthetic-simulation-not-a-forecast framing carried in the README and summary.
- Delivered by the parallel-lead session's worker. The replay-station dispatch cycle: first dispatch (chat e0eee06a) died at an active capacity event (~12:10 UTC — chat destroyed by the site, same class as the morning peak crisis); a duplicate re-dispatch after the wall was voided pre-generation when the external delivery was discovered on the branch.
- Integration-station verification at `002fa8a` (independent re-run): typecheck PASS, lint PASS, arch PASS (667/288/248 — module counts unchanged, work lives in tests), full suite **259 tracked test files — 5396 tests passed / 0 failed** (3 env-gated file skips: real-Redis/Postgres URL seams; the S003 benchmark itself green in the chunked run; 38 postgres-boot hookTimeout flakes + 2 OOM-SIGKILL'd workers all pass serialized — the station-hygiene note below applies).

**Station-hygiene note (2026-09-26, binding for every future verification on this sandbox):** the 4GB box now OOM-kills a single-process `bun run test` (kernel `oom_kill`, 54-byte log). Run the suite CHUNKED: `git ls-files '*.test.ts' | rg -v '^tests/browser/'` (~259 files) split into ~33-file chunks, one `bunx vitest run --maxWorkers=2 <chunk>` per chunk. Do NOT pass `--reporter=basic` (removed in vitest 5 — instant startup error). Under concurrent chunks the embedded-PostgreSQL `beforeAll` boots exceed the 10s default `hookTimeout` on ~30-40 files — those are boot timeouts, NOT regressions: all pass serialized (`--maxWorkers=1`; verified twice — 31 files/624 tests for W094, 38 files/735 tests for W100). Also watch for OOM-SIGKILL'd workers ("Worker exited unexpectedly with signal SIGKILL") — retry those files serialized too (2 such files for W100, both green on retry). Long-running background jobs must be launched orphan-to-init — `( setsid nohup bash script >log 2>&1 < /dev/null & )` so the runner's PPID is 1 — or the between-tool-calls teardown tree-walk reaps them (console boot lesson 147 applies to the product repo too; setsid alone is not enough).

## 4. Remaining implementation frontier

The following work is **not yet evidenced by a W-numbered implementation commit in repository history as of current main** (`73d00ec`, post-W100):

- W099 — Matrix Interoperability Adapter (optional)
- W101 — Final Post-S002 Production Certification

W084, W095, Wave A (W088/W091/W092), Wave B (W093/W096/W097), W094 and W100 were removed from this list by the 2026-09-25/26 replay-session reconciliations (§3a and the Wave A / Wave B / Wave D / Wave E sections above).

Do not mark any of these complete because their contracts, UI stubs or research documents exist. Require real repository implementation and evidence.

## 5. Immediate priority order

### First wave (W088/W091/W092) — ✅ delivered 2026-09-26 (PRs #110/#111/#112)

### Wave B (W093/W096/W097) — ✅ delivered 2026-09-26 (PRs #114/#115/#113)

### Now: W101 — final certification
- W101 (Final Post-S002 Production Certification) is the only remaining core frontier item; all its work-item dependencies (W096/W097/W098/W100) are green at `73d00ec`. It needs production infrastructure and two consecutive same-revision green runs.

### Optional: W099
W099 (Matrix adapter) remains optional — only with a documented customer/use-case justification; it must not block W101.

## 6. Recommended three-worker scheduling from current head

### Wave A (W088/W091/W092) — ✅ delivered 2026-09-26

### Wave B (W093/W096/W097) — ✅ delivered 2026-09-26

### Wave D — W094 ✅ delivered 2026-09-26 (PR #117)

### Wave E — W100 ✅ delivered 2026-09-26 (PR #118)

**Worker A: W094 — Migration + Dual Run** — ✅ delivered and integration-verified at `9f4f15b`.

**Worker B: W100 — Longitudinal S003 Conversion Benchmark** — ✅ delivered and integration-verified; merged at `73d00ec`.

**Worker C: remaining integration hardening / observability.**

### Remaining waves

**W099 — Matrix adapter only if justified** (optional; must not block W101).
**W101 — final certification**: all workers support production certification against one exact deployment revision, with two consecutive green runs.

## 7. W083/W087 reality checks before declaring “cellular is finished”

The current code is materially more complete than the earlier S002 research state, but the new lead must still distinguish module completion from production connectivity.

W087 contains real provider adapter boundaries and real provider-ready contracts, but delivery is still dependent on configured telecom credentials/transports. The E2E proof must use real provider evidence where credentials are available; otherwise use deterministic fixtures and explicitly label what remains environment-dependent.

The same rule applies to W085/W086: provider adapters and canonical contracts are implemented, but production meeting participation must be demonstrated against actual configured provider connections before W101 calls it certified.

## 8. Current production/release state

W079 certification is historical and bound to its exact recorded deployment revision. Do not reuse that verdict for the current W083 head.

The current GitHub combined status for `06422f...` reports a successful Vercel check. The connected Vercel project inspection was not available through the current Vercel API session (403), so do not infer the current deployment identity, production environment variables or live database/worker state from that single status check.

Before W101, independently verify:

- exact production deployment ID;
- exact deployment SHA;
- PostgreSQL path is external/production;
- Redis/queue/lock path is production;
- worker execution;
- production secrets/credentials;
- demo/quick-login disabled;
- realtime/cellular provider connections;
- no critical runtime/network errors.

## 9. Existing quality gates

The repository CI continues to run:

- `bun run typecheck`
- `bun run lint`
- `bun run arch`
- `bun run test`
- migration smoke against PostgreSQL
- real PostgreSQL/Redis integration path

The current `main` branch's Vercel check is green. Do not treat that as sufficient W101 evidence.

Every worker must run the full four repository gates before delivery.

## 10. Non-negotiable implementation constraints

- Architecture v2.1 remains frozen.
- PostgreSQL remains organizational truth.
- Redis is never domain truth.
- LLMs do not become workflow authority.
- Providers stay inside adapters.
- Provider/broker/runtime objects never enter Aurum domain contracts.
- No provider may become architecturally privileged.
- Existing mature OSS should be reused when it passes security/license/maintenance/operational/exit review.
- Ordinary users choose outcomes, not technical providers.
- Provider-specific choices remain reversible.
- Provider costs route through W090 when commercial terms allow; direct billing remains an explicit fallback.
- Consequential actions remain W009-authorized.
- Human employee decisions remain human-authorized.
- Meeting recording requires explicit consent behavior implemented by W086.
- No uncontrolled network scanning for integration discovery.
- Browser automation is a last-mile adapter, never organizational truth.
- Matrix is optional and cannot block the program.
- No worklog/commit message alone proves a feature.

## 11. Final product behavior

### Organization onboarding

`connect organization → Aurum discovers authorized systems → explains why they matter → admin approves → connections are established → verification → mapping → read-only learning → concrete action asks for narrow additional authority → execution → reconciliation → learning`

### Communication

`Tell Sarah … → resolve employee → choose authorized route → preferred channel → SMS → voice fallback → delivery evidence → authorized reply`

Recipient does not need Internet or Aurum.

### Meetings

`meeting → consent/status → transcript/media → speaker identity → evidence → decisions/unknowns/actions → missions/recommendations → outcome`

### Persistent cognition

`event → durable workflow → ephemeral worker → persisted result/evidence → next durable step`

## 12. Definition of done

W080–W101 is complete only when the final production system behaves as one persistent organizational employee that can understand the organization, reach employees, understand meetings, discover/connect/operate existing systems, execute authorized actions, verify/reconcile outcomes, learn and remain provider-independent.

Specifically, W101 must prove the full program against the exact released revision and must not inherit W079 by reference.
