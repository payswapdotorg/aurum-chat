# Aurum Simulation Learning Log

**Status:** CANONICAL ACCUMULATION RECORD  
**Created:** 2026-09-23  
**Purpose:** Preserve findings from product/architecture simulations until the remaining simulation set is complete. This document is input to the later consolidated implementation plan and Tech Lead handoff. It is not itself an implementation commitment.

## Simulation S001 — Major User Journeys + Company Learning Substrate

### Mission tested

Simulate a user navigating the product according to the frozen Architecture v2.1 and test whether the actual implementation makes the capabilities discoverable and coherent. Then evaluate the architecture's ability to learn three industry-independent facts:

1. what Aurum needs to know to achieve a goal;
2. who knows what;
3. what is happening inside and outside the company.

### Findings

#### F1 — Goal-driven knowledge-gap discovery is a real implemented loop

Canonical path observed:

`Goal → desired state → evidence → evaluate current state → gap/unknown → LearningMission → acquisition candidates → source acquisition → evidence → mission resolution → world/CompanyModel learning`

W051 derives candidate unknowns without a user question. A gap can be based on a missing metric reading, an insufficiently known driver, or insufficient standing knowledge. Materiality is policy-gated and persisted as auditable evidence.

W011 makes the knowledge objective, affected goals, unknowns, importance, urgency, target/current confidence, information value, budget, candidates and completion criteria first-class.

W012 selects the next information-gathering action instead of blindly querying all sources.

**Conclusion:** The mechanism for answering “what do we need to know to achieve the goal?” is strongly implemented and structurally aligned with the frozen architecture.

#### F2 — Transactive/organizational knowledge is implemented, but cross-industry proof is incomplete

Employees are first-class knowledge sources. Source selection evaluates common dimensions across people and systems, including relevance, reliability, freshness, authority, expected quality, prior contribution value, cost and access scope. W053 CompanyModel learning includes employee expertise, source reliability, goal interpretation, investigation preferences and related organizational knowledge.

The important semantic separation is preserved: organizational authority is not treated as equivalent to actual knowledge quality.

**Conclusion:** “who knows what?” is architecturally and functionally supported, but current benchmark evidence is concentrated on the reference simulator world rather than independently varied industries.

#### F3 — Internal and external sensing is implemented as one evidence/world-model discipline

Internal state is represented through events, observations, people, systems, projects, suppliers, goals, processes, capabilities and other entities. External state is represented through EnvironmentWatch watchlists for competitors, regulators, government bodies, suppliers, laws, technologies, markets, industries, topics and geographies.

External flow:

`signal → observation → claim → company relationship → impact analysis → risk/opportunity → attention → mission/recommendation`

Freshness, aging/staleness, escalation and contradictions are first-class rather than silently hidden.

**Conclusion:** “what is happening inside/outside the company?” is strongly supported for information Aurum is authorized and able to observe.

#### F4 — Industry-agnostic core is real; cross-industry generalization is not yet proven to the same standard

The frozen core uses general primitives such as goal, person, employee, entity, event, observation, source, evidence, unknown, mission, capability, outcome and policy. Industry-specific work is expected to arrive through specialist agents/extensions.

The current W056 benchmark deliberately uses one hand-tuned reference-company structure whose seed varies identity-bearing details and monthly observations. It is excellent for attribution/determinism/leakage testing but is not a multi-industry benchmark.

**Conclusion:** “industry-independent by architecture” is supported. “consistent across construction, finance, healthcare, technology, etc.” remains an open empirical question.

#### F5 — Missing knowledge is explicitly representable, but persistent organizational pressure needs careful distinction

EnvironmentWatch has explicit freshness policies, escalation policies, stale-episode escalation and notification handoff. Briefings compile unknowns and other attention-worthy sections across continuous windows.

The current architecture therefore supports:

`missing/aging/stale information → escalation/briefing → notification`

It does **not** mean that every unknown is necessarily pestered forever. The correct intended behavior is priority-aware attention that can escalate while a gap remains material, while allowing policy and changing evidence to reduce or retire its priority.

**Follow-up simulation requirement:** verify the complete loop for a repeatedly unresolved unknown:
`unknown → prioritized mission → request/source suggestion → reminder/escalation → new evidence or explicit non-progress → re-evaluation → priority change/retirement`.

This should be treated as a product-behavior proof, not inferred from the existence of escalation primitives alone.

#### F6 — Cross-channel “new employee” model is supported at the domain boundary

The channels contract is explicitly provider-neutral and defines inbound/outbound canonical communication. It covers WhatsApp, Telegram, Signal, Slack, X, Instagram, Facebook/Messenger, LinkedIn, email, SMS/voice and web as provider availability permits.

A person can have multiple external identities linked to one verified person/employee. Provider payloads normalize to canonical communication events.

**Important implementation nuance:** the domain architecture supports employees remaining on their existing channels; Aurum does NOT require each employee to adopt Aurum Chat. However, actual outbound delivery is provider availability/configuration dependent. The contract explicitly allows transports to fail with `provider_unavailable` when a real transport is not wired.

**Simulation conclusion:** Aurum Chat should be treated as the canonical employee conversation surface for Aurum, not the mandatory communication endpoint for every human employee. Aurum can meet people where they already are when the corresponding adapter/connection is configured.

#### F7 — Agent creation, commercial packaging, proposal, lifecycle and governance are architecturally present

Marketplace supports AgentPackage publication through:
`DRAFT → SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW → APPROVED/REJECTED → PUBLISHED → INSTALLABLE → ACTIVE/SUSPENDED/DEPRECATED`.

Agents support persistent definitions, provider-independent execution, permissions, budgets, outcomes, evaluation and lifecycle controls. Agent recruitment/intervention surfaces compare alternatives and require human approval for consequential actions.

**Conclusion:** developers can package/publish governed agents; management can receive agent proposals; Aurum can track agent execution/outcomes and manage lifecycle under policy/approval. Final simulation must verify the full commercial/vendor → marketplace → tenant → proposal → approval → activate → measure → modify/terminate chain end-to-end.

### Current drift hypothesis from S001

Do NOT treat feature count as drift. Measure drift by capability/contract:

- **Architectural contract drift:** whether an architecture capability has no implementation path, a conflicting implementation path, or a provider-specific leak.
- **Behavioral drift:** whether the implemented behavior differs from the frozen semantics.
- **Discoverability drift:** whether the capability exists but cannot be reached through expected user intent.
- **Operational drift:** whether it works in development but not on the actual supported deployment.
- **Evidence drift:** whether the repository claims completion without evidence proving it.
- **Generalization drift:** whether a supposedly generic capability only works for the benchmark's reference world.

### S001 assessment

| Capability | Assessment | Evidence strength |
|---|---|---|
| Goal → knowledge gaps | Strong | High |
| Goal-driven learning missions | Strong | High |
| Source selection | Strong | High |
| Employee knowledge routing | Strong | Medium/High |
| Internal company sensing | Strong | High |
| External environment sensing | Strong | High |
| Freshness/staleness pressure | Implemented, end-to-end persistence loop should be simulated again | Medium |
| Cross-channel employee communication | Architecturally supported; real transport availability is configuration dependent | Medium/High |
| Agent marketplace/vendor packaging | Strong | High |
| Agent proposal/approval/lifecycle | Strong | High |
| Cross-industry generalization | Not yet proven | Low/Medium |

## Evidence anchors

- Frozen architecture: `spec/ARCHITECTURE.md`
- Implementation stack: `spec/IMPLEMENTATION-STACK.md`
- Dependency graph: `spec/WORK-ITEM-DEPENDENCY-GRAPH.md`
- Production certification contract: `spec/PRODUCTION-JOURNEY-CERTIFICATION-2026-09-23.md`
- Production journey certification: `docs/productization-evidence/W079/W079-PRODUCTION-JOURNEY-CERTIFICATION.md`
- Longitudinal benchmark: `spec/LONGITUDINAL-BENCHMARK.md`
- W051/W052/W053/W054/W055/W056 implementation history in GitHub main

## Aggregation rule for later simulations

Each future simulation should add:

1. **Observed capability** — what a real user/system can actually do.
2. **Architecture expectation** — what the frozen architecture requires.
3. **Drift type** — architectural / behavioral / discoverability / operational / evidence / generalization.
4. **Reproduction path** — exact user journey, API, contract or test.
5. **Impact** — low/medium/high, without collapsing independent issues into one score.
6. **Proposed implementation direction** — only after the simulation set is complete.
7. **Open question** — what still needs empirical proof.

The eventual Tech Lead plan should be synthesized from the complete accumulated log, not from this first simulation alone.
