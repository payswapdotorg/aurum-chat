# Aurum Work Item Catalog

Each item is independently reviewable. Dependencies are architectural contracts, not prose suggestions.

## Foundation

### W001 — Tenant and Workspace
Create tenant/workspace entities, membership roles, row/query isolation and tenant context propagation. Verify cross-tenant reads/writes fail.

### W002 — Identity Resolution
Create Person/Employee/ExternalIdentity models and a verified-linking workflow across supported channel providers. Verify duplicate provider identities can resolve to one employee without cross-tenant leakage.

### W003 — Events
Create immutable versioned domain event envelope with tenant, actor, source, correlation and causation fields. Verify ordering metadata and idempotency keys.

### W004 — Observations and Provenance
Record immutable observations with source, channel, timestamp, extraction lineage, permissions and confidence. Verify observation cannot be mutated into authoritative truth.

### W005 — World Model
Implement extensible entities/relationships for company, people, processes, capabilities and environment. Verify relationships are tenant-scoped.

### W006 — Temporal State and Freshness
Version mutable relationships/beliefs and track observation latency, source freshness and stale-after policy.

### W007 — Epistemics
Implement claims, beliefs, hypotheses, unknowns and contradictions with evidence links. Verify conflicting evidence is retained.

### W008 — Goals and Desired State
Implement versioned management goals, desired state, metrics, thresholds, horizon, owner and priority. Verify goal changes are auditable.

### W009 — Policy and Action Authority
Implement OBSERVE/ANALYZE/RECOMMEND/ASK/PROPOSE/EXECUTE authority matrix and deterministic approval gates.

## Cognition and learning

### W010 — Organizational Memory
Provide retrieval/storage contracts for evidence-backed organizational knowledge and transactive memory.

### W011 — Learning Missions
Implement first-class missions with knowledge objective, affected goals, information value, urgency, target confidence, budget, candidate sources/people, rewards and completion criteria.

### W012 — Knowledge Acquisition Planner
Choose the next information source/action among employees, managers, systems, documents, external sources, agents and analyses. Verify mission-driven targeted employee questioning.

### W013 — Cognitive Orchestrator
Implement the canonical company intelligence loop as explicit asynchronous/resumable executions with policy gates and outcome recording.

## Intelligence

### W014 — Environment Watch
Implement company-specific external watchlists with entities, topics, geography, regulators, competitors, suppliers, freshness and escalation policy.

### W015 — Opportunity Engine
Convert external/internal signals into evidence-backed opportunities with estimated value, confidence, affected goals and required capabilities.

### W016 — Process Intelligence
Reconstruct processes from events/observations; detect bottlenecks, duplication, handoffs, manual effort and errors.

### W017 — Capability Graph
Model capabilities supplied by employees, teams, agents, software, suppliers and partners; identify gaps and available alternatives.

### W018 — Automation Opportunities
Represent automation candidates with process evidence, frequency, cost, error rate, candidate solution types, expected ROI and outcome measurement.

### W019 — Workforce Intelligence
Assess workload, role/capability fit, performance signals and staffing needs while preserving alternative explanations and human decision authority.

### W020 — Supplier Intelligence
Score suppliers/subcontractors on price, quality, reliability, capacity, compliance, geography, switching cost and alternatives.

## Agent and software workforce

### W021 — Agent Gateway
Provider-independent execution contract with permissions, async execution, idempotency, retries, normalized results, evidence and cost.

### W022 — Agent Recruitment
Create AgentRecruitmentProposal comparing train/reassign/hire/automate/recruit/install alternatives. Approval is explicit.

### W023 — Agent Teams
Create agent-team topology, roles, shared objectives, budgets, escalation and team outcomes.

### W024 — Agent Evaluation and Termination
Measure outcome, cost, quality, utilization, security and replacement options; lifecycle changes follow policy.

### W025 — Extension Contracts
Define versioned extension manifests, permissions, lifecycle and verification states.

### W026 — General-Purpose Extension Runtime
Support persistent scoped state, declarative UI, schedules, event subscriptions, scoped external participation, quotas, isolation, deployment, rollback and telemetry.

### W027 — Extension Builder
Support design/build/verify/deploy workflow using an isolated agent execution environment and the general runtime.

### W028 — Marketplace Governance
Implement DRAFT→SUBMITTED→AUTOMATED_VERIFICATION→PENDING_REVIEW→APPROVED/REJECTED→PUBLISHED→INSTALLABLE lifecycle for ExtensionPackage and AgentPackage. Platform approval is mandatory.

## Experience and communication

### W029 — Conversation Domain
Persist conversations/messages with actor/source/provenance and links to cognitive executions without making conversations authoritative truth.

### W030 — Channel Adapters
Implement canonical adapters for WhatsApp, Telegram, Signal, Slack, X, Instagram, Facebook/Messenger, LinkedIn, email, SMS/voice and web as provider availability permits. Preserve provider isolation.

### W031 — Notifications
Implement policy-controlled urgent/digest/escalation notification delivery with retries, dedupe, acknowledgment and audit.

### W032 — Management Briefings
Generate policy-controlled proactive briefings for changes, goal drift, unknowns, risks, opportunities, capability gaps, workforce/agent performance and approvals.

### W033 — Management Control Tower
Build management UI around Today, Goals, Situation, Unknowns, Missions, Risks, Opportunities, Capabilities, Processes, Workforce, Agents, Automation, Evidence, Recommendations and Approvals.

## AI/platform surfaces

### W034 — LLM Gateway and BYOA
Provider/model registry, tenant-owned AI provider accounts, routing, availability, performance, cost, policy and hot-swap verification.

### W035 — Agent Provider Registry
Register multiple agent runtimes/providers and route execution without semantic provider coupling.

### W036 — Source Gateway
Provider-independent inbound connectors with OAuth/credentials isolation, polling/webhooks, checkpointing, replay and dedupe.

### W037 — Destination Gateway
Provider-independent outbound destinations for BI, warehouses, CRM/ERP, spreadsheets, APIs and webhooks with authorization and provenance.

### W038 — Public API
Versioned tenant-scoped API exposing capability-oriented operations and webhooks. No raw persistence access.

### W039 — MCP
Capability-oriented MCP server with tenant/principal context, policy checks and audit events. No raw database tools.

## Learning and rewards

### W040 — Outcome Measurement
Tie recommendations, agents, extensions and missions to measurable outcomes and expected-versus-realized value.

### W041 — Company Learning
Version company-specific usefulness/preferences from explicit, behavioral and outcome feedback without mutating policy silently.

### W042 — Knowledge Contributions
Record employee knowledge contributions, validation, knowledge gain, mission impact and investigation-cost avoidance.

### W043 — Rewards
Apply explicit reward policies to valuable knowledge contributions. Rewards are separate from compensation/performance decisions.

## Security and proof

### W044 — Tenant Isolation Verification
Automated authorization and integration tests proving every information-bearing module is tenant-safe.

### W045 — Identity/Channel Verification
End-to-end test that the same employee can communicate across multiple providers while permissions remain consistent.

### W046 — Decision Evidence/Audit
End-to-end reconstruction of input→evidence→belief/mission→policy→recommendation→approval→execution→outcome→learning.

### W047 — Capability Security Verification
Prove extensions, agents and marketplace packages cannot cross tenant/install/permission/sandbox boundaries.

### W048 — Provider Hot-Swap Verification
Run the same capability against multiple AI providers/models and agent runtimes without semantic migration or business code rewrite.

### W049 — Company Intelligence End-to-End Fixture
Prove: observation → goal relevance → unknown → learning mission → employee/system/external acquisition → belief update → opportunity/inefficiency → recommendation → approved capability change → measured outcome.

### W050 — Platform Surface End-to-End Fixture
Prove: employee identity across channels → conversation → cognition → management finding → API/MCP read → approval → notification → audit.
