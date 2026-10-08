# W135 — Aurum Contextual Organizational Lab · WORK NOTES

Work item: `spec/work-items/WORK-ITEM-CATALOG.md` §W135 (dependencies: the
W132 provider fabric, the W133 agent body, the W134 context fingerprint +
info strategy — all consumed, none modified). Design contract:
`spec/AGENT-BODY-LAB-CROSS-PLATFORM-ARCHITECTURE.md` §2 (contextual
conditioning), §4 (the candidate composition), §5 (the comparison set +
"The Lab recommends"), §10 (authority boundaries), §11 (recommendations as
evidence objects).

> "Implement a Flauz-inspired Aurum Lab for organization candidates,
>  marketplace-agent selection, model occupancy, robust evaluation and
>  calibration."
> Acceptance: "organization search includes season/time window, duration,
> staffing, staff experience, workload, capability, environment, budget,
> quality, risk, verification and evidence freshness where relevant;
> rejected candidates are retained; recommendations are outcome-calibrated;
> same subject under materially different contexts may yield different best
> organizations."

Delivery history (honest): D1 banked the vocabulary/storage layers at
082a160 after a sandbox reset killed the first worker mid-delivery; D2
delivered service + contract (50d55b7) and the unit proofs (0e1b436) but
died at the reporting deadline; D3 (this delivery) wrote the service
integration proofs and these notes. All commits are LOCAL ONLY — no GitHub
PAT exists on this box (sandbox reset); the TL owns the push.

## What was built (file map)

Everything lives in `src/modules/org-lab/**` — nothing else in the
repository was touched.

| File | Role |
| --- | --- |
| `types.ts` (703L) | The domain vocabularies: `OrgNode`/`OrgEdge`/`OrgInformationRoute`/`OrgComposition` (the §4 composition; the §5 comparison-set node kinds), `CandidateApplicability` (the DECLARED contextual hypotheses — THE CONTEXTUAL RULE's caller-supplied content), the twelve `OrgFitAxis` fit axes + `DimensionFit` verdicts (match/misfit/agnostic/unobserved/advisory), `OrgCandidate` (immutable content, one-way active→retired), the full §11 evidence-object shapes (`OrgRecommendation`, `CandidateEvaluationRecord`, `OccupancySnapshot`, `ExpectedOutcomeRecord`, `OrgCalibration`, `CalibrationSummary`), and the search shapes (`OrgSearchResult` with the per-axis report + calibration + node-kind census). |
| `migrations/001-org-lab.sql` (372L) | Five tenant-scoped tables: `org_candidates` (UNIQUE(tenant,slug), content-immutable via trigger), `org_recommendations` (the pointer; ONLY legal UPDATE is recorded→calibrated), `org_recommendation_candidates` (ALL evaluated candidates incl. rejected — append-only), `org_recommendation_occupancy` (the model-occupancy snapshot — append-only), `org_recommendation_outcomes` (expected-outcome snapshots — append-only), `org_recommendation_calibrations` (UNIQUE(tenant, recommendation) — one calibration per recommendation, ever). Triggers reject DELETE/TRUNCATE everywhere and every UPDATE except the two one-way lifecycle transitions. |
| `errors.ts` (83L) | 18 typed codes (see the file's vocabulary table): the uniform not-found family (`candidate_not_found`, `recommendation_not_found`, `goal_not_found`, `fingerprint_not_found`, `strategy_not_found`, `evaluation_ref_not_found`, `invalid_outcome_ref`, `node_ref_not_found`), the state family (`candidate_slug_taken`, `candidate_retired`, `node_ref_inactive`, `recommendation_already_calibrated`, `fingerprint_goal_mismatch`) and the input/query family. |
| `validation.ts` (1069L) | Pure guards: the frozen vocabularies (mirrored compiler-pinned to the W132/W134/coverage unions via `satisfies`), the context assertion, the composition discipline (node-id grammar, edge endpoints, agent-body uuid refs, purposes on agent-body nodes only, bounds), the applicability discipline (trim/lowercase/de-dup, vocabulary checks), the §11 discipline (2..32 distinct candidates, ≤1 recommended, rejection reasons iff rejected, criteria/scores co-validation, 1..16 expected outcomes), and all query validators. |
| `ranking.ts` (443L) | The pure contextual-fit + ranking math — THE SINGLE deterministic definition: `contextualFit` (the twelve-axis report), `observedStaffingProfile` (the ≥50%-dominant-bucket derivation), `smoothedSuccessRate` (Laplace), `rankScoreOf` (fit × calibration factor), `rankOrganizationCandidates` (rankScore DESC, slug ASC), `calibrationPolarity` (positive iff every realized outcome met/exceeded), `calibrationAggregate`. No database, no clock, no contracts at runtime. |
| `service.ts` (1273L) | The eleven public operations (see contract.ts). Every mutation is ONE transaction whose statements touch only this module's tables; EVERY cross-module read (goals, context, info-strategy, agent-evaluation, learning, agent-body, provider-fabric) runs on the base connection BEFORE the transaction opens — the W134 transaction-discipline law (PGlite is single-connection; a base-connection read inside an open transaction starves it). `recordCalibration` re-checks the recorded→calibrated transition under a FOR UPDATE row lock (the immutable-version staleness re-check). |
| `contract.ts` (270L) | The ONLY public surface (rule (b)): the eleven operations, `OrgLabError` + codes, the guards/vocabularies/limits, the pure ranking math (exported for verification), the domain types, and the frozen cross-module vocabularies re-exported TYPE-ONLY through their owning contracts. |
| `tests/org-lab-unit.test.ts` (921L) | 32 pure proofs over validation + ranking (no database). |
| `tests/org-lab-service.test.ts` (1668L) | 28 embedded-PGlite integration proofs over the REAL service with REAL cross-module fixtures (the house agent-body bootstrap; the harness NEVER opens its own transaction). |

## The core acceptance, test-locked

**"Same subject under materially different contexts may yield different
best organizations"** — proven TWICE, purely and end-to-end:

- purely (unit): `rankOrganizationCandidates` over three candidates under
  two fingerprints — the spring design ranks first under the spring
  fingerprint, the winter design first under the winter fingerprint;
- end-to-end (service): the SAME three registered candidates and the SAME
  goal, with TWO real W134 fingerprints derived through the context
  contract for that goal — `searchOrganizations` returns
  `[a-spring-crew, c-generalist, b-winter-brigade]` under the spring
  fingerprint and `[b-winter-brigade, c-generalist, a-spring-crew]` under
  the winter one. The divergence is DATA (declared hypotheses vs observed
  context), never code — nothing in the module knows an industry, a season
  name or a workload semantics.

The other three acceptance clauses, equally test-locked:

- **the twelve contextual dimensions**: every search result carries the
  per-axis fit report in canonical order — season/time window, duration,
  staffing/staff experience, workload, capability, environment, risk,
  verification, evidence freshness as MECHANICAL axes (match/misfit/
  agnostic/unobserved) and budget/quality/SLA as ADVISORY axes (both
  postures surfaced, never string-matched); plus the fitScore, the
  calibration aggregate and the §5 node-kind census.
- **rejected candidates are retained**: a recommendation keeps EVERY
  evaluated candidate — recommended AND rejected, rejection reasons
  included — through the rejected candidate's own retirement, and the
  storage triggers reject UPDATE/DELETE/TRUNCATE on the evaluation,
  occupancy, outcome and calibration tables outright (proven with direct
  SQL probes).
- **recommendations are outcome-calibrated**: `recordRecommendation`
  commits to OPEN learning outcomes BEFORE realization (immutable
  definition snapshots — the W054 prediction-hygiene discipline);
  `recordCalibration` consumes the learning module's FROZEN verdicts
  verbatim, stamps the one-way recorded→calibrated transition (terminal:
  re-calibration refuses, abandoned outcomes never calibrate), and the
  calibrated evidence then modulates the LIVE search arithmetically —
  1/1 positive samples lift a fit-1.0 candidate to rank 1.0833 (EVIDENCE
  OVERTAKES FIT, proven against the real service), while a missed outcome
  drags a fit-0.5 candidate to 0.4583 (FAILURE IS RETAINED AND IT COSTS).

## Design decisions & rulings honored

1. **THE CONTEXTUAL RULE is structural, not aspirational.** The ranker's
   ONLY inputs are the caller-supplied applicability hypotheses and the
   observed fingerprint (W134's record, consumed as-is). Matching is
   mechanical set membership; the divergence between contexts is data.
   The unit tests prove no domain vocabulary leaked into the math; the
   service tests prove the same through the real derivation path.
2. **budget/quality/SLA are ADVISORY, never mechanically matched.** The
   fingerprint carries them as free text; mechanically string-matching
   free text would fabricate precision (the same reasoning as W134's
   null-signal law). Both postures are surfaced in the report
   (`declared`/`observed`) for the human/agent decision. *Documented as
   reversible at TL discretion* — the acceptance lists "budget, quality"
   among the search dimensions, and this delivery reports them honestly
   rather than pretending to score them.
3. **The null-signal law, inherited end-to-end.** An absent fingerprint
   dimension is `unobserved`, never faked; a candidate that declares
   nothing the fingerprint observed is `agnostic` with fitScore NULL —
   never a fabricated 0.5 in the REPORT (the 0.5 neutral baseline applies
   only inside the rank blend). Proven purely and against the service
   with a real empty-observation derivation.
4. **Calibration is Laplace-smoothed arithmetic over retained evidence**
   ((successes+1)/(sampleSize+2)): one sample can never swing the ranking
   to 0 or 1, cold start is exactly neutral, and a negative history drags
   below a cold equal-fit peer. ADR-0019's no-leak law: the search and
   `getCandidateCalibration` surface AGGREGATES + evidence recommendation
   ids, never per-recommendation outcome labels.
5. **The polarity rule is strict** (documented judgment call, reversible
   at TL discretion): positive iff EVERY realized expected outcome was
   assessed 'met' or 'exceeded' by the learning module's frozen verdict;
   a single 'missed' is negative. Failed recommendations are retained as
   negative evidence — there is no path that discards them.
6. **The calibration aggregate counts only recommendations in which the
   candidate was the RECOMMENDED design** (disposition 'recommended') —
   a rejected alternative never ran, so it carries no realized outcome of
   its own; its cold-start calibration is null (tested). Same judgment
   class as ruling 5.
7. **Candidate content is IMMUTABLE from registration** (a changed design
   is a NEW candidate with a new slug — the actions-module discipline);
   only the one-way active→retired lifecycle moves, stamped once with the
   required retained reason. Retiring deliberately leaves every evaluation
   citing the candidate untouched: evaluations are retained evidence, and
   an evaluation of a retired design is LEGITIMATE to record (tested) —
   only the SEARCH refuses retired candidates.
8. **The Lab RECOMMENDS (§10, the completion law).** No operation
   installs a package, recruits an agent, executes a specialist or grants
   authority — everything is records and reads. Marketplace governance
   (W028), Agent Recruitment (W022), Action Policy (W009) and the Agent
   Gateway (W021) own the follow-through; W136/W137 consume; W141
   certifies.
9. **TRANSACTION DISCIPLINE (the W134 lesson, binding).** Every
   cross-module read runs on the base connection BEFORE the mutation's
   ONE transaction opens (whose statements touch only org-lab tables):
   `registerCandidate` gates agent-body refs then single-INSERTs;
   `retireCandidate` locks + transitions in one transaction;
   `recordRecommendation` runs ALL evidence gates (goal ACTIVE + version,
   fingerprint readable + goal-matched, strategy readable, candidates
   readable, agent evaluations readable, outcomes OPEN, the occupancy
   snapshot through both binding seams) then appends pointer +
   evaluations + occupancy + outcomes in one transaction;
   `recordCalibration` reads the frozen realizations first, then
   re-checks the transition under FOR UPDATE inside the append
   transaction (the immutable-version staleness re-check — a racing
   calibration that committed first owns the transition). The TEST
   HARNESS honors the same law: it never wraps a service call in its own
   transaction (the W134 deadlock class cannot occur).
10. **Zero recommended candidates is honest** ("no clear winner"):
    `recommendedCandidateId` is null and the occupancy snapshot is empty —
    tested explicitly.

## The seam consumption map (what this module reads, and where)

All cross-module imports target contracts only (rule (b), enforced by the
architecture gate; arch pass 756/337/272). Nothing is re-derived;
everything consumed is consumed verbatim.

| Seam (owner) | Contract symbols consumed | Where in `service.ts` | How the integration tests exercise it |
| --- | --- | --- | --- |
| goals (W008) | `getGoal`, `GoalsError` | `requireActiveGoal` — search + recordRecommendation: the subject goal must be readable and ACTIVE; its current `version` is snapshotted as the §11 "goal revision" | real `createGoal` fixtures; an ARCHIVED goal (via `reviseGoal`) proves the unavailable-state mapping to `goal_not_found` |
| context (W124b frozen type + W134 derivation) | `getFingerprint`, `ContextError`; type-only `ContextDimensionKey`, `DurationClass`, `WorkloadLevel` | search + recordRecommendation: the fingerprint must be readable AND derived FOR the subject goal (else `fingerprint_goal_mismatch`); the eight typed dimensions feed `ranking.ts` verbatim | real `deriveFingerprint` fixtures — full spring observations, materially different winter observations, and an empty-observation derivation (the null-signal search) |
| info-strategy (W134) | `getStrategy`, `InfoStrategyError` | recordRecommendation's optional strategy link: validated readable at write time, opaque afterwards | a real `defineStrategy` conditioned on the fixture goal + fingerprint (its knowledge requirement chains through a real `recordUnknown`) |
| agent-evaluation (W024) | `getAgentEvaluation`, `AgentEvaluationError` | recordRecommendation: every cited `agentEvaluationIds` entry must be readable (deduplicated first) | a real measured `recordAgentEvaluation` over a registered agent, cited on both the recommended and the rejected evaluation |
| learning (W040) | `getOutcome`, `LearningError` | recordRecommendation: every expected outcome readable + OPEN (the commitment BEFORE realization); recordCalibration: every snapshotted outcome readable + SETTLED — the frozen realization (`realizedValue`, `varianceVsExpected`, `assessment`, `fromMeasurementId`, `settledAt`) is consumed VERBATIM, never re-derived | real `defineOutcome` → `recordMeasurement` → `settleOutcome` chains (exceeded / met / missed) plus an `abandonOutcome` arm |
| agent-body (W133) | `getAgentBody`, `AgentBodyError`, `getActiveBinding` | registerCandidate: every agent-body node ref must be readable + ACTIVE (a fresh design references live bodies); `snapshotModelOccupancy`: the body's active attachment per declared purpose — its OPAQUE fabric binding id stored VERBATIM | a real `createAgentBody` + two purpose attachments; a retired body proves `node_ref_inactive` |
| provider-fabric (W132) | `getActiveModelBinding`; type-only `ModelBindingPurpose` | `snapshotModelOccupancy`: the tenant's current active fabric binding for the purpose — its binding id stored VERBATIM; null = honestly unoccupied | a real `connectKnownProvider` → `registerModelManually` → fabric `attachModelBinding` chain (cognition bound; analysis deliberately left unbound — the honest-null occupancy row) |
| coverage (frozen vocabulary) | type-only `CoverageSourceRegistry` | `OrgInformationRoute.registry` grammar — routes are prospective opaque refs into the coverage source registries (deliberately NOT cross-module validated, the W134 PreferredSource discipline) | grammar-validated in unit tests; no runtime read |
| epistemics (W004) | — (indirect) | not read by the service; the W134 strategy link transitively owns Unknown validation | the tests' strategy fixture registers a real Unknown because `defineStrategy` demands one |
| agents (W021) | — (indirect) | not read by the service; cited agent evaluations transitively own agent validation | the tests' evaluation fixture registers a real agent (needs the `agents:administer` claim) because `recordAgentEvaluation` demands one |

## Honest-limitations register (for TL integration)

1. **The FOR UPDATE staleness re-check in `recordCalibration` is
   structurally present but not CONCURRENTLY provable on this box.**
   PGlite is single-connection, so a racing calibrate cannot be
   interleaved with the row lock held; the sequential second call fails
   at the pre-transaction uniform check (`recommendation_already_
   calibrated`) before the lock re-check is reached. What IS proven: the
   one-way transition, the exactly-once stamp, the terminal refusal, the
   open/abandoned-outcome refusals, and the storage-level append-only
   law on the calibration rows. The same class of limitation the W134
   delivery recorded for its own lock re-check.
2. **`bodyBindingId` / `fabricBindingId` are OPAQUE VERBATIM references**
   (the W133 ruling): the occupancy snapshot does not cross-validate that
   the agent-body attachment's binding id exists in the fabric — a
   historical attachment referencing a since-superseded fabric binding is
   exactly the audit evidence that must survive. The TL's WB2 integration
   item ("bindingId existence validation vs the fabric operational API")
   remains open at the composition boundary; W141 owns the live-swap
   certification.
3. **The search RANKS, it does not FILTER.** Every ACTIVE candidate
   appears (a fit-0 design simply ranks last, honestly, with its misfit
   report visible). Callers apply thresholds; inventing a hidden
   cutoff here would be an unrequested policy. `limit` applies after
   ranking.
4. **No authority-claim gating on Lab operations.** Registering
   candidates, recording recommendations and calibrating are claim-free
   (any explicit TenantContext member); an org-lab administer claim
   belongs to app composition's authorization wiring, not the storage
   layer (the agent-body precedent, its limitation 3).
5. **Marketplace packages, tenant agents, human capabilities and external
   specialists remain opaque `(kind, ref, label)` forward references**
   (the §5 ruling): their registries own the verification points; the Lab
   records the comparison. Cross-module existence validation for those
   kinds is a composition-boundary decision (W136/W137 consume first).
6. **Information routes are prospective** — grammar-validated against the
   frozen coverage registry vocabulary, never existence-validated (the
   W134 PreferredSource discipline: a design may route into a source not
   yet onboarded).
7. **Tenant-isolation manifest/sweep + capability-map + census
   registrations are TL-owned** (outside this worker's strict ownership;
   the W125 precedent). The five-tenant isolation proofs live in this
   module's own suite in the meantime.
8. **The vocabulary mirrors in `validation.ts`** (`MODEL_BINDING_
   PURPOSES`, `DURATION_CLASSES`, `WORKLOAD_LEVELS`, `RISK_TOLERANCES`,
   `COVERAGE_SOURCE_REGISTRIES`) are manual reconciliation points if the
   owning contracts ever extend — compiler-pinned via `satisfies`, so
   drift fails typecheck, not runtime.
9. **`candidate_slug_taken` carries a friendly pre-check + the UNIQUE
   mapping** — under a true race the constraint is the truth; the typed
   code is identical either way (not separately race-provable on
   single-connection PGlite; same class as limitation 1).
10. **No app-layer UX** — no routes, screens or MCP surface ship with this
    module; app composition owns them.

## Test inventory (60 proofs, all green)

Integration (28, embedded PGlite, house bootstrap — env pinned before
imports, `runMigrations`, `closeDb`; the harness NEVER opens a
transaction): full §4/§5 composition round-trip · foreign-id uniform
`candidate_not_found` · duplicate slug · W133 node-ref gates (foreign +
retired body) · list query object + tenant scoping · one-way retire
(stamps once, refuses twice, content intact) · storage-level candidate
immutability (label rewrite, DELETE, TRUNCATE) · **THE CONTEXTUAL RULE
END-TO-END** · twelve-axis report canonical order + per-axis verdicts +
advisory free-text axes · agnostic-with-null-fit + node-kind census ·
null-signal empty-fingerprint search · limit + malformed queries · typed
goal/fingerprint/mismatch codes (incl. archived goal) · §11 round-trip ·
**REJECTED CANDIDATES RETAINED** (through retirement + storage triggers on
all four evidence tables) · model-occupancy snapshot through both binding
seams (verbatim ids, honest null) · OPEN-outcome commitment snapshots ·
foreign evidence refs typed (candidate/strategy/evaluation/outcome
settled/abandoned/foreign) · honest no-winner case · open + abandoned
outcomes never calibrate (rec stays recorded) · positive calibration
(frozen verdicts verbatim, exactly-once stamp, terminal refusal,
append-only rows) · negative calibration retained · foreign
recommendation not-found · **calibration modulates the live search**
(evidence-overtakes-fit + failure-costs, aggregates + evidence ids) ·
`getCandidateCalibration` (aggregate / cold start / uniform not-found) ·
listRecommendations (newest-first, counts, AND-filters, retired-candidate
filter) · two-tenant isolation (same slug, no reads, no search/list
leakage).

Unit (32, pure — no database): vocabularies (node/edge kinds, staffing
profiles, risk tolerances, mirrored W132/W134/coverage lists,
twelve-axis canonical order) · guards (uuid, context) · registerCandidate
validation (round-trip + normalization, honest defaults, slug/node/edge/
route discipline, agent-body seam, applicability vocabularies) ·
recommendation validation (round-trip, config/score/rejection/evaluated-
set discipline, zero-winner) · calibration + search/list query validation
· `observedStaffingProfile` derivation · `contextualFit` (all-match,
all-misfit, blend, agnostic-null, unobserved, advisory-when-absent) ·
calibration arithmetic (Laplace, blend, polarity, aggregate) ·
`rankOrganizationCandidates` (THE CONTEXTUAL RULE purely, deterministic
ordering, evidence-overtakes-fit, failure-costs).

## Gates (run from the worktree root, exact commands and outputs)

- `timeout 300 bun run typecheck` — exit 0, zero errors
- `timeout 120 bun run arch` — exit 0, "architecture check passed —
  module files: 756, app/mcp files: 337, tables checked: 272"
- `timeout 240 bun run lint` — exit 0, zero errors
- `timeout 590 bunx vitest run src/modules/org-lab` — 2 files,
  **60/60 passed** (28 service + 32 unit), 0 unhandled errors

The full repository suite is deliberately NOT run — the TL owns the
integration battery. All W135 commits are local to `work/w135-org-lab`
(082a160 → 50d55b7 → 0e1b436 → de8a07e → this note's commit); the push
waits on the operator's PAT re-provision.
