# Architecture Change Request 0003 — Agent Body, Contextual Lab, Execution Platform and Cross-Platform Clients

Status: APPROVED ADDITIVE — frozen Architecture v2.1 remains unchanged
Date: 2026-10-04

## Intent

Extend Aurum so that its persistent agent is a model-agnostic Agent Body; users can add, select and swap AI providers/models; the Lab learns goal- and context-specific information strategies and organizations; marketplace agents can be recruited for specialist execution; new roles can emerge through evidence; Aurum can coordinate external agents; and the product can run across Web, Desktop and Mobile.

## Context rule

Organization recommendations are conditioned on a ContextFingerprint. Relevant context includes domain, task type, season, duration, staffing, staff experience, workload, capabilities, tools, budget, latency, quality, risk, verification and evidence freshness.

## Frozen authorities

Tenant isolation, evidence truth, Cognition workflow, Action Gateway, Agent Gateway, Marketplace governance, LLM Gateway, PostgreSQL persistence and provider-neutral domain contracts remain authoritative.

## Non-negotiable boundaries

Lab = experiment, evaluate, recommend, learn and propose roles.
Aurum = gather/transmit information, understand company reality, monitor goals, coordinate and request recruitment.
Specialist agents = execute domain work.

Lab does not authorize, install, activate or directly execute external agents.

## Cross-platform rule

Web, Desktop and Mobile are projections over shared client/runtime contracts. No client owns canonical company state.

## Execution-platform rule

Browser, computer, sandbox and workspace implementations are interchangeable adapters. A vendor-specific dependency must never leak into domain contracts.

## Review triggers

Return to architecture review if implementation requires a new authoritative semantic store, a second permission/approval authority, a second model router, direct Lab-to-provider execution, cross-client semantic divergence, changed tenant isolation rules, marketplace bypass or secret material crossing into agent/semantic context.