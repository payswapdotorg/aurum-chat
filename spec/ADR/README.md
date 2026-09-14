# Accepted Architecture Decisions

## ADR-0001 — Tenant isolation
Aurum is multi-tenant. Tenant identity is mandatory for every domain operation and every information-bearing record. Search, storage, workers, caches and connectors carry tenant scope.

## ADR-0002 — Learning missions
Aurum turns consequential unknowns into persistent learning missions containing a knowledge objective, affected goals, priority, confidence target, evidence plan, budget, progress and completion criteria.

## ADR-0003 — Identity resolution
An employee may have many external channel identities. ExternalIdentity resolves them into one tenant-scoped person/employee record with explicit verification state.

## ADR-0004 — Marketplace governance
Marketplace artifacts have submission, verification, review, approval, publication, installation and activation states. Third-party packages remain unavailable for tenant installation until platform approval.

## ADR-0005 — API and MCP
API and MCP expose provider-independent Aurum capabilities rather than persistence operations. Every operation is tenant-scoped, authorized and audited.

## ADR-0006 — BYOA
Tenants may connect their own AI providers and eligible agent runtimes. Provider accounts are configuration/authorization resources, not business meaning.

## ADR-0007 — Employee knowledge rewards
KnowledgeContribution records evidence supplied by employees. RewardPolicy may convert validated information value into rewards. Rewards are separate from compensation and performance evaluation.

## ADR-0008 — Agent teams and recruitment
AgentTeam is a first-class actor. AgentRecruitmentProposal compares existing staff, training, hiring, automation, marketplace and agent alternatives before approval.

## ADR-0009 — Destinations
Outbound analytics/data delivery uses a provider-independent Destination Gateway analogous to Sources. Destinations never become domain truth.

## ADR-0010 — Management briefings
Management receives policy-controlled proactive briefings derived from evidence, goals and findings. Briefings are not authoritative source records.

## ADR-0011 — Information freshness
Time-sensitive observations carry source freshness, observed-at time, ingestion latency and stale-after policy. Aurum must be able to explain whether knowledge is current.

## ADR-0012 — Employee assessment
Employee-impacting findings require evidence, uncertainty, alternative explanations and human authorization. Process and workload context must be considered before assessment.

## ADR-0013 — Opportunity engine
Opportunities are first-class evidence-backed findings linking external/internal signals to affected goals, expected value, confidence and required capabilities.

## ADR-0014 — Company intelligence loop
The canonical loop is observe → remember → understand → goals → unknowns → missions → acquire → update → identify gaps/opportunities → recommend/act → measure → learn. Conversation is a channel only.

## ADR-0015 — Provider independence
AI/LLM providers, channel providers, sources, destinations and agent runtimes are hidden behind application-owned contracts. Swapping an implementation cannot require semantic migration.

## ADR-0016 — Company learning model
Aurum maintains a versioned CompanyModel of learned, provider-independent company knowledge. Every learned assertion has provenance, confidence and validity; explicit policy outranks learned preference; learned state survives provider replacement.

## ADR-0017 — Goal gap discovery
Aurum derives consequential unknowns from goals, desired state, temporal state and evidence without a stated question. Candidate unknowns carry impact, urgency, confidence gap and expected information value; only material unknowns become policy-gated missions.

## ADR-0018 — Knowledge source ranking
Source selection ranks provider-independent signals (relevance, reliability, freshness, authority, access scope, cost, prior contribution value) with persisted rationale; employees, managers, systems, documents, external sources, agents and analyses compete on the same dimensions.

## ADR-0019 — Capability outcome learning
Every material intervention records baseline, expected, observed, realized value and variance, linked to the originating goal/authorization. Future recommendations improve only through explicit evidence-linked learning updates; hidden outcome labels never leak into recommendations.
