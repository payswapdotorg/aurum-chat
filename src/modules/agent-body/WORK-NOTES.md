# W133 — Aurum Agent Body + Model Binding · WORK NOTES

Work item: `spec/work-items/WORK-ITEM-CATALOG.md` §W133 (dependencies W021,
W034, W063, W132). Design contract: `spec/AGENT-BODY-LAB-CROSS-PLATFORM-
ARCHITECTURE.md` §1 (body/binding separation) + §10 (authority boundaries).

> "Separate persistent Aurum Agent Body from the LLM that possesses it.
> Body owns role, information behavior, communication, permissions,
> evidence and learning hooks; model owns provider/model runtime
> characteristics."
> Acceptance: "model swap preserves tenant/company/evidence/memory
> identity; bindings are explicit, auditable and policy compatible."

This is a RE-EXECUTION of a proven prior delivery (lost to a sandbox wipe
before push). The design below is the rebuild of the recorded design; the
recorded rulings are honored verbatim.

WB3 UPDATE (the composition wiring): the deferred bindingId existence
integration recorded in ruling 3 and limitation 1 is now DELIVERED — see
ruling 3 and the limitations register for the delivered gate's exact
semantics (existence-not-activity, purpose-agnostic, base-connection,
bounded by the fabric's read surface).

## What was built (file map)

Everything lives in `src/modules/agent-body/**` — nothing else in the
repository was touched.

| File | Role |
| --- | --- |
| `types.ts` | `AgentBody` (role + five §1 policy descriptors as honest plain-JSON-or-null + permittedCapabilities + opaque evidence/learning hook refs + one-way active/retired) and `BodyModelBinding` (append-only attachment: OPAQUE `bindingId`, purpose from the frozen seam, VERBATIM `policyCheck` `{outcome,basis,checkedBy,checkedAt}`, one-way active/superseded/detached, monotonic per-body `position`, timestamps). |
| `migrations/001-agent-body.sql` | `agent_bodies` (tenant-scoped, `UNIQUE(tenant_id, role)`) + `agent_body_model_bindings` (append-only: trigger rejects DELETE/TRUNCATE and every UPDATE except the one-way lifecycle transition; partial UNIQUE index → ONE active binding per (tenant, body, purpose); per-body UNIQUE position). |
| `errors.ts` | 11 typed codes: `invalid_context`, `invalid_body_input`, `invalid_query`, `invalid_binding_input`, `body_not_found`, `body_role_taken`, `body_retired`, `binding_not_found`, `binding_inactive`, `fabric_binding_not_found` (the WB3 composition gate), `policy_check_failed`. |
| `validation.ts` | Pure guards (~800 lines incl. docs): vocabularies, context assertion, input/query validators, credential-key scan (recursive, any depth) for the five §1 descriptors, opaque-ref guards, the verbatim policy-check shape guard, `isAttachablePolicyOutcome` (the ruling as a function). |
| `service.ts` | `createAgentBody` / `getAgentBody` / `listAgentBodies` (query object) / `updateAgentBody` (identity immutable — NO role key) / `retireAgentBody`; `attachModelBinding` (THE SWAP PATH — with the WB3 composition gate: a tenant-scoped body pre-check plus the fabric-registry existence check, BOTH on the base connection BEFORE the one-transaction append pair) / `detachModelBinding` / `getBodyBindings` (full history) / `getActiveBinding`. FOR UPDATE row locks inside single transactions for all mutations; UNIQUE(tenant, role) violation → typed `body_role_taken`; foreign ids → typed `body_not_found`. |
| `contract.ts` | The ONLY public surface. Re-exports `ModelBindingPurpose` from the frozen `@/modules/provider-fabric/contract` (type-only re-export) — and since WB3 the service's composition gate VALUE-imports the fabric's operational binding-registry read (`listModelBindings` + `MAX_LIST_LIMIT`) through that same single legal cross-module import. |
| `tests/agent-body-service.test.ts` | 20 embedded-PGlite integration proofs (exemplar bootstrap: env pinned before imports, `runMigrations` from `../../../../scripts/migrate`; the binding fixtures are REAL fabric-registered bindings — connectKnownProvider → registerModelManually → fabric attachModelBinding chains — per the WB3 composition wiring). |
| `tests/agent-body-unit.test.ts` | 23 pure unit proofs. |

## The core acceptance, test-locked

Create a body with the full §1 policy payload → attach a cognition binding
→ attach a DIFFERENT binding (the swap) → **the body equals the original
byte-for-byte INCLUDING `updatedAt`** (`JSON.stringify` equality, with the
service clock pinned forward across the swap so time demonstrably moved
while the body row demonstrably did not) → history shows both attachments
(old superseded + stamped, new active), positions 1 and 2. The swap path
(`attachModelBinding`) appends the new attachment and supersedes the prior
active one in ONE transaction under a FOR UPDATE lock on the body row; the
`agent_bodies` row is not part of the transaction's writes — no UPDATE, no
`updated_at` bump, and nothing in the schema (no cascade, no trigger, no
column) lets an attachment touch the body.

## Design decisions & rulings honored (the recorded record)

1. **An 'incompatible' policy-check verdict REFUSES the attachment**
   (typed `policy_check_failed`, nothing appended). The layer records
   verdicts verbatim, never fabricates one, and never activates an
   incompatible binding. *Recorded as reversible at TL discretion* — the
   alternative (record-inert: append the attachment in a non-active state)
   was weighed and rejected because an unactivated attachment would still
   be "a binding that possesses the body" in the audit's eyes.
2. **'unknown' verdicts are treated exactly like 'incompatible'.** An
   unverified compatibility can never activate (honesty over
   availability). This is my extension of the same ruling — same
   reversibility note applies.
3. **`bindingId` stays OPAQUE at the STORAGE layer BY DESIGN — the WB3
   composition wiring gates FRESH attachments at the SERVICE boundary.**
   Attachments are append-only audit evidence that must survive
   fabric-side supersession; a historical attachment referencing a
   since-superseded fabric binding is exactly the evidence the audit must
   retain (this is the W134 contrast: W134 validates refs at write time;
   the difference is audit semantics). The composition gate (WB3,
   the recorded TL ruling delivered): `attachModelBinding` first runs a
   tenant-scoped body pre-check on the base connection (uniform
   `body_not_found` BEFORE any fabric query — no existence leak), then
   requires the `bindingId` to EXIST in the tenant's provider-fabric
   registry — read through the fabric's operational API
   (`listModelBindings`, both statuses) on the base connection BEFORE the
   append transaction (the W134 transaction law), refusing with the typed
   `fabric_binding_not_found`. EXISTENCE, not activity: superseded fabric
   bindings qualify; historical rows are never re-validated. The runtime
   purpose list is mirrored locally in `validation.ts`
   (`MODEL_BINDING_PURPOSES`, compiler-pinned to the frozen union via
   `satisfies`) because the frozen W132 contract exports types only.
4. **The body NEVER invokes models.** The LLM Gateway (W034) stays the
   execution authority (§10). This module records WHICH binding possesses
   a body for a purpose; it executes nothing.
5. **Identity is immutable.** The update surface has NO `role` key (a
   caller that tries is rejected with `invalid_body_input` before anything
   is recorded), and the schema's trigger guards role rewrites in depth.
6. **One active attachment per (tenant, body, purpose)** — not per body:
   a body may be possessed by different bindings for different purposes
   simultaneously (cognition + conversation + …). Enforced by the partial
   UNIQUE index and by the swap transaction.
7. **Detach works on retired bodies; attach does not.** Completing the
   audit trail is not a body edit; gaining new possessions is. (My ruling,
   documented here for TL review.)
8. **Retiring a body leaves its attachment history untouched.** The
   attachments are evidence about what POSSESSED the body; retirement is
   recorded on the body. The active/superseded/detached statuses of the
   attachments are untouched by the body lifecycle.
9. **No-op swaps are refused.** Re-attaching the binding that is already
   the active attachment for a purpose is rejected
   (`invalid_binding_input`) — it would only pollute the audit history
   with an attachment identical to the one it supersedes. Re-attaching
   after a detach is legal (there is no active attachment then).
10. **The five §1 descriptors are honest plain-JSON-or-null.** Null means
    "not stated", never "permissive" — this layer neither invents default
    policies nor interprets them. Credential-shaped keys are rejected at
    ANY depth (recursive scan); serialized size and nesting are bounded.

## Honest-limitations register (for TL integration)

1. **The composition gate is bounded by the fabric's read surface.** The
   fabric (W132) exposes no by-id binding read; its list API is capped at
   `MAX_LIST_LIMIT` (500, newest first). A tenant holding more fabric
   bindings than that bound makes older binding ids unresolvable through
   the operational API — such a fresh attachment is refused
   conservatively (`fabric_binding_not_found`), never fabricated. A
   fabric-side by-id read would close this (a W132-surface change,
   outside this module's ownership — noted for the TL).
2. **The gate is EXISTENCE only — deliberately purpose-agnostic.** Which
   fabric purpose a referenced binding was minted under is not constrained
   (a 'cognition' fabric binding may be attached to a body's 'analysis'
   slot; the org-lab occupancy snapshot locks exactly that loose shape —
   bodyBindingId set while the fabric's analysis slot is honestly null).
   Tightening to purpose-match is a TL design decision, not silently
   taken here.
3. **W141 still owns the live-swap proof.** The gate proves the reference
   resolves to a real fabric binding; execution equivalence through a
   swap remains the certification's declared job.
4. **No app-layer UX.** No routes, screens or MCP surface ship with this
   module — app composition owns them.
5. **No authority-claim gating on body management.** The W021 agents
   module gates `registerAgent` behind `agents:administer`; an equivalent
   claim for body management is deferred to app composition (it belongs
   with the app's authorization wiring, not the storage layer).
6. **The body never invokes models** — the LLM Gateway stays the
   execution authority (ruling 4). Any "make this body think" flow is a
   composition-layer concern.
7. **Tenant-isolation sweep + discoverability census/capability-map
   registrations** were TL-owned at delivery and LANDED with the WB2
   integration pass (agent-body-sweep with REAL two-tenant fabric
   fixtures; capability-map + census pins) — the composition wiring here
   is the WB3 continuation of that record.
8. **The hook registries are grammar-validated, not closed-vocabulary.**
   Freezing a closed cross-module registry list here would duplicate the
   owning modules' authority; the composition layer resolves
   `(registry, ref)` pairs. (A deliberate contrast with coverage's frozen
   `['source','channel','meeting','integration']` — those registries were
   frozen by a TL contract; no such contract exists for the evidence/
   learning surfaces yet.)
9. **The runtime purpose mirror in `validation.ts`** is a manual
   reconciliation point if the frozen W132 seam ever adds a purpose —
   pinned by the compiler (`satisfies readonly ModelBindingPurpose[]`),
   so drift fails typecheck, not runtime.

## Test inventory (43 proofs, all green)

Integration (20, embedded PGlite, REAL fabric-registered binding
fixtures): full §1 payload round-trip · duplicate role vs cross-tenant
same role · foreign-id uniform `body_not_found` · list query object +
tenant scoping · update semantics + role immutability · one-way retire
(edits/attaches refused, history readable, retired filter) · **the WB3
composition gate** (unregistered id → `fabric_binding_not_found`, nothing
appended; the registry read is tenant-scoped — another tenant's REAL id
refused on one's own body; uniform `body_not_found` still fires FIRST for
a foreign/missing body; the gate precedes the policy verdict) · first
attachment (position 1, verbatim policy check — a since-SUPERSEDED fabric
binding qualifies: existence, not activity, proven against the fabric's
own registry read) · **THE CORE ACCEPTANCE (byte-for-byte swap)** ·
one-active-per-purpose · incompatible refusal (nothing appended) ·
unknown refusal · no-op swap refusal · detach + re-attach · foreign-id
binding surface · two-tenant binding isolation · storage-level
append-only law (identity rewrites, policy-check rewrites, revival,
DELETE, TRUNCATE) · partial-unique direct INSERT refusal · body-level
storage guards (role rewrite, DELETE, TRUNCATE) · monotonic history
across a full lifecycle.

Unit (23): vocabularies (lifecycles, purpose mirror, outcome vocabulary +
ruling) · uuid guard · context guard · create validators (minimal/full
round-trip, unknown + credential keys, role grammar, non-object
descriptors, nested credential keys, size/depth bounds, capability
grammar/dups/count, hook shape/grammar/dups/credential refs/count) ·
update validators (role refusal, empty refusal, partial semantics) ·
list/get query validators · policy-check payload shape (incl. non-ISO
checkedAt) · attach/detach input validators.

## Gates (run from the worktree root, exact commands)

- `timeout 300 bun run typecheck` — exit 0
- `timeout 300 bun run arch` — pass (new tables migrate cleanly on the
  gate's fresh embedded db; both carry `tenant_id`)
- `timeout 240 bun run lint` — clean
- `timeout 590 bunx vitest run src/modules/agent-body` — 2 files,
  43/43 passed (20 integration + 23 unit), 0 unhandled errors

The full repository suite is deliberately NOT run — the TL owns the
integration battery.
