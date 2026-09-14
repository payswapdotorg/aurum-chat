# ADR-0019 — Capability Outcome Learning

## Status

Accepted (promoted from FINAL-HARDENING.txt, lock 2.1)

## Decision

Every material intervention has:
- a baseline;
- an expected outcome;
- an intervention record;
- an observed outcome;
- variance/realized value;
- a learning update.

Outcomes are linked to the originating goal, recommendation, authorization and execution. Future recommendations may improve only through explicit, evidence-linked learning updates (CompanyModel intervention priors). Hidden outcome labels may never leak into recommendations.

## Consequences

- Failed interventions are retained as negative evidence, not discarded.
- Recommendation quality improvements are attributable to recorded learning, not prompt luck.
- The learning update path is the ONLY channel from outcomes to future behavior.

## Required verification

A fixture must show a successful and a failed intervention each changing future recommendation quality without changing policy, and prove no direct path from outcome labels to recommendations bypasses the recorded learning update.
