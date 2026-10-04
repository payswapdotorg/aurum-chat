# Architecture Change Request 0002 — Company Coverage

**Status:** APPROVED ADDITIVE / NO FROZEN-LOCK CHANGE

## Decision

The “company coverage” concept is approved as a derived, tenant-scoped product/application layer over the existing Aurum v2.1 architecture.

This is explicitly **not** a change to the frozen architecture lock.

## Why

Aurum's mission already requires:
- understanding the company in real time;
- provenance-aware evidence;
- goal-driven unknown discovery;
- learning missions;
- source and channel integration;
- consequential decision evidence;
- outcome measurement.

The missing product-level abstraction is the ability to quantify the observable surface itself and use its gaps as first-class signals.

## Constraints

The implementation must:
- derive coverage from existing domain state;
- remain provider-neutral;
- remain tenant/principal scoped;
- respect policy and authorization;
- preserve immutable evidence;
- expose freshness and provenance;
- avoid universal-surveillance semantics;
- integrate with Unknown/LearningMission/Outcome rather than create parallel cognitive loops;
- never make an LLM authoritative;
- never introduce a second organization truth store.

## Consequence

The repository may introduce a coverage module and query/application surface without modifying the frozen v2.1 core concepts.

The detailed shape is defined in spec/COMPANY-COVERAGE-ARCHITECTURE.md and work is bounded by spec/POST-W123-COVERAGE-DAG-2026-10-04.md.

## Review trigger

If implementation requires:
- a new authoritative organizational aggregate;
- a new authority/approval system;
- changes to tenant-isolation semantics;
- provider-specific objects in a domain contract;
- a replacement for the existing world/evidence model;

the worker must stop and create a new versioned architecture change request instead of silently expanding this decision.
