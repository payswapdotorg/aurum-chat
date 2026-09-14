# Aurum Chat — Frozen Architecture

**Status:** FROZEN
**Version:** 2.1
**Date:** 2026-09-14

## 1. Product definition

Aurum is an always-on organizational intelligence employee for a tenant/company. Its responsibility is to understand the company, its people, operations, capabilities and environment in real time; understand what management is trying to achieve; identify what it does not know that materially affects those goals; launch learning missions to close those knowledge gaps; expose evidence-backed intelligence to management; and recommend or execute authorized capability changes.

Aurum is not a vertical application. Customer support, project management, construction supervision, collections, sales operations, procurement operations, compliance execution and similar jobs belong to specialist agents, agent teams and software extensions recruited or installed under policy.

Conversation is a channel. The cognitive center is the company intelligence loop.

## 2. Canonical company intelligence loop

`observe → remember → understand → evaluate goals → detect gaps/unknowns → prioritize learning missions → acquire knowledge → update world model → detect risks/opportunities/capability gaps → recommend capability changes → execute when authorized → measure outcome → learn`

No single LLM owns this loop. Workflow state, authority, evidence and domain truth remain application-owned.

## 3. Tenant/workspace model

Aurum is multi-tenant. A tenant represents a company. Each tenant owns isolated workspaces, people, identities, channels, sources, destinations, knowledge, goals, policies, learning missions, rewards, agents, extensions, AI provider accounts, marketplace installations, executions and audit history.

Every persisted information-bearing object is tenant-scoped directly or through an immutable ownership chain. Cross-tenant data access is forbidden except through explicit platform-level operations that never expose one tenant's business knowledge to another.

## 4. Organizational world model

The world model represents internal and external reality through extensible entities and relationships.

Core entities include Person, Employee, Team, Manager, Customer, Supplier, Subcontractor, Competitor, Regulator, GovernmentBody, Product, Service, Asset, Location, Project, Process, Contract, Market, Industry, Technology, Agent, AgentTeam, Extension, Capability, Goal, Risk, Opportunity, LearningMission, KnowledgeContribution, Reward, and ExternalIdentity.

Events are immutable historical occurrences. Observations are evidence encountered by Aurum with provenance. Claims are propositions derived from evidence. Beliefs are versioned current working understanding. Hypotheses are unresolved explanations. Unknowns are consequential gaps in knowledge.

Reality is immutable; understanding is mutable.

## 5. Goals and desired state

Management defines goals with objective, desired state, metric/threshold, horizon, owner, priority, evidence sources and success criteria. Goals are versioned and auditable. Goal evaluation may create findings and learning missions but cannot bypass policy.

The goal model is the basis for prioritizing Aurum's learning effort.

## 6. Learning missions

A LearningMission is a persistent objective for acquiring knowledge required by a goal, decision, risk or opportunity.

It contains:
- knowledge objective/question;
- affected goals/decisions;
- unknown(s);
- importance and decision impact;
- urgency;
- target confidence;
- current confidence;
- expected information value;
- investigation budget;
- candidate evidence sources;
- candidate employees/managers;
- candidate systems and external sources;
- optional agent commission;
- reward budget;
- progress;
- completion criteria;
- evidence gathered;
- resulting belief/claim changes;
- outcome.

Mission planning chooses the next best information-gathering action rather than blindly querying every source.

## 7. Knowledge acquisition

Aurum has a Knowledge Acquisition Planner that selects among employees, managers, internal systems, documents, messages, structured business systems, external sources, agents and temporary analyses.

Employees are first-class knowledge sources. Aurum may ask an employee targeted questions when policy permits, record the resulting contribution, assess evidence quality, update the mission, and reward useful contributions.

Aurum maintains transactive memory: who knows, owns, decides, has experience with, influences, or can perform a capability.

## 8. Employee contribution and rewards

KnowledgeContribution records what information an employee supplied, the associated evidence, validation outcome, knowledge gain, goal impact and investigation cost avoided. RewardPolicy converts contribution value into configured rewards.

Rewards must never silently become compensation decisions or performance ratings. Contribution rewards are a separate policy-controlled mechanism.

## 9. Identity resolution and channels

A person may have multiple provider identities. ExternalIdentity links WhatsApp, Telegram, Signal, Slack, X, Instagram, Facebook/Messenger, LinkedIn, email, voice/SMS, web and other supported accounts to one verified person/employee within a tenant.

All channel adapters normalize into canonical communication events. Incoming messages enter evidence/perception. Outgoing messages are actions subject to communication policy.

Provider-specific message objects cannot leak into domain contracts.

## 10. Sources and destinations

Source connectors ingest authorized information from internal and external systems. Destination connectors publish authorized Aurum findings/results to analytics systems, warehouses, BI tools, CRMs, ERPs, spreadsheets, APIs and webhooks.

Both are provider-independent. Ingestion and delivery support idempotency, checkpointing, retries, replay/reprocessing, provenance and audit.

## 11. Epistemics and freshness

Evidence is provenance-bearing. Consequential beliefs expose supporting evidence, uncertainty, alternatives and what evidence could change the conclusion.

Every time-sensitive observation/source may carry freshness metadata, observation latency and stale-after policy. Aurum must be able to say whether its understanding is current, aging or stale.

Contradictions are retained rather than silently merged.

## 12. Environment watch and opportunity intelligence

EnvironmentWatch defines the external entities/topics/geographies/regulators/laws/competitors/suppliers/technologies/markets that matter to a tenant, with freshness and escalation rules.

External intelligence follows:
`external signal → observation → claim → company relationship → impact analysis → opportunity/risk → attention decision → mission or recommendation`.

Opportunity is a first-class object with evidence, estimated value, confidence, affected goals, required capability and recommended next action.

## 13. Process intelligence and capability acquisition

Aurum reconstructs how work actually occurs from observed events and identifies bottlenecks, repeated work, duplicated entry, unnecessary handoffs, errors, approvals and manual effort.

AutomationOpportunity connects observed process inefficiency to solution options:
- train employee;
- reassign work;
- hire human capability;
- recruit agent;
- recruit agent team;
- install marketplace extension;
- build new extension;
- outsource.

This creates the chain `process → capability → gap → acquisition option → authorization → deployment → outcome`.

## 14. Workforce intelligence

Workforce intelligence assesses role expectations, capabilities, workload, process context, outcomes and alternatives. It must separate observed behavior from interpretation. Employment-impacting results follow `evidence → assessment → alternative explanations → alternatives → recommendation → authorized human decision`.

Aurum never autonomously terminates a human employee.

## 15. Agent workforce

Agents are organizational actors with role, capabilities, permissions, contract, objectives, budget, expected outcomes, performance metrics, cost, owner and review schedule.

Agent lifecycle:
`PROPOSED → APPROVAL → RECRUITED → ACTIVE → EVALUATED → RETAIN / MODIFY / TERMINATE`.

AgentTeam is a first-class organizational actor composed of agents with roles, topology, shared objectives, budget, escalation rules and team-level outcomes.

AgentRecruitmentProposal compares existing capability, training, human hiring, automation, marketplace capabilities and agent alternatives before requesting approval.

Agent state is authoritative outside the LLM.

## 16. Agent gateway

Persistent agent definitions are separated from execution infrastructure:
`agent definition → Agent Gateway → runtime/provider adapter → execution → normalized result/evidence/cost/outcome`.

Agent providers/runtimes are replaceable. Execution is asynchronous, permission-scoped, retryable, traceable and idempotent where applicable.

## 17. Extensions and marketplace

Extensions are real software capabilities, not a fixed feature catalog. Runtime supports persistent tenant/install scoped state, host-rendered declarative UI, scheduled triggers, event subscriptions, scoped external participants, isolation, quotas, versioning, deployment, rollback, disablement, compatibility and telemetry.

Marketplace lifecycle:
`DRAFT → SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW → APPROVED / REJECTED → PUBLISHED → INSTALLABLE → ACTIVE / SUSPENDED / DEPRECATED`.

The same governance applies to AgentPackages. Publication never implies tenant installation or activation.

Platform approval is mandatory before third-party packages become installable.

## 18. AI/LLM gateway and BYOA

All AI/LLM capabilities use an application-owned gateway. Provider/model SDKs remain private to adapters. Capability, eligibility, authorization, policy, availability, performance, preference, cost and latency are distinct concerns.

Tenants may connect their own AI providers/accounts through AIProviderAccount records, with scopes, capability permissions, budgets, routing preferences and data policies. Aurum must remain usable without a privileged single provider.

Completed executions retain provider/model metadata for auditability; authoritative business state remains provider-neutral.

## 19. Cognition

Cognitive orchestration connects perception, evidence, world model, goals, attention, unknowns, learning missions, investigation, learning, capability analysis, recommendations and action policy.

Canonical execution:
`observation → evidence/memory → world update → epistemic evaluation → goal evaluation → unknown/mission evaluation → knowledge acquisition → model update → risk/opportunity/capability analysis → recommendation/ask/proposal/action → outcome → learning`.

Cognitive executions are explicit, asynchronous, resumable and traceable.

LLM calls are bounded reasoning capabilities, not workflow authority.

## 20. Action authority

Actions are classified as OBSERVE, ANALYZE, RECOMMEND, ASK, PROPOSE and EXECUTE. Tenant policy defines which authority levels and operations require human approval.

The authority matrix applies uniformly to employee messaging, source access, data export, agent recruitment, agent termination, extension deployment, external communications and other consequential actions.

## 21. Management control tower

The primary management surface is a control tower organized around:
- Today / changes;
- Goals;
- Situation;
- Unknowns;
- Learning Missions;
- Risks;
- Opportunities;
- Capabilities;
- Processes;
- Workforce;
- Agents and agent teams;
- Automation opportunities;
- Evidence / why Aurum believes it;
- Recommendations;
- Approvals;
- Audit.

Chat remains available for natural interaction.

## 22. Management briefings

Aurum proactively produces policy-controlled briefings summarizing meaningful changes, goal drift, unresolved unknowns, risks, opportunities, capability gaps, agent performance, automation candidates and decisions requiring management attention.

Briefings never become authoritative business state themselves; findings link to the underlying evidence and executions.

## 23. API and MCP

A public application API and MCP surface expose provider-independent Aurum capabilities, never raw database operations.

They may expose authorized operations such as querying company knowledge, inspecting goals, unknowns and missions, requesting investigation, reviewing findings, proposing agent recruitment, inspecting agents, retrieving evidence and interacting with approval workflows.

Every API/MCP operation is tenant-scoped, permission-checked and audited.

## 24. Audit and decision evidence

Consequential cognition/actions are reconstructable:
`input → evidence → claims/beliefs → unknown/mission → policy → model/provider → recommendation → approval → execution → result → outcome → learning`.

Audit records are append-only from the domain perspective.

## 25. Infrastructure

Initial deployment is a modular monolith.
- PostgreSQL is authoritative application/domain state.
- Redis is queues/cache/locks only.
- Object storage stores large artifacts.
- Workers execute long-running cognition/investigation/connector/action jobs.
- Executions carry correlation and causation identities.

## 26. Module ownership

Core modules:
auth, organizations, identity, people, world, events, observations, sources, destinations, memory, epistemics, freshness, goals, attention, investigation, missions, knowledge-acquisition, cognition, environment, opportunities, presence, processes, capabilities, automation, workforce, suppliers, actions, agents, extensions, marketplace, learning, rewards, conversations, channels, notifications, briefings, llm, audit, api, mcp.

Each module owns its domain and exposes public contracts. Cross-module internal imports are prohibited.
