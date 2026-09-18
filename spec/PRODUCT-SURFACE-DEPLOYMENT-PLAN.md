# Aurum Product Surface, UX Journey & Free-Tier Deployment Plan

Status: CANONICAL IMPLEMENTATION PLAN · HANDOFF READY
Date: 2026-09-18
Target repository: payswapdotorg/aurum-chat
Architecture baseline: v2.1 (frozen)

This addendum follows the implementation of W000-W056. It does not change the frozen domain architecture. It converts the completed domain/platform capabilities into a usable employee-first product surface and defines the deployment path for a free-tier dogfood environment plus a later commercial environment.

## 1. Repository reality check

Current main at this plan revision: f380bedb44d60aa77907f61b9527a47bf5ad7dd0.

The repository now contains:
- the 43 implemented domain modules;
- the 15-surface Management Control Tower;
- conversations and channel adapters;
- identity resolution;
- source/destination gateways;
- LLM/agent gateways and BYOA contracts;
- extensions, marketplace, rewards, quality, simulator and longitudinal proof;
- tenant-isolation, identity/channel, provider-hotswap, capability-security and end-to-end proof suites.

However, the current product surface is incomplete relative to the architecture:
- `/` redirects to `/today`;
- there is no login/session/onboarding experience;
- the Control Tower requires an explicit tenant query/header development seam;
- there is no chat UI;
- most management surfaces are read-only with few/no drill-down or action affordances;
- there is no connector/connection center;
- there is no user-facing BYOA/provider configuration;
- there is no employee knowledge-contribution/reward experience;
- there is no marketplace/builder UI;
- there is no developer/API/MCP console;
- the architecture specifies `scripts/worker.ts`, but the repository currently has no worker process;
- there is no verifiable Vercel deployment associated with `aurum-chat` in the connected Vercel account and no `.vercel` project file.

The domain architecture is therefore substantially implemented, but the product is not yet an end-user-complete application.

## 2. User journey simulation

### Journey A — first-time company manager

Expected:
1. Open Aurum.
2. Sign in.
3. Create/select company workspace.
4. Invite employees.
5. Connect AI provider.
6. Connect channels/data sources.
7. Define first business goals.
8. Land in Aurum chat with a useful first briefing.

Current:
- Step 1 redirects to Today.
- Step 2 has no UI.
- Tenant scope must be supplied through a development query/header.
- There is no onboarding path.

Gap: CRITICAL.

### Journey B — talk to the Aurum employee

Expected:
1. Open Aurum.
2. See conversation list.
3. Open Aurum.
4. Ask a natural question.
5. Receive answer with evidence/context.
6. Follow links to a goal, unknown, mission, risk, opportunity, capability or approval.
7. Continue the investigation in chat.

Current:
- Conversation and cognition domains exist.
- No chat route or composer exists.
- No conversation list exists.
- No evidence/action cards exist.

Gap: CRITICAL.

### Journey C — discover something management did not ask about

Expected:
1. Aurum notices a goal/evidence gap.
2. Surfaces the unknown.
3. Explains why it matters.
4. Creates or links a learning mission.
5. Explains its chosen knowledge sources.
6. Shows progress and the resulting belief/claim update.
7. Notifies management when the decision-relevant understanding is sufficient.

Current:
- W051/W052/W053 implementations and proof exist.
- Today/Unknowns/Missions pages surface records.
- The pages do not form a clear clickable causal journey and do not expose the reasoning/source-routing path as an interaction model.

Gap: HIGH.

### Journey D — investigate a risk/opportunity/capability gap

Expected:
Situation → Risk/Opportunity/Capability → Evidence → affected goal → recommendation → approval/action → outcome.

Current:
- All required surfaces exist.
- Cross-links and drill-down behavior are insufficient.
- Most pages are list/report surfaces rather than navigable workflows.

Gap: HIGH.

### Journey E — approve a consequential action

Expected:
1. Aurum proposes an action.
2. User sees why, evidence, expected impact and policy.
3. User approves/rejects.
4. Aurum executes.
5. User sees outcome and later learning.

Current:
- Recommendations and approvals exist.
- Approval buttons work through the actions contract.
- Evidence/outcome linkage is mostly hidden in separate surfaces.

Gap: HIGH.

### Journey F — an employee helps Aurum learn

Expected:
1. Aurum asks employee a targeted question in their preferred channel/chat.
2. Employee answers.
3. Contribution is recorded as evidence/knowledge.
4. Employee sees contribution acknowledgement/reward.
5. Management can see knowledge coverage and contribution impact.

Current:
- Backend contribution/reward/channel primitives exist.
- No employee-facing learning/contribution UX exists.

Gap: HIGH.

### Journey G — connect the company

Expected:
Channels + SaaS sources + destinations → authorization → connection health → identity mapping → ingestion/delivery status → provenance.

Current:
- Provider-neutral adapters exist for multiple channels/sources/destinations.
- No connection hub/setup/status interface.

Gap: CRITICAL.

### Journey H — configure AI

Expected:
1. Add tenant-owned AI provider account.
2. Test connection.
3. Configure policy/routing.
4. Inspect cost/latency/availability.
5. Hot-swap provider without changing business semantics.

Current:
- LLM gateway and hot-swap proof exist.
- No user-facing configuration or testing UX.

Gap: HIGH.

### Journey I — recruit/monitor an agent

Expected:
Capability gap → alternatives → agent recruitment proposal → approval → agent/team active → execution/outcome → retain/modify/terminate.

Current:
- Backend lifecycle exists.
- Agent page is largely observational; recruitment/approval/outcome workflow is not surfaced as an end-to-end user journey.

Gap: HIGH.

### Journey J — install/build an extension or marketplace agent

Expected:
Discover → inspect permissions → install / developer publish → automated verification → pending platform review → approved → activate → monitor → suspend/rollback.

Current:
- Backend lifecycle/runtime/builder/marketplace governance exist.
- No product surface exposes it.

Gap: HIGH.

### Journey K — explainability/audit

Expected:
Any consequential answer or decision:
input → observations → evidence → belief/unknown → mission → source selection → policy → recommendation → approval → execution → outcome → learning.

Current:
- Audit/evidence primitives and W046 proof exist.
- No unified explainability view ties the chain together for users.

Gap: HIGH.

### Journey L — developer integration

Expected:
Developer opens console → API keys/scopes → webhooks → MCP connection instructions → event/API activity → revoke/rotate.

Current:
- API/MCP contracts exist.
- No developer console.

Gap: MEDIUM.

## 3. Product experience direction

Aurum should have two connected modes:

1. Employee mode — WhatsApp-like
   - conversation list;
   - Aurum as a persistent company employee;
   - message bubbles and compact timestamps/statuses;
   - natural language first;
   - action/evidence cards inside messages;
   - contextual side drawer on desktop;
   - full-screen conversation on mobile.

2. Management mode — Control Tower
   - current 15 intelligence/governance surfaces remain;
   - surfaces become drill-down destinations rather than the first discovery mechanism.

### ShareNet-dominant visual direction

Use `pectoraux/ShareNet` and `https://sharenet-conformance.vercel.app` as the primary visual and interaction reference. ShareNet should shape most of Aurum's visual system rather than merely influence the shell.

Adopt its:
- warm off-white canvas;
- soft graphite typography;
- restrained neutral palette;
- subtle teal/green semantic accents;
- generous whitespace;
- slim persistent desktop navigation;
- compact mobile header + bottom navigation;
- clear active navigation state;
- subtle hairlines and status pills;
- progressive disclosure through detail panels/sheets;
- quiet skeleton, empty and error states;
- restrained motion and accessible focus treatment;
- avoidance of glassmorphism, heavy gradients and dashboard visual noise.

Aurum's branding should remain subtle and secondary. Do **not** make gold/amber the dominant product palette. WhatsApp-like conversation density, message behavior and employee semantics remain the product interaction model, while the visual language is predominantly ShareNet-inspired.

Do not copy ShareNet's product semantics or information architecture.

### Canonical product shell

Desktop:
- left rail: Chat, Today, Intelligence, People, Connections, Marketplace, More;
- center: current workflow;
- optional right context drawer: evidence, why, related goal, mission, policy, approval/outcome.

Mobile:
- top: company + Aurum identity + presence/status;
- center: chat or selected surface;
- bottom: Chat / Today / Intelligence / People / More.

Global:
- Cmd/Ctrl+K command search;
- persistent tenant/workspace switcher;
- global notification/attention entry;
- deep links between chat and management surfaces.

### Chat discovery starters

The first Aurum conversation should expose useful examples:
- What needs my attention?
- What changed?
- What don't we know?
- How are we doing against our goals?
- Where are we inefficient?
- What should we improve?
- Show me why.
- What is Aurum learning about our company?

All generated findings should expose structured links/cards to the underlying domain objects.

## 4. New implementation work items

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

## 5. Dependency graph

```text
                         W057 UX SHELL
                       /      |       \
                      /       |        \
                 W058 AUTH  W069 DEPLOY W066 AI/BYOA
                    |          |           |
                    |          |           |
                  W059        W060       W067
                    |          |           |
                    +----+-----+-----------+
                         |
                 W061 INTELLIGENCE
                  /      |       \
                 /       |        \
              W062      W063      W065
                 |        |        |
                 +--------+--------+
                          |
                        W064
                          |
                        W068
                          |
                        W070
```

Detailed dependency anchors:

```text
W057 ← W033 + W029
W058 ← W001 + W002
W059 ← W002 + W030 + W036 + W037
W060 ← W013 + W029 + W034 + W057 + W058
W061 ← W013 + W051 + W052 + W057 + W060
W062 ← W011 + W012 + W042 + W043 + W061
W063 ← W018 + W019 + W022 + W023 + W024 + W040 + W062
W064 ← W025 + W026 + W027 + W028 + W057
W065 ← W046 + W061 + W063
W066 ← W034 + W048 + W058
W067 ← W038 + W039 + W058 + W066
W068 ← W049 + W050 + W056 + W058
W069 ← W058 + W059 + W060
W070 ← W057-W069
```

## 6. Three-worker orchestration

The Tech Lead may dispatch at most three workers. Never parallelize two workers over the same architectural primitive.

### Wave 1
Worker A: W057
Worker B: W058
Worker C: W069

### Wave 2
Worker A: W060
Worker B: W059
Worker C: W066

### Wave 3
Worker A: W061
Worker B: W062
Worker C: W063

### Wave 4
Worker A: W064
Worker B: W065
Worker C: W067

### Wave 5
Worker A: W068
Worker B: W070
Worker C: reserved for Tech Lead integration/reconciliation only

The Tech Lead remains the integration owner and must not treat a worker's prose as completion evidence.

## 7. Deployment plan

### Profile A — free-tier internal dogfood

Vercel Hobby:
- web/app hosting and preview CI/CD;
- explicit non-commercial/internal dogfood only.

Neon Free:
- PostgreSQL domain truth.

Upstash Redis Free:
- cache/locks/short-lived queue state if needed;
- never domain truth.

Vercel Workflows:
- durable, resumable multi-step cognition orchestration;
- steps can pause/retry/resume across crashes and deployments;
- Aurum's own persisted CognitionExecution remains the authoritative business record.

Vercel Queues:
- durable asynchronous message delivery for fan-out/background stages;
- at-least-once delivery, so Aurum consumers must remain idempotent;
- use only where queue semantics are actually needed; direct durable workflows remain preferred for single-owner orchestration.

Vercel Blob:
- documents, large evidence artifacts, extension artifacts and generated files.

Resend Free:
- invitations, verification, alerts and transactional mail.

GitHub Actions:
- typecheck, tests, arch gate, lint, migration smoke test and browser E2E.

AI:
- BYOA;
- deterministic seeded demo mode for no-key product demos;
- no single provider required for core operation.

### Profile B — commercial production

Replace the non-commercial Hobby host with a paid/business-capable hosting tier. Keep the same provider-neutral adapters so the domain architecture does not change.

Required:
- paid web compute;
- managed PostgreSQL with backups/restore;
- managed Redis/queue;
- durable object storage;
- transactional email;
- external AI/channel/source credentials;
- alerting and cost controls.

### Deployment pipeline

```text
GitHub PR
   ↓
CI: typecheck + test + arch + lint + migration smoke + browser journeys
   ↓
Preview deployment
   ↓
Seeded demo verification
   ↓
Staging
   ↓
real PostgreSQL + real queue + provider health checks
   ↓
production promotion
   ↓
post-deploy smoke + runtime health + queue health
```

Production configuration must include explicit environment variables for:
- DATABASE_URL;
- REDIS_URL where Redis is enabled;
- workflow/queue configuration;
- object storage credentials;
- auth/session secrets;
- application URL;
- email provider;
- tenant-owned AI provider references;
- tenant-owned channel/source/destination credential references.

Never store raw provider credentials in semantic memory, conversations, evidence or reports.

### Worker deployment requirement

The architecture already specifies a long-running cognition worker but `scripts/worker.ts` is absent from the current repository. W069 MUST close that implementation gap by creating the actual worker/HTTP execution seam without changing the W013 contract.

The deployment must prove:
- a queued execution resumes;
- one bounded stage is processed;
- the state/step is persisted;
- duplicate delivery is idempotent;
- a failed delivery is retried;
- approval/input suspensions survive worker restarts;
- the worker never becomes the source of domain truth.

## 8. Product acceptance gates

The release is not complete until:

1. A new user can sign in and reach an authenticated company workspace without query-string tenant scoping.
2. The primary interaction is a working Aurum conversation.
3. Chat can lead the user into every consequential management capability.
4. The Control Tower remains available as the management mode.
5. Goal → unknown → mission → evidence → belief is visible as a navigable chain.
6. Recommendation → approval → execution → outcome → learning is visible as a navigable chain.
7. Employees can contribute knowledge and see contribution/reward state.
8. Channels, sources, destinations and AI providers can be configured through the product.
9. Agents/extensions/marketplace are discoverable and governed from the product.
10. Evidence/audit is understandable without reading database identifiers.
11. Mobile is a first-class experience, not a horizontal-scroll adaptation.
12. Browser E2E proves every major journey on seeded tenants.
13. Tenant isolation, provider isolation and human-approval invariants remain green.
14. Commercial deployment does not depend on Vercel Hobby.

## 9. Source/design references

ShareNet implementation reference:
- https://sharenet-conformance.vercel.app
- https://github.com/pectoraux/ShareNet

Aurum architecture:
- `spec/ARCHITECTURE.md`
- `spec/ARCHITECTURE-LOCK.md`
- `spec/GOVERNANCE.md`
- `spec/IMPLEMENTATION-STACK.md`
- `spec/WORK-ITEM-DEPENDENCY-GRAPH.md`
- `spec/LONGITUDINAL-BENCHMARK.md`

Current UX evidence:
- `src/app/(tower)/**`
- `src/modules/conversations/**`
- `src/modules/channels/**`
- `src/modules/identity/**`
- `src/modules/sources/**`
- `src/modules/destinations/**`
- `src/modules/llm/**`
- `src/modules/extensions/**`
- `src/modules/marketplace/**`

## 10. Handoff instruction

This document is the authoritative implementation addendum for the product-surface/deployment phase. The Tech Lead must inspect the repository at the handoff SHA, verify every dependency directly, then dispatch workers only within the wave boundaries above.

The implementation plan is canonical for W057-W070. `spec/UX-DEPLOYMENT-HANDOFF-2026-09-18.md` is the concise tech-lead handoff wrapper and must not introduce a competing work breakdown.

No worker may redesign the frozen domain model. UX may expose, compose and navigate the existing contracts, but must not introduce a second source of organizational truth.

Completion evidence is repository code + tests + browser evidence + deployment evidence. Worker prose is never sufficient.
