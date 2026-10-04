# Aurum Implementation Dependency DAG

The implementation is a dependency DAG. Work may run in parallel only when declared contracts are already present and no architectural primitive is concurrently modified.

```text
FOUNDATION
  W001 Tenant + workspace
  W002 Identity resolution
  W003 Events
  W004 Observations + provenance
  W005 World model
  W006 Temporal state + freshness
  W007 Claims/beliefs/unknowns
  W008 Goals + desired state
  W009 Policy + authority

COGNITION CORE
  W003 + W004 → W010 Memory
  W007 + W008 → W011 Learning Missions
  W002 + W004 + W011 → W012 Knowledge Acquisition
  W008 + W009 + W010 + W011 + W012 → W013 Cognitive Orchestrator

ORGANIZATIONAL INTELLIGENCE
  W005 + W006 + W013 → W014 Environment Watch
  W005 + W013 → W015 Opportunity Engine
  W013 → W016 Process Intelligence
  W016 → W017 Capability Graph
  W017 → W018 Automation Opportunities
  W017 → W019 Workforce Intelligence
  W017 → W020 Supplier Intelligence

WORKFORCE / CAPABILITY
  W009 + W013 → W021 Agent Gateway
  W017 + W018 + W021 → W022 Agent Recruitment
  W022 → W023 Agent Teams
  W021 + W022 + W023 → W024 Agent Evaluation/Termination
  W009 + W013 → W025 Extension Contracts
  W025 → W026 Extension Runtime
  W021 + W026 → W027 Extension Builder
  W027 → W028 Marketplace Governance

CHANNEL / EXPERIENCE
  W002 → W029 Conversations
  W029 → W030 Channel Adapters
  W009 + W030 → W031 Notifications
  W008 + W013 + W031 → W032 Management Briefings
  W005 + W007 + W008 + W011 + W013 + W019 + W024 → W033 Control Tower

AI / PLATFORM
  W009 → W034 LLM Gateway + BYOA
  W021 → W035 Agent Provider Registry
  W004 + W006 → W036 Source Gateway
  W036 → W037 Destination Gateway
  W033 + W009 → W038 Public API
  W033 + W009 → W039 MCP

LEARNING / REWARDS
  W012 + W013 → W040 Outcome Measurement
  W040 → W041 Company Learning
  W012 + W040 → W042 Knowledge Contributions
  W042 + W009 → W043 Rewards

SECURITY / GOVERNANCE
  W001 + all information modules → W044 Tenant Isolation Verification
  W002 + W030 → W045 Identity/Channel Verification
  W005 + W007 + W010 + W013 → W046 Decision Evidence/Audit
  W028 + W026 + W021 → W047 Capability Security Verification
  W034 + W035 → W048 Provider Hot-Swap Verification

INTEGRATION PROOF
  W013 + W012 + W014 + W015 + W018 + W019 + W022 + W030 → W049 Company Intelligence End-to-End Fixture
  W028 + W038 + W039 + W033 → W050 Platform Surface End-to-End Fixture
```

## Parallelization tracks

After W001–W009 contracts stabilize, these tracks can proceed in parallel:

- cognition/learning missions;
- source/environment intelligence;
- process/capability/workforce;
- agent workforce;
- extensions/marketplace;
- channels/identity;
- LLM/BYOA;
- API/MCP;
- audit/security.

Every work item must have exact acceptance evidence and must not redefine frozen architecture.

## Learning moat (addenda)

```text
LEARNING MOAT (per ADR-0016/0017/0018/0019)
  W007 + W008 + W011 + W013 → W051 Unprompted Unknown Discovery
  W010 + W012 + W051 → W052 Knowledge Source Ranking
  W040 + W041 + W042 → W053 CompanyModel Learning
  W018 + W022 + W023 + W027 + W040 → W054 Capability Outcome Learning
  W013 + W041 + W051 + W052 + W054 → W055 Quality Measurement
  W053 + W054 + W055 → W056 Longitudinal Company Simulator (per LONGITUDINAL-BENCHMARK.md)
```


## Post-W070 journey / deployment hardening

```text
W057 + W060 → W071 WhatsApp-like Conversation Fidelity
W061 + W065 + W071 → W072 Conversational Intelligence Continuity
W062 + W072 → W073 Chat-based Learning Requests
W063 + W072 → W074 Conversational Interventions / Approval Continuity
W064 + W066 + W067 + W071 → W075 Natural Capability Discovery
W070 + W071 + W072 + W073 + W074 + W075 → W076 Real Browser Journey / Visual Conformance
W069 → W077 Free-Tier Deployment Instantiation
W076 + W077 → W078 Post-Deployment Smoke / Operations Proof
```

### Three-worker waves

```text
Wave 1:  W071 | W075 | W077
Wave 2:  W072 | W073 | W074
Wave 3:  W076 | W078 | Tech Lead integration/reconciliation
```

Ownership rule: W071 owns chat presentation/interaction chrome; W072 owns the reusable conversational-card/context contract; W073 owns learning surfaces; W074 owns intervention surfaces; W075 owns navigation/discovery; W077 owns deployment/infra; W076/W078 own verification. Do not concurrently edit the same primitive outside these ownership boundaries.

## Final release certification

```text
W077 + W078 + W076 + W070 → W079 Production Journey Certification & Release Gate
```

W079 is a release gate, not a feature track. It may not be marked complete from local/preview evidence. It requires two consecutive green certification runs against the same live production deployment revision.

## Post-S002 organizational reach / integration / realtime DAG

```text
W080 Durable Agent Runtime
  ├──→ W084 Deep Action Gateway
  ├──→ W085 Meeting Intelligence Gateway
  ├──→ W086 Realtime Voice / Meeting Companion
  └──→ W098 Persistent Agent Supervision

W081 Integration Intelligence
  ├──→ W082 Universal Connection Broker
  ├──→ W083 Progressive Capability Grants
  └──→ W096 Integration E2E Fixture

W082 + W083 + W009
  └──→ W084 Deep Action Gateway + Reconciliation

W085
  └──→ W086

W084
  ├──→ W092 Vertical Extension Starter Kits
  ├──→ W093 Browser / Computer-Use Fallback
  └──→ W094 Migration + Dual-Run Continuity (after W092)

W087 Cellular Reachability
  └──→ W095 Unified Cross-Channel / Meeting / Telephony Identity

W085 + W086 + W087 + W002 + W030
  └──→ W095 Unified Identity

W088 Aurum Edge Connector
  └──→ W092, W093

W089 Provider Adapter SDK + OSS Registry
  ├──→ W082
  ├──→ W090 Provider Billing
  └──→ optional W099 Matrix Adapter

W090
  └──→ W091 Provider Choice UX

W084 + W088 + W092
  └──→ W094 Migration + Dual Run

W081 + W082 + W083 + W084
  └──→ W096 Integration E2E

W085 + W086 + W087 + W095
  └──→ W097 Meeting + Cellular E2E

W080 + W021 + W023 + W024
  └──→ W098 Supervision / Recovery

W092 + W094 + W096 + W097 + W098
  └──→ W100 Longitudinal S003

W096 + W097 + W098 + W100 + production infrastructure
  └──→ W101 Final Production Certification
```

### Post-S002 three-worker waves

```text
Wave 0:
  Tech Lead — reconcile current main vs exact W079-certified revision; freeze baseline.

Wave 1:
  Worker A — W080 Durable Agent Runtime
  Worker B — W081 Integration Intelligence
  Worker C — W089 Provider Adapter SDK + OSS Technology Registry

Wave 2:
  Worker A — W082 Universal Connection Broker
  Worker B — W085 Meeting Intelligence Gateway
  Worker C — W087 Cellular Reachability

Wave 3:
  Worker A — W083 Progressive Capability Grants + W084 Deep Actions
  Worker B — W086 Realtime Voice + Meeting Companion
  Worker C — W098 Persistent Agent Supervision + Recovery

Wave 4:
  Worker A — W088 Aurum Edge Connector
  Worker B — W090 Provider Billing Gateway
  Worker C — W095 Unified Cross-Channel / Meeting / Telephony Identity

Wave 5:
  Worker A — W091 User-Friendly Provider Choice UX
  Worker B — W092 Vertical Extension Starter Kits
  Worker C — W093 Browser / Computer-Use Fallback

Wave 6:
  Worker A — W094 Migration + Dual Run
  Worker B — W096 Integration Intelligence E2E
  Worker C — W097 Meeting + Cellular E2E

Wave 7:
  Worker A — W099 Matrix Interoperability Adapter (optional)
  Worker B — W100 Longitudinal S003 Conversion Benchmark
  Worker C — Tech Lead security/licensing/provider reconciliation

Wave 8:
  All workers support W101 final production certification.
```

### Parallelization rule

A worker may start an item only after every dependency contract listed in the catalog is already present and stable. Two workers may not concurrently change the same public contract. Optional Matrix work may never block W087, W085/W086, W081-W084, W092 or W101.

### Scope rule

W080-W101 are the only post-S002 implementation scope in this DAG. Historical out-of-scope research artifacts are not implementation dependencies for these work items.
## Post-W106 operational closure DAG

```text
W084 + W088 + W092 → W107 Vertical Kit ↔ Edge Execution Closure
W009 + W030 + W031 + W087 + W095 → W108 Cellular Live Transport + Inbound Authority Closure
W085 + W086 + W095 + W097 → W109 Meeting / Realtime Live-Provider Closure

W084 + W088 + W093 → W110 Real Browser / Computer-Use Driver Composition
W088 + W092 + W094 + W096 → W111 Production Migration Reader / Native-Reader Adapters

W107 + W108 + W109 + W110 + W111 → W112 Post-W106 Live-Capability Certification
```

### Post-W106 parallel waves

```text
Wave 1:
  Worker A → W107
  Worker B → W108
  Worker C → W109

Wave 2:
  Worker A → W110
  Worker B → W111
  Worker C → migration-runner hardening investigation (conditional; no architecture change without evidence)

Wave 3:
  Tech Lead → integration/reconciliation
  All workers → W112 certification
  W099 → optional only when a concrete customer/use-case exists
```

### Post-W106 orchestration law

Independent dependency-ready items must be dispatched concurrently up to three workers.
A new wave may begin only after the TL reconciles the prior wave at an exact base SHA and
updates the repository state/evidence. W099 never blocks the closure program.

## Unified 2026-10-04 Agent Body / Lab / Execution / Cross-Platform DAG

W124 → W125, W126, W131

W125 + W126 + existing W034/W048/W091 → W132 Provider Fabric
W021 + W034 + W063 + W132 → W133 Aurum Agent Body
W012 + W041 + W052 + W053 + W125-W128 + W133 → W134 Information Strategy
W022-W024 + W034 + W040 + W041 + W052-W055 + W133 + W134 → W135 Contextual Organizational Lab
W021-W028 + W035 + W063 + W125-W135 → W136 Agent Exchange / Execution Plan / Relay
W093 + W110 + W131 + W136 → W137 Execution Environment
W028 + W035 + W040 + W054 + W135 + W136 → W138 Emergent Roles / Marketplace Publication
W057 + W060 + W076 + W131-W137 → W139 Cross-Platform Product
W128-W139 → W140 Unified Closed-Loop Learning
W130 + W135-W140 → W141 End-to-End / Cross-Platform Certification

### Contextual Lab rule

Organization selection is a function of goal + task + context, not task subject alone. Context may include season/time window, duration, staffing, staff experience, workload, capabilities, environment, budget, quality, risk, verification and evidence freshness. A change in these inputs may change the best organization and must never be treated as an architecture inconsistency.

### Three-worker waves

Wave A: TL W124; Worker A W125; Worker B W126; Worker C W131.
Wave B: Worker A W132; Worker B W133; Worker C W134.
Wave C: Worker A W135; Worker B W136; Worker C W137.
Wave D: Worker A W138; Worker B W139; Worker C W140.
Wave E: TL integration/certification W141.

No two workers may modify the same public contract concurrently. Root manifests, lockfiles and governance-state files remain TL-controlled.
