// Pure workflow logic of the extensions module (W027 — Extension
// Builder). No database, no context, no time — the closed vocabularies,
// the phase machine, the artifact contracts and the deterministic task/
// key derivations the builder's service operations (and W028's
// marketplace review) share, exactly the way lifecycle.ts and
// manifest-rules.ts serve W025's three enforcers.
//
// W027 owns the BUILDER half of ARCHITECTURE.md §17's extension story:
// "Support design/build/verify/deploy workflow using an isolated agent
// execution environment and the general runtime" (WORK-ITEM-CATALOG).
// The workflow is an explicit, resumable state machine over one build
// session:
//
//   designing → building → built → verified → deploying → deployed
//        ↘ failed (agent failure, invalid artifact, registration or
//          verification rejection, gate rejection, drift)  cancelled
//
// THE ISOLATED AGENT EXECUTION ENVIRONMENT (the W021 Agent Gateway —
// this module's declared dependency, DAG edge W021 + W026 → W027): the
// design and build phases are performed by a tenant-registered AGENT
// through the agents module's provider-independent execution contract
// (submit → pump, async, retryable, evidence-bearing). The isolation is
// threefold, and every layer is enforced, not advisory:
//   1. SCOPE isolation — the builder's agent executions request exactly
//      BUILDER_AGENT_SCOPES ('analyze', 'propose'): the agent may study
//      the brief and PROPOSE a declaration, never EXECUTE anything. The
//      agent definition must have been granted those scopes; the
//      consequential acts (registration, verification evidence,
//      activation, deployment) are performed by THIS module, each behind
//      its own existing authority gate.
//   2. VALIDATION isolation — agent output is data pending deterministic
//      domain validation (lock 10 mirrored: "LLM output is never
//      authoritative merely because an LLM generated it"). The build
//      artifact must pass the SAME validateRegisterExtensionManifestInput
//      a human registration passes — one rule set, no builder bypass.
//   3. EVIDENCE isolation — what the agent produced is retained as
//      append-only artifact custody (raw, bounded), linked to the agent
//      execution that produced it, even when validation rejects it.
//
// THE GENERAL RUNTIME (W026): the deploy phase goes through the runtime's
// matrix-gated deployExtensionVersion (append-only deployment history,
// grant bounded by the manifest ceiling), after the extension is ACTIVE
// (the W025 lifecycle transition, itself matrix-gated). The builder adds
// no deployment mechanism of its own.
//
// Determinism everywhere: the agent tasks, the idempotency keys of both
// agent executions, the activation key and the deployment key are pure
// functions of the build session — a crashed or racing pump re-derives
// them and replays the recorded outcomes instead of duplicating work
// (lock 36's resumability discipline, the agents/cognition pump
// precedent).

import { ExtensionsError } from './errors';
import {
  isEventTopic,
  isExtensionStateScope,
  isExtensionUiSurface,
  isHttpsOrigin,
  isNameSlug,
  isValidCronExpression,
  MAX_EVENT_TOPICS,
  MAX_EXTERNAL_PARTICIPANTS,
  MAX_SCHEDULES,
  type ExtensionExternalParticipant,
  type ExtensionScheduleDeclaration,
  type ExtensionStateScope,
  type ExtensionUiSurface,
} from './manifest-rules';
import { MANIFEST_SCHEMA_VERSIONS } from './verification';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_PARTICIPANT_LABEL_CHARS,
  validateRegisterExtensionManifestInput,
} from './validation';
import type { RegisterExtensionManifestInput } from './types';

// ---------------------------------------------------------------------------
// The phase machine
// ---------------------------------------------------------------------------

/**
 * The lifecycle phases of one extension build session, in workflow
 * order. Live phases are resumable (lock 36); the terminal three are
 * history. Every phase boundary is crossed by exactly one guarded
 * service move, and only forward:
 *
 *   * `designing` — the design agent execution is live (submitted,
 *     possibly awaiting a W009 approval, pumping one attempt at a time);
 *   * `building`  — the design was validated and recorded; the build
 *     agent execution is live;
 *   * `built`     — the built declaration passed the full registration
 *     validation and is registered as an immutable manifest version;
 *   * `verified`  — a verification run over that manifest version
 *     passed (the same append-only evidence W025 records; the builder
 *     appends, never mutates);
 *   * `deploying` — the deployment (and, for a fresh extension, its
 *     activation) sits at the 'extension-deployment' EXECUTE gate
 *     awaiting a human decision;
 *   * `deployed`  — the runtime applied the deployment; terminal;
 *   * `failed`    — a phase ended in rejection (agent failure, invalid
 *     artifact, registration/verification/gate rejection, drift);
 *     terminal;
 *   * `cancelled` — a caller cancelled a live build; terminal.
 */
export const EXTENSION_BUILD_PHASES = [
  'designing',
  'building',
  'built',
  'verified',
  'deploying',
  'deployed',
  'failed',
  'cancelled',
] as const;

export type ExtensionBuildPhase = (typeof EXTENSION_BUILD_PHASES)[number];

export function isExtensionBuildPhase(value: unknown): value is ExtensionBuildPhase {
  return (
    typeof value === 'string' &&
    (EXTENSION_BUILD_PHASES as readonly string[]).includes(value)
  );
}

/** The terminal phases — history from then on; pumping/cancelling them fails. */
export const EXTENSION_BUILD_TERMINAL_PHASES = [
  'deployed',
  'failed',
  'cancelled',
] as const;

export function isExtensionBuildTerminalPhase(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (EXTENSION_BUILD_TERMINAL_PHASES as readonly string[]).includes(value)
  );
}

/** The phases a cancellation may interrupt (everything not terminal). */
export const EXTENSION_BUILD_LIVE_PHASES = EXTENSION_BUILD_PHASES.filter(
  (phase) => !(EXTENSION_BUILD_TERMINAL_PHASES as readonly string[]).includes(phase),
);

export function isExtensionBuildLivePhase(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (EXTENSION_BUILD_LIVE_PHASES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Failure codes (recorded evidence, not thrown errors)
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of build failure codes — DATA recorded on the
 * session (failure_code + failure_detail), never a thrown error: how a
 * build died is evidence (§24 reconstructability), and the pump returns
 * the failed session rather than throwing. Mirrored by the storage CHECK
 * in migrations/012.
 *
 * Registration failures reuse the registry's own codes
 * (version_conflict / version_not_monotonic / extension_deprecated) so
 * the builder's evidence speaks the registry's language.
 */
export const EXTENSION_BUILD_FAILURE_CODES = [
  // design phase
  'design_execution_failed',
  'design_execution_refused',
  'design_execution_cancelled',
  'design_artifact_invalid',
  // build phase
  'build_execution_failed',
  'build_execution_refused',
  'build_execution_cancelled',
  'build_artifact_invalid',
  // registration (the registry's own codes, re-recorded as build evidence)
  'version_conflict',
  'version_not_monotonic',
  'extension_deprecated',
  // verify phase
  'verification_failed',
  // deploy phase (activation + deployment)
  'activation_rejected',
  'activation_failed',
  'deployment_rejected',
  'deployment_failed',
  // cancellation (reason travels in failure_detail)
  'cancelled',
] as const;

export type ExtensionBuildFailureCode = (typeof EXTENSION_BUILD_FAILURE_CODES)[number];

export function isExtensionBuildFailureCode(value: unknown): value is ExtensionBuildFailureCode {
  return (
    typeof value === 'string' &&
    (EXTENSION_BUILD_FAILURE_CODES as readonly string[]).includes(value)
  );
}

/** Bound of the recorded failure detail (the house diagnostic bound). */
export const MAX_FAILURE_DETAIL_CHARS = 512;

// ---------------------------------------------------------------------------
// The agent execution environment (scopes, tasks, keys)
// ---------------------------------------------------------------------------

/**
 * The permission scopes the builder's agent executions operate at — the
 * §20 levels an extension-designing agent may work at. Deliberately
 * WITHOUT 'execute': the agent proposes, the application disposes (the
 * isolation contract; scope → level mapping makes every submission a
 * PROPOSE, which the W009 matrix governs uniformly like every other
 * consequential action).
 */
export const BUILDER_AGENT_SCOPES = ['analyze', 'propose'] as const;

/** The workflow tag every builder task carries (canonical, closed). */
export const BUILDER_WORKFLOW_TAG = 'extension-build';

/** Maximum length of the design artifact's notes field. */
export const MAX_NOTES_CHARS = 2_000;

/** Maximum serialized size of one recorded artifact (custody bound). */
export const MAX_ARTIFACT_BYTES = 262_144; // 256 KiB

/** The canonical design task handed to the design agent execution. */
export interface ExtensionDesignTask {
  workflow: typeof BUILDER_WORKFLOW_TAG;
  phase: 'design';
  extensionKey: string;
  version: string;
  brief: string;
}

/** The canonical build task handed to the build agent execution. */
export interface ExtensionBuildTask {
  workflow: typeof BUILDER_WORKFLOW_TAG;
  phase: 'build';
  extensionKey: string;
  version: string;
  brief: string;
  design: DesignArtifact;
}

/** The design task — pure derivation from the session's fixed target. */
export function designTaskFor(
  target: { extensionKey: string; version: string },
  brief: string,
): ExtensionDesignTask {
  return {
    workflow: BUILDER_WORKFLOW_TAG,
    phase: 'design',
    extensionKey: target.extensionKey,
    version: target.version,
    brief,
  };
}

/** The build task — the design (validated) plus the session's target. */
export function buildTaskFor(
  target: { extensionKey: string; version: string },
  brief: string,
  design: DesignArtifact,
): ExtensionBuildTask {
  return {
    workflow: BUILDER_WORKFLOW_TAG,
    phase: 'build',
    extensionKey: target.extensionKey,
    version: target.version,
    brief,
    design,
  };
}

/**
 * The idempotency keys of the workflow's gated side effects — pure
 * functions of the build id so a crashed or racing pump re-derives the
 * SAME key and replays the recorded outcome (first write wins) instead
 * of duplicating work. All match the idempotency-key grammar shared by
 * the actions/agents/extensions contracts.
 */
export function designExecutionKey(buildId: string): string {
  return `ext-build-design:${buildId}`;
}

export function buildExecutionKey(buildId: string): string {
  return `ext-build-build:${buildId}`;
}

export function activationKey(buildId: string): string {
  return `ext-build-activate:${buildId}`;
}

export function deploymentKey(buildId: string): string {
  return `ext-build-deploy:${buildId}`;
}

// ---------------------------------------------------------------------------
// Artifact extraction (agent output → candidate artifact)
// ---------------------------------------------------------------------------

/** The parsed candidate an agent produced (untrusted until validated). */
export type ArtifactCandidate =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; problems: string[] };

/**
 * Extract the candidate artifact object from an agent execution's
 * canonical result output. Runtimes answer in either shape — a JSON
 * object (most adapters) or a JSON-encoded string (the assistants
 * dialect's output_text, already JSON-parsed when it parsed) — so a
 * string gets one deterministic JSON.parse attempt. Anything else is a
 * loud problem, never a silent substitute value.
 */
export function parseAgentArtifactOutput(output: unknown): ArtifactCandidate {
  let candidate: unknown = output;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return { ok: false, problems: ['the agent answered in prose — the output is not valid JSON'] };
    }
  }
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return {
      ok: false,
      problems: [`the agent's output must be a JSON object (got ${Array.isArray(candidate) ? 'an array' : typeof candidate})`],
    };
  }
  return { ok: true, value: candidate as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// The design artifact contract
// ---------------------------------------------------------------------------

/**
 * The validated DESIGN artifact — the design phase's accepted output: a
 * capability PLAN (what the extension should be), not yet a declaration.
 * Permissions, quotas and the host-runtime range are decided at build
 * time; the design proposes capabilities and intent. All field rules are
 * the manifest-rules primitives (one rule set), collected as problems so
 * the failure detail is complete evidence.
 */
export interface DesignArtifact {
  displayName: string;
  description: string | null;
  stateScope: ExtensionStateScope;
  uiSurfaces: ExtensionUiSurface[];
  schedules: ExtensionScheduleDeclaration[];
  eventSubscriptions: string[];
  externalParticipants: ExtensionExternalParticipant[];
  telemetry: boolean;
  notes: string | null;
}

const DESIGN_ARTIFACT_KEYS = [
  'displayName',
  'description',
  'stateScope',
  'uiSurfaces',
  'schedules',
  'eventSubscriptions',
  'externalParticipants',
  'telemetry',
  'notes',
] as const;

export type DesignValidation =
  | { ok: true; design: DesignArtifact }
  | { ok: false; problems: string[] };

/** Validate a candidate design artifact — pure, total, problem-collecting. */
export function validateDesignArtifact(value: Record<string, unknown>): DesignValidation {
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (!(DESIGN_ARTIFACT_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `unknown design field '${key}' (allowed: ${DESIGN_ARTIFACT_KEYS.join(', ')})`,
      );
    }
  }

  const displayName = value['displayName'];
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    problems.push('displayName must be a non-empty string');
  } else if (displayName.trim().length > MAX_DISPLAY_NAME_CHARS) {
    problems.push(`displayName must be at most ${MAX_DISPLAY_NAME_CHARS} characters`);
  }

  const description = value['description'];
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') {
      problems.push('description must be a string or null');
    } else if (description.trim().length > MAX_DESCRIPTION_CHARS) {
      problems.push(`description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
    }
  }

  const notes = value['notes'];
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== 'string') {
      problems.push('notes must be a string or null');
    } else if (notes.length > MAX_NOTES_CHARS) {
      problems.push(`notes must be at most ${MAX_NOTES_CHARS} characters`);
    }
  }

  const stateScopeRaw = value['stateScope'] === undefined || value['stateScope'] === null
    ? 'none'
    : value['stateScope'];
  if (!isExtensionStateScope(stateScopeRaw)) {
    problems.push(`stateScope must be one of none, tenant, install (got '${String(stateScopeRaw)}')`);
  }
  const stateScope: ExtensionStateScope = isExtensionStateScope(stateScopeRaw) ? stateScopeRaw : 'none';

  const uiSurfacesRaw = value['uiSurfaces'] === undefined || value['uiSurfaces'] === null
    ? []
    : value['uiSurfaces'];
  const uiSurfaces: ExtensionUiSurface[] = [];
  if (!Array.isArray(uiSurfacesRaw)) {
    problems.push('uiSurfaces must be an array of declarative UI surfaces');
  } else {
    for (const surface of uiSurfacesRaw) {
      if (!isExtensionUiSurface(surface)) {
        problems.push(`uiSurfaces entry '${String(surface)}' is not a known declarative UI surface`);
      } else if (!uiSurfaces.includes(surface)) {
        uiSurfaces.push(surface);
      }
    }
  }

  const schedulesRaw = value['schedules'] === undefined || value['schedules'] === null
    ? []
    : value['schedules'];
  const schedules: ExtensionScheduleDeclaration[] = [];
  if (!Array.isArray(schedulesRaw)) {
    problems.push('schedules must be an array of { name, cron } declarations');
  } else if (schedulesRaw.length > MAX_SCHEDULES) {
    problems.push(`schedules must declare at most ${MAX_SCHEDULES} triggers (got ${schedulesRaw.length})`);
  } else {
    const names = new Set<string>();
    for (const entry of schedulesRaw) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push('each schedule must be an object with name and cron');
        continue;
      }
      const record = entry as { name?: unknown; cron?: unknown };
      const name = typeof record.name === 'string' && isNameSlug(record.name) ? record.name : null;
      let nameOk = false;
      if (name === null) {
        problems.push(`schedule name '${String(record.name)}' must be a slug of at most 64 characters`);
      } else if (names.has(name)) {
        problems.push(`duplicate schedule name '${name}'`);
      } else {
        names.add(name);
        nameOk = true;
      }
      const cron =
        typeof record.cron === 'string' && isValidCronExpression(record.cron) ? record.cron : null;
      if (cron === null) {
        problems.push(`schedule '${String(record.name)}' has an invalid five-field cron expression`);
      } else if (nameOk && name !== null) {
        schedules.push({ name, cron });
      }
    }
  }

  const topicsRaw = value['eventSubscriptions'] === undefined || value['eventSubscriptions'] === null
    ? []
    : value['eventSubscriptions'];
  const eventSubscriptions: string[] = [];
  if (!Array.isArray(topicsRaw)) {
    problems.push('eventSubscriptions must be an array of event topic slugs');
  } else if (topicsRaw.length > MAX_EVENT_TOPICS) {
    problems.push(`eventSubscriptions must declare at most ${MAX_EVENT_TOPICS} topics (got ${topicsRaw.length})`);
  } else {
    for (const topic of topicsRaw) {
      if (typeof topic !== 'string' || !isEventTopic(topic)) {
        problems.push(`event subscription topic '${String(topic)}' is not a canonical topic slug`);
      } else if (!eventSubscriptions.includes(topic)) {
        eventSubscriptions.push(topic);
      }
    }
  }

  const participantsRaw = value['externalParticipants'] === undefined || value['externalParticipants'] === null
    ? []
    : value['externalParticipants'];
  const externalParticipants: ExtensionExternalParticipant[] = [];
  if (!Array.isArray(participantsRaw)) {
    problems.push('externalParticipants must be an array of { label, origin } declarations');
  } else if (participantsRaw.length > MAX_EXTERNAL_PARTICIPANTS) {
    problems.push(
      `externalParticipants must declare at most ${MAX_EXTERNAL_PARTICIPANTS} participants (got ${participantsRaw.length})`,
    );
  } else {
    const origins = new Set<string>();
    for (const entry of participantsRaw) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push('each external participant must be an object with label and origin');
        continue;
      }
      const record = entry as { label?: unknown; origin?: unknown };
      const label =
        typeof record.label === 'string' && record.label.trim() !== '' ? record.label.trim() : null;
      if (label === null) {
        problems.push('each external participant needs a non-empty label');
      } else if (label.length > MAX_PARTICIPANT_LABEL_CHARS) {
        problems.push(`external participant labels must be at most ${MAX_PARTICIPANT_LABEL_CHARS} characters`);
      }
      if (typeof record.origin !== 'string' || !isHttpsOrigin(record.origin)) {
        problems.push(
          `external participant '${String(record.label)}' origin '${String(record.origin)}' is not a plain https origin`,
        );
      } else if (origins.has(record.origin)) {
        problems.push(`duplicate external participant origin '${record.origin}'`);
      } else {
        origins.add(record.origin);
        if (label !== null) externalParticipants.push({ label, origin: record.origin });
      }
    }
  }

  const telemetry = value['telemetry'] === undefined || value['telemetry'] === null
    ? false
    : value['telemetry'];
  if (typeof telemetry !== 'boolean') {
    problems.push('telemetry must be a boolean');
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    design: {
      displayName: (displayName as string).trim(),
      description:
        description === undefined || description === null || (description as string).trim() === ''
          ? null
          : (description as string).trim(),
      stateScope: stateScope,
      uiSurfaces,
      schedules,
      eventSubscriptions,
      externalParticipants,
      telemetry: telemetry as boolean,
      notes:
        notes === undefined || notes === null || (notes as string) === ''
          ? null
          : (notes as string),
    },
  };
}

// ---------------------------------------------------------------------------
// The build artifact contract (one rule set with registration — no bypass)
// ---------------------------------------------------------------------------

/** The build artifact's allowed fields (identity is pinned by the session). */
const BUILD_ARTIFACT_KEYS = [
  'manifestSchemaVersion',
  'displayName',
  'description',
  'requestedPermissions',
  'stateScope',
  'uiSurfaces',
  'schedules',
  'eventSubscriptions',
  'externalParticipants',
  'telemetry',
  'quotas',
  'hostRuntime',
] as const;

export type BuildValidation =
  | { ok: true; input: RegisterExtensionManifestInput }
  | { ok: false; problems: string[] };

/**
 * Validate the BUILD artifact — the complete manifest declaration the
 * build agent produced for the session's pinned target — and derive the
 * registration input. The derivation pins extensionKey and version from
 * the SESSION (the agent cannot choose the extension's identity — that
 * is the requester's declared scope), defaults manifestSchemaVersion to
 * the newest supported format, and then runs the SAME
 * validateRegisterExtensionManifestInput a human registration runs: the
 * same closed vocabularies, the same normalization, the same
 * capability↔permission↔quota consistency rule set. There is deliberately
 * no builder-local manifest grammar — one rule set, no drift, no bypass.
 */
export function buildArtifactToRegistration(
  value: Record<string, unknown>,
  target: { extensionKey: string; version: string },
): BuildValidation {
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (!(BUILD_ARTIFACT_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `unknown build field '${key}' (allowed: ${BUILD_ARTIFACT_KEYS.join(', ')})`,
      );
    }
  }

  let manifestSchemaVersion: number =
    MANIFEST_SCHEMA_VERSIONS[MANIFEST_SCHEMA_VERSIONS.length - 1]!;
  if (value['manifestSchemaVersion'] !== undefined && value['manifestSchemaVersion'] !== null) {
    const raw = value['manifestSchemaVersion'];
    if (
      typeof raw !== 'number' ||
      !(MANIFEST_SCHEMA_VERSIONS as readonly number[]).includes(raw)
    ) {
      problems.push(
        `manifestSchemaVersion must be one of ${MANIFEST_SCHEMA_VERSIONS.join(', ')} (got '${String(raw)}')`,
      );
    } else {
      manifestSchemaVersion = raw;
    }
  }

  if (value['hostRuntime'] === undefined || value['hostRuntime'] === null) {
    problems.push('hostRuntime is required (the build declares the host-runtime compatibility range)');
  }

  if (problems.length > 0) return { ok: false, problems };

  const input: RegisterExtensionManifestInput = {
    extensionKey: target.extensionKey,
    version: target.version,
    manifestSchemaVersion,
    displayName: value['displayName'] as string,
    description: (value['description'] ?? null) as string | null,
    requestedPermissions: value['requestedPermissions'] as RegisterExtensionManifestInput['requestedPermissions'],
    stateScope: value['stateScope'] as RegisterExtensionManifestInput['stateScope'],
    uiSurfaces: value['uiSurfaces'] as RegisterExtensionManifestInput['uiSurfaces'],
    schedules: value['schedules'] as RegisterExtensionManifestInput['schedules'],
    eventSubscriptions: value['eventSubscriptions'] as RegisterExtensionManifestInput['eventSubscriptions'],
    externalParticipants: value['externalParticipants'] as RegisterExtensionManifestInput['externalParticipants'],
    telemetry: value['telemetry'] as RegisterExtensionManifestInput['telemetry'],
    quotas: value['quotas'] as RegisterExtensionManifestInput['quotas'],
    hostRuntime: value['hostRuntime'] as RegisterExtensionManifestInput['hostRuntime'],
  };

  try {
    validateRegisterExtensionManifestInput(input);
  } catch (error) {
    // The single shared rule set spoke: surface its message as the
    // artifact's problems (deterministic, same rules as registration).
    if (error instanceof ExtensionsError && error.code === 'invalid_input') {
      return { ok: false, problems: [error.message] };
    }
    throw error;
  }
  return { ok: true, input };
}

// ---------------------------------------------------------------------------
// Execution-status → failure-code folding
// ---------------------------------------------------------------------------

/** The agent-execution status words the builder folds (agents vocabulary). */
const AGENT_EXECUTION_STATUS_WORDS = [
  'awaiting_approval',
  'queued',
  'succeeded',
  'failed',
  'refused',
  'cancelled',
] as const;

/**
 * The failure code a terminal agent execution of the given phase yields,
 * or null while it is live (the pump keeps waiting). Pure fold over the
 * agents module's frozen status vocabulary.
 */
export function failureCodeForExecution(
  phase: 'design' | 'build',
  status: string,
): ExtensionBuildFailureCode | null {
  if (!(AGENT_EXECUTION_STATUS_WORDS as readonly string[]).includes(status)) return null;
  switch (status) {
    case 'awaiting_approval':
    case 'queued':
    case 'succeeded':
      return null;
    case 'failed':
      return phase === 'design' ? 'design_execution_failed' : 'build_execution_failed';
    case 'refused':
      return phase === 'design' ? 'design_execution_refused' : 'build_execution_refused';
    case 'cancelled':
      return phase === 'design' ? 'design_execution_cancelled' : 'build_execution_cancelled';
  }
  return null;
}
