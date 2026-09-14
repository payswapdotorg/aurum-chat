# Mission Alignment Matrix

| Mission requirement | Canonical primitive | Verification target |
|---|---|---|
| Feels like a new employee | Aurum Employment Profile + persistent identity + conversation | stable role, authority, memory, reporting and channel identity |
| One Aurum across all employee channels | ExternalIdentity + Channel Gateway | same employee resolved across supported channels |
| Company workspace/multitenancy | Tenant/Workspace model | tenant isolation tests for every information-bearing aggregate |
| Understand company in real time | Sources + events + observations + freshness | ingestion latency/freshness visible and auditable |
| Understand external environment | EnvironmentWatch + external sources | external event linked to affected company goals/entities |
| Goal-driven learning | Goals + Unknowns + LearningMission | mission priority changes with goal importance |
| Ask employees | Knowledge Acquisition Planner + identity + contribution | targeted employee question creates evidence and mission progress |
| Learn from CRM/tools | Source connectors | structured/unstructured extraction with provenance |
| Reward helpful employees | KnowledgeContribution + RewardPolicy | reward tied to information/goal value, never silent performance rating |
| Output to analytics | Destination Gateway | authorized findings/results exported with provenance |
| Recruit agents | AgentRecruitmentProposal + Agent Gateway | approval → provision → execution → evaluation |
| Recruit teams | AgentTeam | shared objective, roles, budget and outcomes |
| Replace/terminate agents | Agent evaluation + lifecycle | evidence-based retain/modify/terminate proposal |
| Detect inefficiency | Process intelligence | evidence-backed process bottlenecks and cost estimates |
| Capability gaps | Capability Graph + AutomationOpportunity | train/hire/agent/software/outsource alternatives |
| Identify inefficient employees | Workforce Assessment | evidence + alternatives + uncertainty; no autonomous termination |
| Automate tasks | AutomationOpportunity + Extension/Agent acquisition | expected ROI and outcome measurement |
| Industry neutrality | specialist Agent/AgentTeam/Extension ecosystem | core remains horizontal |
| Developers build/test/publish apps | Extension Builder + Runtime | verified stateful extension fixture |
| Approval before marketplace availability | Marketplace lifecycle | PENDING_REVIEW cannot become INSTALLABLE without platform approval |
| Developers publish agents too | AgentPackage marketplace artifact | same review/governance path |
| Provider agnostic | LLM Gateway + Agent Gateway + Source/Channel gateways | hot-swap tests and adapter isolation |
| BYOA | AIProviderAccount + AgentProviderAccount | tenant-owned credentials and routing without semantic lock-in |
| API | API Gateway | versioned tenant-scoped capability API |
| MCP | MCP Gateway | capability-oriented MCP tools with auth/audit |
| Central company intelligence | World Model + Evidence + Control Tower | management can trace any material answer to evidence |
| Management exposure | Control Tower + Briefings | proactive situation/goal/unknown/risk/opportunity view |

## Product success criterion

Aurum should become progressively more valuable because it knows the company better, knows what it still does not know, can acquire that missing knowledge efficiently, and can convert knowledge into authorized capability improvements. It should not require management to manually configure every question or workflow before producing organizational value.
