# Tech Lead Handoff — Post-W070 Aurum Journey / WhatsApp UX / Deployment Hardening

**Repository:** `payswapdotorg/aurum-chat`  
**Baseline:** `af5c26c0a6edabca688c1fffb4b30c64e2a86ee7`  
**Architecture:** v2.1 frozen  
**Maximum concurrency:** 3 workers

## Read first

Canonical implementation plan:

`spec/POST-W070-JOURNEY-UX-DEPLOYMENT-PLAN-2026-09-21.md`

Work-item catalog:

`spec/work-items/WORK-ITEM-CATALOG.md`

Dependency DAG:

`spec/WORK-ITEM-DEPENDENCY-GRAPH.md`

## Repository finding

W001-W070 are delivered on current main.

The product now has:
- authenticated onboarding;
- `/chat` as the product root;
- connections;
- intelligence workflow;
- learning/rewards;
- interventions;
- marketplace/builder;
- explainability;
- AI/BYOA;
- developer/API/MCP;
- deployment adapters;
- deterministic demo roles;
- W070 route/discoverability proof.

The current problem is not missing backend architecture. It is product fidelity and deployment proof.

### Critical correction

The chat code is genuinely implemented, including conversation list, message bubbles, timestamps, unread state, composer, working state and approval cards. However, the current code explicitly demotes WhatsApp to an interaction model while ShareNet controls the visual system.

The required rule is now frozen as:

**ShareNet-dominant visual system + WhatsApp-like interface and interaction behavior.**

The conversation must unmistakably feel like a messaging application while remaining visually branded as Aurum/ShareNet.

### Proof correction

W070 is a strong SSR/API journey harness, but it is not a true browser automation run against a running app.

W076 is therefore mandatory before release.

### Deployment correction

W069 created the deployment foundation but the connected Vercel account still has no `aurum-chat` project.

W077 must instantiate the real dogfood deployment.

## Worker waves

### Wave 1
Worker A — W071: WhatsApp-like Conversation Fidelity  
Worker B — W075: Natural Capability Discovery  
Worker C — W077: Free-Tier Deployment Instantiation

### Wave 2
Worker A — W072: Conversational Intelligence Continuity  
Worker B — W073: Chat-based Learning Requests  
Worker C — W074: Conversational Interventions / Approval Continuity

### Wave 3
Worker A — W076: Real Browser Journey / Visual Conformance  
Worker B — W078: Post-Deployment Smoke / Operations Proof  
Worker C — Tech Lead integration/reconciliation only

## Non-overlap rules

- W071 owns chat visual/interaction chrome.
- W072 owns reusable conversational card/context semantics.
- W073 owns learning surfaces.
- W074 owns intervention surfaces.
- W075 owns navigation/command discovery.
- W077 owns deployment configuration/provider wiring.
- W076 and W078 own verification only.

Do not have workers concurrently modify the same primitive.

## Release gates

No release sign-off until all are true:

1. Anonymous → sign-in → onboarding → company → chat works.
2. /chat visibly reads as a modern WhatsApp-like messaging interface.
3. ShareNet remains the dominant visual language.
4. Intelligence findings can originate in or return to Chat.
5. Learning requests can be completed from Chat.
6. Intervention/approval workflows can be understood and continued from Chat.
7. Every major capability is naturally discoverable without knowing internal module names.
8. Real browser desktop/mobile journeys pass.
9. Real Vercel + Neon + Upstash + Blob + email dogfood environment exists.
10. Durable cognition execution is request/event driven with idempotent recovery; cron is recovery, not the primary cognition trigger.
11. PostgreSQL remains domain truth.
12. Tenant, provider, policy and human-approval invariants remain green.

Worker prose is never completion evidence; repository code, tests, browser evidence and deployment evidence are required.
