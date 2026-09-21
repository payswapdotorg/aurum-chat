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

## Learning moat (addenda promoted from FINAL-HARDENING.txt)

### W051 — Unprompted Unknown Discovery
Implement goal-gap discovery per ADR-0017: material goal/evidence gaps create candidate unknowns without a user question; candidate unknowns contain impact, urgency, confidence gap and information value; only material unknowns become missions; discovery is evidence-linked and auditable; end-to-end synthetic proof exists. Dependencies: W007, W008, W011, W013.

### W052 — Knowledge Source Ranking
Implement source ranking per ADR-0018: ranking is deterministic at the policy/workflow level; relevance, reliability, freshness, authority and cost are separately represented; ranking rationale is retained; employee and system candidates can be compared; synthetic tests prove routing changes when source evidence changes. Dependencies: W010, W012, W051.

### W053 — CompanyModel Learning
Implement the versioned CompanyModel per ADR-0016: durable company-specific learning stores vocabulary, organization, process exceptions, source reliability, employee expertise, capability patterns, investigation preferences and intervention priors; every learned assertion has provenance, confidence, validity and version; learned preference never overrides policy; provider/model replacement preserves learned state; longitudinal testing shows measurable improvement. Dependencies: W041, W042, W040, ADR-0016.

### W054 — Capability Outcome Learning
Implement intervention outcome learning per ADR-0019: interventions establish baseline/expected/observed/realized outcome; realized value and variance are recorded; failed interventions are retained as negative evidence; later similar recommendations use learned intervention priors; no hidden outcome labels may leak into recommendations. Dependencies: W018, W022, W023, W027, W040.

### W055 — Aurum Quality Measurement
Implement quality metrics: unknown-discovery precision/recall, source-selection quality, mission resolution efficiency, evidence quality, recommendation calibration, intervention success, realized value, investigation cost and time-to-useful-understanding. Metrics are tenant-aware, versioned and auditable and do not become business truth. Dependencies: W013, W041, W051, W052, W054.

### W056 — Longitudinal Company Simulator
Implement the synthetic company simulator: employees, teams, CRM/ERP-like systems, messages, projects, suppliers, goals, processes, external events and hidden consequential facts; run month 1/3/6/12/24 scenarios per LONGITUDINAL-BENCHMARK.md; prove repeated work improves source routing, unknown resolution efficiency or recommendation quality; prove no cross-tenant or hidden-ground-truth leakage. Dependencies: W053, W054, W055.

### W057 — Unified Product Shell & UX System
Dependencies: W033, W029.
Implement a ShareNet-dominant responsive shell and visual system, with Aurum's employee/product semantics, desktop rail/mobile bottom nav, command search, notification entry, context drawer, loading/empty/error patterns and tenant/workspace switcher.
Acceptance:
- desktop and mobile shells;
- no dense dashboard-only navigation;
- all major product areas discoverable;
- accessibility keyboard traversal;
- no glassmorphism/gradient chrome.

### W058 — Authentication, Sessions & Tenant Onboarding
Dependencies: W001, W002.
Implement auth/session domain and product entry flow; sign-in/sign-out/session renewal; company/workspace creation and selection; membership/invite flows; authenticated routing.
Remove the query/header tenant seam from normal user navigation. Preserve explicit TenantContext internally.
Acceptance:
- unauthenticated users cannot reach tenant data;
- tenant switching cannot cross scope;
- onboarding reaches usable Aurum chat;
- no development tenant parameter required in authenticated UX.

### W059 — Connection & Integration Hub
Dependencies: W002, W030, W036, W037.
Build user-facing connections center for channels, source systems and destinations.
Acceptance:
- connect/disconnect/configure;
- connection health;
- identity verification/linking;
- source freshness/checkpoint state;
- destination delivery state;
- tenant-owned credential references only.

### W060 — Aurum WhatsApp-like Chat
Dependencies: W013, W029, W034, W057, W058.
Build employee conversation UI and Aurum chat workflow.
Acceptance:
- conversation list;
- unread/new activity;
- message timeline;
- composer;
- streaming/working states;
- citations/evidence;
- action cards for goals/unknowns/missions/risks/opportunities/recommendations/approvals;
- links to management surfaces;
- responsive mobile layout.

### W061 — Intelligence Discovery & Briefing UX
Dependencies: W013, W051, W052, W057, W060.
Turn Today, goals, situation, unknowns, missions, risks, opportunities and capabilities into a discoverable intelligence workflow.
Acceptance:
- goal → gap → unknown → mission → evidence → belief path is navigable;
- proactive findings enter chat and Today;
- severity/urgency is legible;
- “why this matters” and “what Aurum needs next” are always visible.

### W062 — Learning Missions, Contributions & Rewards UX
Dependencies: W011, W012, W042, W043, W061.
Surface learning missions to management and employees.
Acceptance:
- mission detail/progress;
- ask/answer knowledge requests;
- evidence capture;
- contribution acknowledgement;
- reward status/history;
- no compensation/performance semantics leakage.

### W063 — Capability, Workforce & Agent Intervention UX
Dependencies: W018, W019, W022, W023, W024, W040, W062.
Surface capability-gap alternatives and the full agent/workforce lifecycle.
Acceptance:
- compare train/reassign/hire/automate/recruit/install/outsource;
- explicit uncertainty and evidence;
- proposal → approval → activation;
- team topology/budget;
- outcome tracking;
- retain/modify/terminate agent lifecycle;
- human employment decisions remain human-authorized.

### W064 — Extensions, Marketplace & Builder UX
Dependencies: W025, W026, W027, W028, W057.
Build developer/user marketplace surfaces.
Acceptance:
- browse/install;
- permission inspection;
- package status;
- submission/verification/review states;
- publish flow;
- install/activate/suspend/rollback;
- agent packages use the same governance surface.

### W065 — Evidence, Audit & Explainability UX
Dependencies: W046, W061, W063.
Build one causal evidence view.
Acceptance:
- reconstruct any consequential answer/decision;
- source reliability/freshness;
- contradiction display;
- policy evaluation;
- approval record;
- execution/outcome;
- learning update.

### W066 — AI/BYOA & Provider Routing UX
Dependencies: W034, W048, W058.
Build AI provider account management and routing interface.
Acceptance:
- add/verify/revoke tenant provider account;
- model availability;
- policy/routing configuration;
- cost/latency view;
- hot-swap test;
- no provider becomes architecturally privileged.

### W067 — Developer / API / MCP Console
Dependencies: W038, W039, W058, W066.
Build API key/scopes, webhook, MCP connection and developer activity surfaces.
Acceptance:
- create/revoke/rotate keys;
- scope visibility;
- webhook setup/test/redelivery;
- MCP connection instructions;
- auditable integration events.

### W068 — Deterministic Demo Tenant & Role Journey Harness
Dependencies: W049, W050, W056, W058.
Provide non-production seeded tenants/roles for browser verification.
Roles:
- manager;
- employee;
- developer;
- platform reviewer.
Acceptance:
- no production backdoor;
- deterministic data for every major journey;
- role-specific capability visibility.

### W069 — Free-Tier Deployment Foundation
Dependencies: W058, W059, W060.
Implement provider-neutral production adapters and deployment configuration.
Canonical dogfood stack:
- Vercel Hobby for the web surface;
- Neon Free PostgreSQL;
- Upstash Redis Free for queue/cache/lock when required;
- Vercel Workflows for durable/resumable cognition orchestration;
- Vercel Queues for durable asynchronous delivery where queue semantics are required;
- Vercel Blob Hobby for large objects;
- Resend Free for transactional email and invitations;
- GitHub Actions for CI.
The deployment must be treated as internal/non-commercial dogfood while Vercel Hobby is used.

Acceptance:
- real external PostgreSQL;
- real queue/worker execution;
- object storage path;
- email path;
- migrations;
- health/readiness;
- preview/staging/production environment separation;
- usage guardrails;
- observability.

### W070 — Browser Journey, Accessibility & Discoverability Proof
Dependencies: W057-W069.
Automate the end-user journey matrix on desktop and mobile.
Acceptance:
- first-run onboarding;
- manager chat;
- employee chat;
- goal → unknown → mission;
- evidence/explainability;
- recommendation → approval → outcome;
- learning contribution/reward;
- connections;
- BYOA;
- agent recruitment;
- marketplace;
- developer/API/MCP;
- mobile navigation;
- accessibility;
- no dead-end pages;
- every architecture capability has a discoverable user route.


## Post-W070 journey / deployment hardening

### W071 — WhatsApp-like Conversation Fidelity
Dependencies: W057, W060. Restore the full conversational product feel while preserving the ShareNet-dominant visual system. The chat must read as a modern messaging application through conversation-list hierarchy, Aurum identity/status header, message bubble hierarchy, compact metadata/read state, new conversation, composer ergonomics, mobile list/thread transition and quiet chat-specific states. No WhatsApp branding, colors or proprietary assets.

### W072 — Conversational Intelligence Continuity
Dependencies: W061, W065, W071. Make unknowns, missions, risks, opportunities, capabilities, approvals and evidence appear as reusable conversational cards with Open, Why and action affordances. Preserve the originating conversation/context across drill-downs and return to chat.

### W073 — Chat-based Learning Requests
Dependencies: W062, W072. Let Aurum ask targeted employee knowledge questions in chat, capture answers as evidence/contributions, acknowledge contributions, surface reward/recognition state and keep mission progress linked without compensation/performance semantics leakage.

### W074 — Conversational Interventions and Approval Continuity
Dependencies: W063, W072. Surface capability-gap alternatives, agent/workforce/automation proposals, human approval, activation and outcome state in the conversation while preserving detailed intervention surfaces and human decision authority.

### W075 — Natural Capability Discovery
Dependencies: W064, W066, W067, W071. Make all user-facing capabilities discoverable from Chat, More, command search or contextual prompts using task-oriented language. Critical capabilities may not be command-search-only.

### W076 — Real Browser Journey and Visual Conformance
Dependencies: W070, W071, W072, W073, W074, W075. Add real browser automation over the built/hosted app for desktop and mobile, with screenshot/console/network/accessibility verification. Prove the ShareNet-dominant shell and WhatsApp-like conversation fidelity in addition to functional journeys.

### W077 — Free-Tier Deployment Instantiation
Dependencies: W069. Create the real Vercel `aurum-chat` project and provision/connect Neon PostgreSQL, Upstash Redis, Vercel Blob, Resend and GitHub CI. Wire normal cognition to durable workflow/queue execution where available, retaining cron/HTTP only as bounded recovery. Verify environment separation, health/readiness, secrets and non-commercial Hobby guardrails.

### W078 — Post-Deployment Smoke and Operations Proof
Dependencies: W076, W077. Prove the hosted dogfood environment through real authentication, onboarding, chat, seeded journeys, durable execution retry/idempotency, health/readiness, queue/worker observability and release/rollback checks.
