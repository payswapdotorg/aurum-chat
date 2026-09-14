# ADR-0017 — Goal Gap Discovery

## Status

Accepted (promoted from FINAL-HARDENING.txt, lock 2.1)

## Decision

Aurum derives consequential unknowns from active goals, desired state, temporal state and evidence without requiring management to state the exact question.

Candidate unknowns carry:
- affected goals/decisions;
- missing knowledge;
- evidence basis;
- decision impact;
- urgency;
- confidence gap;
- expected information value;
- candidate acquisition paths.

Mission creation is application-owned, policy-gated and auditable. Unknown discovery is never an LLM assertion: the LLM may propose, the application decides, records and links evidence.

## Consequences

- Unknown discovery becomes an unprompted, continuous capability driven by goal-evaluation, not a question-answering feature.
- Every candidate unknown is reconstructable: which goal, which evidence, which decision impact produced it.
- Only material unknowns (sufficient decision impact and information value) may become LearningMissions, through the policy gate.

## Required verification

A synthetic company fixture where a hidden consequential variable causes an unprompted mission: no operator question exists anywhere in the transcript, yet goal + evidence evaluation produces the unknown, the mission and the acquisition plan.
