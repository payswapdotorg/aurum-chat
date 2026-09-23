# Aurum Technology Research — Meetings, Persistent Agent Runtime, Realtime, and Zero-Friction Integrations

**Date:** 2026-09-23  
**Status:** NON-NORMATIVE RESEARCH INPUT  
**Architecture impact:** Does not change frozen Architecture v2.1. Proposed technologies must sit behind existing provider-neutral gateways and infrastructure ports.

## Executive conclusions

1. Aurum should be modeled as a **persistent organizational actor with durable state**, not as one permanently running server process.
2. Authoritative agent identity, memory, goals, permissions, missions, evidence, executions and outcomes remain in PostgreSQL.
3. Long-running cognitive workflows need a durable workflow/orchestration layer. Inngest is the leading current candidate for the TypeScript/event-driven stack; Trigger.dev is the strongest alternative for browser-heavy workloads; Temporal is the strategic enterprise/self-hosting option.
4. E2B and Modal are **execution substrates**, not the home of Aurum's persistent identity or cognition.
5. LiveKit is **not required for normal meeting ingestion**. It becomes highly valuable for live voice/video participation, an in-person Meeting Companion, telephony/SIP and Aurum-hosted realtime rooms.
6. Meeting participation should use native platform APIs where possible, a Meeting BaaS/Recall acceleration layer where needed, LiveKit for Aurum-native realtime media, and browser/desktop capture only as a controlled fallback.
7. Integration onboarding should become a first-class capability: **discover → explain → approve → connect → verify → map → observe → progressively authorize actions → continuously monitor**.
8. Nango is the strongest candidate for the connection/auth/sync foundation; Composio is attractive for agent-ready long-tail actions; Pipedream is a broad fallback. All must remain behind Aurum's Source/Destination/Action gateways.
9. Browser automation should be a last-mile adapter, not the primary integration layer.

## Meeting participation

### In-person meetings

Current Aurum code does not expose a first-class meeting-participant implementation. The architecture has evidence ingestion, channels, cognition, presence and source/destination primitives, so the capability fits the architecture, but it needs a concrete Meeting/Realtime adapter implementation.

The simplest path is an **Aurum Meeting Companion** on an approved laptop/tablet/phone:

- meeting starts;
- explicit consent/recording state is shown;
- microphone audio is streamed or chunked to Aurum;
- realtime STT creates time-aligned turns;
- speaker diarization maps speakers to verified people where possible;
- Aurum extracts observations, claims, unknowns and actions while the meeting proceeds;
- the meeting closes into a durable evidence artifact and follow-up mission/task set.

LiveKit is useful here when Aurum needs true realtime bidirectional audio, interruption handling, or telephony. It is not required for passive note-taking.

### Zoom

Zoom Realtime Media Streams (RTMS) can deliver live audio, video, screen-share and transcript data to an application. Streams can be started automatically, on demand through REST, or from a Zoom App. Audio can be received per participant or merged, with participant IDs and timestamps.

**Priority: P0 native adapter.**

### Microsoft Teams

Microsoft Graph can expose Teams meeting transcripts subject to tenant/admin controls. Microsoft also documents realtime media bots, but explicitly says the Real-time Media Platform is not recommended for AI-agent scenarios and points developers toward Copilot Studio and Graph transcript access for meeting intelligence.

**Priority: P0 transcript/metadata adapter; P1 raw-media adapter only for specialized approved cases.**

### Google Meet

Google Meet REST APIs expose conference records, participants and artifacts such as transcripts and recordings. Google also has a Meet Media API for realtime audio/video, but it is currently a Developer Preview with significant enrollment and technical requirements.

**Priority: P0 REST/artifact adapter; P1 Media API when its access constraints are acceptable.**

### Cross-platform Meeting BaaS

Recall.ai and Meeting BaaS provide a faster route to sending bots to Zoom, Google Meet and Teams. Meeting BaaS supports recording, transcripts, participant data and speaking bots; Recall provides a cross-platform meeting bot API with realtime and asynchronous data.

**Priority: P1 acceleration layer.**

## Persistent-agent runtime

Aurum should have three distinct layers:

### 1. Persistent organizational identity

Lives in PostgreSQL: agent/tenant identity; goals; CompanyModel/memory; unknowns; LearningMissions; permissions and authority; integrations; policies; execution history; evidence/provenance; outcomes and learned priors.

This is what makes Aurum persistent.

### 2. Durable workflow state

A workflow engine manages event-triggered cognition, scheduled observation, long investigations, waiting for employees, waiting for approvals, retries, backoff, human-in-the-loop, resumptions after deployment or worker failure, recurring briefings and unresolved-gap escalation.

Recommended order:
1. Inngest — P0 candidate/default for Aurum's TypeScript/event-driven architecture.
2. Trigger.dev — P0 alternative, particularly strong for long-running AI/browser workloads and human-in-the-loop.
3. Temporal — P1 strategic option where self-hosting/control and high workflow complexity justify the additional operational weight.

Do not make PostgreSQL or an LLM responsible for orchestration semantics.

### 3. Ephemeral execution

Workers/containers execute LLM calls, connector calls, browser sessions, file processing, code/data analysis, media processing and realtime meeting jobs.

Workers may disappear at any time. Durable workflow state must allow another worker to resume.

## E2B vs Modal

Neither should host Aurum's identity.

### E2B

E2B is well suited to secure isolated AI-generated code and computer-use tasks. Its documented sandbox lifetime is bounded, with maximum lifetimes of 1 hour on Hobby and 24 hours on Pro. E2B also provides Desktop sandboxes and an open-source runtime.

**Priority: P1 execution adapter.**

### Modal

Modal is well suited to scalable production compute, GPUs, sandboxes and browser/media workloads. Modal Sandboxes support custom images, volumes and GPUs while still having an explicit sandbox lifetime.

**Priority: P0/P1 execution substrate.**

### Recommendation

Durable workflow → ephemeral Modal/E2B task → normalized result/evidence → durable workflow resumes.

Never equate the persistent Aurum agent with one Modal or E2B sandbox.

## LiveKit

LiveKit is an open-source realtime stack with agents that join rooms as participants, process audio/video/data, support Python or Node.js, integrate with many STT/LLM/TTS providers, and support telephony/SIP and recording/export.

**Priority: P0 for Aurum's realtime meeting/voice product surface; P1 if near-term scope is transcript-first.**

LiveKit should become the provider-neutral realtime transport layer for the Aurum Meeting Companion, Aurum-native voice conversations, telephony/SIP, live meeting participation where Aurum controls the media room, and realtime media sidecars.

It should not replace Zoom/Teams/Meet adapters.

## Voice and meeting intelligence

### Realtime media

- LiveKit Agents — P0.
- OpenAI Realtime / Agents realtime — P1 provider adapter, not domain architecture.
- Pipecat — P1 alternative open-source realtime pipeline if Python-centric media orchestration is preferred.

### Speech-to-text

- Deepgram / AssemblyAI — P0 provider candidates for low-latency production transcription.
- OpenAI STT — P0/P1 provider candidate behind the existing gateway.
- WhisperX — P1 for high-accuracy offline/batch transcription, word-level timestamps and diarization.
- Hugging Face pyannote speaker diarization — P1 self-hostable diarization component.
- Hugging Face models/Spaces — P1 model/tool discovery and optional self-hosted components.

Use a provider-neutral speech pipeline so organizations can choose hosted, customer-owned or self-hosted speech.

## Agent frameworks

### Hugging Face smolagents

Useful for specialist agents and experimentation because it is model/tool agnostic, supports CodeAgent and ToolCallingAgent, MCP, Hub tools/Spaces, and sandboxed code execution through E2B, Modal and Docker.

**Priority: P2 as a specialist-agent implementation option, not as Aurum's core cognitive engine.**

### Letta

Interesting reference for stateful agents and long-lived memory/identity.

**Priority: P2 research/reference candidate.**

Do not delegate Aurum's canonical CompanyModel, epistemics or action authority to a third-party agent memory system.

## Integration technology

### Nango

Nango provides infrastructure for OAuth, credential handling, data syncs, webhooks, API calls and tool calls while leaving the application in control of its normalized data model.

**Priority: P0.**

Best fit for Aurum's Source/Destination gateway and Connection Hub foundation.

### Composio

Composio provides agent-ready tools, managed authentication, intent-based tool discovery and app connections across 1,500+ apps. Its Connect/MCP flow can generate an approval link when an app is first needed and persist the connection for later use.

**Priority: P0/P1.**

Best fit for long-tail action connectivity behind Aurum's Action/Destination gateways.

### Pipedream

Pipedream MCP currently exposes 3,000+ APIs and 10,000+ tools, including managed OAuth/account connections.

**Priority: P1 fallback/long-tail connector broker.**

### Workato

Strong enterprise integration/MCP option with governance and data-residency controls.

**Priority: P1 customer-side bridge.**

Do not make Workato a core dependency; enable enterprises that already use it to expose governed access to Aurum.

### Merge

Useful for normalized APIs across HRIS, ATS, Accounting, Ticketing, CRM, File Storage, Knowledge Base and Chat.

**Priority: P1 selective adoption.**

### Speakeasy

Can generate MCP servers from OpenAPI/Swagger and deploy them in customer-controlled infrastructure.

**Priority: P1.**

This is valuable for customer-specific internal APIs: upload or authorize an OpenAPI contract and automatically expose governed MCP tools without hand-building every adapter.

## Private and on-premise systems

Aurum will encounter systems that cannot or should not be exposed as public SaaS APIs, especially in large enterprises and regulated environments.

Create an **Aurum Edge Connector** as a lightweight, customer-controlled runtime that establishes outbound connections to Aurum and can reach approved internal systems.

The Edge Connector should:

- run inside the customer's network or private cloud;
- make outbound-only connections to Aurum;
- receive only signed, tenant-scoped jobs;
- expose approved source/destination/action capabilities through Aurum's provider-neutral gateway;
- keep credentials inside the customer's secret store;
- support local OpenAPI/MCP endpoints, databases, file shares and approved desktop/browser adapters;
- report capability, health and version metadata to the Integration Intelligence layer;
- support explicit network allowlists and organization policy;
- return normalized evidence/results without exposing provider objects to the domain.

**Priority: P0/P1**, especially for large, regulated and on-premise customers.

This should be an adapter/runtime pattern, not a second Aurum control plane. PostgreSQL, policy, authority and audit remain authoritative in Aurum.

## Browser / computer-use fallback

### Stagehand + Browserbase

Stagehand provides Playwright-like agent browser control, self-healing actions, extraction/observation and production-oriented reliability. Browserbase supplies hosted browser infrastructure.

**Priority: P1 as the last-mile adapter.**

Use this when a business application has no suitable API/MCP, or when its UI is the only execution surface.

Browser automation must never silently become authoritative business state; actions still pass through Aurum authority and evidence contracts.

## Extremely easy organization onboarding

Aurum should build an **Integration Intelligence layer** around the existing Connection/Source/Destination architecture.

### Phase A — Discover

After an authorized organization admin connects an identity or inventory source, Aurum builds a tenant-scoped Tool & System Inventory.

Useful discovery sources include Microsoft Entra/Microsoft 365, Google Workspace, Okta/SSO application inventory where available, approved IT/service catalogs, endpoint/device-management inventories, customer OpenAPI/MCP catalogs, and existing Workato/Pipedream/Composio inventories.

Do not perform uncontrolled network scanning.

### Phase B — Explain

Aurum should produce a plain-language integration map:

Found: Salesforce
Why it matters: customer/account context
What Aurum can read: accounts, contacts, opportunities
What it could do: create/update opportunities and tasks
Data sensitivity: high
Required scopes: explicit
Recommended mode: read-only initially

### Phase C — One-click approval

Offer **Connect recommended tools** rather than manual connector setup. Group related OAuth/SSO permissions and send the administrator through provider-native consent.

Never silently request write permissions.

### Phase D — Automatic verification

Immediately after approval, run safe probes:

authenticate → inspect schema → sample permitted entities → verify tenant boundaries → map identities → detect freshness → record evidence

Any mismatch becomes a visible integration health finding.

### Phase E — Automatic mapping

Map external systems into the Aurum world model: people, customers, suppliers, projects, contracts, processes, products, goals, tickets/tasks, assets, documents and conversations.

Mappings remain evidence-backed and reversible.

### Phase F — Progressive authorization

Request more authority only when an actual task requires it.

Example: Aurum can see Salesforce opportunities. When it needs to update an opportunity after an approved recommendation, it requests only the write scope required for that operation.

### Phase G — Observe before acting

For the initial period, operate in shadow mode: ingest; learn; identify gaps; detect processes; recommend; show evidence; do not execute consequential writes until explicitly authorized.

### Phase H — Continuous integration maintenance

Each connector continuously reports auth status, scope changes, schema changes, rate limits, webhook health, sync lag, coverage, failed actions and reconciliation mismatches.

Aurum should proactively notify the appropriate administrator when an integration degrades.

## Ideal integration experience

Connect organization identity
→ Aurum surveys authorized application inventory
→ Aurum explains what each tool contributes
→ Approve recommended connections
→ OAuth/SSO consent
→ Aurum verifies access
→ Aurum builds the company/system map
→ Aurum learns in read-only mode
→ Aurum proposes useful actions
→ Approve only the required write/action scopes
→ Aurum executes through governed adapters
→ Aurum verifies and records outcomes

## Priority ranking

| Priority | Technology / capability | Why |
|---|---|---|
| P0 | Durable workflow orchestration: Inngest or Trigger.dev | Makes always-on cognition reliable |
| P0 | Nango | OAuth, tokens, sync, webhooks, connection lifecycle |
| P0 | Native Zoom RTMS + Meet REST + Teams transcript adapters | Meeting intelligence without reinventing platform protocols |
| P0 | LiveKit | Realtime voice/meeting/in-person companion layer |
| P0 | Integration Discovery + progressive-consent UX | Biggest reduction in onboarding friction |
| P0 | Deep bidirectional action gateway | Converts visibility into workflow replacement |
| P0 | Strong evidence/reconciliation after every integration action | Trust and correctness |
| P1 | Modal | Scalable isolated execution/media/browser/GPU substrate |
| P1 | Recall.ai or Meeting BaaS | Fast cross-platform meeting participation |
| P1 | Composio | Long-tail agent-ready application actions |
| P1 | Pipedream | Long-tail integration fallback |
| P1 | Stagehand + Browserbase | API-less application fallback |
| P1 | WhisperX + pyannote | Self-hostable high-quality meeting transcription/diarization |
| P1 | Speakeasy | Customer OpenAPI → governed MCP acceleration |
| P1 | Merge | Selective normalized integration families |
| P1 | Workato bridge | Enterprise customer-owned integration ecosystem |
| P2 | Temporal | Strategic enterprise-grade durable execution alternative |
| P2 | E2B | Secure specialist code/computer-use sandbox |
| P2 | Pipecat | Alternative realtime media pipeline |
| P2 | Hugging Face smolagents | Specialist-agent experimentation |
| P2 | Letta | Persistent-agent research reference |

## Architectural rule

None of these technologies should become the source of truth for tenant identity, organizational truth, CompanyModel, epistemic state, goals, unknowns, LearningMissions, action authority, audit evidence or intervention outcomes.

External platforms are adapters and execution substrates.

**Aurum's durable organizational intelligence remains application-owned.**