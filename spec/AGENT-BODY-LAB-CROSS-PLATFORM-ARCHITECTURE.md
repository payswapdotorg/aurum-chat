# Aurum Agent Body, Contextual Lab and Cross-Platform Architecture

Status: ADDITIVE ARCHITECTURE PROPOSAL
Frozen architecture v2.1 remains authoritative.

## 1. Aurum Agent Body

Aurum is a persistent model-agnostic Agent Body plus a separately selected Model Binding.

The body owns role, communication behavior, information acquisition behavior, company context access, memory policy, permitted capabilities, escalation behavior, evidence hooks and learning hooks.

The selected model owns provider, model id, modalities, tool support and runtime characteristics.

Changing the model does not replace the body and does not reset company understanding or learning history.

## 2. Context-sensitive organizational learning

The Lab must condition organization selection on a ContextFingerprint, not only a task type.

Context may include domain, task type, season, time window, duration, staffing level, staff experience distribution, workload intensity, current capabilities, tool/environment availability, budget, latency/SLA, quality, risk, verification requirements, external conditions and evidence freshness.

Therefore the same subject may legitimately produce different best organizations under different conditions. Examples include construction in spring versus fall, a short versus long project, a small versus large staff, or an experienced versus novice-heavy workforce. These are hypotheses for the Lab to test, not hardcoded industry rules.

## 3. Information strategy

The Lab also learns what must be known, who or what should provide it, the required freshness/confidence, acquisition cost and escalation threshold.

This integrates with existing Unknown, LearningMission, KnowledgeAcquisition, CompanyModel, Coverage and Goals authorities.

## 4. Organization candidate

An organization candidate is the composition of a goal and context into role proposals, agent/body nodes, communication topology, information routes, agent candidates, model occupancy and evaluation evidence.

Edges may represent delegation, review, handoff, escalation and information-feed relationships.

The organization is evaluated as a system rather than as a bag of model scores.

## 5. Marketplace agent selection

The Lab may compare tenant agents, marketplace AgentPackages, capability/extension packages, human capabilities and external specialist services.

The Lab recommends. Marketplace governance, Agent Recruitment, Action Policy and Agent Gateway authorize and execute.

## 6. Execution Plan

Aurum needs a durable orchestration projection from goal to tasks to selected execution organization to handoffs, approvals, execution runs, results and outcome.

Execution Plan must remain a projection over existing Action, Agent, Event, Outcome and Cognition authorities, not a second workflow authority.

## 7. Cross-agent relay

Aurum is the information and coordination boundary.

Every handoff records sender, receiver, purpose, evidence references, freshness, authorization, minimal context, expected response and correlation/causation identities.

Specialist agents return normalized results and evidence. Aurum incorporates them into company understanding and user communication.

## 8. Execution environment

The execution environment is an adapter for isolated workspace, browser, files, commands, long-running task lifecycle, persistent session, takeover, cancellation, recovery and artifact handoff.

Possible adapters: local container, Playwright/Chromium, E2B or future sandbox providers.

No execution vendor is architecturally privileged.

## 9. Cross-platform clients

Preferred topology: Web as canonical, Desktop as a Tauri 2 power client, Mobile as an Expo/React Native field client.

All clients use the same semantic/client contracts and resolve authoritative state through the server-side Application/Experience Gateway.

Native capabilities are adapters only.

## 10. Authority boundaries

LLM Gateway: model execution and provider routing.
Agent Gateway: specialist execution runtime.
Marketplace: package governance and installation state.
Action Gateway: consequential action authorization.
World/Evidence/Observation: company reality and evidence.
Cognition: canonical intelligence workflow.
Lab: experimentation, recommendation and learning.
Experience Runtime: presentation.

The Lab never grants authority, directly executes external agents, installs marketplace packages or self-publishes roles.

## 11. Evidence

Every contextual Lab recommendation retains goal revision, context fingerprint, knowledge objective, candidates, marketplace candidates, model occupancies, evaluation configuration, evidence, outcomes, calibration and rejected alternatives.

Historical recommendations are immutable.

## 12. External references

ZCode, OpenMuse, Meta Muse and Epoch are replaceable design references. Aurum remains the authority and must not import a competing semantic database, permission broker, execution authority, model router or marketplace authority.