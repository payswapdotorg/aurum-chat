# Aurum UX + Deployment Handoff — 2026-09-18

Status: AUTHORITATIVE IMPLEMENTATION ADDENDUM · architecture lock 2.1 remains frozen

## 1. Repository truth at handoff

Verified against current `main`:

- Repository: `payswapdotorg/aurum-chat`
- Current main SHA: `b41a696292e5447c476b09f44e04871413e38dba`
- W001-W056 implementation delivery commits are present in non-reverted history.
- Current implementation contains the management Control Tower UI under `src/app/(tower)/**`.
- Current app routes are the 15 tower surfaces: Today, Goals, Situation, Unknowns, Missions, Risks, Opportunities, Capabilities, Processes, Automation, Workforce, Agents, Evidence, Recommendations and Approvals.
- Root `/` redirects to `/today`.
- There is no `/chat` or employee-facing conversational UI route.
- There is no authenticated production session/tenant-selection flow; tower scoping currently uses explicit query parameters (`tenant`, optional `principal`, optional `authority`) as a documented development seam.
- No `src/modules/auth/**` implementation is present.
- No `scripts/worker.ts` is present even though the implementation-stack document describes a worker process.
- No `vercel.json`, `.vercel/project.json`, GitHub deployment workflow, or connected Vercel project named `aurum-chat` is present/known in the connected Vercel account.

The backend implementation and proof suites are therefore substantially ahead of the product interface and production runtime packaging.

## 2. User-journey simulation findings

The simulation was performed against the actual route tree, page implementations, navigation registry, interaction controls and cross-surface links.

### Journey A — New manager joins Aurum

Expected:
sign up → create company/workspace → invite employees → land in Aurum chat → start learning.

Current:
root → /today → explicit tenant query parameter is required → no authentication/onboarding → no employee invitation journey.

Result: BLOCKED for a normal end user.

### Journey B — Manager asks Aurum a question

Expected:
open Aurum → conversation appears like WhatsApp → type question → receive evidence-backed answer → inspect sources → ask follow-up.

Current:
no chat route, no conversation list UI, no composer, no employee/manager messaging surface.

Result: BLOCKED.

### Journey C — Aurum discovers an important unknown without being asked

Expected:
manager sees Aurum message/card → unknown explained in plain language → linked goals/evidence → start/review learning mission.

Current:
Today displays a "Latest goal-gap discovery pass" and open unknowns, but the content is not linked into the corresponding Unknowns/Missions/Evidence surfaces.

Result: discoverable only by manually navigating the sidebar; the causal chain is not navigable in context.

### Journey D — Aurum needs knowledge from an employee

Expected:
Aurum identifies the best employee/source → asks through the right channel → captures evidence → rewards useful contribution → mission updates.

Current:
the domain contracts support missions, acquisition planning, identity and channels, but there is no employee-facing chat/inbox UX, no visible source-selection explanation, no conversational question/answer workflow and no contribution/reward feedback surface.

Result: backend-capable, product-invisible.

### Journey E — Aurum finds a risk/opportunity/process inefficiency

Expected:
finding appears in chat/briefing → click to evidence → inspect affected goal → inspect process/capability gap → review recommended interventions.

Current:
Risk, Opportunity and Process pages are primarily read-only lists/tables. Findings do not consistently deep-link into the evidence, goal, mission, capability or recommendation that produced them.

Result: fragmented discovery.

### Journey F — Aurum recommends changing capability/workforce

Expected:
recommendation → explain alternatives → show evidence/uncertainty → review candidate human/automation/agent/extension options → authorize.

Current:
Workforce, Capabilities, Automation and Agents surfaces exist, but the normal navigation path between them is weak and there is no conversational decision flow. Human-impacting decisions remain correctly human-authorized.

Result: capability exists but decision journey is fragmented.

### Journey G — Manager approves a consequential action

Expected:
Aurum presents action in chat → evidence + policy + expected outcome → approve/reject inline → audit trail.

Current:
Approvals is the main interactive tower surface and uses a decision form. The manager must navigate to /approvals and the page currently explains the authority query-parameter seam.

Result: working control primitive, but not embedded into the employee-like experience.

### Journey H — Developer installs/builds an extension

Expected:
Marketplace → inspect package → verify permissions → install → open extension → developer console/builder → submit → pending review → publish.

Current:
backend extension/runtime/builder/marketplace modules exist, but there is no corresponding application UI route for Marketplace, developer console, extension builder or installation lifecycle.

Result: BLOCKED from normal user navigation.

### Journey I — Tenant connects its AI provider / external systems

Expected:
Settings → AI Providers / Sources / Destinations / Channels → authorize → verify scope → see health → manage/revoke.

Current:
LLM/BYOA, source, destination and channel modules exist, but there is no production-facing integration settings UI and no secure authentication/session layer connecting these controls to a tenant account.

Result: BLOCKED.

### Journey J — Manager learns whether Aurum is getting better

Expected:
Company Learning → evidence-backed learned preferences → intervention outcomes → quality metrics → longitudinal trend.

Current:
W040-W056 are implemented and tested, including quality and longitudinal benchmark modules, but the Control Tower does not make the learning loop a first-class navigable management journey.

Result: backend proof exists, UI proof is missing.

## 3. Product UI direction

The implementation MUST combine:

### ShareNet-inspired shell

Use `pectoraux/ShareNet` and `https://sharenet-conformance.vercel.app` as the visual reference for:

- warm/off-white background;
- calm, restrained typography;
- compact navigation with a clearly visible active state;
- desktop persistent sidebar;
- mobile bottom navigation;
- subtle borders and status pills instead of heavy dashboard chrome;
- generous whitespace;
- progressive disclosure through detail sheets/panels;
- plain-language labels;
- calm state indicators rather than decorative effects;
- responsive behavior designed as a first-class experience.

Do NOT copy ShareNet's information architecture or consumer-network semantics. Copy the interaction discipline and visual restraint.

### Aurum/WhatsApp-like product model

Aurum's primary surface is a conversation:

- chat list on the left/secondary rail;
- main message thread;
- composer anchored at the bottom;
- unread/attention states;
- human-friendly timestamps and presence;
- direct/group/company conversations;
- messages can contain evidence, missions, recommendations, approvals and capability cards;
- message actions open the relevant authoritative management surface;
- conversation is never authoritative truth; authoritative state remains in the domain modules;
- the same employee identity can appear across web, WhatsApp, Telegram, Signal, Slack, X, Instagram, Facebook/Messenger, LinkedIn, email and SMS/voice;
- provider identity is visible as metadata, never as the domain object;
- management Control Tower becomes a contextual workspace reachable from chat, not the first screen.

Recommended desktop structure:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Aurum                                                                      │
├──────────────┬──────────────────────┬───────────────────────────────────────┤
│ Primary nav  │ Conversations        │ Active conversation / intelligence     │
│              │                      │                                       │
│ Chat         │ Search               │ Aurum / Team / Employee               │
│ Intelligence │ Today                │ message thread                        │
│ People       │ Mission: …           │ evidence + actions inline             │
│ Agents       │ Finance team         │                                       │
│ Marketplace  │ Operations           │                                       │
│ Integrations │ Customer: …          │ [composer]                            │
│ Settings     │                      │                                       │
│              │                      │                                       │
│ ● Connected  │                      │                                       │
└──────────────┴──────────────────────┴───────────────────────────────────────┘
```

On mobile, use ShareNet's compact-header + bottom-nav pattern, with the conversation list and thread becoming separate stacked screens.

## 4. New implementation work items

These are implementation addenda. They do not change the frozen architecture or existing W001-W056 semantics.

### W057 — Chat-First Aurum Shell
Dependencies: W029, W030, W033.

Build the primary employee-like Aurum shell:
- ShareNet-inspired responsive shell;
- WhatsApp-like conversation list + thread + composer;
- company/employee/direct/group conversations;
- unread/attention state;
- mobile bottom navigation;
- desktop sidebar;
- accessible keyboard/focus behavior;
- no mock-only dead controls.

Acceptance:
- manager can open Aurum and reach a real conversation surface;
- an employee can open the same company conversation model;
- UI reads/writes through conversation/channel contracts;
- no domain state is persisted by UI components directly.

### W058 — Intelligent Navigation + Deep-Link System
Dependencies: W033, W057.

Turn the existing 15 Control Tower surfaces into a navigable intelligence graph instead of isolated pages.

Every finding/card/message that refers to another object must offer a contextual path:
finding → evidence → goal → unknown → mission → acquisition → recommendation → capability → approval → outcome → learning.

Acceptance:
- no major management card is a dead end;
- tenant scope survives every navigation transition;
- related-object links use stable IDs and authoritative contract/API reads;
- the user can always answer "why am I seeing this?" and "what can I do next?".

### W059 — In-Chat Intelligence Cards + Actions
Dependencies: W009, W013, W040, W057, W058.

Render first-class conversation cards for:
- unknowns;
- learning missions;
- source recommendations;
- risk/opportunity findings;
- process inefficiencies;
- capability gaps;
- workforce alternatives;
- agent recruitment proposals;
- agent teams;
- extension opportunities;
- recommendations;
- approvals;
- intervention outcomes;
- company learning.

Actions must remain policy-gated and must deep-link to the authoritative detail surface.

Acceptance:
- Aurum can explain a finding conversationally and expose its evidence;
- approval-required actions can be reviewed/approved from the conversation while preserving the canonical approval trail;
- no LLM output becomes authoritative merely because it appears in chat.

### W060 — Unified Channel Inbox + Identity UX
Dependencies: W002, W029, W030, W057.

Build tenant-facing channel and identity management:
- connect/disconnect provider;
- provider health;
- identity-linking/review;
- employee channel identities;
- source/provenance badges;
- channel-specific delivery status;
- conversation merge/split review;
- permission consistency.

Acceptance:
- one employee is not presented as multiple pseudo-employees;
- provider objects never leak into canonical domain contracts;
- manager can understand where a message came from and why Aurum is allowed to use it.

### W061 — Capability / Workforce / Agent Decision Center
Dependencies: W017, W018, W019, W021, W022, W023, W024, W028, W059.

Create the decision flow that turns intelligence into authorized capability change:
- compare train/reassign/hire/automate/recruit-agent/install-extension/outsource;
- inspect cost, expected value, uncertainty and evidence;
- inspect agent teams and budgets;
- retain human approval for consequential workforce decisions;
- inspect agent evaluation/termination proposals;
- link outcomes back to recommendations.

Acceptance:
- no employment-impacting action can be executed solely by UI suggestion;
- alternatives and uncertainty remain visible;
- agent lifecycle and extension lifecycle are understandable without reading architecture docs.

### W062 — Developer Console + Marketplace UX
Dependencies: W025, W026, W027, W028, W033, W038, W039.

Expose the complete extension/app/agent developer workflow:
- app/agent catalog;
- package detail;
- permissions;
- install/activate/suspend/deprecate state;
- extension builder;
- verification status;
- submission;
- pending-review status;
- platform approval;
- tenant installations;
- API/MCP developer access and credentials documentation.

Acceptance:
- third-party packages remain non-installable until platform approval;
- permission boundaries are visible before installation;
- developers can discover how to build/test/publish without accessing internal persistence.

### W063 — Integrations + AI Provider Console
Dependencies: W034, W035, W036, W037, W060.

Expose:
- BYOA AI provider accounts;
- model routing policy;
- provider availability/performance/cost;
- inbound source connectors;
- outbound destination connectors;
- connection health;
- credential scopes;
- revoke/reconnect flows;
- provider hot-swap status.

Acceptance:
- tenant owns its provider accounts;
- no provider is privileged;
- secrets never enter semantic memory or conversation transcripts;
- a provider swap preserves authoritative domain state and CompanyModel state.

### W064 — Auth + Workspace Onboarding
Dependencies: W001, W002, W038.

Replace the query-parameter tenant seam with production authentication/session resolution:
- sign up/sign in/sign out;
- tenant/workspace creation;
- membership/invitation;
- principal-to-tenant session mapping;
- role/authority claims;
- explicit admin approval where the product policy requires it;
- demo role entry only in explicitly marked demo mode.

Acceptance:
- no production page depends on `?tenant=` for tenant identity;
- every request has tenant + principal context;
- cross-tenant navigation cannot be created by URL manipulation.

### W065 — Product Journey / Accessibility / Responsive Conformance
Dependencies: W057-W064.

Create browser-level journey tests for at least:
1. onboarding;
2. manager chat;
3. employee chat;
4. unprompted unknown discovery;
5. employee knowledge acquisition;
6. risk/opportunity investigation;
7. capability/workforce recommendation;
8. approval;
9. agent recruitment/evaluation;
10. extension marketplace/install;
11. AI provider/BYOA;
12. source/destination setup;
13. longitudinal learning review;
14. API/MCP developer journey.

Also test:
- desktop;
- tablet;
- mobile;
- keyboard navigation;
- reduced motion;
- accessible names;
- focus order;
- error/empty/loading states.

### W066 — Free-Tier Production Deployment Baseline
Dependencies: W064, W065.

Target stack:
- Vercel Hobby for Next.js UI/API;
- Neon Free for authoritative PostgreSQL;
- Upstash Redis Free for queue/cache/lock backends;
- Vercel Blob or Upstash Blob for large artifacts;
- GitHub Actions for CI;
- Vercel Workflows/Queues for hosted durable background execution where it maps cleanly to W013 semantics.

Required:
- preview + production environments;
- environment-variable contract;
- migrations run explicitly;
- production database never falls back to PGlite;
- `DATABASE_URL` and `REDIS_URL` are required in production;
- domain and webhook URLs recorded;
- no secrets in git.

### W067 — Durable Cognition Runtime Deployment
Dependencies: W013, W066.

Preserve the domain contract while providing a hosted runtime for long-running executions:
- durable workflow/queue adapter;
- retry/idempotency/correlation/causation;
- resumability;
- tenant-aware execution;
- execution telemetry;
- failure replay;
- graceful provider/API timeouts.

The existing domain model remains authoritative; infrastructure merely supplies execution durability.

### W068 — Production Operations / Observability / Safety
Dependencies: W064, W066, W067.

Implement:
- structured logs;
- deployment error monitoring;
- runtime error grouping;
- migration smoke checks;
- DB backup/restore drill;
- free-tier usage guardrails;
- provider credential health checks;
- queue/workflow backlog alerts;
- rate limiting;
- webhook replay protection;
- deploy rollback procedure;
- production readiness checklist.

### W069 — Final UX + Deployment Acceptance
Dependencies: W065, W066, W067, W068.

Final proof must demonstrate:
- every architectural capability is either directly discoverable in the UI or explicitly exposed through API/MCP;
- no major user journey ends in a dead-end page;
- tenant/session isolation survives UI and API paths;
- policy gates remain intact;
- employee-impacting recommendations remain human-authorized;
- marketplace approval precedes installation;
- provider swap is observable;
- W049/W050 still pass;
- longitudinal benchmark still passes;
- production deployment is repeatable from the repository.

## 5. Three-worker orchestration

Maximum three workers. Never let two workers own the same UI/domain primitive concurrently.

### Wave A
Worker 1 → W057 Chat-first shell
Worker 2 → W062 Developer/Marketplace UX
Worker 3 → W064 Auth + Workspace Onboarding

### Wave B
Worker 1 → W058 Navigation + deep links
Worker 2 → W060 Unified channel/identity UX
Worker 3 → W063 Integrations + AI provider console

### Wave C
Worker 1 → W059 In-chat intelligence cards/actions
Worker 2 → W061 Capability/workforce/agent decision center
Worker 3 → W066 Deployment baseline

### Wave D
Worker 1 → W065 Browser journey/accessibility conformance
Worker 2 → W067 Durable cognition deployment adapter
Worker 3 → W068 Production operations/safety

### Wave E
Single Tech Lead / integration worker → W069 final acceptance

Before every work item:
1. inspect actual repository state;
2. verify dependencies in code;
3. read the architecture lock and this addendum;
4. implement only the bounded scope;
5. add regression tests;
6. run typecheck/test/arch/lint;
7. run relevant journey tests;
8. report exact commit and evidence.

## 6. Free-tier deployment plan

### Web/API

Use Vercel Hobby.

Vercel currently lists Hobby at $0/month and includes automatic CI/CD, 1M Function Invocations/month, 4 hours/month of Fluid Active CPU, 50K Workflow Events/month and 1M Queue API operations/month. Hobby functions have a 300-second maximum duration; durable workflows are therefore the preferred hosted execution primitive for long-running cognition rather than keeping a process alive inside a function.

### PostgreSQL

Use Neon Free.

The current Neon Free plan provides 100 projects, 100 CU-hours/project/month, 0.5 GB database storage/project and 10 branches/project. The database remains PostgreSQL, matching the frozen architecture.

### Redis

Use Upstash Redis Free.

Current free allocation: 256 MB data, 500K monthly commands and 10 GB monthly bandwidth. Redis is only used for queue/cache/lock semantics, never domain truth.

### Object storage

Use Vercel Blob or Upstash Blob behind a small repository-owned object-storage port.

Current free allocations are sufficient for early conformance/prototype workloads (1 GB storage and 10 GB/month transfer on both current free offerings).

### CI

Use GitHub Actions.

The repository is public, so standard GitHub-hosted runners are free for public repositories. CI should run typecheck, tests, architecture checks, lint and browser journeys.

### Production environment separation

Required environments:

- preview;
- staging/demo;
- production.

Each environment gets its own Neon branch and scoped Redis credentials. No preview environment may read production tenant data.

### Migration sequence

1. Provision Neon production branch.
2. Set production DATABASE_URL.
3. Run explicit migration runner.
4. Verify tenant-table invariant.
5. Provision Upstash Redis.
6. Set REDIS_URL.
7. Verify queue/cache/lock backend selection.
8. Deploy preview.
9. Run browser journey suite.
10. Promote only the validated artifact to production.
11. Run production smoke suite.
12. Enable scheduled/durable cognition.
13. Record exact deployment SHA.

## 7. Handoff acceptance invariant

Aurum is not considered product-complete merely because W001-W056 exist.

The next completion bar is:

```
backend intelligence
        +
employee-like conversation
        +
contextual management intelligence
        +
discoverable capability/action graph
        +
real tenant authentication
        +
durable hosted execution
        +
browser-level journey proof
        =
handoff-ready Aurum
```

The Control Tower remains a canonical management surface, but it is no longer the primary mental model of the product.
