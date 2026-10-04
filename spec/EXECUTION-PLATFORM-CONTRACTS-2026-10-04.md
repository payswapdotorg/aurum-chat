# Aurum Execution Platform Contracts — 2026-10-04 (W131)

Status: FROZEN CONTRACT DELIVERY (additive to Architecture v2.1 — lock 2.1 untouched)

This is the W131 study record and contract freeze. It converts the patterns
of ZCode, OpenMuse, Meta Muse, Epoch and Flauz into **Aurum-owned, frozen
contracts** (`src/modules/execution/contracts.ts`, exported through
`src/modules/execution/contract.ts`). Nothing is copied from any reference:
external projects are design references only, and no execution vendor is an
architectural authority. The frozen types are the stable interface for
W137 (Execution Environment / Agent Computer Fabric), W139 (Cross-Platform
Product) and the W135 Lab's execution evaluation surface.

## Method

Each reference was cloned read-only and studied along five dimensions:
(a) execution environments/sandboxes, (b) task/worker durability and
recovery, (c) browser/computer session control, (d) human
takeover/observability, (e) shared client contracts and cross-device
continuity. Every pattern is recorded as ADOPTED (with the concrete
contract it shapes) or REJECTED (with the reason). The study was timeboxed:
contracts matter more than exhaustive reading.

## ZCode — zai-org/zcode (studied from the live repository)

A multi-client AI coding workspace (desktop, web, terminal CLI) with a
shared contracts package, provider registry/resolver layers, a separate
long-running agent runtime, background bash/task controls, a CUA
permission broker, and a browser-use surface with typed backend discovery.

- ADOPTED (a): typed **capability discovery** — backends appear in
  discovery only after a completed handshake, with a **generation
  counter** on connection identity (old generations never drift into new
  connections) → shapes `ExecutionEnvironmentDescriptor` /
  `ExecutionAdapterHealth` and the honest-descriptor law (an adapter that
  cannot serve a capability declares `supported: false`).
- ADOPTED (b): the background-task status vocabulary, in particular the
  **`lost`** state (worker death is distinguishable from failure) and
  **`killed`** (cancellation) → folded into `TaskWorkerRunStatus`
  (`lost` = lease death, parked for recovery; `cancelling`/`cancelled` =
  the cooperative cancellation path).
- ADOPTED (d): discovery metadata carries **non-sensitive strings only** —
  credentials never ride along with capability discovery → baked into
  `ExecutionAdapterVendorMetadata` and `ExecutionAdapterCapability.limits`.
- ADOPTED (e): one shared client-contract package consumed by all clients
  (desktop/web/CLI parity) → the Group 4 shared client/runtime contract
  surface (all platforms consume the same semantic contracts).
- REJECTED: ZCode's product-specific runtime architecture (its
  workspace/terminal/IDE product shapes) — Aurum is not an IDE; the
  execution module freezes only the provider-neutral patterns above.

## OpenMuse — CopilotKit/openmuse (studied from the live repository)

An MIT-licensed personal-agent application: Expo/RN web/mobile client,
durable task plans with pause/resume/cancel/retry and approvals, SQL
leases recovering interrupted work, a dedicated browser worker with
persistent profiles, an optional Linux computer (Docker or E2B desktop),
a takeover console, and saved receipts.

- ADOPTED (a): the computer model as **capability-level kinds with
  vendor behind them** (`provider: docker | e2b-desktop` at the product
  layer) → generalized into `ExecutionEnvironmentKind` ('local' |
  'browser' | 'workspace' | 'remote-sandbox') with the vendor as metadata
  only; its `network: disabled | enabled` declaration became
  `SessionIsolationProperties.networkEgress` ('disabled' | 'restricted' |
  'open').
- ADOPTED (b): **SQL leases** (leaseId, leaseUntil, heartbeat) with the
  LostLease semantics ("paused, cancelled or taken over by another
  worker") → `TaskWorkerLease` + the `lost` status + 'recovering'; its
  checkpoint-patch discipline → `TaskWorkerCheckpoint` (opaque cursor,
  covered evidence refs).
- ADOPTED (c): the **dedicated browser worker** with bounded sessions
  (maxSessions, idle timeout) and persistent per-profile state → the
  disposable-session / persistent-profile split in
  `ExecutionEnvironmentSession` (`SessionIsolationProperties.profileScope`
  + `SessionPersistenceGuarantees`).
- ADOPTED (d): **"Take control" opens the same browser session** — the
  human joins the identical session the automation drove →
  `ComputerSessionTakeoverPoint` (control mode `human`, resume by
  explicit hand-back only) and `TaskWorkerTakeover.holder: 'human'`.
- ADOPTED (e): honest receipts — "report failure, timeout, interruption
  and truncation honestly from the receipt", distinct operationIds, no
  automatic retry of interrupted work → the append-only
  `TaskWorkerEvent` evidence/artifact events with digests, and
  `TaskWorkerResumeSemantics.replay: 'never-reexecute-covered'`.
- REJECTED: OpenMuse's external intelligence service as an authority —
  Aurum's PostgreSQL, tenant, evidence, policy and agent authorities
  remain the source of truth (the reference review's standing rule); its
  single-owner personal-agent tenancy model — Aurum is multi-tenant with
  `tenantIsolated: true` baked into every session shape.

## Meta Muse (no reachable repository — relied on the reference-review doc)

No public Meta repository named "Meta Muse" was reachable from this
sandbox. Per the work-order instruction, this study relies on the
recorded findings of `spec/EXECUTION-PLATFORM-REFERENCE-REVIEW-2026-10-04.md`
(Meta's public Muse materials): a persistent secure VM and browser
computer, conversational interaction, explicit approvals, audit trail,
background goals, connectors, generated tools, multi-agent fan-out,
computer use, user takeover, and replayable/auditable work. Only the
observable product patterns were adopted; private implementation details
are not known and are not represented as such anywhere in this delivery.

- ADOPTED (a): **persistent execution environments** (the VM that stays)
  → `SessionPersistenceGuarantees.survivesRestart` and the 'workspace'
  environment kind.
- ADOPTED (b): **background goal work** — long-running work that keeps
  going across interactions → the durable `TaskWorkerRun` record as the
  resume truth (sessions are disposable).
- ADOPTED (d): **explicit approvals and replayable/auditable work** —
  every consequential step routes through approval, and the work is
  replayable afterwards → `ConsequentialActionBoundary` (consequential
  actions route through the existing action authority by opaque id) and
  the append-only event/evidence vocabulary.
- REJECTED: any claim about Meta's private implementation — nothing
  beyond the observable product patterns above is asserted.

## Epoch — payswapdotorg/Epoch (studied from the live repository)

The strongest first-party reference for cross-platform productization:
Web canonical, Desktop Tauri 2, Mobile Expo/React Native; a frozen
application-gateway contract surface (self-contained `index.d.ts`,
parity type-identity assertions, SHA-256 manifest anchors); a
read-projection Experience Graph that is never authority; an offline
queue of pending projections of user intent with five named negatives.

- ADOPTED (client topology): **Web canonical, Desktop power client,
  Mobile field client, all sharing semantic contracts** → the frozen
  cross-platform conclusion: `ClientPlatformKind` = 'web' | 'desktop' |
  'mobile' with `CANONICAL_CLIENT_PLATFORM = 'web'`; server-side state is
  authoritative, clients are projections.
- ADOPTED (e): the **application-gateway envelope discipline** — session
  refs, correlation/causation, idempotency keys, replay markers →
  `ClientSessionRef`, `SharedClientSession`, `CompanyStateProjectionRef`
  (revision + digest bound), and `TaskWorkerRun.correlationId/causationId`.
- ADOPTED (offline): the **five named offline-admission negatives** — a
  local approval is never authority; local semantic mutation is rejected;
  local identity minting is rejected; local digest forgery is rejected;
  an idempotency key is required → `ClientOfflineAdmissionNegative` and
  `ClientQueuedIntent.intentClass: 'pending-projection'` (a queued intent
  is a projection of intent only; the server decides).
- ADOPTED (authority encoding): **make the violation inexpressible** —
  Epoch encodes authority splits structurally (strict objects reject
  embedded kernel state; single-member resolution vocabularies) → the
  literal-baked laws throughout the frozen contracts
  (`tenantIsolated: true`, `requiresActionGateway: true`,
  `authorityTransfer: 'none'`, `resolution: 'server-state-wins'`).
- REJECTED: Epoch's three-renderer spatial-world surface and its
  experience-compiler machinery — out of scope for W131; only the
  client/gateway/continuity patterns above were converted.

## Flauz — payswapdotorg/Flauz (studied from the live repository)

A Code OSS product line ("Code OSS + Agent OS + Workspace OS, with
browser and environment dimensions") whose Engineering Lab handoff
defines the Lab posture this study must preserve: the Lab is a
learning/optimization layer, never a second execution authority; it
recommends, existing systems authorize and execute.

- ADOPTED (posture): **the Lab recommends; execution stays with the
  existing authorities** → the module law itself: the execution
  environment is an adapter, never an authority; the W135 Lab evaluates
  against the frozen capability vocabulary (`ExecutionAdapterCapability`)
  without ever becoming an execution authority.
- ADOPTED (a): the **workspace/environment dimension as a first-class
  product axis** (not a bolt-on) → the 'workspace' environment kind with
  `SessionPersistenceGuarantees.persistentScope` (e.g. '/workspace').
- ADOPTED (contracts): Flauz's **versioned contract families**
  (WorkloadProfile, LabRun, EvaluationReport, CalibrationRecord) → the
  versioned contract-surface convention applied here
  (`EXECUTION_CONTRACT_VERSION`, additive-only from here on).
- REJECTED: the Code OSS substrate itself (extension host, editor
  product, remote-development machinery) — Aurum is not an IDE; only the
  Lab posture and workspace dimension above were converted.

## The frozen contracts (what each group delivers)

1. **ExecutionEnvironment adapter contract** — `ExecutionEnvironmentKind`
   ('local' | 'browser' | 'workspace' | 'remote-sandbox'),
   `ExecutionAdapterCapability` (capability domains, declarations never
   permissions), `ExecutionAdapterVendorMetadata` (vendor identity as
   metadata, the only place a vendor name may appear),
   `ExecutionEnvironmentDescriptor`, `SessionIsolationProperties`
   (`tenantIsolated: true`, `credentialHandling: 'opaque-ref-only'`),
   `SessionPersistenceGuarantees`, `SessionArtifactHandoff` (opaque refs,
   digest-verified), `ExecutionEnvironmentSession` (disposable; phases),
   and the `ExecutionAdapter` capability-shape (probe/open/resume/close —
   the signatures W137 implements).
2. **TaskWorker durability contract** — `TaskWorkerRunStatus` (queued |
   running | suspended | awaiting_approval | cancelling | recovering |
   lost | cancelled | succeeded | failed), `TaskWorkerLease`,
   `TaskWorkerCheckpoint` (opaque cursor + covered evidence),
   `TaskWorkerResumeSemantics` (`resumeFrom: 'checkpoint'`, `replay:
   'never-reexecute-covered'`, `freshSession: true`),
   `TaskWorkerTakeover` (`holder: 'human'`), `TaskWorkerRun`, and the
   append-only `TaskWorkerEvent` union (progress | evidence | artifact |
   status | takeover | recovery | cancellation).
3. **Browser/Computer session contract** — `ComputerSessionPhase`,
   `ComputerSessionControlMode` (automation | human |
   automation-yielding), `ComputerSessionTakeoverPoint`
   (`resumePolicy: 'explicit-handback-only'`), `SessionObservationCapture`
   (`redaction: 'applied'`, opaque artifact refs), and
   `ConsequentialActionBoundary` (`requiresActionGateway: true`,
   `sessionLocalExecution: 'never-for-consequential'`,
   `authorityActionRef` opaque) — the action authority is referenced by
   opaque id and never duplicated.
4. **Shared client/runtime contracts** — `ClientPlatformKind` (web
   canonical, desktop Tauri 2, mobile Expo/RN), `ClientSessionRef`,
   `SharedClientSession`, `CompanyStateProjectionRef` (revision + digest
   bound; embedding the underlying object is inexpressible),
   `ClientRealtimeSubscription`, `ClientDegradationState` +
   `ClientDegradedBehavior`, `ClientOfflineAdmissionNegative` (the five
   named negatives), `ClientQueuedIntent` (projection-only). Server-side
   state is authoritative; clients are projections.
5. **Cross-device continuity contract** — `ContinuityAnchor` (a unit of
   active work that moves across devices; projection refs only),
   `ContinuityHandoff` (`reprojection: 'from-server-state'`,
   `authorityTransfer: 'none'`, `payload: 'projection-refs-only'`), and
   `ContinuityConflict` with the single-member resolution vocabulary
   `ContinuityConflictResolution = 'server-state-wins'` (clients never
   create competing semantic state — a stale client projection is
   discarded on resync).

## Adapter boundaries and authority rules (the law, encoded)

- **Environments are adapters, never authorities.** Capabilities are
  declarations the fabric verifies; permissions are decided by the
  actions module (W009 matrix) and tenant policy. No environment type
  carries a permission.
- **Vendor identity is metadata, not a type-system citizen.** There is no
  'e2b', 'playwright', 'docker' or 'livekit' type anywhere in the frozen
  contracts; adding one is a semantic change requiring TL integration
  approval. A compile test asserts the vocabularies stay vendor-neutral.
- **The action authority is referenced, never duplicated.**
  `ConsequentialActionBoundary.authorityActionRef` is an opaque id; the
  boundary literals make session-local consequential execution
  inexpressible.
- **Sessions are disposable; runs are the durable truth.** Worker/session
  death parks a run 'lost' and never loses it (lock 36); covered work is
  never re-executed on resume.
- **Clients are projections.** Offline queues hold pending projections of
  user intent only; local approvals are never authority; company-state
  references are revision- and digest-bound; the continuity conflict
  resolution vocabulary has exactly one member: server-state-wins.

## Cross-platform contract decisions

Aurum services → application/experience gateway → shared client/runtime
contracts → Web (canonical) / Desktop (Tauri 2) / Mobile (Expo/RN). The
frozen Group 4 + Group 5 vocabulary is the semantic surface all three
clients consume; W139 builds the clients against it, and no client ever
owns semantic company truth, provider credentials, action authority or
execution outcome truth.

## What this unblocks

- **W137 (Execution Environment / Agent Computer Fabric):** implements
  the `ExecutionAdapter` capability-shape behind the frozen kinds; local
  fixture, Playwright/Chromium and E2B-class adapters are ADAPTERS, never
  authorities; the fabric verifies descriptors honestly
  (`supported: false` fails explicitly).
- **W139 (Cross-Platform Product):** builds the three clients against the
  frozen Group 4/5 vocabulary — session refs, projection refs, realtime
  subscription shapes, degradation states, queued intents, continuity
  anchors and handoffs.
- **W135 (Contextual Organizational Lab):** the Lab's execution
  evaluation surface reads the capability vocabulary
  (`ExecutionAdapterCapability`) — the Lab recommends against it, never
  executes through it, and never becomes an execution authority.

## Deviations

NONE. The delivery is additive-only: one new spec file (this one), the
new `src/modules/execution/` module (types only — no service, no runtime
logic, no migrations) and its compile-level contract tests. No existing
file was modified; ARCHITECTURE-LOCK.md v2.1 is untouched.
