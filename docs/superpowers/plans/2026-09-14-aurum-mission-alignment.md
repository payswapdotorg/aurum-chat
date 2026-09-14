# Aurum Mission Alignment Implementation Plan

> For agentic workers: use the repository's work-item governance and verify each work item against the frozen architecture before implementation.

**Goal:** Implement Aurum as a multi-tenant organizational intelligence employee that continuously gathers company/environment information, learns against management goals, launches knowledge missions, orchestrates authorized agents/software, and exposes evidence-backed intelligence across chat, management surfaces, API and MCP.

**Architecture:** Preserve the existing world-model, epistemic, cognitive-orchestration and provider-gateway foundations. Add first-class tenant, identity, learning-mission, knowledge-acquisition, contribution/reward, opportunity, automation, agent-team/recruitment, marketplace-governance, destination, freshness, briefing, API and MCP primitives.

**Tech Stack:** Existing repository implementation stack is intentionally not fixed by this document; implementation must inspect the actual codebase before selecting or changing frameworks. PostgreSQL remains authoritative application state; Redis remains infrastructure-only.

**Spec:** `spec/ARCHITECTURE.md`

## Global constraints

- Conversation is a channel, not the cognitive center.
- Reality is immutable; understanding is mutable.
- Every business object is tenant-scoped.
- Unknowns and LearningMissions are first-class.
- LLM output is not authoritative truth.
- Provider-specific SDKs remain behind adapters.
- Marketplace packages require platform approval before installability.
- Employment-impacting decisions require human authorization.

## Execution sequence

1. Implement W001–W009 foundation contracts and tests.
2. Implement W010–W013 cognition and LearningMission loop.
3. Implement W014–W020 organizational intelligence in parallel once contracts stabilize.
4. Implement W021–W028 agent/extension/marketplace track.
5. Implement W029–W033 identity/channel/management experience.
6. Implement W034–W039 AI, source, destination, API and MCP surfaces.
7. Implement W040–W043 learning/outcome/reward track.
8. Implement W044–W048 security and provider verification.
9. Implement W049–W050 end-to-end fixtures.

## Work item review contract

For every work item, the implementer must provide exact files changed, tests added/updated, commands run, architecture checks passed, dependency evidence, and any known limitation. No completion claim is accepted from prose alone.
