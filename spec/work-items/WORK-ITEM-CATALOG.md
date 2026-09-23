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

### W079 — Production Journey Certification & Release Gate
Dependencies: W077, W078, W070, W076. Certify the complete end-user journey matrix against the real hosted production deployment. Require real production authentication, external PostgreSQL/Redis execution paths, desktop/mobile Chromium journeys, tenant isolation, Chat-first continuity, accessibility/discoverability, and two consecutive zero-failure/zero-blocked runs against the same deployment revision. Completion requires a committed machine-generated certification evidence tree and explicit CERTIFIED READY verdict. Preview/local evidence cannot satisfy this work item.


## Post-S002 organizational reach, integrations, realtime and provider-independence work

### W080 — Durable Agent Runtime Adapter
Dependencies: W013, W021, W034. Abstract durable orchestration behind an Aurum-owned workflow port. Support event triggers, schedules, waits, retries, human approvals, resumptions, idempotency, cancellation and long-running cognition. Orchestration providers must be replaceable without domain changes.
Acceptance: kill/restart workers during active runs; pending approval/employee wait survives; execution resumes exactly once or produces deterministic idempotent recovery; no workflow state is held only in worker memory.

### W081 — Integration Intelligence
Dependencies: W002, W036, W037, W058, W059, W061. Discover authorized organizational tooling, explain why connections matter, recommend safe connections, support bulk approval, automatic verification and a tenant-scoped Tool & System Inventory.
Acceptance: admin grants an approved discovery source; Aurum identifies systems/capabilities; shows outcome-oriented recommendations and scope impact; no uncontrolled network scanning; every discovered system is tenant-scoped.

### W082 — Universal Connection Broker
Dependencies: W081, W036, W037. Integrate OAuth, tokens, syncs and webhooks through provider-neutral adapters. Support a pluggable managed connection broker with Nango as the first candidate and equivalent alternatives.
Acceptance: connect/revoke/refresh; webhook/sync checkpoints; provider outages are localized; credential values never enter domain state; broker replacement does not change domain contracts.

### W083 — Progressive Capability Grants
Dependencies: W009, W081, W082. Start with safe read-only access and request write/action authority only when a concrete task requires it. Make every grant visible, scoped, auditable and revocable.
Acceptance: initial read-only connection; action invocation produces human-readable reason and exact requested scope; denial stops the write; later retry can request only the missing capability.

### W084 — Deep Action Gateway and Reconciliation
Dependencies: W009, W037, W080, W082, W083. Implement discover→inspect→propose→authorize→execute→verify→reconcile with evidence and outcome links across external systems.
Acceptance: multi-system task can execute from Aurum; action receipt and downstream state are verified; reconciliation detects mismatches and creates attention/evidence; provider objects never cross the gateway.

### W085 — Meeting Intelligence Gateway
Dependencies: W002, W004, W013, W036, W080. Create canonical meeting/session/transcript/artifact contracts and native Zoom/Teams/Meet adapters, plus optional cross-platform meeting-bot adapters.
Acceptance: meeting metadata, participant identity, transcript/artifact and provenance are captured into the canonical evidence model; provider-specific schemas remain inside adapters; failed/expired meeting access is explicit.

### W086 — Realtime Voice and Meeting Companion
Dependencies: W080, W085, W095. Implement provider-neutral realtime session contracts with a replaceable LiveKit adapter for Aurum voice, two-way meeting participation, Meeting Companion and telephony/SIP.
Acceptance: start/stop session, consent/recording state, interruption handling, speaker attribution, live transcript, spoken Aurum response, durable meeting artifact; transport provider can be swapped without domain rewrite.

### W087 — Cellular Reachability and Communication Fallback
Dependencies: W002, W009, W030, W031, W095. Implement outcome-oriented “Reach Anyone” using SMS and voice, telecom provider adapters, verified phone identity, delivery/reply state, routing, cost and policy controls. Recipient must not need Internet or Aurum.
Acceptance: manager can tell Aurum “Tell Sarah …”; Aurum resolves Sarah; sends SMS when reachable; falls back to voice when policy permits; recipient reply can return into Aurum; failed delivery is visible and retryable; manager can optionally initiate an SMS/voice request to Aurum itself when the manager has no usable Internet data.

### W088 — Aurum Edge Connector
Dependencies: W080, W082, W083, W084. Provide a customer-controlled runtime for private/on-prem APIs, MCP, OpenAPI, databases, files and approved browser adapters.
Acceptance: outbound-only connection where possible; signed tenant-scoped jobs; local secret handling; capability allowlist; health/version reporting; result normalization; no second organizational truth store.

### W089 — Provider Adapter SDK and OSS Technology Registry
Dependencies: W009, W034, W035, W036, W037. Standardize provider adapter lifecycle, conformance tests, health/capability mapping, provider hot-swap evidence and technology evaluation records including license/security/maintenance/exit path.
Acceptance: one template can produce at least two conforming providers for a representative gateway; provider selection stays outside domain logic; registry is reviewable by Tech Lead.

### W090 — Aurum Provider Billing Gateway
Dependencies: W009, W034, W080, W089. Abstract supported provider payment, usage, budgets and receipts behind Aurum. Use Aurum-mediated settlement when terms permit; direct customer billing is an explicit fallback.
Acceptance: provider cost can be attributed to tenant/capability/execution; budget policy can block/route usage; supported provider settlement produces an auditable receipt; unsupported direct-billing provider does not break capability flow.

### W091 — User-Friendly Provider Choice UX
Dependencies: W066, W080, W089, W090. Present provider selection as outcomes such as cost, privacy, quality, speed or organizational policy. Persist preferences and reveal technical details only in advanced settings.
Acceptance: ordinary user never needs provider jargon; preference can be changed at any time; system explains why a provider was selected; technical override remains available to authorized advanced users.

### W092 — Vertical Extension Starter Kits
Dependencies: W025, W026, W027, W084, W088. Create reusable specialist extension/agent starter kits and first deep integrations for system-of-record-heavy industries without moving vertical semantics into Aurum core.
Acceptance: each pack is installable, permission-scoped, versioned, auditable and removable; core modules remain industry-independent.

### W093 — Browser and Computer-Use Fallback
Dependencies: W080, W084, W088. Use governed browser automation only where APIs/MCP/native adapters are insufficient. Require verification, reconciliation, screenshots/action traces and evidence.
Acceptance: browser task is disposable and resumable; session credentials are isolated; observed state is verified before being treated as a result; failure produces actionable evidence.

### W094 — Migration and Dual-Run Continuity
Dependencies: W081, W082, W084, W092. Import history, preserve identifiers, synchronize during migration, compare legacy/Aurum results, support rollback and progressive retirement.
Acceptance: customer can run incumbent and Aurum in parallel; conflicts are surfaced; rollback is possible; no silent data loss or duplicate authority.

### W095 — Unified Cross-Channel, Meeting and Telephony Identity Verification
Dependencies: W002, W030, W085, W087. Extend identity proof so one person remains one organizational identity across messaging, meetings, SMS, voice and Edge Connector paths.
Acceptance: same verified employee can be recognized across at least three communication modalities; ambiguous matches remain external/unverified instead of being auto-merged.

### W096 — Integration Intelligence End-to-End Fixture
Dependencies: W081-W084. Prove discover→recommend→approve→connect→verify→map→observe→request action scope→execute→reconcile→outcome.
Acceptance: machine-readable fixture, browser evidence for admin UX, provider-failure case, denied-scope case and tenant-isolation case.

### W097 — Meeting and Cellular End-to-End Fixture
Dependencies: W085-W087, W095. Prove meeting transcript/artifact ingestion, Meeting Companion, SMS fallback, voice fallback and reply-to-Aurum continuity.
Acceptance: real provider evidence where credentials permit plus deterministic fixture; exact consent/policy behavior; recipient does not need Aurum or Internet; manager-originated SMS/voice request path is covered where supported.

### W098 — Persistent Agent Supervision and Recovery
Dependencies: W080, W021, W023, W024. Prove durable agent health, review schedules, budgets, waiting states, recovery and resumptions independent of worker lifetime.
Acceptance: worker/process failure does not terminate organizational actor state; review and lifecycle controls remain authoritative; budget and permissions survive resume.

### W099 — Matrix Interoperability Adapter (Optional)
Dependencies: W030, W089, W095. Add Matrix support only when a customer/use-case justifies it. Matrix remains a channel/interoperability adapter, never Aurum core infrastructure.
Acceptance: Matrix events normalize to canonical conversations/evidence; identity and policy checks remain Aurum-owned; Matrix can be disabled without altering core messaging.

### W100 — Longitudinal S003 Conversion Benchmark
Dependencies: W092, W094, W096, W097, W098. Re-run the multi-industry benchmark after the new integration/realtime/action capabilities. Measure Aurum-primary and Aurum-only willingness, context-switching reduction, integration setup effort, trust and realized value.
Acceptance: reproducible seeds, multiple firm sizes/industries, explicit baseline versus mature scenario, no hidden-ground-truth leakage, raw results committed.

### W101 — Final Post-S002 Production Certification
Dependencies: W096, W097, W098, W100 plus production infrastructure. Certify complete production journeys including cross-channel communication, meetings, cellular reachability, integrations, provider choice/billing, durable cognition and specialist execution.
Acceptance: two consecutive same-revision production runs, zero failed/blocked/flaky mandatory journeys, tenant isolation, approval authority, accessibility, evidence and rollback proof.
