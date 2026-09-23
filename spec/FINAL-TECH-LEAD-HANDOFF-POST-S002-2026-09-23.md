# Final Tech Lead Handoff — Aurum Post-S002 W080–W101

**Repository:** `payswapdotorg/aurum-chat`  
**Architecture:** Aurum v2.1 — FROZEN  
**Scope:** **W080–W101 only**  
**Maximum concurrent workers:** 3  
**Historical work outside W080–W101:** do not add to this implementation scope.

## 1. Takeover rule

The Tech Lead must fetch the repository's current `main` at takeover time.

Do not assume that an earlier W079 certification applies to the current main. The exact W079 certification revision is historical evidence only. Reconcile the deployed production SHA with W079 before beginning new production-facing work.

Repository truth order:

1. source code and committed tests;
2. actual live behavior;
3. committed machine-generated evidence;
4. frozen specification/contracts;
5. issue/worklog prose.

When these disagree, the higher item wins.

## 2. Read-first documents

Read these files before dispatching any worker:

- `spec/ARCHITECTURE.md`
- `spec/ARCHITECTURE-LOCK.md`
- `spec/GOVERNANCE.md`
- `spec/IMPLEMENTATION-STACK.md`
- `spec/SIMULATION-LEARNING-LOG.md`
- `spec/TECHNOLOGY-RESEARCH-2026-09-23.md`
- `spec/POST-S002-COHERENT-IMPLEMENTATION-PLAN-2026-09-23.md`
- `spec/work-items/WORK-ITEM-CATALOG.md`
- `spec/WORK-ITEM-DEPENDENCY-GRAPH.md`
- `spec/PRODUCTION-JOURNEY-CERTIFICATION-2026-09-23.md`

The implementation plan, work-item catalog and DAG are the operational source for W080–W101.

## 3. Mission

Evolve Aurum from a strong organizational-intelligence implementation into a persistent, provider-independent organizational work surface.

The target is not another dashboard or another chatbot.

The target is:

`understand organization → reach people → understand meetings → connect systems → operate systems → verify outcomes → learn → become primary work surface`

The organization should not need to reorganize itself around Aurum before receiving value.

## 4. Frozen product principles

### 4.1 One organizational intelligence employee

Aurum owns the organizational intelligence loop, CompanyModel, epistemics, goals, unknowns, missions, evidence, policy, outcomes and management context.

### 4.2 Conversation is a channel

Aurum Chat is the canonical Aurum conversational surface. Employees do not have to abandon the channels they already use.

### 4.3 Universal reach

Aurum should be able to communicate with an employee through their available verified channel.

Canonical user intent:

> **“Tell Sarah the supplier meeting moved to 4pm.”**

Aurum resolves the employee and selects an authorized delivery path.

Fallback:

`preferred connected channel → SMS → voice`

The recipient does **not** need Internet access or an Aurum account.

Where the sender has cellular service but no usable Internet data, an SMS/voice entry path to an Aurum organizational number should be supported where provider terms permit.

If there is no available network/radio path at all, Aurum must explicitly report that it cannot reach the recipient.

### 4.4 Meetings are organizational evidence

Aurum must be able to participate in:

- Zoom;
- Microsoft Teams;
- Google Meet;
- approved in-person meetings.

Meeting information enters the same identity, evidence, CompanyModel and cognition loop.

There is no separate meeting knowledge store.

### 4.5 Persistent actor, ephemeral workers

Aurum is persistent because its identity/state and workflows persist.

Persistent:

- tenant/employee identity;
- CompanyModel/memory;
- goals;
- unknowns;
- LearningMissions;
- policy;
- integrations;
- evidence;
- executions;
- outcomes;
- agent/extension state.

Ephemeral:

- LLM execution;
- browser sessions;
- connector jobs;
- code execution;
- media processing;
- realtime sessions;
- specialist-agent workers.

Worker/process death must not destroy Aurum state or mission progress.

### 4.6 Provider independence

No provider is architecturally privileged.

Providers are adapter implementations, not domain dependencies.

A new provider should require:

1. provider adapter;
2. capability mapping;
3. health/error mapping;
4. credential/scope mapping;
5. conformance tests;
6. hot-swap evidence;

and no core domain rewrite.

### 4.7 Open-source reuse before rebuilding

Before implementing substantial infrastructure, check the technology registry/research.

Reuse a mature open-source component or create a thin adapter when licensing, security, maintenance, operations, performance and exit risk are acceptable.

Do not rebuild a mature equivalent merely to avoid dependencies.

### 4.8 User-facing choices are outcome-oriented

Non-advanced users never need to understand providers or runtimes.

Expose choices such as:

- **Best quality**
- **Fastest**
- **Lowest cost**
- **Most private**
- **Use my organization's setup**
- **Let Aurum choose**

Technical provider names and configuration belong in advanced settings.

A provider choice can be changed later.

### 4.9 Provider spending is abstracted

When a provider supports Aurum-mediated billing, present one Aurum billing experience and settle provider usage underneath.

When direct customer billing is mandatory, explain that requirement without leaking provider mechanics into normal UX.

Provider billing data must not become organizational truth.

## 5. S002 findings driving the plan

S002 simulated 11 industries, 3 firm sizes, 33 firms, 300 projects per firm, 9,900 projects and 7,150 professionals.

Current simulated Aurum-only willingness was about 24.7%; a mature implementation scenario reached about 56.8%.

The important finding is not the exact synthetic percentages. It is the mechanism:

- Aurum's organizational memory and cross-project intelligence are broadly valuable;
- specialized systems of record remain the main replacement barrier;
- Aurum-primary is a nearer target than Aurum-only;
- deep bidirectional integration matters more than adding another dashboard;
- migration and dual-run reduce enterprise switching friction;
- regulated industries require additional trust/deployment controls;
- channel coverage increases access, but deep workflow execution increases replacement potential.

Therefore implementation should prioritize making Aurum the **front door** to existing systems rather than demanding immediate system replacement.

## 6. W080–W101 work items

### W080 — Durable Agent Runtime Adapter
Durable workflow abstraction for event-triggered cognition, schedules, long waits, approvals, retries, cancellation, resumptions and idempotency.

Core proof:
worker/process loss must not lose workflow state; an active workflow can resume deterministically.

### W081 — Integration Intelligence
Discover authorized organizational tooling, explain why each system matters, recommend safe connections and build the tenant-scoped Tool & System Inventory.

Core proof:
authorized discovery produces understandable recommendations without uncontrolled scanning.

### W082 — Universal Connection Broker
Abstract OAuth, credentials, syncs and webhooks behind provider-neutral boundaries.

Core proof:
connect/revoke/refresh/checkpoint behavior survives provider errors and broker replacement.

### W083 — Progressive Capability Grants
Start read-only. Ask for narrowly scoped write/action authority only when a concrete task requires it.

Core proof:
the user sees why the permission is necessary; denying it prevents the action; retry asks only for the missing authority.

### W084 — Deep Action Gateway and Reconciliation
Implement:

`discover → inspect → propose → authorize → execute → verify → reconcile → evidence → outcome`

Core proof:
multi-system work can be initiated from Aurum and downstream state is verified.

### W085 — Meeting Intelligence Gateway
Canonical meeting/session/transcript/artifact contracts plus native Zoom/Teams/Meet adapters and optional cross-platform acceleration.

Core proof:
participant identity, transcript/artifact and provenance enter the canonical evidence model.

### W086 — Realtime Voice and Meeting Companion
Provider-neutral realtime contracts with a replaceable LiveKit implementation.

Core proof:
live session start/stop, explicit consent/status, interruption, speaker attribution, live transcript, spoken response and durable meeting artifact.

### W087 — Cellular Reachability and Communication Fallback
Implement the **Reach Anyone** capability over SMS/voice with multiple telecom adapters and routing/policy/cost logic.

Core proof:
manager → Aurum → verified employee → SMS, voice fallback if permitted, delivery evidence, optional reply back to Aurum.

### W088 — Aurum Edge Connector
Customer-controlled runtime for private/on-prem APIs, MCP/OpenAPI, databases, files and approved browser adapters.

Core proof:
signed tenant-scoped jobs can reach private systems without creating a second control plane.

### W089 — Provider Adapter SDK and OSS Technology Registry
Standardize adapter lifecycle and maintain technology evaluation records.

Registry fields:

`capability, provider/project, license, security, maintenance, deployment, data handling, cost/performance, failure modes, exit strategy, adapter status, last reviewed`

Core proof:
at least two materially different providers can satisfy a representative gateway contract.

### W090 — Aurum Provider Billing Gateway
Abstract provider usage/cost/budget/settlement.

Core proof:
cost is attributable to tenant/capability/execution, budget policy can constrain usage, supported provider settlement is auditable and direct-billing exceptions do not break capability execution.

### W091 — User-Friendly Provider Choice UX
Outcome-oriented provider selection and persistent preferences.

Core proof:
ordinary users never need provider jargon; advanced users can inspect/override where authorized.

### W092 — Vertical Extension Starter Kits
Reusable specialist extension/agent packs and first deep integrations for system-of-record-heavy industries.

Core proof:
packs are installable, permission-scoped, versioned, auditable, removable and do not introduce vertical semantics into the core.

### W093 — Browser and Computer-Use Fallback
Governed browser automation only when native/API/MCP routes are unavailable or insufficient.

Core proof:
disposable isolated sessions, action traces, verification and reconciliation.

### W094 — Migration and Dual-Run Continuity
Historical import, identifier preservation, synchronization, legacy/Aurum comparison, rollback and progressive retirement.

Core proof:
Aurum and incumbent can run together without silent data loss or competing authority.

### W095 — Unified Cross-Channel/Meeting/Telephony Identity
Keep one organizational Person/Employee identity across messaging, meetings, SMS and voice.

Core proof:
one verified employee is recognized across multiple communication modalities; ambiguity never auto-merges.

### W096 — Integration Intelligence E2E Fixture
Prove the complete connection discovery and action path.

Core proof:

`discover → recommend → approve → connect → verify → map → observe → request action scope → execute → reconcile → outcome`

### W097 — Meeting and Cellular E2E Fixture
Prove meeting intelligence, Meeting Companion, SMS, voice and reply continuity.

Core proof:
supported real-provider evidence plus deterministic fallback fixture; recipient needs neither Internet nor Aurum.

### W098 — Persistent Agent Supervision and Recovery
Prove persistent agent health, budgets, review schedules, waits and restart recovery.

Core proof:
worker death does not terminate the organizational actor or lose lifecycle state.

### W099 — Matrix Interoperability Adapter (Optional)
Matrix is **optional interoperability**, not Aurum's messaging core.

Implement only when customer/use-case evidence justifies it.

Core proof:
Matrix events normalize into canonical Aurum conversations/evidence and can be disabled without changing Aurum core messaging.

### W100 — Longitudinal S003 Conversion Benchmark
Repeat the S002 multi-industry simulation after these capabilities mature.

Measure:

- Aurum-primary willingness;
- Aurum-only willingness;
- context-switching reduction;
- integration setup effort;
- action success/reconciliation;
- trust;
- realized value.

Do not present synthetic results as market forecasts.

### W101 — Final Post-S002 Production Certification
Certify the complete production experience.

Required domains:

- persistent cognition;
- integrations;
- deep actions;
- cross-channel identity;
- meetings;
- realtime;
- cellular reachability;
- provider choice;
- provider billing;
- Edge;
- vertical extensions;
- browser fallback.

## 7. Dependency DAG

```text
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
```

## 8. Three-worker execution waves

### Wave 0 — Tech Lead only

- fetch current main;
- reconcile current deployment against exact W079 certification revision;
- record current production/deployment SHA;
- record new W080–W101 baseline SHA;
- confirm current repository has all canonical post-S002 docs;
- verify there are no dependency cycles;
- freeze work-item ownership.

### Wave 1

**Worker A:** W080 Durable Agent Runtime  
**Worker B:** W081 Integration Intelligence  
**Worker C:** W089 Provider Adapter SDK + OSS Technology Registry

### Wave 2

**Worker A:** W082 Universal Connection Broker  
**Worker B:** W085 Meeting Intelligence Gateway  
**Worker C:** W087 Cellular Reachability

### Wave 3

**Worker A:** W083 Progressive Capability Grants + W084 Deep Actions  
**Worker B:** W086 Realtime Voice + Meeting Companion  
**Worker C:** W098 Persistent Agent Supervision + Recovery

### Wave 4

**Worker A:** W088 Aurum Edge Connector  
**Worker B:** W090 Provider Billing Gateway  
**Worker C:** W095 Unified Cross-Channel / Meeting / Telephony Identity

### Wave 5

**Worker A:** W091 User-Friendly Provider Choice UX  
**Worker B:** W092 Vertical Extension Starter Kits  
**Worker C:** W093 Browser / Computer-Use Fallback

### Wave 6

**Worker A:** W094 Migration + Dual Run  
**Worker B:** W096 Integration Intelligence E2E  
**Worker C:** W097 Meeting + Cellular E2E

### Wave 7

**Worker A:** W099 Matrix interoperability only if customer/use-case evidence justifies it  
**Worker B:** W100 Longitudinal S003 Conversion Benchmark  
**Worker C:** Tech Lead security/licensing/provider reconciliation

### Wave 8

All workers support W101 final production certification.

## 9. Worker operating rules

### Contract ownership

One worker owns a public contract at a time.

Dependent workers consume public contracts only.

Cross-module internal imports remain forbidden.

### Provider isolation

Provider SDKs are confined to their adapter boundaries.

Provider objects may not cross into Aurum domain contracts.

### Failure isolation

A provider outage must not become a domain failure.

The adapter converts provider-specific failure into canonical capability/error state.

### Persistence

A worker can disappear at any point.

Long-running state must survive that disappearance.

### Authorization

No consequential action bypasses W009 policy/authority.

### Evidence

No provider execution becomes authoritative merely because it returned success.

External state must be verified and reconciled when the capability permits it.

### Tenant isolation

Every integration, meeting, telephony, realtime and Edge operation remains tenant-scoped.

### Architecture lock

Workers do not modify Architecture v2.1 silently.

An architecture change requires explicit change control and versioning.

## 10. User experience requirements

The product should hide technical complexity.

### First launch

The organization gives Aurum permission to understand its environment.

Aurum then discovers and explains the systems it finds.

Do not require administrators to browse a connector catalog one system at a time unless discovery is unavailable.

### When a new capability needs a provider

Aurum asks:

> **How should I handle this?**

Then:

> **Best quality**  
> **Fastest**  
> **Lowest cost**  
> **Most private**  
> **Use my organization's setup**  
> **Let Aurum choose**

Only authorized advanced users see the specific provider/runtime choice.

### Progressive authority

Default:

**observe/read**

Then:

**recommend**

Then, when required:

**request the exact action permission**

Then:

**execute**

Then:

**verify**

Then:

**record outcome**

## 11. Ideal integration journey

```text
Connect organization
    ↓
Aurum surveys authorized tools
    ↓
Aurum explains why each matters
    ↓
Aurum recommends safe connections
    ↓
Admin approves
    ↓
Automatic authentication
    ↓
Automatic verification
    ↓
Identity/entity mapping
    ↓
Read-only learning
    ↓
Useful finding/action appears
    ↓
Aurum requests only required additional authority
    ↓
Authorized execution
    ↓
Verification + reconciliation
    ↓
Evidence + outcome
    ↓
CompanyModel learning
```

## 12. Ideal communication journey

```text
Manager: "Tell Sarah the supplier meeting moved to 4pm."
                  ↓
             Aurum identity
                  ↓
          available channels
                  ↓
       preferred authorized route
            ↙         ↘
          SMS         voice
            ↓           ↓
              Sarah
                  ↓
           delivery evidence
                  ↓
        optional authorized reply
```

The recipient does not need Internet or an Aurum account.

## 13. Ideal meeting journey

```text
meeting starts
    ↓
consent / participation state
    ↓
media/transcript
    ↓
speaker identity
    ↓
evidence
    ↓
decisions / unknowns / actions
    ↓
missions / recommendations
    ↓
outcome
    ↓
CompanyModel learning
```

## 14. Technology policy

### Durable orchestration

Keep orchestration behind an Aurum workflow port.

Current deployment-compatible infrastructure may be used while Inngest/Trigger.dev/Temporal remain replaceable candidates.

### General execution

Use Modal or equivalent scalable execution where appropriate.

### Isolated code/computer use

Use E2B or equivalent isolated sandboxes where appropriate.

### Realtime

Use LiveKit through a provider-neutral realtime gateway.

### Meeting capture

Prefer native platform APIs; use Recall/Meeting BaaS as an acceleration adapter when useful.

### Integrations

Use Nango or equivalent managed connection infrastructure behind Aurum gateways.

Use long-tail brokers only when they materially reduce coverage and preserve Aurum authority/audit semantics.

### Browser fallback

Use Stagehand/Browserbase/E2B-style execution only when native integration is insufficient.

### Matrix

Optional W099 only. Never make Matrix a prerequisite for core Aurum communication.

## 15. OSS due diligence

Before adopting a dependency, record:

- what capability it solves;
- license;
- source availability;
- security posture;
- activity/maintenance;
- deployment/control;
- customer data handling;
- performance and cost;
- failure modes;
- exit/replacement path.

A mature open-source component should be reused when those checks pass and the adapter boundary remains healthy.

## 16. Acceptance and certification

A work item is complete only when its repository state and evidence satisfy the catalog.

Do not accept:

- mocks presented as real providers;
- screenshots without actual functional paths;
- provider SDK import without adapter isolation;
- tests that bypass authorization;
- local-only evidence for production claims;
- worklog claims unsupported by code/evidence.

W101 is the final release gate.

It requires:

- two consecutive production runs against one exact deployment revision;
- zero failed mandatory journeys;
- zero blocked mandatory journeys;
- zero flaky mandatory journeys;
- tenant isolation;
- human-approval invariants;
- provider independence evidence;
- meeting/cellular evidence;
- persistent-runtime recovery evidence;
- integration/action reconciliation evidence;
- rollback evidence.

## 17. Definition of done for the whole W080–W101 program

The program is complete only when an organization can reasonably experience Aurum as:

**one persistent organizational employee**

that can:

**understand the company → reach employees wherever they are → participate in meetings → discover and connect the organization's tools → operate those tools under authority → verify results → learn from outcomes → remain useful without provider lock-in.**

The system should progressively move the organization toward **Aurum-primary** operation and, where specialist capabilities and regulatory constraints allow, **Aurum-only** operation.
