# Company Coverage Architecture — 2026-10-04

**Status:** APPROVED ADDITIVE ARCHITECTURE
**Applies to:** Aurum v2.1 frozen architecture
**Purpose:** make “the company is queriable” a measurable, governed product property without changing the frozen core architecture.

## 1. Product thesis

Aurum should make the company queriable.

The company is represented through the authorized signals that describe its people, systems, conversations, meetings, work, customers, suppliers, processes, goals, environment and outcomes. Aurum turns those signals into a provenance-aware company model and exposes that model through an AI query plane.

The promise is not “Aurum has access to everything.” The promise is:

**Aurum can tell you what it knows, where that knowledge came from, how fresh it is, what parts of the company it can see, what it cannot see, and how those blind spots affect the decisions that matter.**

This keeps the claim honest while making coverage itself part of the product.

## 2. Coverage is not a second source of truth

Coverage is a derived, tenant-scoped view over existing Aurum state.

It MUST NOT become another organizational database.

Coverage derives from:
- authorized connections and declared capabilities;
- observed source/channel/meeting/system activity;
- identity resolution;
- ingestion freshness/checkpoints;
- world-model entities and relationships;
- goals, desired states, learning missions and decisions;
- evidence and provenance;
- connector health and authorization state;
- explicit exclusions and policy.

PostgreSQL remains authoritative domain state. Coverage describes the observable surface of that state.

## 3. Coverage object model

### CoverageSurface

A logical area of company reality that Aurum may observe, such as:
- people and organizational structure;
- customer interactions;
- support tickets;
- sales opportunities;
- projects/tasks;
- meetings;
- internal communications;
- finance;
- operations;
- suppliers;
- documents/knowledge;
- external environment;
- agent/extension activity.

A surface is provider-neutral. “Support tickets” is a semantic category; Jira, Linear, Zendesk and another system are provider implementations.

### CoverageSource

An authorized source capable of contributing observations to a surface.

It references the existing source/channel/meeting/integration registries through opaque IDs. Credentials never enter coverage state.

### CoverageClaim

A derived statement about observability.

It retains:
- tenant;
- surface;
- source reference;
- observation basis;
- current state;
- freshness;
- confidence;
- evaluation time;
- reason/explanation.

### CoverageGap

A material missing or stale portion of company observability.

Examples:
- no support-ticket system connected;
- meetings are connected but recordings are disabled;
- CRM sync is authorized but stale;
- customer messages are captured on one channel but not another;
- project tasks are visible while associated delivery events are not;
- a goal depends on a business surface whose coverage is insufficient.

A gap is an attention input, not merely a dashboard warning.

### CoverageSnapshot

An immutable-at-evaluation-time summary of the company's observable surface.

It answers:
- what surfaces are covered;
- which sources provide that coverage;
- approximate completeness;
- freshness;
- confidence;
- policy restrictions;
- unresolved gaps;
- goal/decision impact.

A later snapshot never rewrites an earlier one.

## 4. Coverage dimensions

Aurum evaluates coverage across separate dimensions. Never compress all of them into one percentage.

### Breadth

What company domains are represented at all?

### Depth

For a covered domain, how much of the relevant object graph is observable?

### Freshness

How current is the latest usable observation relative to the source freshness policy?

### Identity continuity

Can records be joined confidently to the same organizational person/entity across systems?

### Provenance completeness

Can an answer trace material claims back to evidence?

### Temporal completeness

Can Aurum see sufficient history rather than only the latest state?

### Outcome completeness

Can observed actions be connected to measurable outcomes?

### Permission completeness

Is the relevant data actually authorized for Aurum to read/use for the requested purpose?

### Goal sufficiency

Is coverage sufficient for the tenant's current important goals and decisions?

Goal sufficiency is the most important product-facing dimension. A company can have broad coverage while remaining dangerously blind to one critical goal.

## 5. Coverage states

Use a small provider-neutral vocabulary:

- **COVERED** — sufficient authorized evidence exists and freshness is within policy.
- **PARTIAL** — some expected evidence exists, but material portions are missing.
- **STALE** — evidence exists but has exceeded its freshness policy.
- **UNAVAILABLE** — source/provider cannot currently be accessed.
- **UNAUTHORIZED** — coverage is intentionally absent because authorization is missing/revoked.
- **EXCLUDED** — policy explicitly excludes this information.
- **UNKNOWN** — Aurum lacks enough evidence to classify the surface.

These are not provider states and must not expose raw provider error codes to ordinary users.

## 6. Query plane

The company query plane sits above the world model, epistemics, memory, observations, sources and coverage view.

A query MUST:
1. resolve tenant and principal context;
2. determine the requested company scope;
3. retrieve relevant canonical records through module contracts;
4. consider coverage for the requested scope;
5. distinguish observed facts, derived beliefs, hypotheses and unknowns;
6. attach provenance and freshness to material claims;
7. identify material coverage gaps that could affect the answer;
8. preserve uncertainty and contradictions;
9. produce an answer through the LLM Gateway when language generation is needed;
10. never allow LLM output to become authoritative truth.

A query response has two layers:

**Answer** — the best evidence-backed response.

**Coverage context** — what was visible, what may be missing, freshness/authorization caveats, and which gaps could materially change the answer.

The UI may summarize Coverage context, but the underlying structured representation must remain machine-readable for API/MCP consumers.

## 7. “Every meeting / every ticket / every interaction” interpretation

The product must never claim universal capture merely because a connector exists.

Aurum should answer questions such as:
- “How much of our customer support history can you see?”
- “Which meetings from the last 30 days are represented?”
- “Are there customer conversations outside the connected channels?”
- “Which tickets affecting Goal X are missing or stale?”
- “What percentage of the evidence required for this decision is currently observable?”
- “What would we need to connect to close the remaining blind spot?”

For a surface to be represented as broadly covered, Aurum needs explicit evidence of relevant source classes and freshness, not just a configured integration.

## 8. Closed-loop monitoring

Coverage becomes valuable when combined with the existing company intelligence loop.

The closed-loop chain is:

**observe → model → compare with goals → detect knowledge/coverage gaps → investigate → recommend → authorize → act → measure outcome → learn**

The monitoring layer detects two classes of deviation.

### Reality deviation

“What is happening differs from the desired state.”

Examples:
- support response time exceeds the target;
- project delivery is slipping;
- supplier lead time worsened.

### Knowledge deviation

“Aurum cannot reliably determine whether reality meets the desired state.”

Examples:
- CRM is stale;
- important meetings are not captured;
- ticket history is incomplete;
- customer messages exist outside connected channels;
- a material process step leaves no observable event.

Knowledge deviation is itself a business risk.

## 9. Coverage-driven attention

Coverage gaps enter the existing Attention / Unknown / LearningMission machinery.

A material gap becomes a candidate unknown when:
- it affects an important goal, decision, risk or opportunity;
- the information value is non-trivial;
- the gap is actionable through a source, employee, system or other authorized capability.

This preserves the existing goal-driven investigation rule: Aurum does not indiscriminately investigate everything.

The planner chooses the next best information-gathering action.

## 10. Closed-loop adjustment

When the system detects a deviation, the response sequence is:

1. detect;
2. explain using evidence;
3. classify as reality gap, knowledge gap, or both;
4. estimate goal/decision impact;
5. select the least-cost/highest-value investigation or intervention;
6. request human authority when required;
7. execute through existing capability/agent/deep-action controls;
8. verify observed result;
9. measure outcome;
10. append learning;
11. reassess the same goal and coverage state.

No new autonomous authority is introduced by coverage.

## 11. Customer-interaction normalization

Customer interactions are a semantic category, not a new vertical subsystem.

Provider-specific channels such as email, WhatsApp, phone, web, social and support platforms continue to enter through existing adapters and normalize into canonical communication/evidence records.

Coverage answers which customer-interaction classes are actually represented.

Likewise, “ticket” means a normalized work/support record exposed by an authorized source. Jira, Linear, Zendesk and other providers stay inside their adapters.

This preserves provider isolation and prevents Aurum core from becoming an accidental CRM/PM/helpdesk.

## 12. Meetings

Meeting coverage must distinguish:

**Scheduled** — Aurum knows the meeting exists.

**Joined/captured** — meeting/session evidence was actually received.

**Transcribed** — usable transcript evidence exists.

**Attributed** — participants/speakers can be mapped to organizational identities.

**Recorded artifact** — a durable recording/artifact exists when the provider and tenant authorization permit it.

These are separate facts. “Meeting connected” is never equivalent to “every meeting recorded.”

Consent and provider authorization remain hard boundaries.

## 13. Security and privacy

Coverage MUST obey all frozen locks:
- tenant isolation;
- explicit principal/authority;
- provider isolation;
- consent/recording rules;
- no credential storage in semantic memory;
- employee-impacting evidence and uncertainty requirements;
- policy over learned preference.

Coverage calculations operate only on evidence the requesting principal is authorized to see/use.

A CoverageGap must never reveal the existence of another tenant's data.

## 14. Product surfaces

The user-facing product should expose coverage as a calm operational signal rather than infrastructure telemetry.

Examples:

**Company coverage**
“Most of customer operations is visible. Two important gaps remain.”

**For this answer**
“Based on CRM, support history and 18 recent customer conversations.”

**Blind spot**
“Customer conversations from the sales team's personal SMS numbers are not connected, so this answer may miss those interactions.”

**Goal impact**
“Goal: reduce customer response time. Support-ticket coverage is current; customer WhatsApp coverage is incomplete.”

The user should be able to move from a gap → affected goal → affected sources → connection/learning action → resulting coverage improvement.

## 15. Certification principles

A coverage implementation is complete only when:
- coverage is computed from real connector/evidence state;
- coverage dimensions are independently measurable;
- gaps can be traced to actual missing/stale/unauthorized evidence;
- material gaps can generate Attention/Unknown/LearningMission work;
- queries expose provenance + freshness + coverage caveats;
- coverage itself is tenant-isolated;
- no provider-specific object leaks through the query/coverage contracts;
- deterministic fixtures and live-provider evidence remain explicitly separated;
- longitudinal tests demonstrate that better coverage improves organizational understanding or decision quality.

## 16. Non-goals

This architecture does not introduce:
- a second company database;
- universal surveillance;
- indiscriminate crawling;
- automatic access to personal accounts;
- a replacement CRM/PM/helpdesk;
- autonomous employment decisions;
- a provider-specific “master connector”;
- a requirement that every company connect every system before Aurum is useful.

The goal is not maximum data collection.

The goal is **maximum decision-relevant understanding from authorized evidence, with the remaining uncertainty made visible.**
