# W139 — Cross-Platform Aurum Product · WORK NOTES

Work item: `spec/work-items/WORK-ITEM-CATALOG.md` §W139 (declared dependencies:
W131-W137, W057, W060, W076 — the runtime seam set below, all consumed
read-only or type-only, none modified). Design contract:
`spec/ARCHITECTURE-CHANGE-REQUEST-0003-AGENT-BODY-LAB-CROSS-PLATFORM.md`
(the Cross-platform rule: Web canonical, Desktop the power client, Mobile
the field client), the frozen W131 Group 4/5 client/continuity
vocabularies in `spec/EXECUTION-PLATFORM-CONTRACTS-2026-10-04.md`
(`ClientPlatformKind`, `ClientSessionState`,
`CompanyStateProjectionRef`, `ContinuityHandoffSemantics`,
`ContinuityConflictResolution = 'server-state-wins'` — consumed TYPE-ONLY
through `@/modules/execution/contract`), W057 (the product-shell semantics
this module mirrors at contract level), W060/W076 (the chat surface and
the real-browser conformance the canonical web renderer owns — app
composition, not this module) and ADR-0001 (tenancy).

> "Productize Aurum with Web as canonical, Desktop as Tauri 2 power client
>  and Mobile as Expo/React Native field client, unless an
>  architecture-reviewed replacement is proven better."
> Acceptance: "same authoritative conversation/company state across clients;
>  background work is inspectable everywhere; platform-native capabilities
>  are adapters; cross-device handoff is evidenced."

Delivery history (honest): no W139-D1/D2 entries exist in the shared
worklog (the last entry is Task ID 21) — the history was recovered from
the branch's git log, the W138-D3 precedent. D1/D2 delivered in three
commits — 8011ca9 (layers 1-3: types/errors/validation/migration, the
three adapter doubles, service + contract — arch 788/337/292), 4fd7637
(unit proofs 21/21), 5495664 (service proofs 28/28 + THE
navigation_state ROUND-TRIP REPAIR: the D1 spine INSERT stored the whole
working-context JSON in the `navigation_state` column, which the
navigation mapper cannot round-trip — the repair stores exactly the
navigation shape via `navigationJsonOf`, the spine's focus/draft living
in their own columns; a documented judgment call against freezing the
context twice). D3 (this delivery) re-ran every gate at the tip — all
green on the FIRST run, zero repairs needed (the W136/W137 precedent:
the deadline-window delivery was intact) — and wrote these notes, the
module's only remaining deliverable.

## What was built (file map)

Everything lives in `src/modules/cross-platform/**` — nothing else in
the repository was touched.

| File | Role |
| --- | --- |
| `types.ts` (753L) | The domain shapes: `ClientSession` (the W131 `SharedClientSession` persisted — server-issued identity, DERIVED state: revoked > expired > active, never a stored string), the client-agnostic projections (`ConversationStateProjection`, `CompanyOverviewProjection`, `ProductShellModel` — each bound to a content-addressed `CompanyStateProjectionRef`), `BackgroundWorkItem` (normalized `phase` + the seam's native status VERBATIM as `seamStatus`), the vendor-neutral `PlatformAdapter` SPI (`probe`/`invoke`, five capability domains, `PlatformVendorMetadata` the ONLY place a vendor/product name may appear), the handoff family (`HandoffWorkingContext` frozen at open; `HandoffSession` the spine with `anchorRevision`; `HandoffEvidence` the append-only trail; `HandoffResumption` carrying the frozen W131 semantics literals + the re-projection + the recorded conflict), and the W057 shell mirror (`ProductAreaId`, the fifteen tower slugs consumed in validation, `ShellNavigationState`). The frozen W131 vocabulary and the conversations seam's `Conversation`/`Message` read shapes are re-exported TYPE-ONLY through this file — the contract's single re-export point. |
| `migrations/001-cross-platform.sql` (232L) | Three tenant-scoped tables with four load-bearing laws. `client_sessions` (law 3): identity columns immutable via the `client_sessions_identity_guard` trigger (platform/principal/device label/expiresAt frozen; UPDATE legal only for last_seen/revocation columns; revocation one-way and terminal with the acting principal required; DELETE/TRUNCATE rejected — a revoked session is retained evidence). `handoff_sessions` (law 2): the working context immutable from creation via `handoff_sessions_context_guard`; only tracking columns (active session, open-on platform, last-active, anchor revision) and the one-way open → closed lifecycle move, the close stamping `closed_at`/`closed_by` exactly once; the focus-seam CHECK pair (present iff background-work); a PARTIAL UNIQUE index making ONE open handoff per (tenant, focus_seam, focus_ref) structural on the background-work path; DELETE/TRUNCATE rejected. `handoff_evidence` (law 1): append-only outright — the `handoff_evidence_append_only` trigger rejects UPDATE/DELETE/TRUNCATE even for callers bypassing the service; the conflict-discipline CHECK (resolution + discarded revision exist exactly on `conflict-discarded` events); the evidence-kind/platform/status vocabularies CHECK-mirrored. Cross-module references are opaque, deliberately NOT foreign keys (the house discipline). |
| `errors.ts` (94L) | 21 typed codes (the file's vocabulary table, header consistent with the union): the input family (`invalid_context` … `invalid_capability_input`), the uniform not-found family (`session_not_found`, `handoff_not_found`, `conversation_not_found`, `mission_not_found`, `work_item_not_found`, `tenant_not_found` — cross-tenant access indistinguishable from missing, no existence leak), the session-governance family (`session_not_active`, `session_already_revoked`, `session_principal_mismatch`), the handoff family (`handoff_not_open`, `handoff_already_closed`, `handoff_same_session`), and the adapter family (`adapter_not_found` (the platform-removal refusal), `adapter_already_registered`, `capability_not_supported` (the honest-descriptor refusal), `capability_invocation_failed` (the mapped vendor throw)). |
| `validation.ts` (847L) | Pure guards (no database, no clock, no TenantContext reads — the org-lab discipline): the W131 client vocabulary and this module's closed unions mirrored and compiler-pinned with `satisfies` (platform kinds, session states, seams, phases, focus kinds, evidence kinds, capability domains, product areas, the fifteen W033/W057 tower slugs); **`canonicalJson` + `digestOf` — the projection content-addressing**: recursively key-sorted JSON serialization (undefined/functions/non-finite numbers rejected; array order IS semantic) and the `sha256:`-prefixed hex digest — exported through the contract so ANY client kind can verify a served projection against its ref; and every input/query validator (session registration with the structural ISO check — future-ness lives in the service, which owns the clock; the working-context rules: `focusSeam` required IFF background-work, draft ≤ 20000, navigation must be a product area with an optional tower slug; the 256 KiB canonicalized capability-input bound; limit bounds everywhere). |
| `adapters/web-adapter.ts` (115L) | The WEB adapter double — a DETERMINISTIC SIMULATION of the canonical client's native surface (no browser, no Notification API, no getUserMedia, no network): notifications/file-access/share/camera supported, WINDOW MANAGEMENT honestly `supported: false` (a browser tab does not own its window). Vendor identity is METADATA ('aurum-web-sim'); scriptable `invokeFailures` make the vendor path throw; a read-only invocation/probe log serves the proofs. |
| `adapters/desktop-adapter.ts` (113L) | The DESKTOP adapter double — the POWER client's surface, same discipline (no Tauri 2 runtime, no OS notification center, no filesystem touch): notifications/file-access/window-management/camera supported, SHARE honestly refused (no OS share sheet on the desktop path). 'Tauri 2' appears only in vendor METADATA strings. |
| `adapters/mobile-adapter.ts` (115L) | The MOBILE adapter double — the FIELD client's surface, same discipline (no Expo/React Native runtime, no push service, no camera hardware): notifications/share/camera supported, WINDOW MANAGEMENT honestly refused (a phone app never owns its window); file access declared 'restricted' (document picker only) via the non-sensitive note — the W131 limits discipline. |
| `service.ts` (1567L) | The twenty-one domain operations (see contract.ts). TRANSACTION DISCIPLINE (the W134 law, binding): every cross-module read (all seven seams) and every evidence gate runs on the base connection BEFORE the transaction; each mutation keeps its spine update + evidence appends atomic in ONE transaction touching only this module's tables; the one-way transitions (revoke, handoff moves, resumption, close) re-check legality under a FOR UPDATE row lock (the staleness re-check). **Adapter I/O (probe/invoke) is ALWAYS outside every transaction** — capability operations open no transaction at all. The in-memory adapter registry: one registration per platform kind, probed-at-registration, the removal op touching no table. The frozen seam-status → phase mapping tables; `computeFocusProjection` (the mechanical 'from-server-state' reprojection); the W057 shell model (seven areas in plan order with the canonical web hrefs, 25 command entries = 7 areas + 15 tower surfaces + 3 entry points, the notification entry over the REAL notifications seam, the context drawer, the tenant/workspace switcher over the organizations seam). |
| `contract.ts` (234L) | The ONLY public surface (rule (b)): the 21 domain operations (4 client-session, 2 state-projection, 2 background-work, 5 adapter/capability, 7 handoff, 1 shell), `CrossPlatformError` + codes, the guards/vocabularies/limits, `canonicalJson`/`digestOf` (the client-side verification surface), the domain types, and the three adapter factories. NO domain-mutation primitive exists on the surface (test-locked by the export tripwire). |
| `tests/cross-platform-unit.test.ts` (331L) | 21 pure proofs over validation, the canonical serialization/digest and the three adapter doubles (no database). |
| `tests/cross-platform-service.test.ts` (1699L) | 28 embedded-PGlite integration proofs over the REAL service with REAL cross-module fixtures through nine owning contracts (organizations W001, conversations W029, notifications W031, goals W008, missions W011, agents W021, actions W009, agent-exchange W136, execution-fabric W137 — the harness NEVER opens its own transaction; the storage-trigger probes are the deliberate direct-SQL exception). |

## The acceptance, test-locked (all four clauses)

- **SAME AUTHORITATIVE CONVERSATION/COMPANY STATE ACROSS CLIENTS** —
  web, desktop and mobile client sessions of the same tenant/principal
  read BYTE-IDENTICAL projections, toEqual-proven for every read
  surface: `readConversationState` ("serves byte-identical projections
  to web, desktop and mobile sessions"), `readCompanyOverview`,
  `listBackgroundWork` AND `getBackgroundWorkItem`, and `readShellModel`
  — the reads are CLIENT-AGNOSTIC BY CONSTRUCTION (no platform parameter
  exists on any state read; the export tripwire pins the surface).
  The projections are CONTENT-ADDRESSED: any client kind can recompute
  the digest from the served projection alone
  (`cp.digestOf` over the documented canonical payload — locked: the
  recomputed digest equals the served `projectionRef.digest`; a
  different message window is a different digest — the window is part
  of the content). Revision semantics are explicit: conversation
  revision = the thread's message count (monotonic under appends);
  company-overview revision = served goal + mission count; the goals'
  and missions' own fields mirror VERBATIM (W008/W011 records). An
  empty tenant reads an empty overview — no fabricated state.
- **BACKGROUND WORK IS INSPECTABLE EVERYWHERE** — the typed feed over
  the three seams with IDENTICAL semantics per client kind: the feed
  and the per-item reads are toEqual-identical through web, desktop and
  mobile sessions; the seven normalized phases map the seams' native
  statuses (missions: active → in-flight, completed → succeeded,
  abandoned → cancelled; runs: awaiting_approval → awaiting-decision,
  queued → in-flight, succeeded/failed, refused → failed, cancelled;
  leases: preparing/live → in-flight, suspended, lost, released →
  succeeded, cancelled, failed) while `seamStatus` preserves the native
  vocabulary VERBATIM — proven over REAL W011 missions in all three
  statuses, a REAL W136 plan with queued/succeeded/awaiting_approval
  runs over REAL W021 executions, and REAL W137 leases
  (preparing/live/cancelled over those runs through the deterministic
  local-container adapter); the exact sort invariant (latest activity
  first, workId tie-break); seam/phase filters with the limit applying
  after; `work_item_not_found` uniform (missing ≡ foreign ≡ off-window
  on every seam); an empty tenant sees the empty feed everywhere.
- **PLATFORM-NATIVE CAPABILITIES ARE ADAPTERS** — the vendor-neutral
  SPI behind the deterministic doubles: ONE registration per platform
  kind (a second refuses `adapter_already_registered`; the list is
  probed live, never assumed); the honest-descriptor refusals are
  explicit (`capability_not_supported`: web window-management, desktop
  share, mobile window-management — the unit suite pins each double's
  surface); a vendor-path throw maps to the typed
  `capability_invocation_failed` — never a fabricated receipt; and THE
  REMOVAL-NEUTRALITY PROOF (the W137 pattern): with EVERY adapter
  unregistered, all seven domain read families (conversation state,
  company overview, background work, shell model, handoff sessions,
  client sessions, evidence trails) are byte-identical while
  probe/invoke refuse `adapter_not_found` typed, and re-registration
  restores serving through the same frozen SPI.
- **CROSS-DEVICE HANDOFF IS EVIDENCED** — the full evidenced lifecycle
  over a REAL conversations seam: OPEN (the working context frozen
  VERBATIM — normalized shape — plus 'session-opened' evidence bound to
  the CURRENT server projection: revision + digest), HANDOFF to another
  device (verbatim context, 'handoff-recorded' with from/to platforms,
  the receiving session's last-seen stamp moves), RESUME with a FRESH
  revision (the EXACT context restored, re-projected from current
  server state, the frozen W131 semantics literals verbatim —
  reprojection 'from-server-state', authorityTransfer 'none', payload
  'projection-refs-only' — conflict null), RESUME with a STALE revision
  after the server state moved (one more recorded message): the stale
  client projection is DISCARDED and the discard recorded
  ('conflict-discarded', resolution 'server-state-wins',
  discardedClientRevision retained, anchorRevision bumps — the frozen
  single-member vocabulary), CLOSE (one-way; 'session-closed' evidence).
  The trail is append-only and the context immutable at the STORAGE
  level (UPDATE/DELETE/TRUNCATE on handoff_evidence, draft/focus_ref
  mutation on handoff_sessions, platform/device_label mutation and
  DELETE on client_sessions — all rejected by trigger probes);
  anchorRevision ALWAYS equals the evidence count; the trail reads in
  timeline order with kind filters. The mission-focus path re-projects
  from current server state too (a revised mission's version 2 makes
  the client's revision 1 stale). The structural violations refuse
  typed: same-session handoffs, foreign-principal sessions (both
  directions), unresolved focuses (the honest-focus gate), revoked and
  expired acting sessions.

## Design decisions & rulings honored

1. **THE PRODUCT DECISION, structurally: Web is the CANONICAL client,
   Desktop (Tauri 2) the POWER client, Mobile (Expo/React Native) the
   FIELD client — and Tauri/Expo are NEVER type-system citizens** (the
   W131 vendor-neutrality law applied to client platforms): vendor and
   product names appear ONLY in `PlatformVendorMetadata` on the
   adapter's descriptor; the unit suite pins `isPlatformKind('tauri')`
   === false and `isCapabilityDomain('expo-camera')` === false; every
   adapter-produced string is metadata.
2. **No second state authority.** Server-side state is authoritative;
   clients are projections (the frozen W131 conclusion). Every state
   read is a live composition over the owning seams' contracts at read
   time; this module persists ONLY client sessions and handoff
   evidence — three tables, no domain truth. The export tripwire locks
   the surface to the 21 semantic-core operations + the typed error +
   the pure validation/digest surface + the three adapter factories:
   no conversation/goal/mission/agent/execution/notification/tenant
   mutation primitive can even be imported from this contract.
3. **Client-agnostic BY CONSTRUCTION, not by testing discipline
   alone**: no state read takes a platform parameter. The platform kind
   of the asking session is recorded for journey/evidence purposes
   only (`open_on_platform`, the evidence rows' from/to platforms) and
   never participates in state computation — byte-identity across
   client kinds is the structural consequence, locked by the toEqual
   proofs.
4. **Content-addressed projections are client-verifiable.**
   `canonicalJson` + `digestOf` ride the PUBLIC contract surface so any
   client kind recomputes a served projection's digest — key order
   never decides a digest (unit-proven with structurally equal,
   differently ordered objects), array order is semantic, non-JSON
   values are rejected outright. The digest is the content address; the
   revision is the cheap change signal (conversation message count;
   served goal+mission count).
5. **Contract-level shell semantics, NO UI** (the module ruling,
   recorded here as the catalog asks): the W057 shell read model is a
   typed projection — seven areas in plan order with the CANONICAL WEB
   RENDERER's hrefs, 25 command-search entries (7 areas + the fifteen
   tower surfaces + the three entry points), the notification entry
   derived from the REAL notifications seam, the context drawer
   describing an optional focus's CURRENT server state, and the
   tenant/workspace switcher over the organizations seam (an
   unprovisioned tenant refuses `tenant_not_found` honestly — no
   fabricated switcher). The web app remains the canonical renderer of
   these semantics; desktop and mobile consume the SAME model.
6. **The ONE normalization layer over the seams' native status
   vocabularies**: the frozen phase mapping (ruling 3's cousin on the
   feed) — the phase is what every client kind renders identically;
   `seamStatus` preserves the seam's own vocabulary VERBATIM, never
   re-minted. An unmapped native status falls back to 'in-flight'
   honestly (the mapping tables are exhaustive over the current frozen
   vocabularies; a new seam status surfaces verbatim in `seamStatus`).
7. **Adapters are runtime wiring, NEVER domain state** (the W137
   ruling): register/unregister touch no table; ONE registration per
   platform kind keeps resolution deterministic (a second is a typed
   error, not a silent override); removal changes no domain contract
   (test-locked) and only the capability surface surfaces it; the
   registry is in-memory per-process.
8. **The honest-descriptor law, verbatim from W137**: descriptors are
   probed, never assumed; an unsupported domain is an EXPLICIT typed
   refusal; an adapter throw is mapped to the typed
   `capability_invocation_failed` (honest failure evidence — never a
   fabricated receipt); a declaration is NOT a permission (authorization
   stays with W009 and tenant policy); no credential value is
   expressible on the descriptor or request (non-sensitive strings and
   plain-JSON payloads only, bounded to 256 KiB canonicalized).
9. **Handoffs are EVIDENCE**: the working context is frozen at open
   (storage-enforced), moves VERBATIM between devices, restores EXACTLY
   on resumption — while the FOCUS is re-projected from CURRENT server
   state (the frozen W131 literals). A stale client projection is
   discarded and the discard itself is evidence — the frozen
   single-member resolution 'server-state-wins' (clients never win
   against server state). `anchorRevision` is the client's seen-cursor:
   it ALWAYS equals the evidence count (the spine bumps it inside the
   same transaction as every append).
10. **The honest-focus gate**: a handoff focus that does not resolve
    against CURRENT server state is refused at open
    (`conversation_not_found` / `mission_not_found` /
    `work_item_not_found`) — no handoff of a phantom focus; the SAME
    projection that gates the open binds the 'session-opened' evidence.
11. **A user's working context moves between their OWN devices only**
    (`session_principal_mismatch`, enforced on open, handoff and
    resume), and a handoff must MOVE (`handoff_same_session` — the
    receiving session must differ from the holding one). On the
    background-work path, ONE open handoff per work item per tenant is
    STRUCTURAL (the partial unique index); conversation and mission
    focuses are deliberately not unique — multiple concurrent working
    contexts on the same conversation/mission are legal.
12. **Client sessions are server-issued identity, never client-minted**:
    the service records them; `state` is DERIVED (revoked > expired >
    active — never a stored string that could drift); revocation is
    one-way and terminal (FOR UPDATE re-check; `session_already_revoked`
    on the sequential second call); a revoked or expired session can no
    longer ACT (`session_not_active` on open/handoff/resume); the
    acting session's last-seen stamp moves on every session-acting
    call.
13. **TRANSACTION DISCIPLINE (the W134 lesson, binding).** PGlite is
    single-connection: every cross-module read and evidence gate runs
    on the base connection BEFORE the mutation; each mutation is ONE
    transaction (spine update + evidence appends atomic) touching only
    this module's tables; the one-way transitions re-check legality
    under FOR UPDATE. Adapter I/O is OUTSIDE every transaction — the
    capability operations open no transaction at all.
14. **Deterministic orders (test-locked):** client sessions
    newest-issued first (issued_at DESC, id DESC); handoff sessions
    most-recently-active first (last_active_at DESC, id DESC); the
    evidence trail in timeline order (recorded_at ASC, id ASC —
    same-millisecond events order by id, the count/multiset proofs);
    the background-work feed by latest activity (updatedAt DESC,
    workId DESC tie-break); the shell areas in W057 plan order; command
    entries by declaration order.
15. **Principals and time are system-captured**: actors and revoked-by
    come from the explicit TenantContext; semantic timestamps come from
    the injectable clock — the suite pins it throughout (twelve pinned
    stamps; same-millisecond writes never decide what a proof shows).

## The seam consumption map (what this module reads, and where)

All cross-module imports target contracts only (rule (b), enforced by
the architecture gate; arch pass 790/337/292). Nothing is re-derived;
everything consumed is consumed verbatim.

| Seam (owner) | Contract symbols consumed | Where in `service.ts` | How the integration tests exercise it |
| --- | --- | --- | --- |
| execution contract (W131 frozen vocabularies) | `ClientPlatformKind`, `ClientSessionState`, `CompanyStateProjectionRef`, `ContinuityConflict`, `ContinuityHandoffSemantics` (all TYPE-ONLY) | types.ts (the domain shapes + re-exports), validation.ts (compiler-pinned mirrors with `satisfies`), the adapter doubles (platform kinds) | every test asserts against the frozen shapes; the unit suite pins the mirrored vocabularies; the resumption asserts the semantics literals VERBATIM |
| conversations (W029) | `getConversation`, `listMessages`, `ConversationsError`; type-only `Conversation`/`Message` | `readConversationState` + `computeFocusProjection` (the conversation focus) | REAL `createConversation` → `recordMessage` chains (3-turn and 1-turn threads); a foreign id and an unprovisioned-tenant read prove uniform `conversation_not_found`; the appended fourth message moves the reprojection (the stale-resume proof) |
| goals (W008) | `listGoals` | `readCompanyOverview` (the goal summaries, verbatim fields) | REAL `createGoal` fixtures ×2; the overview asserts the ids, statuses and the digest recomputability |
| missions (W011) | `getMission`, `listMissions`, `MissionsError` | `readCompanyOverview`, `listBackgroundWork` (mission items), `getBackgroundWorkItem` (mission seam), `computeFocusProjection` (mission focus — revision = mission.version) | REAL missions in all three statuses (active, `completeMission`, `abandonMission`); a `reviseMission` moves the focus reprojection to version 2 — the stale mission-resume proof; foreign reads refuse `work_item_not_found`/`mission_not_found` uniformly |
| agent-exchange (W136) | `listExecutionPlans`, `listExecutionRuns` | `listBackgroundWork` (execution-run items, gathered per plan) + `getBackgroundWorkItem` (run seam) + `computeFocusProjection` (the background-work focus) | a REAL plan + three REAL runs (queued / succeeded / awaiting_approval) over REAL W021 executions — the fake in-process transport (the sanctioned wiring seam); the awaiting run is left pending via the REAL W009 authority policy |
| execution-fabric (W137) | `listFabricLeases` | `listBackgroundWork` (fabric-lease items — phase from the lease status, updatedAt from the latest lifecycle stamp) | a REAL `registerEnvironmentDefinition` + three REAL leases (preparing / prepared-live / cancelled) acquired over the W136 runs through the fabric's own deterministic local-container adapter |
| notifications (W031) | `listNotifications` | `readShellModel` — the notification entry (attentionCount over pending/escalating/escalated, latest subject/stamp) | a REAL digest-class notification policy + two REAL notifications pinned at two clock stamps — the entry reads exactly them |
| organizations (W001) | `getTenant`, `listWorkspaces`, `OrganizationsError` | `readShellModel` — the tenant/workspace switcher | a REAL `provisionTenant` + `createWorkspace` (the default + 'Field Operations'); an unprovisioned tenant proves the honest `tenant_not_found` |
| agents (W021) · actions (W009) | — (fixture-only) | not read at runtime by the service | the harness builds the execution side: `registerAgent` + `setAgentTransport` (the in-process fake) + `submitAgentExecution`/`runAgentExecution`, and `setAuthorityPolicy` (the approval-gated level that leaves one run awaiting) |

## Honest-limitations register (for TL integration)

1. **No real Tauri 2 or Expo/React Native builds ship with this
   module — deliberately.** The deliverable is the CROSS-PLATFORM
   SEMANTIC CORE + the adapter SPI: the 21 operations, the
   content-addressed projections, the handoff evidence model and the
   vendor-neutral capability surface. The three adapter doubles are
   DETERMINISTIC SIMULATIONS (no browser Notification API, no OS
   notification center, no push service, no camera hardware, no
   filesystem touch, no network). Real Tauri 2 and Expo/RN adapter
   bindings behind the same frozen shape — and the client BINARIES
   (signed desktop installers, store mobile builds) — are documented
   NEXT STEPS at composition, exactly as W137's real
   playwright/E2B evaluation is (the domain contracts are identical
   either way; that is what the removal-neutrality clause proves).
2. **The adapters are deterministic doubles**: scriptable failures,
   read-only invocation logs, honest capability surfaces (web: no
   window management; desktop: no share; mobile: no window management,
   restricted file access). No real vendor path has been exercised.
3. **The FOR UPDATE staleness re-checks (revoke, handoff moves,
   resumption, close) are structurally present but not CONCURRENTLY
   provable on this box** (PGlite is single-connection — the same
   class as the W134-W138 limitation): a racing transition cannot be
   interleaved with the row lock held; the sequential second call
   fails at the pre-transaction check before the lock re-check is
   reached. What IS proven: the one-way transitions, the exactly-once
   stamps, the terminal refusals and the sequential second-call
   refusals (`session_already_revoked`, `handoff_already_closed`,
   `handoff_not_open`).
4. **Sweeps / registrations / census / discoverability for the three
   new tables are TL-owned** (the W125/W135/W136-integration/WC-INT
   precedent — outside this worker's strict ownership): the
   tenant-isolation manifest entry, the health census pin (298 → 301),
   the schema-reconciliation pins and the discoverability registration
   for `client_sessions`, `handoff_sessions` and `handoff_evidence`
   await the TL integration pass. The arch gate's table count moved
   289 → 292 with W139's three tables (the migration is
   auto-discovered; the count is honest). The two-tenant isolation
   proofs live in this module's own suite in the meantime.
5. **The adapter registry is in-memory (per-process)**: a process
   restart clears registrations; only capability probing/invocation
   surfaces the removal (`adapter_not_found`) — deliberate (wiring is
   never domain state), flagged for the app-composition boot sequence
   (the W137 precedent, same wording).
6. **The background-work feed is bounded by the seams' read
   surfaces**: the tenant's 50 most-recent plans × 50 runs each
   (the exchange's plan-scoped reads), 50 missions and 50 leases,
   then the phase filter, then the caller's limit. `getBackgroundWorkItem`
   resolves missions by direct read but runs/leases within that
   bounded window — deeper histories need composition read ops (the
   W137 500-run question's sibling).
7. **The background-work focus's reprojection revision is structurally
   1** (the work item has no natural revision counter — its phase
   moves are captured in the DIGEST, not the revision): a stale client
   projection on the background-work path is therefore not detectable
   by revision comparison (`clientRevision !== revision`), unlike the
   conversation (message count) and mission (version) paths. Honest
   boundary of the conflict-detection surface, recorded here.
8. **No authority-claim gating on module operations** (the
   org-lab/agent-exchange/fabric precedent): any explicit
   TenantContext member can register sessions, open handoffs and
   invoke capabilities; the same-principal handoff rule compares
   PRINCIPAL IDS, not authority claims — authorization wiring belongs
   to app composition.
9. **`readShellModel` requires a provisioned tenant**
   (`tenant_not_found`, honestly) — an unprovisioned tenant has no
   switcher state; the other reads serve empty projections rather
   than refusing.
10. **No app-layer UX** — no routes, screens, MCP surface or client
    binaries ship with this module (the module ruling: the web app
    remains the canonical renderer; W076 owns the real-browser
    conformance of that renderer; the desktop/mobile renderers are
    composition).
11. **The full repository suite is deliberately NOT run by this
    worker** — the TL owns the integration battery (the W135
    precedent).

## Test inventory (49 proofs, all green)

Integration (28, embedded PGlite, env pinned before imports,
`runMigrations`, `closeDb`; the harness NEVER opens a transaction):
client sessions (4) — the three platform kinds as server-issued
identity · the past-expiry + malformed refusals · newest-first listing
with platform/derived-state filters · uniform not-founds (missing ≡
foreign) · revocation (2) — revoke once + the sequential second-call
refusal + a revoked session cannot act · an expired session is
derived-state expired and cannot act · conversation state (3) —
byte-identical across web/desktop/mobile · the digest recomputable
from the served projection alone (and window-sensitive) · uniform
`conversation_not_found` · company overview (2) — identical summaries
with verbatim field mirroring + recomputable digest · an empty tenant
reads empty · background work (4) — the three seams with normalized
phases + verbatim statuses over REAL fixtures · the IDENTICAL feed and
per-item reads for every client kind + the deterministic order ·
seam/phase filters with limit-after · uniform `work_item_not_found` +
the empty feed · adapters (3) — one registration per kind + second
refused + honest descriptors · capabilities served + unsupported
refused + vendor throws mapped + closed input vocabularies · REMOVAL
NEUTRALITY (zero adapters → all seven domain read families
byte-identical, probe/invoke typed refusals, re-registration restores)
· handoff (5) — the full evidenced lifecycle (open → handoff → resume
fresh → resume stale → close; the six-event trail multiset; anchor
= evidence count; kind filters) · the mission-focus reprojection +
sequential second-call refusals · the structural violations (same
session, foreign principals, unresolved focuses ×3, missing
session/handoff, validation through the service) · the nine
storage-level trigger probes (append-only, immutable context,
immutable identity) · the status/focus/platform filters · tenant
isolation (1) — B sees none of A's sessions/handoffs/evidence,
uniform not-founds on every path, the same shapes coexisting, A
untouched · shell (4) — every W057 element identical for every client
kind (seven areas + hrefs + modes, 25 command entries by target kind,
the notification entry over REAL notifications, drawer 'none', the
switcher over REAL tenant + workspaces) · the contextual drawer
through all three focus kinds · the honest `tenant_not_found` · THE
EXPORT TRIPWIRE (20 forbidden domain-mutation names absent; the
function surface exactly the 21 operations + the typed error + the 13
pure validation/digest exports + the 3 adapter factories).

Unit (21, pure — no database): canonical serialization + digest (4) —
key order never decides a digest · array order is semantic · non-JSON
values rejected · stable prefixed sha256 hex · vocabulary pins (5) —
the frozen W131 client vocabulary (tauri/expo refused) · the
vendor-neutral capability domains · the seven W057 areas in plan
order · the fifteen tower slugs · the closed background-work/handoff
vocabularies · validation guards (6) — focusSeam IFF background-work ·
navigation area + tower slug · draft/focusRef bounds · the open-input
uuid discipline · the capability-input canonicalizability + closed
vocabularies · the shell-focus rules · adapter doubles (6) — the web
honest descriptor · the desktop surface · the mobile surface ·
deterministic invocation + the proof log · scriptable vendor failures
· vendor identity metadata-only.

## Gates (run from the worktree root, exact commands and outputs)

Run by this finisher TWICE at the same content (once on the clean tip
5495664 before the notes existed, once with the notes in place —
identical results; the .md touches nothing the gates count):

- `timeout 300 bun run typecheck` — exit 0, zero errors (`tsc --noEmit`)
- `timeout 120 bun run arch` — exit 0, "architecture check passed —
  module files: 790, app/mcp files: 337, tables checked: 292"
- `timeout 240 bun run lint` — exit 0, zero errors (`eslint .`)
- `timeout 590 bunx vitest run src/modules/cross-platform` — exit 0,
  2 files, **49/49 passed** (28 service, 6311ms + 21 unit, 12ms),
  0 unhandled errors, duration 9.13s

The full repository suite is deliberately NOT run — the TL owns the
integration battery. The W139 chain is `8011ca9` (D1 layers 1-3) →
`4fd7637` (unit proofs) → `5495664` (service proofs + the
navigation_state round-trip repair) → this note's commit on
`work/w139-cross-platform`; pushed to origin by this finisher.
