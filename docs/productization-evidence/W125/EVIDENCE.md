# W125 EVIDENCE — Company Coverage Registry and Measurement Model

Worker: W125 (Wave 1, Worker A) · Branch: `work/w125-company-coverage`
Base: `debb222` (W124 — repository truth reconciliation; main at dispatch)
Date: 2026-10-04 (sandbox clock) · Worker session: 3 continuation turns

## Scope delivered (per spec/POST-W123-COVERAGE-DAG-2026-10-04.md W125)

- `src/modules/coverage/types.ts` — the TL-frozen shared contract vocabulary,
  derived 1:1 from COMPANY-COVERAGE-ARCHITECTURE.md §3–§5: the §5 state
  vocabulary (COVERED/PARTIAL/STALE/UNAVAILABLE/UNAUTHORIZED/EXCLUDED/
  UNKNOWN), the §4 dimension vocabulary (all nine, in documented order —
  "never compress all of them into one percentage"), the §3 object model
  (CoverageSurface / CoverageSource / CoverageClaim / CoverageGap /
  CoverageSnapshot) with tenant-scoped semantics and per-operation
  input/query shapes.
- `src/modules/coverage/contract.ts` — the only public surface (arch gate
  rule (b)); the declared W081/W082/W085/W095/W096 dependency world is
  the DERIVATION world and is deliberately not imported (audit module's
  verified-but-not-imported precedent, documented in the contract).
- `src/modules/coverage/errors.ts` — typed error codes; uniform
  not-found semantics (no cross-tenant existence leak).
- `src/modules/coverage/validation.ts` — pure validation + the W125
  measurement model: `rollupSurfaces` (§5 precedence), `measureDimensions`
  (nine separate dimensions; honest UNKNOWN for identity-continuity
  (W095), outcome-completeness (W040), goal-sufficiency (W127)),
  `deriveGaps` (§3 attention inputs; material ⇔ evidence exists but is
  deficient), `derivePolicyRestrictions` (§5 intentional absences).
  Credential-shaped keys and raw-credential source refs are rejected —
  §13 "credentials never enter coverage state" enforced at the input
  surface.
- `src/modules/coverage/service.ts` — the ten contract operations over
  the db port (`$n` placeholders), explicit TenantContext on every
  statement, injectable-clock timestamps, uuid identities.
- `src/modules/coverage/migrations/001-coverage.sql` — five tenant-scoped
  tables (coverage_surfaces/sources/claims/snapshots/gaps) with CHECK
  constraints mirroring the frozen vocabularies and append-only triggers
  on claims/snapshots/gaps (§3: "a later snapshot never rewrites an
  earlier one").
- `src/modules/coverage/tests/` — 55 tests: 40 pure (vocabularies frozen
  against the architecture doc, validation, measurement model) + 15
  integration against embedded PostgreSQL (PGlite `:memory:`).

## Required registrations (allowed ownership: "contract registration and
migration ordering")

- `src/app/api/health/lib.ts` — EXPECTED_TABLE_CENSUS 259 → 264 and the
  five coverage tables added to EXPECTED_TABLE_NAMES. The code's own
  instruction: "extend it whenever a migration adds a table." Without
  this the readiness probe reports 503 (verified failing → fixed →
  health suite 6/6 green).
- `src/modules/journey-proof/discoverability.ts` — the coverage module
  registered in the capability discoverability map (its test requires
  every src/modules folder to be mapped). Honest mapping: the registry
  is backend in W125; its product surface arrives with the W126 query
  plane; mapped to /intelligence where coverage context will appear.
- `.gitignore` — `coverage` → `/coverage` (root-anchored). The bare
  `coverage` entry (meant for the test-coverage output directory)
  silently ignored the entire `src/modules/coverage/` module; without
  this fix the module cannot be committed at all.

## Gates (run in this sandbox on this branch)

| Gate | Command | Result |
|------|---------|--------|
| typecheck | `bun run typecheck` | PASS (exit 0, 0 errors) |
| lint | `bun run lint` | PASS (exit 0) |
| arch | `bun run arch` | PASS — "module files: 708, app/mcp files: 331, tables checked: 255" (incl. the five new coverage tables; every table carries tenant_id) |
| build | `bun run build` | PASS (exit 0; full route table compiled) |
| test | `bun run test` | The repository's full suite exceeds this sandbox's single-command timeout, so it was executed in three batches (111 + 70 + 68 files, identical to `vitest run`'s own order): **2,599 tests passed, 0 new failures**. The only failures anywhere are the 4 intelligence-integration tests that are PRE-EXISTING on the base commit — verified identical (same 4 test ids, 4 failed / 9 passed on both base `debb222` and this branch; base run captured in a clean worktree). The module's own suites: 55/55. |

## Tenant-isolation evidence (ADR-0001)

`coverage-service.test.ts > tenant isolation (ADR-0001)`: tenant B's
registry/lists are empty where tenant A has state; cross-tenant
`getSnapshot` → uniform `snapshot_not_found`; cross-tenant `recordClaim`
→ uniform `surface_not_found`; independent evaluation per tenant. The
arch gate additionally verified tenant_id on all five new tables.

## Live / fixture / block classification

- FIXTURE (deterministic, in-repo): all 55 module tests (embedded
  PostgreSQL `:memory:`; clock-relative freshness fixtures so the
  measurement model is deterministic whenever the suite runs).
- LIVE: none in W125 — the registry's claims arrive from evaluator
  surfaces (W129 interaction adapters, W127 goal attention) that derive
  from real connector/evidence state; W125 itself owns no provider
  connection.
- BLOCK: none known for W125 scope. W126/W127 depend on this contract
  (additive extension points documented: CoverageGap.affectedGoalIds).

## The measurable promise (per the completion law)

The registry answers, per tenant, from recorded evidence: what portion
of the company it can currently see (breadth/depth), how reliable that
visibility is (freshness/provenance/confidence), what it is missing
(gaps + policy restrictions, stated honestly), and — through the frozen
W127 extension point — whether the missing visibility matters to the
company's goals. It never claims the company is fully covered; the
honest UNKNOWN dimensions say exactly what is not yet measurable.

## Exact commit

Exact commit: `3ebb231c72e94df9095d51c4dd16692efdd94215` (the commit that
adds this file). Pushed to origin and verified by `git ls-remote` ref
match.
