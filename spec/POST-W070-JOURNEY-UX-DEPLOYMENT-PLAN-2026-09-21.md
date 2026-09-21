# Aurum Post-W070 Journey, WhatsApp UX & Free-Tier Deployment Hardening Plan

**Status:** CANONICAL POST-W070 IMPLEMENTATION PLAN  
**Date:** 2026-09-21  
**Repository:** `payswapdotorg/aurum-chat`  
**Current head verified:** `af5c26c0a6edabca688c1fffb4b30c64e2a86ee7`  
**Architecture:** v2.1 — FROZEN

This plan is the post-W070 hardening phase. It does not replace the frozen domain architecture and does not create a second organizational source of truth.

## 1. Repository truth

W001-W070 now have final delivery commits on the current main line.

The product surface has materially changed since the original W057-W070 handoff:

- `/` now redirects to `/chat`;
- authenticated sessions and tenant onboarding exist;
- `/chat` exists and is the employee-first product surface;
- connections, intelligence, learning, interventions, marketplace, AI/BYOA, developer and explainability surfaces exist;
- `scripts/worker.ts`, `/api/worker`, `vercel.json` and deployment adapters now exist;
- deterministic demo roles and a broad W070 journey/discoverability suite exist.

However, two release-level issues remain:

1. **WhatsApp-like interface fidelity has been diluted.**  
   The implementation explicitly defines WhatsApp as the interaction model while ShareNet defines the visual system. The rendered architecture therefore contains the right primitives — conversation list, message bubbles, timestamps, unread state, composer, working indicator, approvals — but the product can still feel like a ShareNet-style application containing a chat surface rather than an unmistakable messaging-first Aurum employee.

2. **The current W070 'E2E' proof is not a real browser automation proof.**  
   The journey suite renders real server components/HTML and calls the real route-adapter libraries, but it is an SSR/test-harness walk rather than a browser run against the running application. It is strong repository-level evidence but does not replace real desktop/mobile browser verification.

A third deployment fact is also important:

3. **W069 is implemented as a deployment foundation, not an instantiated deployment.**  
   The connected Vercel account currently has no `aurum-chat` project, so Aurum is not currently verifiably deployed there. The repository has the deployment adapters and configuration, but provider provisioning/project creation/post-deploy proof still need to occur.

## 2. UX rule correction — frozen for this phase

The required product rule is:

> **ShareNet-dominant visual direction + WhatsApp-like interface and interaction model.**

This is stronger than the previous wording "ShareNet visual language, WhatsApp interaction model."

### ShareNet controls

ShareNet remains the dominant source for:

- warm off-white canvas;
- soft graphite typography;
- restrained neutral surfaces;
- subtle teal/green semantic accents;
- generous whitespace;
- slim navigation;
- hairlines and restrained status pills;
- progressive disclosure;
- calm empty/loading/error states;
- restrained motion;
- accessible focus treatment;
- no glassmorphism and no gradient chrome;
- no gold/amber-dominant palette.

### WhatsApp-like controls

The Aurum Chat surface must visibly and behaviorally read as a modern messenger:

- conversation list as a first-class primary pane;
- identifiable Aurum contact header with avatar/name/status;
- familiar chat-thread hierarchy;
- member messages right-aligned and Aurum messages left-aligned;
- compact timestamps and delivery/read state;
- day separators;
- unread/new activity treatment;
- new-chat affordance;
- compact multiline composer;
- send affordance;
- message working/typing state;
- mobile conversation-list → thread transition;
- thread back navigation;
- conversation persistence and deep links;
- contextual cards embedded inside the message stream rather than replacing it;
- attachments/extension actions may be introduced only when backed by an actual product capability;
- context drawer is secondary and opens from the conversation rather than becoming the primary information architecture.

Do not copy WhatsApp branding, colors, logos or proprietary assets.

The rule is **not** "make every Aurum screen look like WhatsApp." The rule is that **Aurum Chat must feel like a real messaging product, while the surrounding Aurum application visually belongs to ShareNet.**

## 3. Simulated journey audit

### A — First-time manager

**Result: PASS at repository level; browser proof still required.**

Path proven by W070:

`anonymous → /signin → signup → session → /onboarding → create company → /chat`

The route gate prevents anonymous tenant access and a company-less authenticated session is redirected to onboarding.

Remaining usability requirement: after onboarding, the first screen must make the Aurum conversation feel obviously available without the user having to understand the product taxonomy.

### B — Talk to Aurum

**Result: IMPLEMENTED, UX-FIDELITY GAP.**

The current code proves:

`/chat → conversation list → thread → composer → cognition execution → answer → evidence/action cards`

The chat implementation has the intended primitives.

The gap is experiential: the shell still competes strongly for attention with the messenger surface. W071 must make the conversation unmistakably primary.

### C — Unprompted discovery

**Result: PASS at route/SSR level; needs chat continuity.**

Proven chain:

`goal → gap → unknown → mission`

The Intelligence hub and detail pages expose the chain. The key improvement is that proactive findings should also arrive as conversational messages/cards with a one-click return path into the relevant investigation.

### D — Risk / opportunity / process investigation

**Result: PASS at route/SSR level; navigation is more complete than before.**

The capability map and W070 journey tests now establish reachable routes for these surfaces.

Remaining improvement: investigations should preserve the originating chat conversation/context when a user opens a detailed management surface.

### E — Consequential approval

**Result: PASS.**

The repository proves:

`recommendation → human decision → activation → outcome`

and chat can decide pending approvals inline.

This interaction should become the default conversational pattern for all approval-bearing interventions, not only the seeded approval journey.

### F — Employee knowledge contribution

**Result: PASS at surface level; chat-first improvement required.**

The learning surface now exposes knowledge requests, contribution state and recognition/reward state.

The next UX step is to let Aurum ask the employee in the same conversation where the employee already works, with the Learning page acting as the supporting detail surface.

### G — Connect company systems

**Result: PASS.**

The connection hub exposes channels, source systems, destinations and identity mapping.

WhatsApp appears as an actual supported connection in the seeded journey.

Remaining improvement: when Aurum discovers that a missing connection is blocking an investigation, the conversation should link directly to the needed connection task.

### H — Configure AI / BYOA

**Result: PASS.**

`/ai` exposes multiple tenant-owned provider accounts and W070 exercises provider configuration without privileging one provider.

Remaining improvement: "Aurum cannot answer this because no suitable model is available" should lead to the provider configuration path from chat.

### I — Agent recruitment / workforce intervention

**Result: PASS at workflow level; chat continuity required.**

W070 proves capability gap → alternatives → proposal → approval → activation → agent detail.

Remaining improvement: recommendation cards should originate in or return to the Aurum conversation so the user does not experience the intervention subsystem as an unrelated application.

### J — Marketplace / extensions

**Result: PASS.**

Public catalog, package details, installed packages and developer review states are reachable.

Remaining improvement: More/Marketplace and contextual "install capability" prompts should make the marketplace discoverable without a user already understanding the package model.

### K — Explainability / audit

**Result: PASS.**

W065/W070 reconstruct consequential decisions and retain contradiction/evidence links.

Remaining improvement: every important chat answer and action card should offer `Why this?` and preserve enough context to reach the complete explanation without losing the conversation.

### L — Developer / API / MCP

**Result: PASS.**

The developer console exposes API key lifecycle, webhooks and MCP instructions.

Remaining improvement: make Developer discoverable through More/command search and contextual "Integrate Aurum" entry points, while keeping it out of the core employee chat chrome.

### M — Mobile

**Result: structurally PASS; real-browser visual proof required.**

The current implementation has a top bar, five-area bottom navigation and a one-pane-at-a-time chat mode.

W076/W078 must verify the actual rendered mobile experience and ensure chat opens as a true conversation screen rather than a cramped dashboard.

## 4. Capability discoverability result

The W070 capability map now covers the architecture modules with real product routes. The route graph is substantially complete.

The remaining distinction is:

**reachable** ≠ **naturally discovered**.

The next phase therefore measures discoverability from the user's primary mental model:

`Chat → contextual action → detail surface → return to Chat`

and:

`Chat → Search/More → capability hub`

No capability should require a user to know Aurum's internal module names.

## 5. New work items

### W071 — WhatsApp-like Conversation Fidelity

**Dependencies:** W057, W060.

Restore the full conversational product feel without changing Aurum's ShareNet-dominant visual system.

Scope:
- chat list hierarchy;
- Aurum identity/header/status;
- message bubble hierarchy;
- compact metadata/read state;
- thread controls;
- new conversation;
- search/filter affordance where already supported;
- composer ergonomics;
- mobile list/thread transition;
- empty/loading/error treatment inside the chat surface.

Acceptance:
- the first 5 seconds on /chat clearly read as a messaging application;
- ShareNet remains the visual language;
- no WhatsApp branding/colors/logos;
- chat occupies the dominant central visual area;
- management chrome remains available but visually secondary;
- desktop and mobile behavior are both intentional;
- keyboard and 44px+ touch-target checks pass.

### W072 — Conversational Intelligence Continuity

**Dependencies:** W061, W065, W071.

Make the intelligence graph live inside the conversation without making chat authoritative truth.

Scope:
- unified card presentation for unknowns, missions, risks, opportunities, capabilities, approvals and evidence;
- `Open`, `Why this?`, and relevant action affordances;
- stable `/chat?c=<conversation>` return links from management surfaces;
- preserve conversation/context when opening drill-downs;
- proactive findings delivered into chat;
- explainability context opens from the message/card.

Acceptance:
- no major intelligence workflow causes unexplained context loss;
- every consequential chat card has evidence/context;
- every drill-down can return to the originating conversation.

### W073 — Chat-based Learning Requests

**Dependencies:** W062, W072.

Move employee knowledge acquisition into the conversational experience.

Scope:
- Aurum asks targeted knowledge questions in chat;
- employee answer capture;
- contribution acknowledgement;
- reward/recognition state;
- evidence linkage;
- mission progress visible from the same thread.

Acceptance:
- an employee can complete a knowledge request without discovering the Learning route first;
- contribution/reward semantics remain separate from compensation/performance;
- management can inspect the same evidence chain from the supporting Learning surface.

### W074 — Conversational Interventions & Approval Continuity

**Dependencies:** W063, W072.

Make agent/workforce/automation recommendations conversationally actionable.

Scope:
- capability-gap cards;
- alternative comparison;
- proposal state;
- human approval;
- activation;
- outcome;
- retain/modify/terminate lifecycle context;
- human-employment safeguards.

Acceptance:
- a manager can understand a recommendation from Chat;
- approval remains explicitly human-authorized;
- post-action outcome returns to the originating thread;
- detailed intervention surfaces remain available for deeper management work.

### W075 — Natural Capability Discovery

**Dependencies:** W064, W066, W067, W071.

Ensure users can discover the full platform without knowing its internal taxonomy.

Scope:
- command-search task language;
- More hub grouping;
- contextual links from chat;
- connection prompts;
- AI/BYOA prompts;
- marketplace prompts;
- developer/API/MCP discovery;
- management-mode bridge.

Acceptance:
- every user-facing capability is reachable from Chat, More or contextual drill-down;
- no critical capability is command-search-only;
- labels describe user intent rather than internal modules;
- mobile reachability remains intact.

### W076 — Real Browser Journey & Visual Conformance

**Dependencies:** W070, W071-W075.

Add real browser automation on the built application.

Scope:
- desktop journeys;
- mobile journeys;
- browser screenshots;
- console/network error capture;
- authentication and tenant switching;
- chat list/thread/composer;
- contextual cards;
- all major W070 journeys;
- accessibility smoke;
- visual assertions for ShareNet-dominant shell + WhatsApp-like conversation.

Acceptance:
- actual browser automation, not only SSR rendering;
- no console errors in major journeys;
- no dead-end pages;
- chat visually passes the WhatsApp-like fidelity checklist;
- mobile chat is first-class.

### W077 — Free-Tier Deployment Instantiation

**Dependencies:** W069.

Turn the deployment foundation into a real hosted dogfood environment.

Canonical target:
- Vercel Hobby;
- Neon Free PostgreSQL;
- Upstash Redis Free;
- Vercel Blob;
- Resend Free;
- GitHub Actions;
- Vercel Workflows/Queues where they improve durable execution.

Important correction: the current W069 implementation exposes a worker plus daily cron/HTTP seam. That is retained as a recovery/sweep mechanism, but it must not be the primary cognition trigger for an employee product that is intended to react promptly. Use request-driven/durable workflow and queue execution for normal cognition stages; keep the cron sweep bounded and idempotent.

Acceptance:
- a real Vercel `aurum-chat` project exists;
- GitHub main is connected;
- preview deployments work;
- production dogfood deployment exists;
- Neon production database is external PostgreSQL;
- Upstash is used only for execution/cache/lock;
- Blob and email paths are real;
- Workflows/Queues are wired without changing W013 semantics;
- health/readiness passes;
- secrets are environment-scoped;
- no raw tenant credentials enter memory/chat/evidence;
- deployment is explicitly internal/non-commercial while on Hobby.

### W078 — Post-Deployment Smoke & Operations Proof

**Dependencies:** W076, W077.

Prove the deployed system rather than only the repository.

Acceptance:
- sign-in/onboarding works on the hosted deployment;
- Chat is the primary root experience;
- seeded demo journeys work;
- browser journeys pass on production dogfood;
- worker/workflow retry and duplicate semantics are observed;
- health endpoint is green;
- queue depth and worker metrics are inspectable;
- deployment rollback is documented;
- environment separation is verified.

## 6. New dependency graph

```text
                         ┌───────────────┐
                         │ ✅ W001-W070  │
                         └───────┬───────┘
                                 │
               ┌─────────────────┼─────────────────┐
               ▼                 ▼                 ▼
           ⬜ W071            ⬜ W075            ⬜ W077
        Chat fidelity     Capability discovery  Deployment
               │                 │                 │
               └────────┬────────┘                 │
                        ▼                          │
                    ⬜ W072                        │
          Conversational continuity                │
               ┌────────┼────────┐                 │
               ▼        ▼        ▼                 │
           ⬜ W073   ⬜ W074   (shared W072)       │
           Learning  Interventions                 │
                       /                          │
                      /                           │
                 └────▼──────────────┐             │
                    ⬜ W076           │             │
              Real browser proof     │             │
                         └──────┬────┘             │
                                ▼                  │
                            ⬜ W078 ◄──────────────┘
                         Hosted acceptance
```

## 7. Three-worker orchestration

Maximum concurrency remains **3 workers**.

### Wave 1
- Worker A → W071
- Worker B → W075
- Worker C → W077

No shared primitive ownership:
- A owns Chat presentation/interaction;
- B owns navigation/discoverability/More/command registry;
- C owns deployment/infra/configuration.

### Wave 2
- Worker A → W072
- Worker B → W073
- Worker C → W074

Ownership:
- A owns the reusable conversational-card/context contract;
- B owns Learning UX and contribution/reward presentation;
- C owns intervention UX and lifecycle presentation.

W073/W074 consume W072's card/context contract and must not fork it.

### Wave 3
- Worker A → W076
- Worker B → W078
- Worker C → reserved for Tech Lead integration, conflict reconciliation and release gating.

W078 cannot be signed off until W076 and W077 are green.

## 8. Free-tier deployment plan

Current provider reality:

- **Vercel:** no `aurum-chat` project currently exists in the connected teams, so there is no verified Aurum deployment yet.
- **Neon:** use the current Free plan for dogfood PostgreSQL; production remains PostgreSQL domain truth.
- **Upstash Redis:** current Free tier is sufficient for a small dogfood execution/cache layer.
- **Vercel Blob:** current Hobby allowance is sufficient for early document/evidence artifacts.
- **Resend:** current Free allowance is sufficient for internal invitations/transactional email at dogfood scale.
- **GitHub Actions:** use for all repository gates and browser conformance.

Current public plan limits should be treated as implementation-time guardrails rather than architecture:

- Vercel Hobby currently includes 1M function invocations/month, 4 Active CPU hours/month, 50K Workflow Events/month, 1M Queue API operations/month, and 1GB Blob storage with 10GB Blob data transfer included.
- Neon Free currently includes per-project free compute/storage allocations and branching suitable for preview/staging dogfood.
- Upstash Redis Free currently includes 256MB data, 500K commands/month and 10GB monthly bandwidth.
- Resend Free currently includes 3,000 emails/month and 100/day.

### Provisioning order

```text
1. Create Vercel project: aurum-chat
        │
2. Create Neon project + production DB
        │
3. Create preview/staging DB branches
        │
4. Create Upstash Redis database
        │
5. Create Vercel Blob store
        │
6. Create/verify Resend sending path
        │
7. Configure Vercel env sets
        │
8. Connect GitHub main + preview deployments
        │
9. Run migrations + health check
        │
10. Run seeded demo browser verification
        │
11. Promote dogfood production
        │
12. Run post-deploy W078 acceptance
```

### Environment matrix

```text
PR / Preview
  Vercel preview
  Neon branch database
  Upstash preview DB
  test Resend credentials
  preview Blob

Staging
  dedicated Vercel branch/project
  Neon staging DB
  Upstash staging DB
  staging Resend
  staging Blob

Dogfood Production
  Vercel Hobby aurum-chat
  Neon production DB
  Upstash production DB
  production Resend
  production Blob
```

### Execution model

Normal cognition:
`request/event → durable execution → bounded W013 stage → persist → next stage`

Queue/fan-out:
`event → queue → idempotent consumer → bounded stage`

Recovery:
`cron/manual sweep → find stuck work → re-enqueue through the same idempotent path`

Never:
`cron → custom reasoning loop → hidden state`

The worker/infrastructure layer never becomes domain truth. `CognitionExecution` and PostgreSQL remain authoritative.

## 9. Tech Lead release gates

Do not call Aurum release-complete merely because W001-W078 have delivery commits.

Release requires:

```text
✅ W001-W070 delivered
       +
⬜ W071-W075 UX correction complete
       +
⬜ W076 actual browser proof
       +
⬜ W077 real provider deployment
       +
⬜ W078 hosted acceptance
       ↓
Aurum dogfood release candidate
```

The specific UX gate is:

> Opening Aurum must feel like opening an organizational employee's messaging conversation, not like opening a management dashboard.

The specific visual gate is:

> The application should look predominantly like ShareNet; the conversation should behave and read visually as a modern WhatsApp-like messenger.

The specific deployment gate is:

> The hosted app must use real external PostgreSQL and real durable execution infrastructure; embedded/memory backends are development/test only.

## 10. Worker evidence contract

For every W071-W078:

1. inspect live repository before editing;
2. verify dependency SHAs;
3. read architecture lock and work item;
4. do not change W001-W056 domain contracts unless the Tech Lead opens an explicit architecture change request;
5. add/update tests;
6. run typecheck;
7. run lint;
8. run architecture gate;
9. run relevant unit/integration suites;
10. run real browser verification where the item requires it;
11. report exact commit SHA plus reproducible verification evidence;
12. never treat implementation prose as completion evidence.

## 11. Design invariants

These remain frozen:

- ShareNet-dominant visual system;
- WhatsApp-like Aurum conversation interface;
- chat is primary product entry;
- Control Tower remains management mode;
- PostgreSQL is domain truth;
- Redis/queues/workflows are infrastructure only;
- LLM/agent providers are replaceable;
- tenant isolation is mandatory;
- human employment decisions remain human-authorized;
- marketplace approval remains separate from installation;
- API/MCP expose capabilities, not raw persistence;
- no raw credentials in semantic memory/chat/evidence;
- no provider-specific object leaks into domain contracts.

