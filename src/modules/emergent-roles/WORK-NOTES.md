# W138 — Emergent Roles + Marketplace Publication · WORK NOTES

Work item: `spec/work-items/WORK-ITEM-CATALOG.md` §W138 (declared dependencies:
W135, W136, W028, W040, W054 — all consumed, none modified; the runtime seam
set is wider, see the seam map). Design contract: `spec/ARCHITECTURE.md` §13
(the chain `process → capability → gap → acquisition option → authorization →
deployment → outcome` — this module is the durable `gap → acquisition option`
edge), §17 (the marketplace lifecycle and "The same governance applies to
AgentPackages. Publication never implies tenant installation or activation"),
§20 (the action-authority matrix), §24 (the reconstruction chain and "Audit
records are append-only"), ADR-0001 (tenancy), ADR-0019 (capability outcome
learning — failed interventions retained as negative evidence, no hidden
outcome labels leak).

> "Allow recurring capability gaps to produce evidence-backed RoleProposals
>  and marketplace submissions."
> Acceptance: "role proposals carry evidence, capability demands, alternatives
>  and evaluation; publication/install/activation remain governed; Lab cannot
>  self-publish or self-activate."

Delivery history (honest): D1 delivered the full static layer + service +
contract + unit tests untracked, then died at the reporting deadline before
any commit (the TL banked the delivery as 7a93439, state unverified). D2
Layer A (ad77939) verified + repaired the banked delivery — two unit-test
type errors fixed (malformed-context assertions cast as `never`, the
agent-exchange house pattern). D2 Layer B+C (4e5da9d) verified the design
against every acceptance clause, delivered the 34 service proofs with REAL
cross-module fixtures, and REPAIRED the two Lab-separation storage triggers
(the D1 plpgsql had ambiguous variable names — `SELECT … INTO origin_kind`
collided with the column, so the D1 migration had never actually executed;
the variables are now `v_origin_kind`/`v_origin_principal`). D3 (this
delivery) re-ran every gate at the tip and wrote these notes.

## What was built (file map)

Everything lives in `src/modules/emergent-roles/**` — nothing else in the
repository was touched.

| File | Role |
| --- | --- |
| `types.ts` (507L) | The domain shapes: `RoleGapEvidence` + the discriminated `GapEvidenceSource` (exactly one upstream ref per record — the three recurring-gap seams), `CapabilityDemand` (the W017 proficiency semantics: level in [0, 1]), `AlternativeConsidered` (each with its REQUIRED retained evaluation), `RoleProposalEvaluation` (rationale / whyNow / gapRecurrence — all required), `RoleProposal` + its frozen provenance `RoleProposalOrigin` (the `principalId` is SYSTEM-CAPTURED, never caller-supplied), the frozen `ReviewDecisionSnapshot`, `MarketplaceSubmissionRequest` (the package key/version/state frozen verbatim), `RoleActivation`, and the read/query shapes. `MarketplacePackageState` is imported TYPE-ONLY from the marketplace contract — the single cross-module vocabulary this surface speaks. |
| `migrations/001-emergent-roles.sql` (437L) | Five tenant-scoped tables: `role_gap_evidence` (append-only; three PARTIAL UNIQUE indexes — one upstream record is one gap, per tenant per seam), `role_proposals` (the pointer; identity/content immutable via the `role_proposal_guard` trigger, ONLY legal UPDATEs are the one-way lifecycle transitions, each stamping its column exactly once; a six-way status↔stamp coherence CHECK; the origin CHECK pair — org-lab ⇒ recommendation NOT NULL, otherwise NULL; `cardinality(evidence_citations) >= 2` at the storage level too; DELETE/TRUNCATE read `lifecycle-managed`), and `role_proposal_reviews` / `role_marketplace_submissions` / `role_activations` (append-only — triggers reject UPDATE/DELETE/TRUNCATE outright; reviews UNIQUE(tenant, proposal) — one decision per proposal, ever; the package_state CHECK mirrors the verbatim W028 vocabulary). Two Lab-separation triggers (`emergent_roles_lab_no_self_publish` / `…_self_activate`) make the forbidden rows unrepresentable even for callers bypassing the service. Cross-module references are opaque forward references, deliberately NOT foreign keys (the house discipline). |
| `errors.ts` (158L) | 33 typed codes (see the file's vocabulary table): the input family (`invalid_context` … `invalid_query`), the uniform not-found family (`gap_evidence_not_found`, `proposal_not_found`, `capability_ref_not_found`, `recommendation_ref_not_found`, `outcome_ref_not_found`, `plan_ref_not_found`, `run_ref_not_found`, `review_request_not_found`, `marketplace_ref_not_found`, `recruitment_ref_not_found` — cross-tenant access indistinguishable from missing, no existence leak), the signal family (`outcome_not_gap_evidence`, `recommendation_not_gap_evidence`, `run_not_gap_evidence` — readable but not a gap signal), and the governance family (`gap_source_already_cited`, `citation_demand_mismatch`, `slug_taken`, `proposal_not_submittable` / `_not_withdrawable` / `_not_under_review` / `_not_approved`, `review_not_decided`, `marketplace_ref_not_agent_package`, `lab_cannot_self_publish`, `lab_cannot_self_activate`, `recruitment_not_approved`). |
| `validation.ts` (767L) | Pure guards (no database, no clock, no TenantContext reads — the org-lab discipline): the frozen vocabularies (`ROLE_PROPOSAL_STATUSES`, `ROLE_PROPOSAL_TERMINAL_STATUSES`, `ROLE_PROPOSAL_ORIGIN_KINDS`, `GAP_EVIDENCE_SOURCE_KINDS`, `satisfies`-pinned to types.ts), the field bounds, the per-kind gap-source shapes (exactly the right refs, uuids only), `validateCreateRoleProposalInput` — the RECURRENCE FLOOR (2..16 DISTINCT citations), demand discipline (distinct capability ids, the W017 [0,1] level semantics), alternative discipline (distinct labels, evaluation REQUIRED), the three-question evaluation summary, and the provenance rules (org-lab REQUIRES its recommendation; tenant-operator must not carry one) — plus every transition/review/submission/activation/query validator. |
| `service.ts` (1220L) | The thirteen public operations (see contract.ts). TRANSACTION DISCIPLINE (the W134 law, binding): EVERY cross-module read (capabilities, learning, org-lab, agent-exchange, marketplace, agent-recruitment, actions) runs on the base connection BEFORE the mutation — `recordGapEvidence` gates capability + upstream source then SINGLE-appends; `createRoleProposal` gates provenance, every demand, every citation (readable AND about a demanded capability) and slug-freedom, then SINGLE-appends the whole frozen case as one row; `submitRoleProposal`/`withdrawRoleProposal`/`recordProposalReview`/`recordRoleActivation` pre-check the lifecycle, then ONE transaction re-checking the transition under a FOR UPDATE row lock before the stamp (the staleness re-check); `recordMarketplaceSubmission` gates (APPROVED, visible agent package, Lab separation) then SINGLE-appends. Tenant-scoped loaders with uniform typed not-founds; deterministic read orders (proposals newest-first; evidence/submissions/activations on the recorded_at ASC, id ASC timeline). |
| `contract.ts` (234L) | The ONLY public surface (rule (b)): the thirteen operations, `EmergentRolesError` + codes, the guards/vocabularies/limits, the domain types, and the frozen cross-module vocabulary (`MarketplacePackageState`) re-exported TYPE-ONLY through its owning contract. |
| `tests/emergent-roles-unit.test.ts` (457L) | 21 pure proofs over validation (no database). |
| `tests/emergent-roles-service.test.ts` (1586L) | 34 embedded-PGlite integration proofs over the REAL service with REAL cross-module fixtures through eleven owning contracts (the harness NEVER opens its own transaction — the W134 deadlock class cannot occur). |

## The acceptance, test-locked (five clauses)

- **Proposals carry EVIDENCE** — the recurrence floor is structural: a
  proposal cites 2..16 DISTINCT gap-evidence records (unit-proven: one gap
  is not a recurring gap; duplicates refused), each citation a readable
  record of THIS tenant about a DEMANDED capability; the gap records
  themselves aggregate the three REAL recurring-gap signals through their
  owning contracts — a settled-MISSED W040 outcome (fixture: expected 10
  at_least, measured 4), a NEGATIVELY-calibrated W135 recommendation (built
  by settling the recommendation's expected outcome as missed and running
  the REAL `recordCalibration` loop) and a FAILED W136 execution run (a
  REAL W021 execution dispatched through a rejecting in-process transport,
  recorded on a REAL exchange plan). Non-signals refuse with their typed
  codes (open/met outcomes, uncalibrated/positive recommendations,
  succeeded runs); ONE UPSTREAM RECORD IS ONE GAP (all three seams
  double-cite-refused, `gap_source_already_cited`; partial unique indexes
  backstop); the whole frozen case round-trips verbatim.
- **Capability demands are TYPED** — every demand names a REAL, ACTIVE
  W017 capability with a minimum proficiency in the [0, 1] semantics
  (unit-proven: distinct capabilities, level bounds); a retired or foreign
  capability reads uniformly `capability_ref_not_found` (a live proposal
  demands live graph nodes); a citation about a capability the proposal
  does NOT demand refuses `citation_demand_mismatch` — the recurrence
  claim stays grounded.
- **Alternatives + evaluation are RECORDED** — 1..8 alternatives, EACH with
  its retained evaluation (why it lost — the "nothing is ever discarded"
  law; unit-proven: evaluation required, labels distinct), plus the
  three-question structured evaluation (rationale / whyNow /
  gapRecurrence, all required, unit-proven); both round-trip verbatim
  through the service.
- **Publication/install/activation remain GOVERNED** — the surface
  tripwire: the contract exports NO createPackage/submitPackage/
  publishPackage/makePackageInstallable/installPackage/reviewPackage/
  createRecruitmentProposal/recruitAgent/activatePackage/decideApproval
  primitive (tested); the submission REQUEST cites a REAL W028
  AgentPackage walked through the marketplace's own governed chain to
  INSTALLABLE, freezes key/version/state VERBATIM and leaves the package
  UNMOVED (asserted against a fresh `getPackage`); invisible packages and
  non-agent kinds refuse with typed codes; the activation RECORD cites a
  REAL APPROVED W022 acquisition (a still-pending one refuses
  `recruitment_not_approved`) and stamps fulfilled exactly once; the
  review records a TERMINAL W009 decision snapshot VERBATIM (pending
  refuses `review_not_decided`; a REJECTION is retained evidence exactly
  like an approval); gap evidence, reviews, submissions and activations
  are append-only at the STORAGE level (UPDATE/DELETE/TRUNCATE probes);
  proposal content is immutable and DELETE reads `lifecycle-managed`.
- **The Lab cannot self-publish or self-activate** — the org-lab-sourced
  proposal (created against a REAL W135 recommendation by the fixed Lab
  principal) is refused, with typed errors, when that same principal
  records its marketplace submission (`lab_cannot_self_publish`) or its
  activation (`lab_cannot_self_activate`); a DIFFERENT governed principal
  records both successfully; and the storage triggers make the bad rows
  unrepresentable even for callers bypassing the service entirely (direct
  INSERT probes rejected with `Lab authority separation`).

## Design decisions & rulings honored

1. **The module is an EMERGENCE PROJECTION, not an authority.** Nothing
   here creates, submits, reviews, publishes or installs a marketplace
   package and nothing recruits an agent. The marketplace (W028) owns the
   governed package chain through INSTALLABLE, Agent Recruitment (W022)
   owns approved acquisitions, the actions matrix (W009) owns authority
   decisions, and W141 certifies the journey. Every cross-module import on
   the write path is a READ (existence, state, snapshot); every mutation
   touches only this module's tables. §17's law is taken literally:
   publication never implies installation or activation — this module
   records LINKS, never effects.
2. **THE EVIDENCE AUTHORITY RULE: the module invents NO evidence authority
   of its own.** Every gap-evidence record cites exactly ONE upstream
   record through its owning contract, validated at write time; the three
   source kinds are a frozen vocabulary (learning-outcome /
   org-lab-recommendation / execution-run). The module aggregates existing
   evidence authorities — it never mints one.
3. **The signal gates are frozen-verdict gates (the W054/ADR-0019
   prediction-hygiene law).** Only a SETTLED outcome assessed 'missed'
   counts (never open/met/exceeded — the frozen miss, never a prediction);
   only a CALIBRATED recommendation with NEGATIVE polarity counts (the
   Lab's own retained negative evidence); only a FAILED execution run
   counts. No hidden outcome label can leak into a proposal, because only
   terminal frozen assessments are citable. This is how the declared W054
   dependency is consumed — as a LAW on the gates, not a runtime seam.
4. **ONE UPSTREAM RECORD IS ONE GAP** (honest recurrence counting): three
   partial unique indexes make each upstream outcome/recommendation/run
   citable at most once per tenant; the pre-check gives the typed
   `gap_source_already_cited`. Combined with the 2..16 DISTINCT-citation
   recurrence floor, a single miss cannot pose as a recurring gap through
   either path.
5. **The submission REQUEST / activation RECORD model (the provenance
   separation).** This module records TYPED, append-only evidence that an
   APPROVED proposal was linked to a governed artifact — a REAL visible
   AgentPackage (key/version/state frozen verbatim at record time) and a
   REAL APPROVED W022 recruitment proposal — and never invokes, advances
   or substitutes for the governed chains behind them. The proposal must
   itself be APPROVED through a terminal W009 review before either record
   may land (`proposal_not_approved`).
6. **The review-snapshot model.** The W009 authority system decides; this
   module records the FROZEN decision snapshot VERBATIM, re-read FRESH at
   record time (never the caller's possibly-stale authorization-time
   return). A still-pending request refuses (`review_not_decided`) — this
   surface never decides, anticipates or rewords an authority outcome. A
   REJECTION is exactly as retainable as an approval (both are evidence).
   At most one review per proposal, ever (UNIQUE(tenant, proposal) + the
   one-way lifecycle: the review is the only exit from under_review).
7. **The Lab authority separation is keyed on PROVENANCE and enforced
   TWICE.** 'org-lab' proposals must cite a REAL W135 recommendation
   (readable, any status — provenance is where the proposal emerged from,
   not a gap signal), and their origin principal — SYSTEM-CAPTURED from
   the TenantContext, never caller-supplied — is refused as the recorder
   of the proposal's submission and activation (typed
   `lab_cannot_self_publish` / `lab_cannot_self_activate`) AND by storage
   triggers (the marketplace reviewPackage separation-of-duties
   precedent): the bad rows are unrepresentable even for callers bypassing
   the service. A tenant-operator proposal cannot fabricate Lab
   provenance (validation refuses a recommendationId on that kind), and
   its origin principal MAY record both — the separation is the Lab's;
   the operator's proposal already passed the same governed W009 review.
8. **Content is IMMUTABLE from creation; only the one-way lifecycle
   moves** (draft → under_review → approved | rejected → fulfilled, with
   the draft | under_review → withdrawn exit; a changed proposal is a NEW
   proposal — `slug_taken`). Each transition stamps its column EXACTLY
   ONCE (submitted_at/by, decided_at, fulfilled_at, withdrawn_at), the
   withdrawal retains its required reason in `lifecycle_note`, and the
   trigger's six-way status↔stamp coherence matrix makes an inconsistent
   row unrepresentable. Fulfillment is exactly-once STRUCTURALLY: the
   activation transaction re-checks `approved` under the FOR UPDATE lock
   and stamps `fulfilled` — a second activation fails the lifecycle gate.
9. **TRANSACTION DISCIPLINE (the W134 lesson, binding).** PGlite is
   single-connection; every cross-module gate runs on the base connection
   BEFORE the mutation, then either a SINGLE atomic INSERT (gap evidence,
   proposal, submission — the registerCandidate precedent) or ONE
   lock-and-stamp transaction (submit, withdraw, review, activation)
   whose statements touch only this module's tables. The test harness
   honors the same law.
10. **Vocabulary ownership.** The status/origin-kind/source-kind unions
    are THIS module's own frozen vocabularies (types.ts their single
    home, mirrored in validation.ts `satisfies`-pinned so drift fails
    typecheck). The one cross-module vocabulary spoken — the marketplace
    package state frozen onto submission records — is consumed VERBATIM
    from the W028 contract at record time and never re-validated here (a
    frozen snapshot is evidence, not input); contract.ts re-exports it
    TYPE-ONLY through its owning contract.
11. **Uniform not-found discipline (ADR-0001) end-to-end**: foreign,
    missing, retired and unreadable references read identically as their
    typed not-found codes — no existence leak on any seam. Deterministic
    orders: proposals newest-first (created_at DESC, id DESC); gap
    evidence, submissions and activations on the recorded_at ASC, id ASC
    evidence timeline.
12. **Principals and time are system-captured**: `createdBy`,
    `submittedBy`, `recordedBy` and `origin.principalId` come from the
    explicit TenantContext; semantic timestamps come from the injectable
    clock (the proofs pin it — same-millisecond writes never decide what
    a test shows).

## The seam consumption map (what this module reads, and where)

All cross-module imports target contracts only (rule (b), enforced by the
architecture gate; arch pass 770/337/283). Nothing is re-derived; everything
consumed is consumed verbatim.

| Seam (owner) | Contract symbols consumed | Where in `service.ts` | How the integration tests exercise it |
| --- | --- | --- | --- |
| capabilities (W017) | `getCapability`, `CapabilitiesError` | `requireLiveCapability` — every gap record's capability AND every proposal demand: readable + ACTIVE (retired/archived/foreign → uniform `capability_ref_not_found`) | real `registerCapability` fixtures; a RETIRED capability (via `reviseCapability`) and a foreign id both prove the uniform refusal |
| learning (W040) | `getOutcome`, `LearningError` | `requireMissedOutcome` — the 'learning-outcome' gap source: readable AND settled with the frozen assessment 'missed' (else `outcome_not_gap_evidence`) | real `defineOutcome` → `recordMeasurement` → `settleOutcome` chains — missed (4 vs at_least 10), met (10), and an open outcome |
| org-lab (W135) | `getRecommendation`, `OrgLabError` | `requireNegativelyCalibratedRecommendation` (the gap source: readable AND calibrated NEGATIVE) + `requireOriginRecommendation` (the org-lab provenance: readable, any status) | real `registerCandidate` ×2 + `recordRecommendation` fixtures; the negative one runs the REAL `recordCalibration` loop after its expected outcome settles missed (positive and uncalibrated arms refuse); a foreign id proves `recommendation_ref_not_found` on both paths |
| agent-exchange (W136) | `getExecutionPlan`, `listExecutionRuns`, `AgentExchangeError` | `requireFailedExecutionRun` — the 'execution-run' gap source: plan readable (`plan_ref_not_found`), run among the plan's recorded runs (`run_ref_not_found`), frozen executionStatus 'failed' (`run_not_gap_evidence`) | a REAL `createExecutionPlan` + `recordExecutionRun` pair over REAL W021 executions — one delivered (succeeded run), one rejected by the in-process fake transport (failed run); a missing plan and an unknown run prove the typed codes |
| marketplace (W028) | `getPackage`, `MarketplaceError`; type-only `MarketplacePackageState` | `requireVisibleAgentPackage` — the submission's package: visible to this tenant (the marketplace owns visibility — foreign/pre-publication → uniform `marketplace_ref_not_found`) AND kind 'agent' (§17); key/version/state returned and FROZEN verbatim | a REAL vendor chain `createPackage` → `submitPackage` → `runAutomatedVerification` → `reviewPackage(approve)` → `publishPackage` → `makePackageInstallable`; a still-invisible submitted package and a missing id refuse uniformly; a PUBLISHED extension package proves `marketplace_ref_not_agent_package`; the recorded state asserted UNMOVED against a fresh `getPackage` |
| agent-recruitment (W022) | `getRecruitmentProposal`, `AgentRecruitmentError` | `requireApprovedRecruitment` — the activation's acquisition: readable AND APPROVED (else `recruitment_not_approved`) | a REAL `createRecruitmentProposal` → `requestRecruitmentApproval` → `decideApproval(approve)` → `settleRecruitmentProposal` chain over real capability-gap fixtures; a still-pending one refuses |
| actions (W009) | `getActionRequest`, `ActionsError` | `requireTerminalReviewRequest` — the review's request: readable AND terminal (pending → `review_not_decided`); the decision snapshot (actionKind, authorityLevel, status, requestedBy, requestedAt, decidedAt) consumed VERBATIM | real `authorizeAction` (EXECUTE — the default matrix's approval-gated level that mints a PENDING request) + `decideApproval` chains: approved, REJECTED (retained), one left pending; the snapshot asserted field-for-field against the actions module's own values |
| ADR-0019 discipline (W054) | — (a law, not a seam) | not read at runtime; inherited as the signal-gate law (ruling 3 above) | the non-signal refusals (open/met outcomes, positive/uncalibrated recommendations, succeeded runs) are the W054 no-leak law proven at the boundary |
| goals (W008) · context (W134) · agents (W021) · extensions (W025) | — (fixture-only) | not read by the service | the harness builds REAL upstream state: the goal + fingerprint the W135 recommendation conditions on; the REAL W021 executions behind the W136 runs (the in-process fake transport is the sanctioned wiring seam — no provider contacted); the extension manifest behind the kind-mismatch package probe |

## Honest-limitations register (for TL integration)

1. **The FOR UPDATE staleness re-checks (submit, withdraw, review,
   activation) are structurally present but not CONCURRENTLY provable on
   this box** (PGlite is single-connection — the same class as the
   W134/W135/W136 limitation): a racing transition cannot be interleaved
   with the row lock held; the sequential second call fails at the
   pre-transaction lifecycle check before the lock re-check is reached.
   What IS proven: the one-way transitions, the exactly-once stamps, the
   terminal refusals and the post-terminal gates.
2. **Sweeps / registrations / census for the five new tables are
   TL-owned** (the W125/W135 precedent — outside this worker's strict
   ownership): the tenant-isolation manifest and schema-pinned census
   registrations for `role_gap_evidence`, `role_proposals`,
   `role_proposal_reviews`, `role_marketplace_submissions` and
   `role_activations` await the TL integration pass. The arch gate's
   table count moved 278 → 283 with W138's five tables (the migration is
   auto-discovered; the count is honest). The two-tenant isolation
   proofs live in this module's own suite in the meantime.
3. **Recurrence DETECTION is caller-driven.** The module proves every
   cited signal real and enforces the ≥2-distinct floor, but no
   automatic sweep of the outcome/recommendation/run streams discovers
   recurring gaps — a human or composing agent decides what to cite.
   Automatic gap discovery is composition-owned (W140's unified
   closed-loop learning consumes this aggregation surface).
4. **The Lab separation compares PRINCIPAL IDS, not authority claims.**
   No authority-claim gating exists on module operations (the
   org-lab/agent-body precedent): the same human operating a second
   principal id, or a colluding second principal, is invisible at this
   layer — authorization wiring belongs to app composition. The
   separation targets the structural Lab path (org-lab provenance),
   which is what the acceptance clause names; tenant-operator proposals
   deliberately follow only the W009 review's own separation.
5. **The frozen package snapshot never updates** (append-only evidence):
   the marketplace chain may advance a package after its submission
   record lands; consumers needing live state re-read through the W028
   contract. Same law, same reasoning as W136's run freezes.
6. **Multiple submission records per approved proposal are legal**
   (append-only evidence; no uniqueness on (tenant, proposal, package)):
   a re-submission is a NEW evidence row, not a state change, and the
   governed chain is unaffected. Deliberate — submissions are evidence,
   not a pointer (documented judgment call, reversible at TL
   discretion). By contrast at most ONE activation exists structurally
   (ruling 8).
7. **The review snapshot's `decidedAt` defensively falls back to
   `requestedAt`** if the actions read ever returned a terminal request
   without a `decidedAt` — in practice terminal requests carry it; the
   fallback keeps the snapshot total rather than nullable, and never
   fabricates a decision.
8. **A cosmetic comment inconsistency in `errors.ts`**: the header block
   says "(31 codes)" while the closing line and the actual union carry
   33. Discovered by this finisher; left in place per ownership (a
   one-word TL fix at integration).
9. **No app-layer UX** — no routes, screens or MCP surface ship with
   this module; app composition owns them.
10. **The full repository suite is deliberately NOT run by this
    worker** — the TL owns the integration battery (the W135/W136
    precedent).

## Test inventory (55 proofs, all green)

Integration (34, embedded PGlite, env pinned before imports,
`runMigrations`, `closeDb`; the harness NEVER opens a transaction):
the three REAL cross-seam gap records (settled-MISSED W040 verbatim ·
NEGATIVELY-calibrated W135 · FAILED W136 run, each with the pinned clock
and system-captured principal) · non-signal refusals ×5 (open/met
outcome, uncalibrated/positive recommendation, succeeded run) · uniform
not-founds (missing outcome/plan/run/recommendation, RETIRED + foreign
capability) · ONE-UPSTREAM-ONE-GAP ×3 seams · gap-evidence append-only
(UPDATE/DELETE/TRUNCATE probes) · **the whole frozen case round-trip**
(citations, demands, alternatives-with-evaluations, evaluation summary) ·
the LAB-origin proposal against a REAL recommendation ·
`citation_demand_mismatch` · missing/foreign citations + `slug_taken` +
foreign provenance · proposal content immutable + DELETE/TRUNCATE
`lifecycle-managed` · submit (exactly-once stamps) + re-submission
refused · withdrawal (retained reason, terminal refusals) ·
non-under-review + pending + foreign-request review refusals · **the
APPROVED decision snapshot VERBATIM** (status/decidedAt move) · the
REJECTED review retained (second exit; no submission after rejection) ·
second review refused · reviews append-only · **THE LAB CANNOT
SELF-PUBLISH** · the submission VERBATIM + UNMOVED (fresh `getPackage`
re-read) · unapproved/invisible/missing/non-agent submission refusals ·
**THE SURFACE TRIPWIRE** (no publication/install/recruitment/decision
primitive exported; all thirteen ops present) · submissions append-only
+ Lab-separated (direct INSERT probe) · **THE LAB CANNOT SELF-ACTIVATE**
· the activation against the APPROVED W022 acquisition (fulfilled once,
review stamp survives) · unapproved/foreign acquisition + draft-proposal
refusals · fulfilled terminality (no re-activation/submit/withdraw/
review) · activations append-only + Lab-separated (direct INSERT probe)
· **TWO-TENANT ISOLATION** (same slug coexists, foreign reads not-found,
foreign gap not citable, no list leakage, foreign submissions/
activations refused) · reads (newest-first proposals with status/origin
filters + counts, evidence timeline with seam/capability filters,
proposal-scoped submission/activation lists, query validation).

Unit (21, pure — no database): the vocabularies + their guards +
terminality + the TenantContext assertion · recordGapEvidence input
(round-trip, the three source shapes, mixed/unknown refs refused,
observation bounds, uuid discipline) · createRoleProposal input
(round-trip, slug grammar + title bounds, **THE RECURRENCE FLOOR**
(min/empty/over-max), duplicate citations, demand distinctness + the
W017 level bounds + empty demands, alternative evaluation required +
distinct labels + empty alternatives, the three-question evaluation
required, **the provenance rules**) · transition/review/submission/
activation inputs · the deep-link, filter and proposal-scoped query
validators (limit bounds, vocabulary filters).

## Gates (run from the worktree root, exact commands and outputs)

- `timeout 300 bun run typecheck` — exit 0, zero errors (`tsc --noEmit`)
- `timeout 120 bun run arch` — exit 0, "architecture check passed —
  module files: 770, app/mcp files: 337, tables checked: 283"
- `timeout 240 bun run lint` — exit 0, zero errors (`eslint .`)
- `timeout 590 bunx vitest run src/modules/emergent-roles` — exit 0,
  2 files, **55/55 passed** (34 service + 21 unit), 0 unhandled errors,
  duration 8.81s at the clean tip 4e5da9d / 9.31s with these notes in
  place (every gate re-run by the finisher after writing this file; all
  four identical to the pre-note runs)

The full repository suite is deliberately NOT run — the TL owns the
integration battery. The W138 chain is `7a93439` (D1, TL-banked) →
`ad77939` (D2 Layer A) → `4e5da9d` (D2 Layer B+C) → this note's commit
on `work/w138-emergent-roles`.
