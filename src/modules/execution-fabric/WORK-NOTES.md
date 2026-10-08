# W137 — Execution Environment / Agent Computer Fabric · WORK NOTES

Work item: `spec/work-items/WORK-ITEM-CATALOG.md` §W137 (dependencies:
W093, W110, W131, W136 — the consumed seams listed below, all consumed,
none modified). Design contract: `spec/ARCHITECTURE.md` §24 (the
reconstruction chain's execution leg and "audit records are
append-only"), the W131 frozen execution-contract vocabularies (the
adapter capability-shape, environment kinds, session isolation and
persistence shapes — consumed type-only through
`@/modules/execution/contract`), the W093/W110 BrowserDriver port
(computer-use stays the one owner of governed browser automation) and
ADR-0001 (tenancy).

> "Implement interchangeable isolated workspace/browser/computer
>  adapters. Evaluate local container, Playwright/Chromium and
>  E2B/equivalent remote sandbox paths."
> Acceptance: "isolation, persistence where required, artifact handoff,
> takeover, cancellation, recovery and evidence are tested; vendor
> removal does not change domain contracts."

Delivery history (honest): D1/D2/D3 delivered in seven commits —
dfcf161 (types/errors/validation/migration), 67505a4 (local-container +
browser adapters, TL-banked at the deadline), 7d270fb (remote-sandbox
adapter), 378e2a4 (service.ts + the in-memory adapter registry, incl.
the `credential_ref` column fix), ecb0476 (contract.ts), daee371 (unit
proofs 580L + a 2-line `query ?? {}` default fix in the two list ops,
TL-banked), f9ac1c8 (service proofs 1895L, TL-banked UNVERIFIED — the
dead D3 worker never ran gates on it). D4 (this delivery) ran all four
gates on the banked state: **the suite verified GREEN on the first run
— zero repairs were needed** (the W136 precedent repeated: the
deadline-killed delivery was intact). D4 then wrote these notes, the
module's only remaining deliverable.

## What was built (file map)

Everything lives in `src/modules/execution-fabric/**` — nothing else in
the repository was touched.

| File | Role |
| --- | --- |
| `types.ts` (561L) | The domain shapes: `EnvironmentDefinition` (the vendor-neutral registry record — frozen kind + isolation + persistence + required capability domains; content immutable from creation), `FabricLease` (the lease bound to ONE W136 execution run, with every lifecycle stamp column), the four append-only evidence shapes (`FabricLeaseEvent`, `LeaseArtifactHandoff`, `LeaseEvidenceRecord`, `LeaseCheckpoint`) and the read/query shapes. `FabricLeaseStatus` composes the frozen W131 session phases + worker-run statuses into the fabric's own seven-state machine. `FabricAdapter` extends the frozen `ExecutionAdapter` SPI with ONE additive optional field (`subjectRef` on the open request — vanilla frozen adapters still serve session/environment-scoped definitions). |
| `migrations/001-execution-fabric.sql` (494L) | Six tenant-scoped tables: `environment_definitions` (the pointer; ONLY legal UPDATE is the one-way active → retired transition with `retired_at` stamped exactly once; every identity/content column immutable), `fabric_leases` (the lifecycle pointer — the storage guard mirrors `fabricLeaseTransitionProblem`: identity/acquisition content immutable, terminal rows frozen outright, only legal status moves, `session_id` changes ONLY on prepare/recover, each stamp exactly-once with its retained reason), and the four append-only evidence tables (`fabric_lease_events` / `fabric_lease_artifacts` / `fabric_lease_evidence` / `fabric_lease_checkpoints` — triggers reject UPDATE/DELETE/TRUNCATE outright, §24). Cross-module references are opaque forward references, deliberately NOT foreign keys (the house discipline). |
| `errors.ts` (118L) | 29 typed codes (the file's vocabulary table): the input family (`invalid_context` … `invalid_query`), the uniform not-found family (`definition_not_found`, `lease_not_found`, `exchange_plan_not_found`, `execution_run_not_found` — cross-tenant access indistinguishable from missing, no existence leak), and the governance family (`definition_key_taken`, `definition_retired`, `definition_already_retired`, the five adapter codes incl. `adapter_not_registered` (the vendor-removal refusal) and `adapter_capability_unsupported` (the honest-descriptor refusal), the lease-state codes (`lease_already_terminal`, `lease_not_preparing`, `lease_not_live`, `lease_not_suspended`, `lease_not_lost`, `lease_suspended`), `checkpoint_required` and `invalid_transition`). |
| `validation.ts` (1061L) | Pure guards (no database, no clock, no TenantContext reads — the org-lab discipline): the W131 vocabularies mirrored and compiler-pinned with `satisfies` (kinds, capability domains, profile scopes, network egress, checkpoint levels — drift in the owning contract fails TYPECHECK here), the lease-status family sets (terminals, cancellable, releasable, losable, recoverable, the three servable postures), **`fabricLeaseTransitionProblem` — THE single deterministic legality definition** of the lease state machine, and every input/query validator (defKey slug grammar, bounds, opaque-ref bounds — never value checks, uuid rules, limit bounds). |
| `adapters/local-container.ts` (293L) | Catalog path (a): a DETERMINISTIC SIMULATION of a local container runtime serving the frozen 'workspace' kind — per-profile volumes keyed from (tenant, scope, subject) (the persistence-where-required surface), the command log, disposable sessions with a durable adapter-side registry for `resume(<session-id>)`, scriptable open/resume failures. No container engine, no process, no filesystem touch, no network — documented honestly in the file header. |
| `adapters/browser-adapter.ts` (276L) | Catalog path (b): the frozen shape mapped onto the W093/W110 **BrowserDriver port** (consumed type-only through the computer-use contract — the fabric WRAPS the port, it never duplicates browser authority). open → `driver.startSession` on the isolated profile key (per tenant always; per subject when scope 'task' — the W093 per-(tenant,task) discipline); resume → a fresh session on the SAME profile; close → `driver.endSession`; probe → the honest descriptor (filesystem/commands NOT supported — supported:false, the honest-descriptor law). THE SUITE NEVER LAUNCHES REAL CHROME: the driver is injected (a fake double in tests; production wiring is W110's `createPlaywrightBrowserDriver` or an approved W088 edge adapter). |
| `adapters/remote-sandbox.ts` (473L) | Catalog path (c): the E2B-equivalent remote sandbox client behind an INJECTABLE transport port (one narrow HTTP round-trip; the adapter builds plain JSON envelopes, no secret value ever in `headers` from adapter code — the fetch-backed default transport adds NO credential; the production wiring closure owns vendor auth). The documented generic wire: POST/DELETE `/sandboxes[/{id}]`, GET `/health`; probe reports vendor health honestly ('unavailable' when the vendor does not answer — never fabricated). `createFakeRemoteSandboxTransport` is the test double; no test ever touches a network. |
| `service.ts` (1728L) | The twenty-four domain operations (see contract.ts). TRANSACTION DISCIPLINE (the W134 law, binding): every cross-module read (the W136 plan/run gates, definition/lease loads) runs on the base connection BEFORE the mutation; each mutation keeps its append + lifecycle transition atomic in ONE transaction whose statements touch only this module's tables; the one-way transitions re-check legality under a FOR UPDATE row lock (the staleness re-check). **Adapter I/O (open/resume/close) is external to the database and happens OUTSIDE every transaction** — a vendor-path failure stamps the lease 'failed' with the actionable detail first, then refuses typed; a racing terminal transition wins and the freshly opened disposable session is closed best-effort. The in-memory adapter registry: probe-at-registration handshake, generation counter, the vendor-removal op. |
| `contract.ts` (317L) | The ONLY public surface (rule (b)): the 24 domain operations (2 definition ops, 10 lease-lifecycle ops, 3 evidence-record ops, 8 reads, plus the vendor-removal wiring op `unregisterExecutionAdapter`; `registerExecutionAdapter` + `listRegisteredAdapters` complete the wiring seam), `ExecutionFabricError` + codes, the guards/vocabularies/limits, `fabricLeaseTransitionProblem` exported for verification, the domain types, the three catalog-path adapter factories, and the frozen W131 vocabularies re-exported TYPE-ONLY through the execution contract. NO execution primitive on the surface. |
| `tests/execution-fabric-unit.test.ts` (580L) | 20 pure proofs over validation + the three adapters' legality (no database). |
| `tests/execution-fabric-service.test.ts` (1895L) | 42 embedded-PGlite integration proofs over the REAL service with REAL cross-module fixtures (goal → W136 plan → W021 execution → recorded run, walked through the owning contracts; the harness NEVER opens its own transaction — the W134 deadlock class cannot occur). |

## The core acceptance, test-locked (all eight clauses)

- **ISOLATION** — two fully independent tenants hold same-defKey
  definitions and same-shaped leases with uniform foreign not-founds,
  empty foreign list views and no evidence-tail leakage
  (`tenant isolation (ADR-0001)` suite: "holds fully independent fabric
  state across two tenants" + "isolates adapter sessions per tenant
  (structural profile keys)"); the isolation literals are structural
  (`tenantIsolated: true`, `credentialHandling: 'opaque-ref-only'`
  round-tripped in "registers and normalizes the retained shape");
  the W082 credential law is proven end-to-end — the opaque ref rides
  the lease, is handed VERBATIM to the adapter's open at prepare
  (asserted on the browser adapter's receipt surface) and never
  appears in any domain evidence tail; the isolated profile keys are
  tenant-scoped on every adapter path (unit proof, the W093
  discipline).
- **PERSISTENCE WHERE REQUIRED** — a durable-checkpoint lease with NO
  recorded checkpoint refuses recovery (`checkpoint_required` — the
  resume truth must exist before a fresh session replays from it);
  with one, recovery resumes from the checkpoint cursor into a FRESH
  session bound to the SAME isolated profile; a session-checkpoint
  definition recovers from its prior session; the checkpoint names the
  covered evidence refs (replay never re-executes covered work);
  `survivesRestart` is honored through the per-profile volume/profile
  continuity ("persistence where required" suite + "cuts a durable
  checkpoint naming the covered evidence" + "parks a dead lease lost,
  then recovers a FRESH session from the checkpoint").
- **ARTIFACT HANDOFF** — artifacts cross the environment boundary by
  OPAQUE reference in both directions (digest optional), the manifest
  reads back in evidence order and filters; the four evidence tables
  reject UPDATE/DELETE/TRUNCATE at the storage level (probed with
  direct SQL) ("hands artifacts across the boundary and captures
  evidence with literal redaction" + "records artifacts in both
  directions and filters the manifest" + "keeps the four evidence
  tables append-only at the storage level").
- **TAKEOVER** — the W131 'Take control' cycle: a HUMAN holds control
  (holder 'human', required reason retained, opaque W009
  authorityActionRef retained VERBATIM — asserted against a fresh
  `getActionRequest` read — and never decided by the fabric); control
  returns by EXPLICIT HAND-BACK ONLY (release on a suspended lease
  refuses `lease_suspended`); the cycle's legal shape is held
  ("takes over for a human … and hands back" + "holds the
  takeover/handback cycle to its legal shape").
- **CANCELLATION** — fabric-executed (no cooperative window): the
  terminal state commits FIRST, the vendor session closes best-effort
  AFTER; cancellable from preparing/live/suspended/lost; a
  human-held lease never blocks cancellation; a REMOVED vendor never
  blocks cancellation (the whole `cancellation` suite + the
  vendor-removal suite's "never blocks cancellation" proof).
- **RECOVERY** — lease death parks 'lost' (NOT terminal — the run
  record survives, the disposable session does not); recovery stamps
  the checkpoint ref it resumed from and clears the loss; recovery is
  legal only from 'lost' and only once per loss; a failing vendor
  resume stamps the lease 'failed' with the actionable detail, then
  refuses typed ("parks a dead lease lost, then recovers a FRESH
  session from the checkpoint" + "recovers only lost leases (and only
  once per loss)" + "stamps the lease failed when the vendor path
  fails to resume").
- **EVIDENCE** — the frozen W131 capture vocabulary (screenshot /
  action-trace / dom-snapshot / console) with the verification triad
  (unverified / verified / mismatched — the W093 discipline: nothing
  is treated as a result before verification) and LITERAL redaction
  'applied' (credentials never ride in observations); servable only
  on in-flight postures (terminal leases refuse `invalid_transition`);
  the full evidence timeline reads back in (recorded_at, id) order,
  filterable by kind; the storage guard mirrors the state machine
  (defense in depth — "captures evidence across the verification
  triad and filters by capture kind" + "holds the servable postures"
  + "reads back the full evidence timeline in order" + "mirrors the
  state machine at the storage level").
- **VENDOR REMOVAL DOES NOT CHANGE DOMAIN CONTRACTS** — the SAME
  domain flow (acquire → prepare → artifact → evidence → checkpoint →
  takeover → handback → loss → recovery → release) driven through the
  fake-browser and fake-remote-sandbox adapters produces IDENTICAL
  domain outcomes (statuses, reasons, timestamps, event timelines —
  the vendor-neutral projection); unregistering the adapters leaves
  every read serving while prepare/recover refuse
  `adapter_not_registered` and cancellation still completes;
  re-registration restores acquisition with the contracts UNCHANGED;
  no vendor name rides in any adapter-produced session or domain
  record (vendor identity is METADATA on the descriptor — the only
  place it is visible) (the `vendor-removal clause` suite ×3 + the
  unit-level `vendor-removal neutrality` suite ×2).

## Design decisions & rulings honored

1. **The fabric is NOT an execution authority.** Nothing on this
   surface submits, dispatches, pumps or cancels an agents-module
   execution (W021 owns execution), never drives a browser step plan
   itself (W093/W110 computer-use owns governed browser automation —
   the browser adapter only COMPOSES its driver port) and never
   decides an approval (W009; the takeover's `authorityActionRef` is
   an opaque reference, never a decision).
2. **The lease is the durable truth; the adapter session is
   disposable** (W131's "sessions are disposable; runs are the durable
   truth", applied to the lease). A lost lease recovers into a FRESH
   session; the storage guard lets `session_id` change ONLY on prepare
   (NULL → value) and recover (value → a DIFFERENT value).
3. **`fabricLeaseTransitionProblem` is the single legality
   definition**, mirrored by the storage guard (defense in depth):
   preparing → live/cancelled/failed; live → suspended/lost/
   cancelled/released/failed; suspended → live/handback… lost/
   cancelled/failed; lost → live/cancelled/failed; terminal rows
   frozen outright. Unit-proven for every legal and illegal move and
   mirrored against the storage guard's vocabulary.
4. **The W131 law: vendor identity is METADATA, never a domain
   value.** There is no 'e2b', 'playwright' or 'docker' type anywhere
   in the module's domain surface; the fabric resolves adapters at
   acquisition by KIND + capability declaration only, deterministically
   (earliest-registered capable adapter wins); no vendor name may
   appear in a definition, lease, event, artifact, evidence record or
   checkpoint — test-locked.
5. **The honest-descriptor law.** An adapter that cannot serve a
   required capability domain declares supported:false and acquisition
   refuses explicitly (`adapter_capability_unsupported`); an unhealthy
   vendor is reported honestly (`adapter_unavailable` — never
   fabricated); nothing is wired by default (the frozen 'local' kind
   refuses `adapter_unavailable` — no adapter in this delivery serves
   it yet). Registration probes the adapter (the completed-handshake
   discipline: a backend appears in discovery only after a completed
   handshake).
6. **The adapter registry is in-memory wiring, NEVER domain state.**
   `unregisterExecutionAdapter` — the vendor-removal operation —
   never touches a lease row: reads of served leases still work,
   prepare/recover refuse `adapter_not_registered`, cancellation
   never consults the registry for legality. Re-registration replaces
   the entry with a fresh generation.
7. **TRANSACTION DISCIPLINE (the W134 law, binding).** PGlite is
   single-connection: every gate (definition state, W136 plan/run,
   adapter resolution) runs on the base connection BEFORE the
   mutation; each mutation is ONE transaction touching only this
   module's tables, with the one-way transitions re-checking legality
   under FOR UPDATE. **Adapter I/O is OUTSIDE every transaction**
   (external to the database): a vendor open/resume failure stamps the
   lease 'failed' with the bounded actionable detail first (honest
   failure evidence — a racing transition that committed first owns
   the state and nothing is stamped), then refuses typed.
8. **Fabric lease cancellation is fabric-executed, not cooperative.**
   The frozen worker-run 'cancelling'/'recovering' intermediates
   belong to the RUN side (W021/W140 own the cooperative window); the
   fabric lease closes the ENVIRONMENT directly — the terminal state
   commits first, the vendor session closes best-effort after
   (documented ruling; a vendor close failure never resurrects or
   re-opens a lease).
9. **Persistence where required is enforced at the recovery gate.**
   The definition declares the checkpoint level; a durable-checkpoint
   lease without a recorded checkpoint refuses recovery
   (`checkpoint_required`). The checkpoint tail is append-only, so
   recovery re-derives the resume ref under the lock — the stamp names
   what actually existed at commit time. The resume-token convention
   is documented: `<session-id>@<worker-cursor>` (or a bare session
   id) names the vendor session the fresh one continues.
10. **The takeover's authority link is an OPAQUE W009 reference.**
    Consequential takeovers route through the action gateway by id
    exactly as the frozen contracts do; the fabric records the routing,
    it never reads, decides or re-words the authority outcome (the
    test asserts the ref against a fresh `getActionRequest` read —
    verbatim, never interpreted).
11. **Definitions are immutable content with a one-way lifecycle.**
    A changed definition is a NEW definition under a NEW key
    (`definition_key_taken`); retirement is one-way and terminal
    (`definition_already_retired`); retired definitions refuse NEW
    leases while existing leases continue (`definition_retired`).
12. **Credentials are opaque references only (W082).** The ref is
    persisted on the lease and handed verbatim to `adapter.open` at
    prepare; a secret VALUE is inexpressible in the types
    (`credentialHandling: 'opaque-ref-only'`, `opaque-ref bounded,
    never a value check` in validation).
13. **The ONE deliberate extension of the frozen SPI**: the additive
    OPTIONAL `subjectRef` on `FabricAdapterSessionRequest` (the frozen
    `ExecutionSessionOpenRequest` has no field for the subject a
    task-scoped profile is scoped to — the W093 per-(tenant,task)
    discipline). A vanilla frozen ExecutionAdapter that ignores it
    still serves session- and environment-scoped definitions
    correctly.
14. **Deterministic orders (test-locked):** definitions and leases
    newest-first (created_at DESC, id DESC); events, artifacts,
    evidence and checkpoints by (recorded_at ASC, id ASC) — the
    evidence-timeline order.

## The seam consumption map (what this module reads, and where)

All cross-module imports target contracts only (rule (b), enforced by
the architecture gate; arch pass 773/337/284). Nothing is re-derived;
everything consumed is consumed verbatim.

| Seam (owner) | Contract symbols consumed | Where | How the tests exercise it |
| --- | --- | --- | --- |
| agent-exchange (W136) | `getExecutionPlan`, `listExecutionRuns`, `AgentExchangeError`, type `ExecutionRun` | `requireActiveExchangePlan` / `requireExecutionRunOnPlan` in service.ts — the acquisition gates (plan readable + ACTIVE; run recorded on the plan), always on the base connection BEFORE the mutation | REAL fixture chains: `createGoal` → `createExecutionPlan` → `submitAgentExecution` → `recordExecutionRun`; refusals proven for a missing plan, a COMPLETED plan (`exchange_plan_not_found` uniform) and an off-plan run (`execution_run_not_found`) |
| execution contract (W131 frozen vocabularies) | `ExecutionAdapter`, `ExecutionAdapterCapability(Domain)`, `ExecutionAdapterHealth`, `ExecutionAdapterVendorMetadata`, `ExecutionEnvironmentDescriptor`, `ExecutionEnvironmentKind`, `ExecutionEnvironmentSession`, `ExecutionSessionOpenRequest`, `SessionArtifactHandoff`, `SessionIsolationProperties`, `SessionPersistenceGuarantees` (all TYPE-ONLY) | types.ts (the domain shapes + the FabricAdapter SPI), the three adapters (descriptors, sessions), validation.ts (compiler-pinned mirrors with `satisfies`) | every test asserts against the frozen shapes; the unit suite pins the mirrored vocabularies and the adapters' honest descriptors per kind |
| computer-use (W093/W110) | `BrowserDriver`, `BrowserAllowlist` (TYPE-ONLY, through the contract) | `adapters/browser-adapter.ts` — the browser path WRAPS the BrowserDriver port (open → startSession on the isolated profile key, resume → a fresh session on the same profile, close → endSession); the fabric never duplicates browser authority | a FAKE driver injected in the fabric's suite (never launches Chrome); the governed allowlist is handed to the driver at every session start; production wiring is W110's `createPlaywrightBrowserDriver` (its one-time real-browser evidence run stays W110's, docs/productization-evidence/W110/) |
| goals (W008) | `createGoal` | fixture-only (the W136 plan gate transitively demands a real goal) | real `createGoal` fixtures in every exchange chain |
| agents (W021) | `registerAgent`, `submitAgentExecution` | fixture-only (the W136 run's execution side — the fabric never touches the execution itself) | real agent + execution fixtures via the in-process fake transport (the sanctioned wiring seam; no real provider contacted) |
| actions (W009) | `authorizeAction`, `getActionRequest` | fixture-only (the takeover's opaque `authorityActionRef`) | a real authorized action request; the recorded ref asserted verbatim against a fresh read — never decided by the fabric |

## Honest-limitations register (for TL integration)

1. **The local-container adapter is a DETERMINISTIC SIMULATION** — no
   container engine, no process, no filesystem touch, no network; the
   per-profile volumes, command log and session registry are in-memory
   models. A real containerd/Docker evaluation is a NEXT STEP at
   composition, behind the same frozen shape.
2. **The browser and remote-sandbox adapters run on FAKE transports in
   tests** — the browser path drives an injected fake BrowserDriver
   (real Playwright/Chromium NOT exercised by this suite; the one-time
   real-browser evidence remains W110's recorded run) and the remote
   path drives `createFakeRemoteSandboxTransport` (no test ever
   touches a network; no E2B account/vendor SDK involved). Real
   playwright and real E2B/equivalent evaluation against these
   adapters is a documented NEXT STEP for composition/W139 — the
   contracts and the wire protocol are already frozen here.
3. **The FOR UPDATE staleness re-checks are structurally present but
   not CONCURRENTLY provable on this box** (PGlite is
   single-connection — the same class as the W134/W135/W136
   limitation): the sequential second call fails at the pre-transaction
   uniform check before the lock re-check is reached. What IS proven:
   the one-way transitions, the exact-once stamps, the terminal
   refusals and the storage-level guard mirror.
4. **Sweeps / registrations / census / discoverability for the six new
   tables are TL-owned** (the W125/W135/W136-integration precedent —
   outside this worker's strict ownership): the tenant-isolation
   manifest and schema-pinned census registrations for
   `environment_definitions`, `fabric_leases`, `fabric_lease_events`,
   `fabric_lease_artifacts`, `fabric_lease_evidence` and
   `fabric_lease_checkpoints` await the TL integration pass. The arch
   gate's table count moved 278 → 284 with W137's six tables (the
   migration is auto-discovered; the count is honest). The two-tenant
   isolation proofs live in this module's own suite in the meantime.
5. **The W136 run gate is bounded by the exchange's read surface.**
   `requireExecutionRunOnPlan` resolves the run within the plan's
   first 500 recorded runs (the exchange exposes an oldest-first
   bounded list, no offset read) — deeper histories need a
   W136-integration read op (recorded as the open composition
   question; honest in the service's own comment).
6. **The adapter registry is in-memory (per-process).** A process
   restart clears registrations; persisted leases keep their opaque
   `adapter_id` and reads keep serving, but prepare/recover refuse
   `adapter_not_registered` until re-registration — deliberate (wiring
   is never domain state), flagged for the app-composition boot
   sequence.
7. **Lease expiry is detection-driven, not swept.** `lease_until`
   passing without heartbeats does not auto-park the lease 'lost';
   `markFabricLeaseLost` is the detection point (the honest caller
   reports what detected the death). A background expiry sweep is a
   composition/W140 concern.
8. **The frozen 'local' kind has no serving adapter in this delivery**
   (it stays legal for in-process fixture environments; acquisition
   refuses `adapter_unavailable` — nothing is wired by default, by
   law).
9. **No authority-claim gating on fabric operations** (the
   org-lab/agent-exchange precedent): recording definitions, leases
   and evidence is claim-free for any explicit TenantContext member;
   authorization wiring belongs to app composition, not the storage
   layer.
10. **No app-layer UX** — no routes, screens or MCP surface ship with
    this module; app composition owns them.
11. **The full repository suite is deliberately NOT run by this
    worker** — the TL owns the integration battery (the W135
    precedent).

## Test inventory (62 proofs, all green)

Integration (42, embedded PGlite, env pinned before imports,
`runMigrations`, `closeDb`; the harness NEVER opens a transaction):
registerEnvironmentDefinition (retained shape with isolation literals,
defKey reuse refused, newest-first kind-filtered listing) · the W136
acquisition gates (missing/non-ACTIVE plans uniform, off-plan runs,
retired definitions refuse while existing leases continue, unserved
kind + unsupported capability refused explicitly) · the full lease
lifecycle over the REAL W136 run (acquire with the resolved adapter,
prepare tenant+subject isolated with the opaque credential handed
verbatim, artifact handoff + evidence with literal redaction, the
durable checkpoint naming covered evidence, the human takeover with
the opaque W009 ref + hand-back, heartbeat renewal, lost → FRESH
session recovery from the checkpoint, the clean release, the full
filtered evidence timeline) · persistence where required
(checkpoint_required, session-checkpoint recovery) · the state machine
(prepare exactly once, the takeover/handback legal shape, heartbeats
only live, recovery only lost + once per loss, terminal freeze, the
storage-guard mirror) · cancellation (live, human-held, lost) ·
artifacts/evidence (both directions + manifest filters, the
verification triad + capture-kind filters, the servable postures,
storage-level append-only on all four evidence tables) · the
vendor-removal clause (identical domain outcomes on both vendor paths,
reads after removal + prepare/recover refused + cancellation never
blocked, re-registration restores acquisition) · the honest-descriptor
law + vendor-path failures (unhealthy vendor refused, open failure
stamps failed, resume failure stamps failed, the explicit failure
report) · the read surface (lease filters, event-tail filters +
limit) · two-tenant isolation (independent state, structurally
tenant-scoped session profiles).

Unit (20, pure — no database): `fabricLeaseTransitionProblem` (every
legal move, every illegal move with deterministic reasons, nothing out
of terminal, the storage-guard vocabulary mirror) · definition
validation (normalization, grammars/vocabularies refused) · acquire
validation (defaults, uuid refs, window bounds) ·
lifecycle/evidence/checkpoint/query validation (takeover reason +
uuid authority ref, artifact ref/kind/digest bounds, the frozen capture
vocabulary + verification triad, cursor bounds + covered-ref dedupe,
filter vocabularies + limit bounds) · adapter legality per catalog path
(workspace/browser/remote-sandbox honest descriptors, the unreachable
vendor reported honestly, the remote wire protocol with NO credential
material) · vendor-removal neutrality at unit level (no vendor name in
any adapter-produced session, tenant-scoped profile keys on every
path).

## Gates (run from the worktree root, exact commands and outputs)

Run by this finisher TWICE at the same content (once on the banked
tip f9ac1c8 before the notes existed, once with the notes in place —
identical results; the .md touches nothing the gates count):

- `timeout 300 bun run typecheck` — exit 0, zero errors
- `timeout 120 bun run arch` — exit 0, "architecture check passed —
  module files: 773, app/mcp files: 337, tables checked: 284"
- `timeout 240 bun run lint` — exit 0, zero errors
- `timeout 590 bunx vitest run src/modules/execution-fabric` — exit 0,
  2 files, **62/62 passed** (42 service + 20 unit), 0 unhandled
  errors, ~8.3s total (service ~6.1s, unit ~0.02s)

The full repository suite is deliberately NOT run — the TL owns the
integration battery. All W137 commits live on
`work/w137-execution-env` (dfcf161 → 67505a4 → 7d270fb → 378e2a4 →
ecb0476 → daee371 → f9ac1c8 → this note's commit); pushed to origin by
this finisher.

---

## Wave C integration pass (2026-10-08, task WC-INT on work/wc-integration)

This section is APPENDED by the integration-pass finisher (append-only;
the record above is history). It records what THIS pass closed against
the honest-limitations register, following the W136-INT precedent (the
dated append in agent-exchange WORK-NOTES, commits 45c829a → d5a8934 →
f226654 on work/w136-integration).

**Limitation #4 — CLOSED.** The deferred integration-tier registrations
for the six tables (`environment_definitions`, `fabric_leases`,
`fabric_lease_events`, `fabric_lease_artifacts`, `fabric_lease_evidence`,
`fabric_lease_checkpoints`) are delivered:

1. **Tenant-isolation sweep** — `tests/tenant-isolation/execution-fabric-sweep.test.ts`
   (manifest v10 → v11): a REAL two-tenant service proof in the
   WB2/W136 house style. Tenant A builds fabric state through the public
   contract (an immutable environment definition; a lease acquired and
   prepared LIVE over a REAL W136 plan/run chain — goal → plan → agent
   execution → recorded run, all through the consumed seams; the human
   takeover + explicit hand-back; the artifact/evidence/checkpoint
   tails); tenant B sees none of it — empty-list invisibility on
   `listEnvironmentDefinitions` / `listFabricLeases` and the lease-scoped
   evidence lists, uniform `definition_not_found` / `lease_not_found` on
   the read, the one-way retirement, every lifecycle transition and
   every append (foreign ≡ missing), the mapped
   `exchange_plan_not_found` / `execution_run_not_found` composition
   refusals (B cannot even acquire over A's plan or run — the
   stolen-body precedent), and the same defKey + lease shape coexisting
   per tenant with fully isolated evidence tails.
2. **Discoverability registration** — the module joined
   `src/modules/journey-proof/discoverability.ts` as a platform
   instrument (domain infrastructure with a delivered service + six
   tables, no user-facing routes yet; it leaves the instrument list when
   W139/W140 land the composition surfaces — the meetings/cellular
   precedent). The e2e instrument-list pin moved 24 → 26 declared
   harnesses.
3. **Health census** — `EXPECTED_TABLE_CENSUS` 287 → 298 with the six
   table names added to `EXPECTED_TABLE_NAMES`, verified against the
   health suite's fresh fully-migrated embedded db (the census test
   re-migrates and asserts).
4. **Schema-reconciliation pins** — 144 → 146 applied / 147 → 149
   discovered / 147 → 149 skipped (`execution-fabric/001`, the six-table
   first migration).
5. **Schema-boundary sweep — no allowlist additions required**: every new
   UNIQUE constraint carries tenant_id ((tenant_id, def_key) on
   environment_definitions), there are no FKs at all (opaque forward
   references are the house discipline), and the tables carry NOT NULL
   uuid tenant_id — the sweep passed unchanged.

**Honest new table counts at the pass tip:** the arch gate reads
**780 module files / 337 app/mcp files / 289 tables checked** on the
integrated branch (the module's own six tables moved the count 278 → 284
pre-merge; the W138 merge's five complete 284 → 289); the health census
287 → 298; the schema-reconciliation pins 144/147/147 → 146/149/149.

**Still open after this pass** (unchanged from the register above): #1
(the local-container adapter is a deterministic simulation), #2 (the
browser + remote-sandbox adapters run on fake transports — real
playwright/E2B evaluation at composition/W139), #3 (the FOR UPDATE
staleness re-checks not concurrently provable on single-connection
PGlite), #5 (the W136 run gate bounded to the plan's first 500 runs),
#6 (the in-memory adapter registry), #7 (lease expiry detection-driven,
not swept), #8 (the frozen 'local' kind has no serving adapter), #9 (no
authority-claim gating), #10 (no app-layer UX — W139/W140), and #11
(the TL-owned full-repository battery; this pass ran the four gates plus
the tenant-isolation directory, all green).

**Pass gates (worktree /home/z/aurum-wcint, branch work/wc-integration,
base e53ab66 — the post-W137/W138 merge point off main 256d5bb; run at
the tip 1227aa2 and re-run with these notes in place, identical):**
`timeout 300 bun run typecheck` → exit 0, zero errors · `timeout 120
bun run arch` → exit 0, "architecture check passed — module files: 780,
app/mcp files: 337, tables checked: 289" · `timeout 240 bun run lint` →
exit 0, zero errors · `timeout 590 bunx vitest run tests/tenant-isolation`
→ exit 0, 37 files / **242/242 tests green** (this module's sweep
included), duration ~229s.

**Pass commits (work/wc-integration):** 3a95814 (the sweep + manifest
v11) → c95e6e5 (discoverability + the e2e pin) → b25cfcc (the census +
schema pins) → 1227aa2 (the W138 errors.ts cosmetic fix — recorded in
the emergent-roles notes) → this note's commit.
