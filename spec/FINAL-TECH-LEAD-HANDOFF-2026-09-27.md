# Aurum Tech Lead Final Handoff — 2026-09-27

**Repository:** `payswapdotorg/aurum-chat`
**Canonical branch:** `main`
**Takeover code/evidence baseline:** `c3d6a331c69ed3f8b9edcb4e86750cbc89c84caa` (always fetch the actual current `main` before integrating)
**Latest certified production revision:** `625a133e22904972394b6e418f2a3b2c9cda676a`
**Latest certified deployment:** `dpl_BCtojsKXWqF3qsEmczyHfUxaauGJ`
**Production host recorded by W106:** `https://aurum-chat-livid.vercel.app`
**Architecture:** v2.1 — FROZEN
**Completed program:** mandatory W080–W101
**Optional:** W099 Matrix interoperability
**Maximum concurrent workers:** 3

This is the canonical takeover document for the next Tech Lead. It supersedes the historical
post-W083 handoff for operational purposes. The historical handoff remains in the repository as
evidence of the earlier state.

## 1. Repository-only operating rule

The repository is the durable operating memory for this program.

Use this order of authority:

1. source code and committed tests;
2. exact live production behavior, when a live claim is being made;
3. committed machine-generated evidence;
4. frozen specifications, contracts and ADRs;
5. work-item catalog and dependency graph;
6. worklogs, issue prose, commit messages and chat transcripts.

A chat transcript is never a required dependency for implementation. If a fact matters to the
next worker, encode it in a tracked file under `spec/`, `tests/`, or the appropriate evidence
tree.

Never mark a work item complete because a worker says it is complete. Completion requires
repository implementation + required tests/gates + exact evidence appropriate to the work item.

## 2. Current verified state

The repository has advanced well beyond the previous W083 takeover point.

Verified mandatory implementation lineage:

- W080 Durable Agent Runtime — `1ee5f0348d8868d1745cbe19632f177fbb7ec610`
- W081 Integration Intelligence — `2b76ac75b1b00fa5431aad9c9b9b82d4f786d84a`
- W082 Universal Connection Broker — `7b8387d70ccd96da7bbd7daaa1748419d6f05586`
- W083 Progressive Capability Grants — `06422f163e579fc1be26e50ee124a536d6e371d5`
- W084 Deep Action Gateway + Reconciliation — `323efb6bba05b8eb903944b693fdc3ab0de93849`
- W085 Meeting Intelligence Gateway — `0719ce132ded606906f0d0342dffd7d6933d4437`
- W086 Realtime Voice + Meeting Companion — `2495666f6a5fbb6b6688b21e0fad24e1992691b4`
- W087 Cellular Reachability — `7eff0b0fdadf92be99c11d7d84da281151caff2d`
- W088 Aurum Edge Connector — `a3852094f7867ec26979e2623ae6f537256ec831`
- W089 Provider Adapter SDK + OSS Registry — `de7bb3bc323e78de951ca9537bb3269661f4d631`
- W090 Provider Billing — `7fcdb33467c8c7b6cd66fad999cac9134e091f66`
- W091 Provider Choice UX — `7b7ff1e4780877268943b1c3f05f9638f1800d59`
- W092 Vertical Starter Kits — `17c7796fa923cb0339018ba45e48ab72b400ddcb`
- W093 Browser / Computer-Use Fallback — `737e67eb64aa98c430376a10bd6a2f0aa275f7a6`
- W094 Migration + Dual Run — `9f4f15b32a8d6bdbe222c926025d775640de9a14`
- W095 Unified Identity — `2f415e3c959f67b7507ae31e7c2cdaae9ba73871`
- W096 Integration Intelligence E2E — `e37f1d444c6e414923f054f1f9f5cff7fa789e1f`
- W097 Meeting + Cellular E2E — `c71f2e220e202f391dede8cf5cd2681a3f55c281`
- W098 Persistent Supervision + Recovery — `239502a671cd114f39af5243c6115dff3c498119`
- W100 Longitudinal S003 Benchmark — `73d00ecbabc9402dde8374671d18108a2958d2e0`

W099 is intentionally optional and non-blocking.

## 3. Production certification state

The first W101 production campaign was not trusted or laundered. It exposed genuine defects:

- J13 anonymous shell race;
- J20 production schema drift / migration-name collision;
- J16/J17/J18/J22 missing product surfaces.

The repair chain included:

- #120 `850b85b` — anonymous shell fix;
- #122 `d1c0960` — migration-name collision repair;
- #123 `8ddd0df` — constraint/index collision repair;
- W102 `25f3a9c` — schema drift guards and orphan-debris protections;
- W103 `6970c06` — channel-family v1 API operations;
- W104 `625a133` — meetings + cellular product/API surfaces;
- W105 `0c0a29d` — vertical-kit marketplace path.

W106 then ran two consecutive same-revision production certifications against
deployment `dpl_BCtojsKXWqF3qsEmczyHfUxaauGJ` at commit
`625a133e22904972394b6e418f2a3b2c9cda676a`.

Both runs recorded:

- 22 passed
- 0 failed
- 0 blocked
- 0 flaky
- 0 unexpected
- identical deployment identity
- identical journey matrix

Therefore the latest committed release evidence is **CERTIFIED READY for the tested
production revision**.

Do not generalize that verdict to a future deployment automatically.

## 4. What is genuinely complete

The core W080–W101 architecture and proof program is complete.

The repository now contains:

- durable workflow state and recovery;
- integration intelligence;
- connection brokering;
- progressive capability grants;
- deep actions + reconciliation;
- meetings + realtime companion;
- cellular reachability;
- edge execution;
- provider SDK and billing;
- outcome-oriented provider selection;
- vertical starter kits;
- governed computer-use fallback;
- migration/dual-run continuity;
- unified cross-channel identity;
- integration E2E;
- meeting/cellular E2E;
- persistent agent supervision;
- longitudinal S003 benchmark;
- exact-SHA production certification machinery and evidence.

## 5. Important distinction: contract-complete vs live-provider-complete

Do not confuse an implemented provider-neutral contract with a live provider integration.

The following are known and intentionally explicit environment-dependent seams:

### Vertical kits / Edge

`src/modules/vertical-kits/service.ts` still has a nullable Edge port and reports
`deferred-on-w088` / `edge_unavailable` when it is not wired.

W088 itself is implemented. The next TL should close the composition seam rather than
reimplement either module.

### Cellular

W087 contains real Twilio and Telnyx adapter boundaries and the complete outcome-oriented
reach lifecycle, but the deployment can still surface `provider_unavailable` when no live
transport is configured.

W097 also records one explicit deferred authority gap for the manager-originated path:
the inbound request can return into Aurum, but its formal W009 authority-gate record remains
deferred and must not be silently treated as complete.

### Meetings / Realtime

W085/W086 contain canonical contracts and adapter boundaries for Zoom, Teams, Google Meet,
Recall, LiveKit and OpenAI Realtime. The deterministic E2E proof is strong, but live provider
credentials/transport were not present in the audited environment.

### Computer use

W093 is governed and resumable, but the repository's default driver remains the deterministic
scripted driver. A real browser driver is environment/customer-side and must be wired behind
the existing contract.

### Migration

W094 intentionally leaves incumbent and native readers as explicit ports. The fixture path is
complete, but real source-system readers remain environment-dependent.

These are not reasons to reopen the architecture. They are reasons to finish adapter
composition and live evidence where the environment can support it.

## 6. Known infrastructure risk

The migration runner remains name-keyed in `_migrations`. W102 adds a strong schema census and
guards the production drift class that was actually observed, but the underlying possibility
of two different migration contents sharing one migration name remains conceptually present.

Treat this as a hardening risk to investigate, not as permission to rewrite the migration system
without evidence.

## 7. New continuation program

The original W080–W101 roadmap is complete. The next work is operational closure of the
environment-dependent seams discovered during adversarial review.

The continuation DAG is canonical in:

`spec/POST-W106-CONTINUATION-DAG-2026-09-27.md`

Initial three-worker wave:

- Worker A — W107 Vertical Kit ↔ Edge execution composition closure
- Worker B — W108 Cellular live transport + manager-inbound authority closure
- Worker C — W109 Meeting/Realtime live-provider wiring + production evidence

Second wave:

- Worker A — W110 real Browser / Computer-Use driver composition
- Worker B — W111 production migration reader/native-reader adapters
- Worker C — migration-runner hardening investigation / implementation only if evidence
  warrants it

Final release proof:

- W112 — post-W106 live-capability certification matrix and release evidence.

W099 Matrix can be considered only if a documented customer/use-case exists. It must never
block W107–W112.

## 8. Worker dispatch discipline

The Tech Lead must behave as an orchestrator, not as a single worker.

Before every dispatch:

1. fetch current `main`;
2. inspect current dependency graph and work-item status;
3. check active branches/PRs to prevent duplicate delivery;
4. identify at most three dependency-ready items;
5. create narrow worker prompts with explicit ownership boundaries;
6. require every worker to write its status/evidence back into the repository;
7. reconcile worker branches only after independent review of code, tests and affected
   contracts;
8. run the required integration gates at the exact merged tree;
9. update the canonical state files before dispatching the next wave.

Workers may run concurrently whenever their declared dependencies and ownership boundaries allow it.
Do not serialize independent work merely for convenience.

Workers must never depend on a chat transcript to recover context. Their prompt must point to
the exact repository documents and exact work item.

No two workers may concurrently edit the same frozen contract or shared registration primitive
unless the TL explicitly partitions ownership and performs the final reconciliation.

## 9. Required worker delivery record

Every worker delivery must leave repository evidence containing:

- work-item ID;
- base SHA;
- worker branch;
- implementation commit;
- files changed;
- dependency verification;
- exact tests run;
- exact gate results;
- live-provider evidence vs deterministic-fixture evidence;
- known limitations / deferred seams;
- cross-tenant evidence where applicable;
- rollback/recovery implications;
- final disposition: delivered / blocked / failed.

A commit message alone is insufficient.

## 10. Required repository gates

Every integrated delivery must pass:

- `bun run typecheck`
- `bun run lint`
- `bun run arch`
- `bun run test`
- migration smoke against PostgreSQL
- real PostgreSQL / Redis integration path where credentials are available

On the audited 4 GB sandbox, run the non-browser Vitest suite using the established chunked
station method recorded in the repository. Do not interpret sandbox OOM or hook-timeout behavior
as a product regression without serialized reproduction.

## 11. Production truth rules

For every future production claim, record:

- deployment ID;
- exact deployment commit SHA;
- environment label;
- PostgreSQL backend class and migration count;
- worker/queue/Redis health;
- relevant provider connection posture;
- exact browser journey results;
- evidence directory;
- two-run agreement where a release gate requires it.

A previous certified deployment is a rollback target, not proof for a new deployment.

## 12. First action for the next TL

Read, in this order:

1. `spec/REPOSITORY-SOURCE-OF-TRUTH.md`
2. `spec/CURRENT-STATE-2026-09-27.md`
- Machine-readable current state: `spec/CURRENT-STATE-2026-09-27.json`
3. `spec/POST-W106-CONTINUATION-DAG-2026-09-27.md`
4. `spec/TECH-LEAD-ORCHESTRATOR-PROMPT-2026-09-27.md`
5. `spec/ARCHITECTURE.md`
6. `spec/ARCHITECTURE-LOCK.md`
7. `spec/GOVERNANCE.md`
8. `spec/work-items/WORK-ITEM-CATALOG.md`
9. `spec/WORK-ITEM-DEPENDENCY-GRAPH.md`
10. `docs/productization-evidence/W106/`

Then independently verify `main` and recompute the dispatchable frontier before sending work.

## 13. Non-negotiable architecture constraints

- architecture v2.1 remains frozen;
- PostgreSQL is organizational truth;
- Redis/cache/queue/locks are infrastructure only;
- provider-specific objects remain inside adapters;
- no provider becomes architecturally privileged;
- consequential actions remain W009-authorized;
- employee decisions remain human-authorized;
- evidence remains immutable and provenance-bearing;
- unknowns remain first-class;
- browser automation is last-mile execution, never organizational truth;
- Matrix remains optional;
- vertical semantics remain out of Aurum core;
- live-provider absence must be reported honestly, never simulated as production success;
- no uncontrolled network scanning;
- repository state must be sufficient for the next TL/worker to continue without this chat.

## 14. Definition of successful continuation

The continuation succeeds when the environment-dependent seams are either genuinely wired and
live-proven or are explicitly, machine-checkably marked environment-blocked with the exact
required prerequisite.

The goal is not more architecture. The goal is one coherent, durable Aurum organizational actor
whose already-complete contracts are actually composable in production without hidden gaps.
