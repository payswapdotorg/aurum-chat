# Aurum Post-Simulation Coherent Implementation Plan — 2026-09-23

**Repository:** `payswapdotorg/aurum-chat`  
**Architecture:** v2.1 — FROZEN  
**Maximum concurrency:** 3 workers  
**Inputs:** S001/S002 simulation learning log, technology research, current work-item catalog/DAG, current production certification evidence

## 0. Mission

Turn Aurum into a persistent, provider-independent organizational work surface that can operate through existing systems and communications without forcing provider lock-in or requiring every employee to adopt Aurum Chat.

Primary outcomes:
- understand and operate through the organization's existing systems;
- communicate with employees wherever they are, including cellular SMS/voice when the recipient has no Internet;
- participate in Zoom/Teams/Meet and in-person meetings;
- remain durable when execution workers disappear;
- discover organizational tools automatically and minimize integration setup;
- request provider permissions only when needed;
- route provider payments through Aurum where commercial terms permit;
- reuse mature open-source technology instead of rebuilding equivalent infrastructure;
- add/replace providers through adapters without changing Aurum domain semantics;
- increase Aurum-primary adoption and make Aurum-only operation possible where domain and regulatory constraints permit.

## 1. Non-negotiable rules

### Aurum owns truth
PostgreSQL remains authoritative for tenant identity, people, CompanyModel, epistemics, goals, unknowns, missions, policy, evidence, actions, agents, extensions and outcomes.

### Providers are adapters
No vendor SDK, meeting object, integration-broker object, billing object or agent-runtime object may leak into domain contracts.

Adding a provider requires an adapter, conformance tests, capability/health mapping, credential/scope mapping, hot-swap evidence and an explicit exit path.

### Open source before rebuild
Before building substantial infrastructure, evaluate mature open-source implementations. Prefer thin adapters around proven software when licensing, security, maintenance, operational maturity and exit risk are acceptable.

### Outcome-oriented choices
Ordinary users choose outcomes such as **Best quality**, **Lowest cost**, **Most private**, **Fastest**, **Use my organization's service**, or **Let Aurum choose**. Advanced users may inspect exact providers and technical configuration.

### Billing gateway
Where a provider permits platform-mediated billing, the user pays Aurum and Aurum settles provider costs underneath. Provider terms, geography and regulated billing rules may require a direct customer relationship; that must remain an explicit exception.

## 3. Persistent Aurum runtime

Aurum is a persistent organizational actor, not a permanent process.

### Durable state
`tenant + Aurum identity + CompanyModel/memory + goals + unknowns + missions + policies + integrations + execution history + evidence + outcomes` remain application-owned.

### Durable workflow
Use one pluggable workflow adapter for event-triggered cognition, scheduled observation, long investigations, human waits, approvals, retries, resumptions, briefings and escalation.

Current deployment support can continue with Vercel Workflows. Inngest, Trigger.dev and Temporal must remain replaceable adapter candidates.

### Ephemeral execution
LLM calls, browser sessions, media processing, connector work, specialist agents and code execution run in disposable workers or sandboxes.

Modal is the leading general execution candidate; E2B is a specialized isolated-code/computer-use candidate.

## 4. Workstream A — Universal integration

### Goal
Make connection feel like **giving Aurum permission to understand and operate the organization**, not configuring a connector catalog.

Journey:
`connect organization identity → discover systems → explain why they matter → recommend safe connections → approve → connect → verify → map → observe → request authority as needed → execute → reconcile → learn`

Required capabilities:
- tenant-scoped Tool & System Inventory;
- authorized app/tool discovery;
- provider capability registry;
- OAuth/credential lifecycle;
- automatic entity and identity mapping;
- source freshness/checkpoints;
- bulk approval for safe read scopes;
- progressive write/action consent;
- shadow/read-only mode;
- continuous connector health;
- automatic reconciliation and evidence;
- reversible mappings and disconnect/rollback.

Nango is the leading connection/OAuth/sync candidate; Composio and Pipedream are long-tail action/connectivity candidates; Workato and customer MCP/OpenAPI are enterprise bridges; Merge is selective.

## 5. Workstream B — Deep action / Aurum as front door

Move from seeing systems to operating them:
`discover → inspect → propose → authorize → execute → verify → reconcile → evidence → outcome`

A professional should be able to initiate multi-system work from Aurum without manually opening each underlying application for ordinary cases.

## 6. Workstream C — Meetings

Make Aurum a participant in organizational conversations.

Native P0 adapters:
- Zoom RTMS;
- Microsoft Teams Graph meeting/transcript/artifact access;
- Google Meet REST/transcript/artifacts.

Recall.ai or Meeting BaaS can accelerate cross-platform support while native adapters mature.

Canonical meeting lifecycle:
`scheduled/started → consent/status → transcript/media → speaker attribution → evidence → decisions → unknowns → actions → missions → outcomes`

Meeting evidence enters the same Aurum evidence/cognition loop; it is not a parallel knowledge store.

## 7. Workstream D — Realtime voice and in-person companion

Use LiveKit behind a provider-neutral realtime gateway for Aurum voice, realtime two-way meeting participation, Meeting Companion, telephony/SIP and Aurum-hosted realtime rooms.

Transcript-first meeting capture does not require LiveKit; live spoken participation does.

Meeting Companion runs on approved phone/tablet/laptop hardware and exposes explicit participation/recording state.

## 8. Workstream E — Cellular Reachability / Reach Anyone

### Product requirement
Aurum must be able to convey information to a person even when that recipient has no Internet and does not use Aurum.

Example:
> Manager: **Tell Sarah in the next office that the supplier meeting moved from 3pm to 4pm.**

Aurum resolves Sarah's verified phone identity and chooses the appropriate route.

Fallback ladder:
`preferred connected channel → SMS → voice call`

Recipient needs only an ordinary mobile phone for the SMS/voice fallback.

Replies can return by SMS into the Aurum conversation when authorized.

Voice can either bridge a call or deliver a synthesized message, subject to policy.

Telecom adapters should support multiple providers such as Twilio, Telnyx and regionally appropriate providers such as Africa's Talking.

Exact boundary:
- no Internet + cellular service → SMS/voice works;
- no Internet + local IP network → optional local edge transport may work;
- no network/radio path at all → software cannot create remote reachability and must report that limitation.

Where the manager has no Internet data but can use SMS/voice, provide an SMS/voice entry path to an Aurum-owned organizational number where supported.

## 9. Workstream F — Aurum Edge Connector

Provide a customer-controlled runtime for private/on-prem systems:
`Aurum cloud → signed outbound job → customer Edge Connector → internal system → normalized result/evidence → Aurum`

Keep credentials customer-side where possible. Support approved local APIs, MCP, OpenAPI, databases, files and browser adapters. Do not create a second organizational control plane.

## 10. Workstream G — Provider choice and billing

At first launch and whenever a capability first needs a provider, ask the user for the desired outcome rather than provider terminology.

Persist preferences at user/tenant level and let Aurum select an eligible implementation.

Create an Aurum Provider Billing Gateway that normalizes provider cost, budget, usage and receipts. Route supported provider settlement through Aurum. Fall back to direct customer billing where necessary.

## 11. Workstream H — Specialist vertical depth

Do not create industry forks of the Aurum core.

Build governed extension/agent packs for construction/AEC, finance/banking/accounting, sales/GTM, technology/software, healthcare, transport/delivery, hospitality, fashion/retail, entertainment/media, legal and defense/security.

Use the S002 result to prioritize system-of-record-heavy vertical integrations rather than merely adding industry dashboards.

## 12. Workstream I — Browser/computer-use fallback

Use browser automation only when APIs/MCP/native adapters are insufficient.

`Aurum action → Stagehand/Browserbase/E2B worker → observed action → verification → reconciliation → evidence`

Browser automation never becomes authoritative business state.

## 13. Workstream J — Matrix interoperability

Matrix is optional. Do not add it to the core merely to solve cellular reachability.

Use Matrix when a customer already operates Matrix or needs an open, customer-controlled communication/interoperability fabric and bridges. Matrix enters through the channel gateway like every other provider.

## 14. Workstream K — OSS/provider evaluation

Maintain a technology registry containing capability, project/provider, license, security status, maintenance/activity, deployment model, data handling, cost/performance, failure modes, exit strategy, adapter status and last review date.

Before rebuilding infrastructure, the Tech Lead reviews the registry.

## 15. Work-item DAG — W080 to W101 only

### Foundation
W080 Durable Agent Runtime Adapter
W081 Integration Intelligence
W082 Universal Connection Broker
W083 Progressive Capability Grants

### Communication and execution
W084 Deep Action Gateway and Reconciliation
W085 Meeting Intelligence Gateway
W086 Realtime Voice and Meeting Companion
W087 Cellular Reachability and Communication Fallback
W088 Aurum Edge Connector

### Provider independence and economics
W089 Provider Adapter SDK and OSS Technology Registry
W090 Aurum Provider Billing Gateway
W091 User-Friendly Provider Choice UX

### Industry and fallback
W092 Vertical Extension Starter Kits
W093 Browser and Computer-Use Fallback
W094 Migration and Dual-Run Continuity

### Identity and proof
W095 Unified Cross-Channel, Meeting and Telephony Identity Verification
W096 Integration Intelligence End-to-End Fixture
W097 Meeting and Cellular End-to-End Fixture
W098 Persistent Agent Supervision and Recovery

### Optional interoperability and release
W099 Matrix Interoperability Adapter (Optional)
W100 Longitudinal S003 Conversion Benchmark
W101 Final Post-S002 Production Certification

## 16. Dependency relationships

W080 → W084, W085, W086, W098
W081 → W082, W083, W089, W096
W082 + W083 + W009 → W084
W085 → W086
W002 + W030 + W085 + W086 + W087 → W095
W084 + W088 → W092, W093
W089 → W082, W090, optional W099
W090 → W091
W084 + W088 + W092 → W094
W081 + W082 + W083 + W084 → W096
W085 + W086 + W087 + W095 → W097
W080 + W021 + W023 + W024 → W098
W092 + W094 + W096 + W097 + W098 → W100
W096 + W097 + W098 + W100 + production infrastructure → W101

## 17. Three-worker execution waves

### Wave 0 — integrity
Tech Lead only: fetch current main, reconcile the exact deployed revision against the exact W079-certified revision, record the new baseline SHA, and verify W080–W101 are the only active post-S002 implementation scope.

### Wave 1
Worker A — W080 Durable Agent Runtime
Worker B — W081 Integration Intelligence
Worker C — W089 Provider Adapter SDK + OSS Technology Registry

### Wave 2
Worker A — W082 Universal Connection Broker
Worker B — W085 Meeting Intelligence Gateway
Worker C — W087 Cellular Reachability

### Wave 3
Worker A — W083 Progressive Capability Grants + W084 Deep Actions
Worker B — W086 Realtime Voice + Meeting Companion
Worker C — W098 Persistent Agent Supervision + Recovery

### Wave 4
Worker A — W088 Aurum Edge Connector
Worker B — W090 Provider Billing Gateway
Worker C — W095 Unified Cross-Channel / Meeting / Telephony Identity

### Wave 5
Worker A — W091 User-Friendly Provider Choice UX
Worker B — W092 Vertical Extension Starter Kits
Worker C — W093 Browser / Computer-Use Fallback

### Wave 6
Worker A — W094 Migration + Dual Run
Worker B — W096 Integration Intelligence E2E
Worker C — W097 Meeting + Cellular E2E

### Wave 7
Worker A — W099 Matrix Interoperability Adapter only if justified by customer/use-case evidence
Worker B — W100 Longitudinal S003 Conversion Benchmark
Worker C — Tech Lead security/licensing/provider reconciliation

### Wave 8
All workers support W101 Final Post-S002 Production Certification.

## 18. Execution rules

- Only the Tech Lead resolves cross-worker conflicts or changes dependency ownership.
- Public contracts are frozen before dependent work begins.
- Provider SDKs stay inside adapter boundaries.
- UI workers do not become domain owners.
- Provider failures must be localized and observable.
- Long-running work must resume after worker/process loss.
- Consequential actions require Aurum policy/authority checks.
- External actions require verification/reconciliation before being treated as successful.
- Tenant isolation applies to every integration, meeting, telephony and Edge path.
- No work item may claim completion from prose, mocks or unverified provider imports.
- Frozen Architecture v2.1 cannot be silently modified.

## 19. Outcome-oriented user choice rules

Ordinary users never need to choose a vendor, SDK, runtime or protocol.

At first launch or when a capability first needs a provider, show outcomes such as:

**Best quality** · **Fastest** · **Lowest cost** · **Most private** · **Use my organization's setup** · **Let Aurum choose**

Aurum selects an eligible provider from tenant-approved capabilities and records why it was selected.

Advanced settings may reveal and override the selected provider when authorized. Provider choice remains changeable after initial setup.

## 20. Integration onboarding rules

Default experience:

**Connect organization → discover authorized systems → explain value → recommend safe connections → approve → connect → verify → map → observe → request additional authority only when needed → execute → reconcile → learn.**

Read access is the default starting point.

Write/action capability is requested only when a concrete task needs it, with the reason, scope, expected consequence and estimated provider cost shown before approval.

## 21. Communication requirements

Aurum must support the user intent:

**“Tell Sarah the supplier meeting moved to 4pm.”**

Aurum resolves Sarah's verified identity, chooses an authorized route, delivers through the preferred channel, falls back to SMS and then voice where policy permits, records delivery evidence and can route authorized replies back into Aurum.

The recipient does not need Internet access or an Aurum account.

When the sender has no usable Internet but still has cellular service, an SMS/voice entry path to an Aurum organizational number is supported where provider terms permit.

When there is genuinely no network/radio path, Aurum reports that no route exists.

## 22. Meeting requirements

Aurum must participate in Zoom, Microsoft Teams, Google Meet and approved in-person meetings.

Meeting information enters the same canonical evidence, identity, CompanyModel and cognition loop.

Consent/recording state must be explicit.

## 23. Persistent-agent requirements

The persistent Aurum actor is durable state plus durable workflows, not one permanent process.

PostgreSQL remains authoritative.

Ephemeral workers/sandboxes execute LLM, browser, media, connector and specialist-agent tasks.

Worker death must not destroy Aurum state or mission progress.

## 24. Open-source reuse rule

Before implementing infrastructure, check the OSS technology registry.

Prefer a mature existing open-source component or thin adapter when licensing, security, maintenance, operational maturity, performance and exit risk are acceptable.

Do not reimplement a mature equivalent solely to avoid a dependency.

## 25. Provider billing rule

Where provider terms allow Aurum to mediate payment, expose one Aurum billing experience and settle provider charges underneath.

Where direct provider billing is mandatory, preserve the same outcome-oriented UX and clearly identify the external billing requirement.

No provider billing object becomes organizational truth.

## 26. Product-level success metrics

Track separately:
- Aurum-primary adoption;
- Aurum-only willingness;
- context-switching reduction;
- time-to-useful-understanding;
- integration setup effort;
- action success and reconciliation rate;
- meeting capture/usefulness;
- cellular reachability success;
- provider failure recovery;
- realized value;
- time from first connection to first useful organizational insight.

## 27. Final sequence

**Understand the organization** → **Reach everyone** → **Understand every meeting** → **Connect every relevant system** → **Act through those systems** → **Prove outcomes** → **Learn continuously** → **Become the primary work surface** → **Replace redundant front ends where safe**

Do not turn Aurum into an industry-specific monolith.