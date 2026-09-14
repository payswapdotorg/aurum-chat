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
