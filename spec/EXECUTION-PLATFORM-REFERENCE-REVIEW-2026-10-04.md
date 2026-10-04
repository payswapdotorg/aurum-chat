# Aurum Execution Platform Reference Review — 2026-10-04

Status: CANONICAL DESIGN INPUT

This is a design research record. It does not claim that Aurum copies any external product or private implementation.

## ZCode — zai-org/ZCode

The current official repository is a multi-client AI coding workspace with desktop, web and terminal clients. Its repository separates provider modules, shared UI/client layers, server/services, desktop packaging and the included agent CLI/runtime. The current README documents desktop packaging for macOS, Windows and Linux.

Adopt the pattern of explicit provider/model configuration, shared client contracts, a separate long-running agent runtime, and desktop/web parity. Do not import ZCode's product-specific runtime architecture.

## OpenMuse — CopilotKit/openmuse

OpenMuse is an MIT-licensed personal-agent application with an Expo/React Native web/mobile client, durable tasks, a dedicated browser worker, optional Linux computer, persistent browser profiles, pause/resume/cancel/retry, approvals, saved receipts and human takeover of browser sessions.

Adopt the separation between client, durable worker and computer/browser capabilities. Keep Aurum's PostgreSQL, tenant, evidence, policy and agent authorities as the source of truth instead of adopting OpenMuse's external intelligence service as an authority.

## Meta Muse and Muse Code

Meta's current public Muse materials describe a persistent secure VM and browser computer, conversational interaction, approvals, audit trail, background goals, connectors and generated tools. Its developer materials also describe multi-agent orchestration, fan-out, computer use, GitHub agents and an OpenAI-compatible model API.

Adopt only the observable product patterns: persistent execution environments, explicit approvals, background goal work, multi-agent fan-out, user takeover and replayable/auditable work. Private implementation details are not known and must not be represented as such.

## Epoch — payswapdotorg/Epoch

Epoch is the strongest first-party reference for Aurum cross-platform productization: Web is canonical, Desktop uses Tauri 2, Mobile uses Expo/React Native, all clients share semantic/client contracts, an Application Gateway composes existing authorities, and native capabilities stay behind adapters.

This should be the default Aurum client topology unless a later architecture decision proves a better option.

## Flauz — payswapdotorg/Flauz

Flauz is the strongest first-party reference for the organizational Lab: model-agnostic agent bodies, organization candidates, model occupancy, robust evaluation, calibration and an explicit LabExecutionPort. The Lab recommends; Agent OS executes.

Aurum should additionally condition the organization search on the current context, not only the task subject.

## Recommended execution platform

Build a provider-neutral execution-environment plane with interchangeable adapters for isolated workspaces, browsers, commands, files, persistent sessions, long-running tasks, takeover, cancellation, recovery and artifact handoff.

Candidate adapters may include local containers, Playwright/Chromium and E2B or an equivalent remote sandbox. E2B is a candidate adapter, not a platform authority.

## Cross-platform conclusion

Aurum services -> Application/Experience Gateway -> shared client/runtime contracts -> Web/Desktop/Mobile.

Clients never own semantic company truth, provider credentials, action authority or execution outcome truth.

## Required TL decision before coding

Freeze an Aurum-owned execution environment contract and a shared client runtime contract. Record what is adopted from each reference, what is rejected, why the selected sandbox/browser/runtime boundary is replaceable, and how takeover/recovery/cross-device continuity work.