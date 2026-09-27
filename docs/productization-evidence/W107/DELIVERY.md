# W107 — Vertical Kit ↔ Edge Execution Composition Closure — Delivery Record

**Work item:** W107 (spec/POST-W106-CONTINUATION-DAG-2026-09-27.md; the canonical catalog on main)
**Base SHA:** 53bd2711982a7016fc36e1376e375d7551142652
**Branch:** `work/w107-vertical-edge-composition`
**Implementation commit:** see `git log -1` on the branch (this file is committed with the implementation).
**Delivery type:** DELIVERED (deterministic proof over the REAL W088 implementation) with the LIVE
customer-edge leg honestly ENVIRONMENT-BLOCKED (prerequisites below; never faked).

---

## 1. What was delivered

1. **THE COMPOSITION ADAPTER** (`src/modules/vertical-kits/edge-adapter.ts` — new):
   `createEdgeConnectorKitEdge(ctx, options)` implements the W092 kit-side `VerticalKitEdge`
   port over the W088 Edge Connector's PUBLIC transport composition —
   `createEdgeDeepActionTransport` (imported from `@/modules/edge-connector/contract`, the
   architecture-checker-legal import; NO edge-connector internal is ever imported). Every kit
   edge call therefore rides the REAL W088 machinery end-to-end: a SIGNED, tenant-scoped edge
   job envelope, execution customer-side through the edge's dial-home loop (the injected
   `drive` hook — never an outbound connection toward the edge), canonical result submission,
   and W084-shaped results back (`{found, state}` reads; `{status, receiptId, detail}`
   receipts in the accepted/rejected/failed taxonomy). The adapter re-uses W084
   DeepActionTransport/reconciliation — it forks nothing: the deep-action
   discover→inspect→propose→authorize→execute→verify→reconcile discipline remains THE
   reconciliation model, and edge results/evidence stay exactly W084-shaped.

2. **THE W084-W088 IDEMPOTENCY DISCIPLINE, REUSED** (inside the adapter):
   - **Execute** derives a STABLE, content-addressed idempotency key
     `kit-edge:<installationId>:w:<sha256(scope)>:<sha256(canonicalJson(payload))>` — an
     identical write replays the ORIGINAL edge job (exactly-once execution customer-side,
     the W088 `job_key` replay discipline verbatim); a changed payload is a genuinely new
     write and executes fresh. The scope is hashed (not embedded raw) because external
     targets are opaque strings while edge idempotency keys are charset-bounded.
   - **Inspect** mints a FRESH key per call (`kit-edge:<installationId>:i:<scope>:<uuid>`) —
     a kit read is a LIVE read of the system of record and must never replay a previously
     recorded outcome.

3. **ADDITIVE PER-TENANT REGISTRATION** (`src/modules/vertical-kits/service.ts` — additive):
   `setTenantKitEdge` / `getTenantKitEdge` / `resetTenantKitEdges` — the Family-A
   globalThis-anchored per-tenant registry (the W108 cellular per-provider pattern adapted
   to the kit seam's tenant scope; the W058 Next-bundle-divergence lesson). The kit runtime
   resolves the CALLING tenant's edge first (`resolveEdgeForTenant`), falling back to the
   frozen global `setVerticalKitEdge` seam (single-tenant deployments and the scripted test
   double — every existing W092 test unchanged and green). A binding created by
   `createEdgeConnectorKitEdge` carries its wiring tenant; registering it under a DIFFERENT
   tenant is refused loudly (`invalid_input` — a cross-tenant wiring mistake never becomes a
   silent leak).

4. **GRANT/W009 AUTHORITY UNCHANGED AND PROVEN** — the composition adds NO authority path:
   `inspectKitIntegration` / `executeKitIntegration` still consult `gateKitCapability`
   (the W009-fronted kit grant gate) BEFORE the edge is ever invoked; a denial is returned
   as data with the deterministic, task-grounded reason and the transport is never called
   (proven: zero edge jobs, zero dial-home cycles, zero connectivity calls in the denial
   test). The edge-side allowlist (W088) adds the EDGE's own boundary policy on top —
   defense in depth on both sides, both honest.

5. **STALE `deferred-on-w088` WORDING REMOVED** — only where the real binding supersedes it
   (see §4 below): the module doc headers/narratives that called W088 "the future
   implementor" / the edge seam "DEFERRED-ON-W088", the `EDGE_UNAVAILABLE_MESSAGE` refusal
   text, the four starter-kit integration descriptions that claimed the deep-integration
   path was "DEFERRED-ON-W088 (the Edge Connector)", and the one spec handoff sentence that
   tasked the next TL with closing the seam. The FROZEN contract literals stay verbatim:
   the `KitIntegrationReadiness` union `'deferred-on-w088' | 'ready'` (W092 froze the value;
   it remains the honest unwired-state literal, and the marketplace surface that reads it
   is untouched) and the `edge_unavailable` error code.

## 2. Files changed

| File | Kind | Note |
| --- | --- | --- |
| `src/modules/vertical-kits/edge-adapter.ts` | NEW | the W107 composition adapter |
| `src/modules/vertical-kits/tests/vertical-kits-edge-composition.test.ts` | NEW | deterministic proof over the REAL W088 implementation (5 tests) |
| `src/modules/vertical-kits/service.ts` | MODIFIED (additive) | per-tenant registry + per-tenant edge resolution in the 3 call sites; doc updates |
| `src/modules/vertical-kits/contract.ts` | MODIFIED (additive) | exports the adapter + registry; doc updates |
| `src/modules/vertical-kits/types.ts` | MODIFIED (doc-only) | stale seam narrative updated; frozen type literals untouched |
| `src/modules/vertical-kits/errors.ts` | MODIFIED (doc-only) | `edge_unavailable` narrative updated |
| `src/modules/vertical-kits/kits.ts` | MODIFIED (content/doc) | 4 stale integration descriptions |
| `spec/FINAL-TECH-LEAD-HANDOFF-2026-09-27.md` | MODIFIED (minimal) | the one superseded "next TL should close the composition seam" sentence |
| `docs/productization-evidence/W107/*` | NEW | this record |

NO migrations, NO schema changes, NO `EXPECTED_TABLE_CENSUS` or count-pin touches, NO
edge-connector changes (read-only), NO changes to `src/infra/cellular.ts`,
`src/modules/cellular/**`, `src/modules/meetings/**`, `src/modules/realtime/**`.

## 3. Deterministic proof (the REAL W088 implementation, not a fake)

`src/modules/vertical-kits/tests/vertical-kits-edge-composition.test.ts` drives the ACTUAL
edge-connector machinery — `registerEdgeRuntime` (enrollment, admin-claim-gated),
`wireEdgeSigner` + `createHmacSigner` (the enrollment key), `createInMemoryEdgeRuntime`
(the deterministic customer-side runtime that dials home through the REAL contract calls
and enforces its OWN local allowlist at the boundary), `createPrivateApiDouble` +
`recordAdapters` (the contract-level connectivity double) — composed with the full
governed kit lifecycle (register → verify → install → the W009 grant review → activate)
through `createEdgeConnectorKitEdge` + `setTenantKitEdge`:

1. **`inspects and executes a kit integration through the edge: signed jobs, W084-shaped
   evidence`** — the read and the write become signed tenant-scoped edge jobs (3 jobs on
   the feed, all terminal), the write executes exactly once customer-side with the
   edge-minted opaque receipt id (`edge-api-N`), the read returns the live state (and sees
   the write afterwards), the kit ledgers record the invocation + edge action with the
   W084 receipt shape and the edge identity, `getKitStatus` reports `ready` integrations
   with the wired edge id, and every job carries the wiring's opaque credentialRef and
   advisory systemKey.
2. **`denies a missing kit grant BEFORE any edge call: no job, no dial-home, denial as
   data`** — with the write grant revoked (out-of-band drift, constraint-shaped) on an
   ACTIVE installation, `executeKitIntegration` returns the denied invocation (basis
   `grant-missing`, reason naming `write.case-matters`) with `receipt: null`; the edge job
   feed is EMPTY, the drive hook never ran, the connectivity adapter was never called.
3. **`keeps the W084 write discipline: identical content replays the original job; changed
   content executes fresh`** — the same payload twice replays ONE edge execution (identical
   receipt id, two recorded kit actions); a changed payload executes a second job; a live
   read sees the latest state.
4. **`isolates tenants: each rides its OWN edge; foreign installations are missing;
   unwired tenants refuse honestly`** — two tenants with separate edges/adapters: each
   tenant's job feed and adapter records hold ONLY its own targets; a foreign tenant's
   installation is `installation_not_found` (read and write paths); a third tenant with no
   wiring fails `edge_unavailable` and reports the frozen `deferred-on-w088` readiness;
   a cross-tenant REGISTRATION mistake is refused loudly.
5. **`surfaces an edge-boundary refusal of a kit read honestly (the edge contract error,
   never a fake read)`** — the dispatch allowlist names the read capability but the
   simulator's own LOCAL allowlist does not: the boundary refuses, the honest `rejected`
   receipt lands on the job, and the W088 transport surfaces it to the kit caller as the
   edge contract's own typed error (`edge_job_rejected`) — exactly as EdgeConnectorError
   surfaces through the W084 deep-action pipeline (no forked error model).

Gates (re-run by the TL from repo facts): `bun run typecheck` PASS, `bun run lint` PASS,
`bun run arch` PASS (module files: 678, app/mcp files: 308, tables checked: 249),
`bun run test -- vertical-kits edge-connector` **81/81 PASS** (7 files). Adjacent suites
also run because the starter-kit content changed:
`bun run test -- marketplace-kits` 48/48 PASS, `bun run test -- migration-service` 11/11
PASS, `bun run test -- s003-conversion` 31/31 PASS.

## 4. Deferred-wording closure (the exact stale strings removed)

- `src/modules/vertical-kits/contract.ts` — the `THE EDGE SEAM (DEFERRED-ON-W088)` header
  block ("the Edge Connector (W088, in flight in a parallel work stream) is the future
  implementor…") and the "integrations are 'deferred-on-w088' until an edge is wired"
  status-report line → replaced by the composed-seam narrative (`THE EDGE SEAM (COMPOSED —
  W107)`); the dependency-posture note that awaited W088 → now records the edge-connector
  contract import.
- `src/modules/vertical-kits/types.ts` — the `THE EDGE SEAM (DEFERRED-ON-W088)` manifest
  header, the `KitEdgeIntegrationDeclaration` section header + doc, the
  `VerticalKitEdge` port doc, the `KitStatusReport` doc, and the
  `KitIntegrationReadiness` comment (the frozen union literal itself is KEPT verbatim as
  the unwired-state value, now documented as such).
- `src/modules/vertical-kits/service.ts` — acceptance property 5 (the DEFERRED-ON-W088
  narrative), the `EDGE_UNAVAILABLE_MESSAGE` refusal text, and the two
  `DEFERRED-ON-W088:` call-site comments in the inspect/execute paths.
- `src/modules/vertical-kits/errors.ts` — the `edge_unavailable` doc ("the Edge Connector
  (W088) is the future implementor… DEFERRED-ON-W088 until it lands").
- `src/modules/vertical-kits/kits.ts` — the header narrative ("once W088 lands") and the
  four integration descriptions' "Deep-integration path DEFERRED-ON-W088 (the Edge
  Connector)" sentences.
- `spec/FINAL-TECH-LEAD-HANDOFF-2026-09-27.md` — the one superseded sentence ("The next TL
  should close the composition seam rather than reimplement either module") now records the
  W107 closure with pointers.
- KEPT (unrelated/still-true, deliberately untouched): the W092-era test comments and the
  `describe('the DEFERRED-ON-W088 edge seam')` label in the existing service test (they
  describe the still-true UNWIRED behavior), the marketplace surface's readiness literal
  (frozen contract value, out of W107 ownership), the journey-proof discoverability note
  (describes the marketplace view's vocabulary; out of ownership), and the dated planning
  docs (`TECH-LEAD-ORCHESTRATOR-PROMPT`, `POST-W106-CONTINUATION-DAG`) — history stays
  history, per the W108 precedent of not rewriting the TL's own working docs.

## 5. The LIVE customer-edge leg — ENVIRONMENT-BLOCKED

Deterministic proof is complete over the REAL W088 implementation (the in-memory runtime
that dials home through the real contract calls). A LIVE customer-controlled edge — a real
customer process enrolled with its own enrollment key, heartbeating, pulling jobs and
executing real connectivity adapters against a live system of record — cannot exist in
this sandbox: there is no customer environment, no enrollment key material, and no
customer-side edge process. **ENVIRONMENT-BLOCKED.** Exact prerequisites to prove the live
leg later:

1. A customer-operated edge runtime enrolled per the W088 contract
   (`registerEdgeRuntime` with the customer's opaque `signingKeyId`), its enrollment key
   material loaded in the gateway wiring (`wireEdgeSigner`) AND held customer-side.
2. The edge dialed home at least once (verified heartbeat → `connected` health) with its
   local allowlist covering the kit integration's capability keys (`read.case-matters` /
   `write.case-matters` or the accounting equivalents) and locally-resolvable secret refs.
3. A per-tenant wiring call: `setTenantKitEdge(tenantId, createEdgeConnectorKitEdge(ctx,
   { edgeId, drive, credentialRef, systemKey }))` in the production wiring surface (the
   invocation site itself is a W112 certification frontier — no production route calls the
   registry yet, exactly as no production route called `setDeepActionTransport` at this
   base).
4. A live kit write driven through `executeKitIntegration`, recording the edge-minted
   receipt and the customer-side execution evidence.

Never faked: no simulated "live" evidence is recorded anywhere in this delivery.

## 6. Frontier notes (left for W112 certification, deliberately)

- **Production wiring invocation site** — no production route/worker currently calls
  `setTenantKitEdge`; the composition surface is delivered and proven, the invocation
  point (which tenant-edge bindings a deployment constructs, from what configuration)
  follows the same W112 frontier as the cellular pump wiring (the W108 precedent).
- **Marketplace readiness view** — `src/app/(product)/marketplace/lib/kits.ts` still reads
  the GLOBAL `getVerticalKitEdge()` seam (out of W107 ownership). When per-tenant edges
  are wired in production, that view should switch to the tenant-aware
  `getTenantKitEdge`/status resolution (one-liner) so the marketplace detail page agrees
  with `getKitStatus`. Its current behavior is unchanged and its tests stay green.
- **Deep-action task composition per kit write** — kit writes ride the W084 TRANSPORT
  (envelope, evidence, idempotency, receipt taxonomy) directly through the kit runtime's
  own ledgers; composing full W084 deep-action TASKS (discover→…→reconcile rows with
  observation evidence) for kit operations remains the W094/W112 pipeline frontier, per
  the W092 design (the kit runtime records its own invocation/action evidence today).
- **Live leg** — see §5.
