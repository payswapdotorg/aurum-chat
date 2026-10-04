# Post-W123 Company Coverage DAG — 2026-10-04

**Purpose:** convert the approved “make the company queriable / closed-loop” direction into bounded repository work.

**Workers:** maximum 3 concurrent.

**Architecture:** additive to frozen Architecture v2.1. No worker may silently alter ARCHITECTURE-LOCK.md.

## Baseline

Current main at planning time:
- SHA: 8836c080a4381771615fdbfafc46dde997b2569c
- Latest production deployment observed through Vercel: dpl_HHZeajTYPksduy1VnrR3KCku86d8
- Production Git SHA: 2733b3398e90159916062df4464d4896a382335a
- Production domain: https://aurum-chat-livid.vercel.app

Production is behind current main. No new coverage work may claim production certification until the exact deployed revision is verified.

## W124 — Repository Truth Reconciliation

Dependencies: none.

Update the repository's orchestration truth so the next TL/worker can operate entirely from current committed state.

Acceptance:
- current-state snapshot records current main SHA;
- current production deployment and SHA are recorded only as independently observed;
- W113–W123 and all later work are represented in a coherent continuation record;
- stale “next wave” instructions are explicitly superseded;
- canonical-source references point to the new coverage architecture and DAG;
- no historical evidence is rewritten.

Status at creation: DISPATCH FIRST.

## W125 — Company Coverage Registry and Measurement Model

Dependencies: W081, W082, W085, W095, W096; Company Coverage Architecture §2–§5.

Introduce the provider-neutral coverage contract.

Acceptance:
- tenant-scoped CoverageSurface/CoverageSource/CoverageClaim/CoverageGap/CoverageSnapshot semantics;
- separate breadth/depth/freshness/identity/provenance/temporal/outcome/permission/goal dimensions;
- COVERED/PARTIAL/STALE/UNAVAILABLE/UNAUTHORIZED/EXCLUDED/UNKNOWN states;
- derivation is evidence/connection based;
- no credentials in coverage state;
- coverage never becomes a second source of organizational truth;
- architecture and tenant-isolation gates pass.

Allowed ownership:
- new src/modules/coverage/ module;
- coverage migrations/tests;
- contract registration and migration ordering.

Do not touch:
- frozen world/observation/source/channel/meeting contracts except minimal additive exports if formally required;
- UI.

## W126 — Company Query Plane

Dependencies: W125, W007, W010, W013, W036, W037.

Create a provider-neutral query/read model over existing contracts.

Acceptance:
- queries are tenant/principal scoped;
- retrieves relevant company state through public module contracts;
- material results retain evidence/provenance/freshness;
- contradictions remain visible;
- answer includes structured coverage context;
- missing coverage that could materially change an answer is explicit;
- LLM generation is downstream of retrieval/epistemic assembly and never authoritative;
- API/MCP exposure is capability-shaped rather than raw persistence.

Allowed ownership:
- new query/application module and contract;
- query result types/tests;
- product API route and chat integration behind existing shell conventions.

Do not touch:
- provider-specific adapters;
- policy/action authority;
- frozen domain contracts unrelated to query.

## W127 — Coverage-to-Goal Attention Loop

Dependencies: W125, W126, W051, W052, W061.

Connect material coverage gaps to the existing goal/unknown/learning machinery.

Acceptance:
- material coverage gaps can become candidate unknowns;
- planner ranks investigation by information value and goal impact;
- stale or missing data can create knowledge-gap findings;
- non-material gaps do not create noise;
- resulting missions remain goal/decision-driven and policy-bounded;
- evidence explains why the gap matters.

Do not create a parallel “coverage agent”.

## W128 — Closed-Loop Deviation Monitor

Dependencies: W126, W127, W040, W054.

Connect observation/goal comparison to adjustment.

Acceptance:
- distinguish reality deviation from knowledge deviation;
- detect material deviations against goal desired state;
- select investigate/recommend/act paths through existing primitives;
- consequential action always uses W009 authority;
- resulting action is verified/reconciled;
- outcome is measured and feeds the existing learning-update path;
- longitudinal fixture proves the loop can reduce uncertainty or improve outcome quality.

## W129 — Business Interaction Coverage Adapters

Dependencies: W125, W126.

Define semantic normalization tests for coverage of:
- customer interactions;
- support tickets;
- projects/tasks;
- meetings;
- operational workflows.

Acceptance:
- at least three existing source/channel/meeting providers contribute evidence to the same semantic category;
- provider-specific objects remain inside adapters;
- identity resolution preserves one person/entity across supported sources;
- missing channels/systems produce honest PARTIAL/UNKNOWN coverage;
- no universal-capture claim is inferred from a single configured provider.

Reuse existing W030/W036/W085/W095 paths rather than introduce new provider abstractions.

## W130 — Coverage Benchmark and Certification

Dependencies: W124–W129.

Create the machine-checkable acceptance program.

Acceptance:
- tenant-isolation coverage tests;
- query correctness + provenance/freshness tests;
- coverage-gap → unknown/mission tests;
- closed-loop deviation/outcome tests;
- provider-failure/stale-data tests;
- contradictory-evidence tests;
- at least one live connected-source certification where credentials permit;
- exact deployment ID/SHA bound to production certification;
- coverage metrics are reproducible and longitudinal.

## Parallel waves

### Wave 0
W124 — repository truth reconciliation.

### Wave 1
After W124:
- Worker A → W125
- Worker B → W126
- Worker C → architecture/query UX contract review only; no implementation overlap with W125/W126.

### Wave 2
After W125 + W126:
- Worker A → W127
- Worker B → W129
- Worker C → targeted integration/testing reconciliation.

### Wave 3
After W127 + W129:
- Worker A → W128
- Worker B → W130
- Worker C → production/release readiness reconciliation.

Maximum 3 concurrent workers.

## Completion law

A work item is not delivered from narrative alone.

Require:
- code;
- tests;
- architecture gate;
- tenant-isolation evidence;
- machine-readable evidence record;
- exact commit;
- explicit live/fixture/block classification.

Never claim “the company is fully covered.”

The measurable promise is:

**Aurum knows what portion of the company it can currently see, how reliable that visibility is, what it is missing, and whether the missing visibility matters to the decisions the company is trying to make.**
