# Aurum Post-Simulation Coherent Implementation Plan — 2026-09-23

**Repository:** `payswapdotorg/aurum-chat`  
**Architecture:** v2.1 — FROZEN  
**Maximum concurrency:** 3 workers  
**Inputs:** S001/S002 simulation learning log, technology research, current work-item catalog/DAG, current production certification evidence

## 0. Mission

Turn Aurum into a persistent, provider-independent organizational work surface that can operate through existing systems and communications without forcing provider lock-in or requiring every employee to adopt Aurum Chat. Fuse Universal Comm OS into this product as the communications substrate rather than maintaining two end-user communication products.

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

## 2. CommOS fusion rule

`payswapdotorg/commos` is not a second end-user product. Aurum is the canonical product. The validated CommOS protocol/runtime subset becomes Aurum's communication kernel beneath W030/W045/W087/W086/W088.

Reuse the CommOS protocol contracts and implementation ideas for universal identity links, communication intent, encrypted bundles, delivery states/proofs, capability advertisements, routing, transport interfaces, gateway semantics, DTN/store-and-forward and Android edge foundations. Do not import CommOS's separate web UI, auth model, singleton demo network, separate business data model or second AI cognition loop.

CommOS current repo truth is mixed maturity: P1/P2/P3/P5/P6/P8/P9/P10/P11 are implemented/validated at different levels; P4 Android source exists but its worklog says validation is still in progress and P4.2 BLE remains blocked; P7 Matrix is not implemented. Experimental channel adapters in CommOS are not production delivery evidence.

The extraction must preserve one semantic owner per concern: Aurum owns tenant/employee/person identity, organizational policy, conversations, evidence, cognition and business truth; CommOS owns communication transport semantics below those boundaries.

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

## 13. Workstream J — Matrix / CommOS interoperability

Matrix is optional. Do not add it to the core merely to solve the cellular requirement. CommOS already defines Matrix as an adapter/fabric below the universal communication protocol; Aurum should inherit that boundary, not make Matrix a required transport.

Use Matrix when a customer already operates Matrix or needs an open, customer-controlled communication/interoperability fabric and bridges. Matrix enters through the channel gateway like every other provider.

## 14. Workstream K — OSS/provider evaluation

Maintain a technology registry containing capability, project/provider, license, security status, maintenance/activity, deployment model, data handling, cost/performance, failure modes, exit strategy, adapter status and last review date.

Before rebuilding infrastructure, the Tech Lead reviews the registry.

## 15. New work-item DAG

### CommOS fusion extraction

CommOS protocol/core → Aurum communication-kernel boundary → Aurum identity/policy/evidence → production transports/gateways → delivery evidence.

Extract only the validated reusable CommOS subset. Do not import the CommOS application shell, separate auth, singleton demo network, separate business data model or second AI loop.

### Foundation

W080 Durable Agent Runtime Adapter  
W081 Integration Intelligence  
W082 Universal Connection Broker  
W083 Progressive Capability Grants

### Communications and execution

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

### Fusion, learning and release

W099 CommOS Fusion and Communication Kernel  
W100 Longitudinal S003 Conversion Benchmark  
W101 Final Post-S002 Production Certification

## 16. Dependency relationships

W079 certification reconciliation → W099

W080 → W084, W086, W098

W081 → W082, W083, W089, W096

W082 + W083 + W009 → W084

W099 + W002 + W030 → W095

W099 → W085, W087, W088

W085 + W095 → W086

W087 + W095 → W097

W088 + W084 → W092, W094

W089 → all new provider adapters, including optional Matrix

W090 → W091

W093 → W084

W092 + W084 + W040 → W100

W096 + W097 + W098 + W100 + W099 → W101

## 17. Three-worker execution waves

### Wave 0 — integrity
Tech Lead: reconcile current main, deployed revision and W079 certification before feature work. Main has moved since the earlier certified revision.

### Wave 1
Worker A — W080 Durable Agent Runtime
Worker B — W081 Integration Intelligence
Worker C — W099 CommOS Fusion and Communication Kernel

### Wave 2
Worker A — W082 Universal Connection Broker
Worker B — W085 Meeting Intelligence Gateway
Worker C — W087 Cellular Reachability and Communication Fallback

### Wave 3
Worker A — W083 Progressive Capability Grants + W084 Deep Actions
Worker B — W086 LiveKit Realtime + Meeting Companion
Worker C — W088 Edge Connector + W089 Provider/OSS Registry

### Wave 4
Worker A — W090 Provider Billing Gateway + W091 Provider Choice UX
Worker B — W092 Vertical Extension Foundation
Worker C — W093 Browser Fallback

### Wave 5
Worker A — W094 Migration and Dual Run
Worker B — W095 Unified Identity
Worker C — W098 Persistent Agent Supervision and Recovery

### Wave 6
Worker A — W096 Integration Intelligence E2E proof
Worker B — W097 Meeting and Cellular E2E proof
Worker C — Tech Lead integration, security and licensing reconciliation

### Wave 7
All workers support W100 S003 longitudinal simulation and W101 final production certification.

## 18. Acceptance rules

Nothing is complete because an SDK was installed or a happy-path demo worked.

Every work item requires appropriate unit/integration tests, architecture-boundary checks, tenant isolation, provider failure tests, policy/approval tests, user journey evidence and real provider evidence when provider capability is claimed.

Provider-specific defects must remain inside adapters.

Every long-running workflow must survive worker/process loss.

Every integration action must have an auditable authorization, result and reconciliation path.

Every CommOS-derived transport capability must be independently conformance-tested inside Aurum before being treated as production-ready. Experimental/in-process CommOS adapters cannot be promoted merely by reuse.

## 19. Product success metrics

Track separately:
- Aurum-primary adoption;
- Aurum-only willingness;
- context-switching reduction;
- time-to-useful-understanding;
- integration setup effort;
- connector coverage;
- action success and reconciliation rate;
- meeting capture usefulness;
- cellular reachability success;
- provider failure recovery;
- realized value;
- time from first connection to first useful organizational insight.

## 20. Final product sequence

`Understand the organization`
→ `Reach everyone`
→ `Understand every meeting`
→ `Connect every relevant system`
→ `Act through those systems`
→ `Prove outcomes`
→ `Learn continuously`
→ `Become the primary work surface`
→ `Replace redundant front ends where safe`

Do not reverse this sequence by creating an industry-specific monolith.