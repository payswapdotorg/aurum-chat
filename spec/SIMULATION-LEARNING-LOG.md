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

## S001 addendum — drift, cross-channel communication, persistent attention, agent commerce

### F8 — Architecture-to-implementation drift should be measured by contract, not feature count

The frozen architecture has 26 sections and the work-item system maps implementation work across those sections. Current code exposes concrete contracts for the core intelligence loop, world model, channels, environment watch, briefings, learning, CompanyModel, agents and marketplace. W079 also gives production evidence for the principal employee journeys.

A simple item-count ratio would therefore understate the remaining drift because the main residuals are semantic/operational/generalization boundaries rather than missing modules.

S001 working estimate, using a contract-weighted rubric:
- **~88–92% implementation alignment** with the frozen architecture;
- **~8–12% residual drift/uncertainty**.

The midpoint working figure is **~10% drift**. This is an analytical estimate, not a machine-generated repository metric. The main contributors are:
1. cross-industry generalization is not yet demonstrated at benchmark strength;
2. real provider transport availability is configuration/provider-dependent, even where canonical channel contracts exist;
3. persistent unresolved-gap “hammering” is represented by mission/briefing/escalation primitives, but the exact repeated-attention product loop still needs dedicated simulation;
4. marketplace supports governed agent packaging/publication/installability, but a commerce/payment/revenue-sharing layer is not present in the frozen marketplace contract;
5. latest main is newer than the exact W079-certified deployment revision, so W079 certification should not be silently inherited by a changed production revision.

### F9 — Aurum does not require every employee to use Aurum Chat

The channel architecture explicitly models Aurum as a participant that communicates through canonical provider-neutral adapters. One employee/person may have multiple ExternalIdentity records mapped to the same verified employee. W030 supports inbound normalization and outbound delivery for WhatsApp, Telegram, Signal, Slack, X, Instagram, Facebook/Messenger, LinkedIn, email, SMS/voice and web as provider availability permits.

Therefore the intended employee model is:

`employee remains on existing channel → Aurum meets them there → canonical conversation/evidence enters Aurum's intelligence loop`

Aurum Chat is the canonical Aurum conversation UX, not a mandatory replacement for every employee's existing communications tool.

Operational caveat: a provider connection/transport must actually be configured. The channels contract deliberately fails with `provider_unavailable` when a transport is not wired.

### F10 — Unresolved knowledge gaps can stay in management attention, but “hammering until resolved” needs explicit simulation proof

EnvironmentWatch implements freshness policies, stale-episode escalation and policy-snapshotted escalation records. Briefings compile continuous windows containing changes, goal drift, unknowns, risks, opportunities, capability gaps and approvals, and Notifications provides urgent/digest/escalation delivery with retries, dedupe, acknowledgment and escalation.

Learning missions also prevent repeated duplicate mission creation while an active mission covers the same gap.

The intended state machine is:

`gap → mission → acquisition attempt → unresolved → remain visible/escalated → re-evaluate → priority changes OR new acquisition path → resolved/retired`

However, S001 did not directly simulate multiple unanswered cycles through the live product. Future simulation must prove the user-visible “keep this in management attention until its information value/priority falls or it is resolved” behavior.

### F11 — Agent building/publishing is implemented; commercial selling is not yet evidenced as a first-class feature

Developers can create governed AgentPackages containing role, instructions, runtime provider and permissions; submit them; pass automated verification; undergo mandatory platform review; publish; and make them installable. This is a real vendor/platform governance path.

Aurum can also propose agent/capability interventions, require human approval, activate agents, track executions/cost/outcomes, and operate evaluation/lifecycle controls.

What is **not** represented in the current marketplace contract is a commercial transaction layer: listing price, checkout, payment settlement, marketplace revenue split, vendor payout, tax handling, subscription/license billing, etc. Therefore the accurate current answer is:

- build agent: **yes**;
- package/publish for governed marketplace distribution: **yes**;
- tenant install/activate through the full marketplace + extension/agent runtime stack: **architecturally yes, with the governed installation/runtime split**;
- propose an agent to management: **yes**;
- track performance/outcomes/cost: **yes**;
- terminate/disable under the agent lifecycle and management authority model: **yes** for agent/runtime/execution lifecycle operations; human employee termination remains prohibited;
- sell agents for money through an Aurum-native marketplace transaction system: **not currently implemented/evidenced**.

### Follow-up simulation queue

Prioritize these after the current simulation set:
- cross-industry worlds (construction / finance / healthcare / technology / additional industries) using the same intelligence-loop assertions;
- unresolved-unknown persistence and repeated escalation/deprioritization;
- real employee conversations across multiple provider channels with one person identity and one organizational knowledge graph;
- agent vendor → marketplace → tenant purchase/install → proposal → approval → activation → performance → modify/terminate lifecycle;
- explicit commerce requirements before adding any marketplace monetization work.

## S001 addendum — refined drift measurement

### F12 — Distinguish strict implementation drift from validation uncertainty

Using the 26 frozen architecture sections as equally weighted top-level contracts:
- 22 are implemented without a material semantic gap;
- 4 are partially evidenced/implemented at the boundary (not absent): real provider transport availability for channel/agent delivery, repeated unresolved-gap attention behavior, and cross-industry generalization evidence.

Treating each partial section as 50% complete gives:
`(22 + 4×0.5) / 26 = 92.3% alignment`

Therefore the **strict architecture-to-implementation drift is approximately 7.7%, rounded to ~8%**.

A broader **capability/evidence uncertainty remains around ~10%** because some concerns are not missing modules: they are deployment/provider configuration, unproven repeated-attention behavior, and the lack of a genuinely multi-industry benchmark. The earlier ~10% working estimate should be understood as this broader practical gap, not literal missing-code percentage.

## S001 addendum — provider-channel boundary

### F13 — Aurum is channel-agnostic, but only for the channels actually implemented/configured

W030's canonical provider vocabulary currently names WhatsApp, Telegram, Signal, Slack, X, Instagram, Facebook/Messenger, LinkedIn, email, SMS/voice and web. **Discord is not currently in that frozen vocabulary.** Therefore “employees can stay wherever they are” is true as an architectural pattern, but Discord specifically requires a future provider adapter/vocabulary addition before it can be claimed as a native Aurum channel.

Likewise, a channel contract existing is not the same as a live transport being configured. The channel module explicitly supports provider-independent registration/inbound normalization/outbound delivery but reports `provider_unavailable` when its transport is not wired/configured.

For in-person communication, there is no native physical-presence conversation channel in the current frozen implementation. In-person knowledge can enter through captured/transcribed evidence or another source adapter, but that is not the same as Aurum directly participating in the conversation.
