# Repository Source-of-Truth Contract — Aurum

**Canonical repository:** `payswapdotorg/aurum-chat`
**Canonical branch:** `main`

This file defines how future Tech Leads and workers must operate without relying on conversation
history.

## Canonical records

- Architecture: `spec/ARCHITECTURE.md`
- Frozen architecture lock: `spec/ARCHITECTURE-LOCK.md`
- Governance: `spec/GOVERNANCE.md`
- Work-item definitions: `spec/work-items/WORK-ITEM-CATALOG.md`
- Dependency DAG: `spec/WORK-ITEM-DEPENDENCY-GRAPH.md`
- Current state: `spec/CURRENT-STATE-2026-09-27.md`
- Machine-readable current state: `spec/CURRENT-STATE-2026-09-27.json`
- Current continuation DAG: `spec/POST-W106-CONTINUATION-DAG-2026-09-27.md`
- TL execution prompt: `spec/TECH-LEAD-ORCHESTRATOR-PROMPT-2026-09-27.md`
- Final takeover handoff: `spec/FINAL-TECH-LEAD-HANDOFF-2026-09-27.md`
- Current takeover snapshot: `spec/CURRENT-STATE-2026-10-04.md`
- Company coverage architecture: `spec/COMPANY-COVERAGE-ARCHITECTURE.md`
- Company coverage continuation DAG: `spec/POST-W123-COVERAGE-DAG-2026-10-04.md`
- Company coverage architecture change record: `spec/ARCHITECTURE-CHANGE-REQUEST-0002-COMPANY-COVERAGE.md`
- Production evidence: `docs/productization-evidence/<program>/`
- CI definition: `.github/workflows/ci.yml`

## Source-of-truth rules

1. A fact needed for implementation must exist in the repository.
2. A work-item status must be derivable from source/tests/evidence, not from chat prose.
3. A certification is bound to its exact deployment ID and exact commit SHA.
4. A later commit never inherits an earlier release verdict automatically.
5. A branch or PR is not delivery until its code is merged or deliberately recorded as the
   authoritative branch state.
6. A test count in prose is not evidence until the corresponding test execution and result are
   inspectable.
7. A deterministic fixture proves the contract path; it does not prove live-provider behavior.
8. A missing provider credential is an environment prerequisite, not permission to fake success.
9. Worker context must be reconstructible from repository files.
10. Every accepted implementation change must update the relevant work-item/evidence record so
    the repository stays internally consistent.
11. The latest dated current-state snapshot supersedes older takeover instructions for orchestration,
    while older snapshots remain historical evidence.
12. Company coverage is a derived observability view, not a second organizational source of truth.

## State-file law

The current-state file is a snapshot, not a second source of code truth. When main moves:

- update the snapshot's takeover SHA;
- record the new exact production revision only after verification;
- update the continuation frontier;
- preserve prior state as historical evidence rather than silently rewriting it.

## Worker context law

Every worker branch must contain or reference, through committed repository paths:

- the work-item definition;
- its dependencies;
- ownership boundaries;
- acceptance criteria;
- verification commands;
- known repository constraints.

A worker must be able to start from the repository alone.

## Evidence law

Prefer machine-readable evidence over prose. For user-facing journeys, retain screenshots,
transcripts, results and error captures where the certification contract requires them.

## Duplicate-work law

Before dispatching:

- inspect recent commits;
- inspect active branches/PRs;
- identify any previously delivered but unmerged worker work;
- do not dispatch the same work item twice;
- if duplicate trees exist, reconcile them once and record why one delivery is authoritative.

## Change-control law

Architecture changes require explicit versioned change control. No worker may silently modify
the frozen architecture to make a work item easier.

## Completion language

Use only these statuses unless the governing document defines a stricter vocabulary:

- **DELIVERED** — implementation + required tests/gates + required evidence are present.
- **CERTIFIED** — the exact certification contract passed for the exact revision.
- **BLOCKED** — a specified prerequisite/surface is absent and the evidence proves the absence.
- **FAILED** — a tested contract/journey violated its expected behavior.
- **OPTIONAL** — deliberately non-blocking work.

Never turn BLOCKED into PASS by weakening the assertion.

## Coverage truth law

Coverage claims must distinguish configured connectivity from actual observable evidence. A connected
provider is not proof of complete coverage. Coverage must expose freshness, authorization, provenance and
material blind spots, and those blind spots may enter the existing Unknown/LearningMission loop when
information value warrants investigation.
