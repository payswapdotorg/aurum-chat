# Final Tech Lead Handoff — Aurum + CommOS Post-S002

**Repository:** `payswapdotorg/aurum-chat`  
**Current main at handoff:**  `5939bd735d5693878f34d2928e036b76327c00c6`  
**Frozen Aurum architecture:** v2.1  
**Maximum concurrent workers:** 3  
**Canonical implementation plan:** `spec/POST-S002-COHERENT-IMPLEMENTATION-PLAN-2026-09-23.md`  
**Canonical work catalog:** `spec/work-items/WORK-ITEM-CATALOG.md`  
**Canonical DAG:** `spec/WORK-ITEM-DEPENDENCY-GRAPH.md`  
**Simulation record:** `spec/SIMULATION-LEARNING-LOG.md`  
**Technology research:** `spec/TECHNOLOGY-RESEARCH-2026-09-23.md`  
**CommOS fusion assessment:** `spec/COMMOS-FUSION-REVIEW-2026-09-23.md`

## 1. Mission

Implement the post-S002 architecture without creating two overlapping products.

**Aurum is the one product and organizational intelligence employee.**

**Universal Comm OS is the communications substrate inside Aurum.**

The end-state is:

```text
organization understanding
        ↓
persistent organizational employee
        ↓
one conversational/work surface
        ↓
reach every relevant person
        ↓
understand meetings
        ↓
connect every important system
        ↓
operate those systems
        ↓
verify/reconcile outcomes
        ↓
learn continuously
        ↓
become the primary work surface
        ↓
replace redundant front ends where safe
```

## 2. Repository truth already established

### Aurum

Aurum main is ahead of the exact W079 certification base. The comparison from W079 certified base:

`c0ea5f78f8979d46029ac6124eff2bf0ebd6d988`

to current main:

`c43193b3a6ae1b1275a2dd8f78936f54a165b6c9`

was **12 commits ahead** and included additional release-certification code/files. Therefore the W079 verdict must not be inherited silently by current main.

### CommOS

CommOS main reviewed:

`9d1f24250e5037cb49b3499794c158f09caf4398`

The strongest reusable portions are the provider-neutral communication substrate:

- Universal Identity/channel-link semantics;
- identity verification state machine;
- communication intent;
- encrypted CommunicationBundle/proofs;
- delivery state machine;
- capability advertisements/cache;
- routing;
- transport interfaces;
- gateway runtime;
- DTN/store-and-forward concepts;
- Android edge runtime foundations.

The following must **not** become second Aurum subsystems:

- CommOS web/UI;
- CommOS auth/user model;
- CommOS singleton demo network;
- CommOS business data model;
- CommOS AI loop;
- CommOS separate billing/analytics application.

## 3. Important CommOS evidence warnings

These are hard preconditions for reuse.

1. CommOS SMS/email/WhatsApp adapters are explicitly experimental in-process transcript adapters. They are not real production delivery.
2. CommOS P4 Android is not fully validated; its worklog says P4.1-B validation is in progress and P4.2 BLE is blocked.
3. The current CommOS main file `android/app/src/main/java/io/commos/edge/AndroidResourceSampler.kt` is only 14 bytes while the worklog describes a larger implementation. This is direct repository-vs-worklog evidence drift.
4. CommOS P7 Matrix Fabric is not implemented.
5. No root LICENSE/README/COPYING file was visible in the reviewed CommOS repository. Any external redistribution/extraction decision therefore needs an explicit licensing review even though internal reuse between these user-owned repositories is operationally possible.

Do not port a CommOS claim merely because its roadmap/worklog says it exists.

## 4. Product rules frozen by this handoff

### One identity

A Person/Employee in Aurum remains the organizational identity authority.

CommOS channel identities map into Aurum's Person/Employee/ExternalIdentity records.

### One policy authority

Aurum W009 remains the authority for whether Aurum may communicate, export, install, execute or otherwise act.

### One evidence truth

CommOS delivery/proof events become Aurum communication evidence and audit facts.

### Provider neutrality

Twilio, Telnyx, Africa's Talking, LiveKit, Zoom, Teams, Meet, Matrix, Nango, Composio, Pipedream, Modal, E2B, Inngest, Trigger.dev, Temporal, etc. are replaceable implementations.

No provider SDK enters an Aurum domain contract.

### Open source first

Do not rebuild a capability already supplied by a mature OSS project unless licensing, security, maintenance, operational, performance or architectural constraints make reuse unsuitable.

## 5. User experience rule

Non-advanced users must choose outcomes, not technologies.

Use:

- **Best quality**
- **Lowest cost**
- **Most private**
- **Fastest**
- **Use my organization's service**
- **Let Aurum choose**

Advanced settings can expose exact provider names and technical configuration.

When Aurum needs a provider for a concrete task, ask at the moment of need rather than forcing a technical setup tour during onboarding.

## 6. Universal communication requirement

The canonical user command is:

> **"Aurum, tell Sarah the supplier meeting moved to 4pm."**

Aurum should:

1. resolve Sarah to the correct employee;
2. inspect her available verified communication paths;
3. choose the best permitted route;
4. send via the preferred channel;
5. fall back to SMS;
6. fall back to voice where policy permits;
7. report delivery status;
8. retain the communication evidence;
9. route any authorized reply back into Aurum.

**The recipient does not need Internet or an Aurum account.**

If the sender has cellular service but no Internet data, an SMS/voice entry path to an Aurum organizational number should be supported where telecom/provider terms permit.

If there is no cellular, local network or peer-radio path at all, Aurum must report that no communication path exists.

## 7. Meeting requirement

Aurum must be able to participate in:

- Zoom;
- Microsoft Teams;
- Google Meet;
- in-person meetings.

Meeting intelligence enters the same evidence/CompanyModel/cognition loop.

Meeting participation is not a second knowledge store.

## 8. Persistent-agent requirement

Aurum is a persistent organizational actor with durable state.

It is **not** a permanently running container.

Durable:

- identity;
- memory/CompanyModel;
- goals;
- unknowns;
- missions;
- policy;
- integrations;
- evidence;
- executions;
- outcomes.

Ephemeral:

- LLM execution;
- browser sessions;
- connector jobs;
- specialist agents;
- media processing;
- code execution;
- realtime sessions.

Worker death must not destroy Aurum.

## 9. New work items

### W080 — Durable Agent Runtime Adapter
Durable workflow abstraction for long-running cognition, waiting, approval, retry, schedule and resume.

### W081 — Integration Intelligence
Discover authorized organizational tooling, explain why it matters, recommend connections and build the tenant Tool & System Inventory.

### W082 — Universal Connection Broker
OAuth/token/sync/webhook lifecycle behind provider-neutral gateway boundaries.

### W083 — Progressive Capability Grants
Read-only/shadow mode first; request narrowly scoped write/action permission only when needed.

### W084 — Deep Action Gateway and Reconciliation
discover → inspect → propose → authorize → execute → verify → reconcile → evidence → outcome.

### W085 — Meeting Intelligence Gateway
Canonical meeting/session/transcript/artifact model plus native Zoom/Teams/Meet adapters and optional meeting-BaaS acceleration.

### W086 — Realtime Voice and Meeting Companion
Provider-neutral realtime gateway; LiveKit as leading implementation candidate.

### W087 — Cellular Reachability and Communication Fallback
Reach Anyone over SMS/voice with multi-provider telecom routing and delivery/reply evidence.

### W088 — Aurum Edge Connector
Customer-controlled runtime for private/on-prem APIs, MCP/OpenAPI, databases, files and approved browser adapters.

### W089 — Provider Adapter SDK and OSS Technology Registry
Standard provider adapter lifecycle, conformance tests, capability/health mapping, hot-swap verification and technology evaluation records.

### W090 — Aurum Provider Billing Gateway
Aurum-mediated provider billing/usage where contractual terms permit.

### W091 — User-Friendly Provider Choice UX
Outcome-oriented provider selection and persistent preferences.

### W092 — Vertical Extension Starter Kits
Specialist packs for system-of-record-heavy industries without changing the Aurum core.

### W093 — Browser/Computer-Use Fallback
Governed browser execution only when API/MCP/native integration is insufficient.

### W094 — Migration and Dual-Run Continuity
Historical import, ID preservation, synchronization, legacy/Aurum comparison, rollback and progressive retirement.

### W095 — Unified Cross-Channel/Meeting/Telephony Identity
One employee across Aurum, communications, meetings, phone and Edge.

### W096 — Integration Intelligence E2E Fixture
End-to-end connection discovery, approval, verification, mapping, observation, action and reconciliation.

### W097 — Meeting and Cellular E2E Fixture
End-to-end meeting + SMS + voice path evidence.

### W098 — Persistent Agent Supervision and Recovery
Durable health, waiting, reviews, budgets, retries and restart recovery.

### W099 — CommOS Fusion and Communication Kernel
Extract validated provider-neutral CommOS primitives into Aurum.

Matrix is an optional adapter inside this boundary, not core infrastructure.

### W100 — Longitudinal S003 Conversion Benchmark
Measure Aurum-primary and Aurum-only adoption after the new implementation.

### W101 — Final Post-S002 Production Certification
Final production release gate.

## 10. Dependency graph

```text
                         ┌────────── W080 ──────────┐
                         │                         │
W079 integrity ─→ W099 CommOS kernel          W098
                         │
              ┌──────────┼───────────┐
              ↓          ↓           ↓
            W085       W087        W088
              │          │
              ↓          ↓
            W086       W097

W081 → W082 → W083 → W084
  │                  │
  └→ W089            ├→ W092
                     └→ W094

W099 + W002 + W030 → W095

W090 → W091
W093 → W084

W084 + W092 + W040 → W100

W096 + W097 + W098 + W099 + W100 → W101
```

## 11. Three-worker execution plan

### Wave 0 — Tech Lead only

Do not start implementation until the Tech Lead:

- reconciles current main against exact W079 certification revision;
- records the exact new implementation baseline;
- freezes CommOS source SHAs;
- reconciles the CommOS AndroidResourceSampler contradiction;
- confirms CommOS source/license status;
- confirms no existing Aurum primitive is being duplicated.

### Wave 1

**Worker A — W080 Durable Agent Runtime**

Own workflow abstraction and durable execution semantics.

**Worker B — W081 Integration Intelligence**

Own organizational tool discovery, recommendation and onboarding UX.

**Worker C — W099 CommOS Fusion**

Own extraction of the validated CommOS communication kernel into Aurum.

No provider integrations yet beyond what is required to establish the kernel boundary.

### Wave 2

**Worker A — W082 Universal Connection Broker**

**Worker B — W085 Meeting Intelligence Gateway**

**Worker C — W087 Cellular Reachability**

W087 owns the manager→secretary Reach Anyone path and real telecom adapter boundary.

### Wave 3

**Worker A — W083 Progressive Capability Grants + W084 Deep Actions**

**Worker B — W086 LiveKit Realtime + Meeting Companion**

**Worker C — W088 Aurum Edge Connector + W089 Provider/OSS Registry**

### Wave 4

**Worker A — W090 Provider Billing Gateway + W091 Provider Choice UX**

**Worker B — W092 Vertical Extension Starter Kits**

**Worker C — W093 Browser/Computer-Use Fallback**

### Wave 5

**Worker A — W094 Migration + Dual-Run Continuity**

**Worker B — W095 Unified Cross-Channel/Meeting/Telephony Identity**

**Worker C — W098 Persistent Agent Supervision and Recovery**

### Wave 6

**Worker A — W096 Integration Intelligence E2E**

**Worker B — W097 Meeting + Cellular E2E**

**Worker C — independent security/licensing/provider reconciliation**

### Wave 7

Run W100 S003 against the mature implementation.

Then W101 final production certification.

Matrix implementation may be scheduled whenever real customer/use-case evidence warrants it, but it must never block the cellular, meeting or general integration path.

## 12. Worker non-overlap rules

- Only one worker owns a public gateway contract at a time.
- Provider-specific work stays inside adapter folders.
- UI workers do not modify domain semantics.
- CommOS extraction may reuse source contracts/tests but may not introduce a second database truth or auth model.
- No worker changes frozen Architecture v2.1.
- If a requirement appears to require an architecture change, stop and report the required change to the Tech Lead.
- Work items may be implemented together only when their public contracts are already stable and ownership boundaries are explicit.

## 13. Technology selection policy

### Durable workflow

Keep the technology behind an Aurum workflow port.

Current deployment-compatible choice remains Vercel Workflows.

Inngest / Trigger.dev / Temporal are replaceable candidates, not domain dependencies.

### Execution

- Modal: general scalable execution;
- E2B: isolated code/computer-use execution;
- normal workers/containers: ordinary background tasks.

### Realtime

LiveKit is the leading realtime implementation, not a semantic dependency.

### Meetings

Native platform adapters first; Recall.ai/Meeting BaaS may accelerate cross-platform coverage.

### Integrations

Nango is the leading connection/OAuth/sync candidate.

Composio/Pipedream/Workato/Merge/Speakeasy may be used behind provider-neutral boundaries when they materially reduce coverage or onboarding work.

### Browser fallback

Stagehand/Browserbase/E2B only after API/MCP/native paths are unavailable or insufficient.

### OSS

Before writing equivalent infrastructure, check the OSS registry created by W089.

## 14. Required production behavior

### Integration onboarding

```text
Connect organization
→ Aurum surveys authorized tools
→ Aurum explains why each matters
→ approve recommended safe connections
→ automatic connection
→ automatic verification
→ automatic mapping
→ read-only learning
→ ask for additional authority only when needed
→ execution
→ reconciliation
→ learning
```

### Communication

```text
"Tell Sarah..."
→ identity resolution
→ best permitted channel
→ SMS
→ voice
→ delivery evidence
→ optional reply into Aurum
```

### Meeting

```text
meeting
→ consent/status
→ transcript/media
→ speaker attribution
→ evidence
→ decisions
→ unknowns
→ actions
→ missions
→ outcomes
```

### Persistent cognition

```text
event
→ durable execution
→ worker
→ evidence/result
→ durable state
→ next step
```

## 15. Final acceptance gates

A release cannot be called complete merely because a provider SDK or OSS component was installed.

The final gates require:

1. **One product:** Aurum remains the sole organizational UX.
2. **One identity:** no duplicated employee/person authority.
3. **One policy authority:** Aurum W009 governs consequential communications/actions.
4. **One evidence truth:** communication/delivery evidence enters Aurum audit/evidence.
5. **Provider independence:** at least two materially different implementations can satisfy each important provider gateway without changing domain contracts.
6. **CommOS conformance:** reused protocol primitives pass Aurum-side conformance tests.
7. **Real cellular:** manager can reach an offline recipient by SMS and/or voice through a real provider.
8. **Meeting intelligence:** real provider evidence for supported meeting platforms.
9. **Persistent execution:** worker/process loss does not lose cognition state.
10. **Integration Intelligence:** authorized organizational tooling can be discovered and connected without manual connector-by-connector setup.
11. **Progressive authority:** read-only first; write/action authority is explicit and scoped.
12. **Action reconciliation:** external writes are verified against resulting state.
13. **Enterprise Edge:** private system path is proven without turning Edge into a second control plane.
14. **Open-source due diligence:** adopted dependencies have explicit license/security/maintenance/exit records.
15. **Simulation:** S003 shows movement in Aurum-primary/Aurum-only metrics.
16. **Production certification:** W101 has two consecutive zero-failure/zero-blocked runs against one exact production deployment revision.

## 16. Final source-of-truth order

When reports conflict:

1. repository code;
2. real live behavior;
3. committed machine-generated evidence;
4. frozen specs;
5. worklog/issue prose.

The CommOS AndroidResourceSampler contradiction is the canonical example of why this order matters.

## 17. Current roadmap status

```text
FOUNDATION
W001–W056  ✅ Delivered

PRODUCT / UX / DEPLOYMENT
W057–W078  ✅ Delivered / evidenced
W079       ✅ Certified on its exact recorded revision
             ⚠ Current main is newer; re-certification required

POST-S002
W080       ⬜ Durable Agent Runtime
W081       ⬜ Integration Intelligence
W082       ⬜ Universal Connection Broker
W083       ⬜ Progressive Capability Grants
W084       ⬜ Deep Action Gateway
W085       ⬜ Meeting Intelligence Gateway
W086       ⬜ Realtime Voice / Meeting Companion
W087       ⬜ Cellular Reachability
W088       ⬜ Aurum Edge Connector
W089       ⬜ Provider SDK / OSS Registry
W090       ⬜ Provider Billing Gateway
W091       ⬜ User-Friendly Provider Choice
W092       ⬜ Vertical Extension Starters
W093       ⬜ Browser Fallback
W094       ⬜ Migration / Dual Run
W095       ⬜ Unified Identity
W096       ⬜ Integration E2E
W097       ⬜ Meeting + Cellular E2E
W098       ⬜ Persistent Agent Supervision
W099       ⬜ CommOS Fusion Kernel
W100       ⬜ S003 Conversion Benchmark
W101       ⬜ Final Production Certification
```

## 18. Final strategic decision

Do not build two products.

Build:

**Aurum — the organizational intelligence employee**

with:

**Universal Comm OS — the reusable communication kernel underneath it.**

The communication kernel should make Aurum capable of reaching an employee wherever they are; the intelligence layer should decide **who, why, what, when and whether**; the transport layer should decide **how**; and the evidence layer should remember **what actually happened**.

That separation is the key to achieving both universal organizational intelligence and universal reach without creating a monolith or provider lock-in.
