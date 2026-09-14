# ADR-0018 — Knowledge Source Ranking

## Status

Accepted (promoted from FINAL-HARDENING.txt, lock 2.1)

## Decision

Aurum ranks possible knowledge sources using provider-independent signals:
- semantic relevance;
- historical reliability;
- recency/freshness;
- authority;
- access scope;
- expected answer/evidence quality;
- investigation cost;
- prior contribution value.

The ranking rationale is persisted and auditable. The Knowledge Acquisition Planner may choose among employees, managers, systems, documents, external sources, agents and analyses. Ranking is deterministic at the policy/workflow level: the same inputs and the same learned state produce the same ordering.

## Consequences

- Source selection is explainable after the fact (rationale record per decision).
- Learned source reliability (CompanyModel) modulates ranking without overriding explicit access policy.
- Employee and system candidates compete on the same measurable dimensions.

## Required verification

Synthetic tests prove source selection changes when reliability, freshness, relevance or cost changes, and that the persisted rationale identifies which signal caused the change.
