// Unit tests for the extensions module's builder logic (W027 — pure, no
// database): the phase machine and its terminal/live partition, the
// failure-code vocabulary and the execution-status fold, the fixed agent
// scopes of the isolated execution environment, the canonical task and
// idempotency-key derivations, the agent-output extraction, the design
// artifact contract and — the security core — the build artifact's
// single-rule-set conversion into a registration input that must pass
// the SAME validation a human registration passes. The workflow's
// service-level behavior (pump, gates, custody, isolation) is covered by
// extensions-builder.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import {
  BUILDER_AGENT_SCOPES,
  BUILDER_WORKFLOW_TAG,
  EXTENSION_BUILD_FAILURE_CODES,
  EXTENSION_BUILD_LIVE_PHASES,
  EXTENSION_BUILD_PHASES,
  EXTENSION_BUILD_TERMINAL_PHASES,
  MAX_ARTIFACT_BYTES,
  MAX_FAILURE_DETAIL_CHARS,
  MAX_NOTES_CHARS,
  activationKey,
  buildArtifactToRegistration,
  buildExecutionKey,
  buildTaskFor,
  deploymentKey,
  designExecutionKey,
  designTaskFor,
  failureCodeForExecution,
  isExtensionBuildFailureCode,
  isExtensionBuildLivePhase,
  isExtensionBuildPhase,
  isExtensionBuildTerminalPhase,
  parseAgentArtifactOutput,
  validateDesignArtifact,
  type DesignArtifact,
} from '../builder';
import {
  MAX_BRIEF_CHARS,
  MAX_CANCEL_REASON_CHARS,
  validateCancelExtensionBuildInput,
  validateGetExtensionBuildQuery,
  validateListExtensionBuildArtifactsQuery,
  validateListExtensionBuildsQuery,
  validateRegisterExtensionManifestInput,
  validateRequestExtensionBuildInput,
  validateRunExtensionBuildInput,
} from '../validation';
import { ExtensionsError } from '../errors';

// ---------------------------------------------------------------------------
// The phase machine
// ---------------------------------------------------------------------------

describe('extension build phases (the workflow state machine)', () => {
  it('pins the phase vocabulary in workflow order', () => {
    expect(EXTENSION_BUILD_PHASES).toEqual([
      'designing',
      'building',
      'built',
      'verified',
      'deploying',
      'deployed',
      'failed',
      'cancelled',
    ]);
  });

  it('partitions terminal and live phases disjointly and totally', () => {
    expect(EXTENSION_BUILD_TERMINAL_PHASES).toEqual(['deployed', 'failed', 'cancelled']);
    expect([...EXTENSION_BUILD_LIVE_PHASES].sort()).toEqual(
      ['building', 'built', 'deploying', 'designing', 'verified'].sort(),
    );
    for (const phase of EXTENSION_BUILD_PHASES) {
      expect(isExtensionBuildPhase(phase)).toBe(true);
      expect(isExtensionBuildTerminalPhase(phase)).toBe(
        (EXTENSION_BUILD_TERMINAL_PHASES as readonly string[]).includes(phase),
      );
      expect(isExtensionBuildLivePhase(phase)).toBe(
        (EXTENSION_BUILD_LIVE_PHASES as readonly string[]).includes(phase),
      );
    }
    expect(isExtensionBuildPhase('dreaming')).toBe(false);
    expect(isExtensionBuildPhase(42)).toBe(false);
    expect(isExtensionBuildTerminalPhase('designing')).toBe(false);
    expect(isExtensionBuildLivePhase('deployed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failure codes and the execution-status fold
// ---------------------------------------------------------------------------

describe('extension build failure codes (recorded evidence)', () => {
  it('pins the closed vocabulary', () => {
    expect(EXTENSION_BUILD_FAILURE_CODES).toEqual([
      'design_execution_failed',
      'design_execution_refused',
      'design_execution_cancelled',
      'design_artifact_invalid',
      'build_execution_failed',
      'build_execution_refused',
      'build_execution_cancelled',
      'build_artifact_invalid',
      'version_conflict',
      'version_not_monotonic',
      'extension_deprecated',
      'verification_failed',
      'activation_rejected',
      'activation_failed',
      'deployment_rejected',
      'deployment_failed',
      'cancelled',
    ]);
    for (const code of EXTENSION_BUILD_FAILURE_CODES) {
      expect(isExtensionBuildFailureCode(code)).toBe(true);
    }
    expect(isExtensionBuildFailureCode('design exploded')).toBe(false);
  });

  it('folds agent execution statuses to failure codes per phase', () => {
    // live statuses fold to null in both phases
    for (const status of ['awaiting_approval', 'queued', 'succeeded']) {
      expect(failureCodeForExecution('design', status)).toBeNull();
      expect(failureCodeForExecution('build', status)).toBeNull();
    }
    expect(failureCodeForExecution('design', 'failed')).toBe('design_execution_failed');
    expect(failureCodeForExecution('design', 'refused')).toBe('design_execution_refused');
    expect(failureCodeForExecution('design', 'cancelled')).toBe('design_execution_cancelled');
    expect(failureCodeForExecution('build', 'failed')).toBe('build_execution_failed');
    expect(failureCodeForExecution('build', 'refused')).toBe('build_execution_refused');
    expect(failureCodeForExecution('build', 'cancelled')).toBe('build_execution_cancelled');
    // an unmapped status is not a failure (total fold)
    expect(failureCodeForExecution('design', 'exploded')).toBeNull();
  });

  it('bounds the recorded failure detail', () => {
    expect(MAX_FAILURE_DETAIL_CHARS).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// The isolated agent execution environment
// ---------------------------------------------------------------------------

describe('builder agent scopes (the isolation contract)', () => {
  it('requests exactly analyze + propose — never execute', () => {
    expect(BUILDER_AGENT_SCOPES).toEqual(['analyze', 'propose']);
    expect(BUILDER_AGENT_SCOPES).not.toContain('execute');
  });
});

describe('canonical task derivation', () => {
  const target = { extensionKey: 'invoice-ocr', version: '2.0.0' };

  it('derives the design task from the pinned target and brief', () => {
    const task = designTaskFor(target, 'Read invoices into the world model');
    expect(task).toEqual({
      workflow: BUILDER_WORKFLOW_TAG,
      phase: 'design',
      extensionKey: 'invoice-ocr',
      version: '2.0.0',
      brief: 'Read invoices into the world model',
    });
  });

  it('derives the build task with the validated design embedded (§25 causation input)', () => {
    const design: DesignArtifact = {
      displayName: 'Invoice OCR',
      description: 'Reads invoices',
      stateScope: 'tenant',
      uiSurfaces: ['control-tower-panel'],
      schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
      eventSubscriptions: ['invoice.received'],
      externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
      telemetry: true,
      notes: 'sync the invoices nightly',
    };
    const task = buildTaskFor(target, 'the brief', design);
    expect(task.workflow).toBe(BUILDER_WORKFLOW_TAG);
    expect(task.phase).toBe('build');
    expect(task.extensionKey).toBe('invoice-ocr');
    expect(task.version).toBe('2.0.0');
    expect(task.brief).toBe('the brief');
    expect(task.design).toEqual(design);
  });
});

describe('deterministic idempotency key derivation', () => {
  it('derives stable, distinct keys per purpose from the build id', () => {
    const buildId = newId();
    expect(designExecutionKey(buildId)).toBe(`ext-build-design:${buildId}`);
    expect(buildExecutionKey(buildId)).toBe(`ext-build-build:${buildId}`);
    expect(activationKey(buildId)).toBe(`ext-build-activate:${buildId}`);
    expect(deploymentKey(buildId)).toBe(`ext-build-deploy:${buildId}`);
    // determinism: same input, same key (a re-pump replays, never duplicates)
    expect(designExecutionKey(buildId)).toBe(designExecutionKey(buildId));
    const other = new Set([designExecutionKey(buildId), buildExecutionKey(buildId), activationKey(buildId), deploymentKey(buildId)]);
    expect(other.size).toBe(4);
  });

  it('produces keys that satisfy the shared idempotency-key grammar', () => {
    const buildId = newId();
    for (const key of [designExecutionKey(buildId), buildExecutionKey(buildId), activationKey(buildId), deploymentKey(buildId)]) {
      expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/);
      expect(key.length).toBeLessThanOrEqual(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Agent output extraction
// ---------------------------------------------------------------------------

describe('parseAgentArtifactOutput (agent output is data pending validation)', () => {
  it('accepts a plain JSON object as-is', () => {
    const parsed = parseAgentArtifactOutput({ displayName: 'X' });
    expect(parsed).toEqual({ ok: true, value: { displayName: 'X' } });
  });

  it('parses a JSON-encoded string (the assistants dialect)', () => {
    const parsed = parseAgentArtifactOutput('{"displayName":"X"}');
    expect(parsed).toEqual({ ok: true, value: { displayName: 'X' } });
  });

  it('rejects prose that is not JSON — loudly, never a substitute value', () => {
    const parsed = parseAgentArtifactOutput('I would design an invoice reader...');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]).toContain('not valid JSON');
  });

  it('rejects non-object shapes (arrays, null, numbers, booleans)', () => {
    for (const output of [[{ a: 1 }], null, 42, true, '["a","b"]']) {
      const parsed = parseAgentArtifactOutput(output);
      expect(parsed.ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The design artifact contract
// ---------------------------------------------------------------------------

describe('validateDesignArtifact (the capability plan)', () => {
  it('accepts a complete design and normalizes nothing away', () => {
    const design = validateDesignArtifact({
      displayName: 'Invoice OCR',
      description: 'Reads invoices into the world model',
      stateScope: 'tenant',
      uiSurfaces: ['control-tower-panel', 'settings-form'],
      schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
      eventSubscriptions: ['invoice.received', 'invoice.paid'],
      externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
      telemetry: true,
      notes: 'nightly sync is enough',
    });
    expect(design.ok).toBe(true);
    if (design.ok) {
      expect(design.design.displayName).toBe('Invoice OCR');
      expect(design.design.stateScope).toBe('tenant');
      expect(design.design.schedules).toEqual([{ name: 'nightly-sync', cron: '0 2 * * *' }]);
    }
  });

  it('applies the closed defaults for a minimal design', () => {
    const design = validateDesignArtifact({ displayName: 'Tiny Widget' });
    expect(design.ok).toBe(true);
    if (design.ok) {
      expect(design.design.stateScope).toBe('none');
      expect(design.design.uiSurfaces).toEqual([]);
      expect(design.design.schedules).toEqual([]);
      expect(design.design.eventSubscriptions).toEqual([]);
      expect(design.design.externalParticipants).toEqual([]);
      expect(design.design.telemetry).toBe(false);
      expect(design.design.description).toBeNull();
      expect(design.design.notes).toBeNull();
    }
  });

  it('collects every problem at once (complete evidence)', () => {
    const design = validateDesignArtifact({
      displayName: '',
      stateScope: 'galaxy',
      uiSurfaces: ['hologram'],
      schedules: [{ name: 'bad name!', cron: 'not cron' }, { name: 'a', cron: '0 0 * * *' }, { name: 'a', cron: '0 0 * * *' }],
      eventSubscriptions: ['not a topic!'],
      externalParticipants: [{ label: '', origin: 'http://insecure.example.com' }],
      telemetry: 'yes',
      surprise: true,
    });
    expect(design.ok).toBe(false);
    if (!design.ok) {
      const joined = design.problems.join(' | ');
      expect(joined).toContain("unknown design field 'surprise'");
      expect(joined).toContain('displayName must be a non-empty string');
      expect(joined).toContain("stateScope must be one of none, tenant, install");
      expect(joined).toContain("'hologram' is not a known declarative UI surface");
      expect(joined).toContain("schedule name 'bad name!'");
      expect(joined).toContain('invalid five-field cron expression');
      expect(joined).toContain("duplicate schedule name 'a'");
      expect(joined).toContain('not a canonical topic slug');
      expect(joined).toContain('non-empty label');
      expect(joined).toContain('not a plain https origin');
      expect(joined).toContain('telemetry must be a boolean');
    }
  });

  it('bounds the human-readable fields with the shared registry bounds', () => {
    const design = validateDesignArtifact({
      displayName: 'X'.repeat(121),
      description: 'Y'.repeat(2001),
      notes: 'Z'.repeat(MAX_NOTES_CHARS + 1),
    });
    expect(design.ok).toBe(false);
    if (!design.ok) {
      expect(design.problems.some((p) => p.includes('displayName must be at most 120'))).toBe(true);
      expect(design.problems.some((p) => p.includes('description must be at most 2000'))).toBe(true);
      expect(design.problems.some((p) => p.includes(`notes must be at most ${MAX_NOTES_CHARS}`))).toBe(true);
    }
  });

  it('enforces the shared schedule and participant ceilings', () => {
    const tooManySchedules = Array.from({ length: 17 }, (_, i) => ({ name: `s${i}`, cron: '0 0 * * *' }));
    expect(validateDesignArtifact({ displayName: 'X', schedules: tooManySchedules }).ok).toBe(false);
    const tooManyParticipants = Array.from({ length: 33 }, (_, i) => ({
      label: `P${i}`,
      origin: `https://p${i}.example.com`,
    }));
    expect(validateDesignArtifact({ displayName: 'X', externalParticipants: tooManyParticipants }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The build artifact contract (one rule set with registration — no bypass)
// ---------------------------------------------------------------------------

/** A complete, consistent build artifact exercising every declaration field. */
function completeBuildArtifact(): Record<string, unknown> {
  return {
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1_000,
    },
    hostRuntime: { minVersion: '1.2.0', maxVersion: '3.0.0' },
  };
}

describe('buildArtifactToRegistration (the SAME rule set as registration)', () => {
  const target = { extensionKey: 'invoice-ocr', version: '2.0.0' };

  it('converts a consistent artifact into a registration input pinned to the session target', () => {
    const built = buildArtifactToRegistration(completeBuildArtifact(), target);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input.extensionKey).toBe('invoice-ocr'); // pinned, not chosen by the agent
      expect(built.input.version).toBe('2.0.0');
      expect(built.input.manifestSchemaVersion).toBe(1); // the supported default
      expect(built.input.displayName).toBe('Invoice OCR');
      expect(built.input.requestedPermissions).toContain('state:read');
      // the derived input passes the full registration validation — the
      // identical gate a human registration passes
      expect(() =>
        validateRequestBuildInputRoundTrip(built.input),
      ).not.toThrow();
    }
  });

  it('accepts an explicit supported manifestSchemaVersion', () => {
    const built = buildArtifactToRegistration(
      { ...completeBuildArtifact(), manifestSchemaVersion: 1 },
      target,
    );
    expect(built.ok).toBe(true);
  });

  it('rejects an unsupported manifestSchemaVersion', () => {
    const built = buildArtifactToRegistration(
      { ...completeBuildArtifact(), manifestSchemaVersion: 7 },
      target,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.problems[0]).toContain('manifestSchemaVersion must be one of 1');
    }
  });

  it('rejects the agent choosing the extension identity (unknown fields)', () => {
    for (const smuggled of ['extensionKey', 'version']) {
      const built = buildArtifactToRegistration(
        { ...completeBuildArtifact(), [smuggled]: 'evil-override' },
        target,
      );
      expect(built.ok).toBe(false);
      if (!built.ok) {
        expect(built.problems.some((p) => p.includes(`unknown build field '${smuggled}'`))).toBe(true);
      }
    }
  });

  it('requires the host-runtime declaration', () => {
    const artifact = completeBuildArtifact();
    delete artifact['hostRuntime'];
    const built = buildArtifactToRegistration(artifact, target);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.problems[0]).toContain('hostRuntime is required');
    }
  });

  it('enforces the capability↔permission consistency rule set (no builder bypass)', () => {
    // stateScope declared, but the permission justification is missing
    const artifact = completeBuildArtifact();
    delete artifact['requestedPermissions'];
    const built = buildArtifactToRegistration(artifact, target);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.problems[0]).toContain('the manifest declaration is inconsistent');
    }
  });

  it('enforces the quota rule set (a quota without its capability is inconsistent)', () => {
    const artifact = completeBuildArtifact();
    delete artifact['externalParticipants'];
    const built = buildArtifactToRegistration(artifact, target);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.problems[0]).toContain('maxExternalCallsPerDay is set without any declared external participant');
    }
  });

  it('surfaces the registry vocabulary in its problems (one rule set, one language)', () => {
    const built = buildArtifactToRegistration(
      { ...completeBuildArtifact(), uiSurfaces: ['hologram'] },
      target,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.problems[0]).toContain("'hologram' is not a known declarative UI surface");
    }
  });
});

/** The round-trip proof helper: the derived input is a legal registration. */
function validateRequestBuildInputRoundTrip(input: Parameters<typeof validateRegisterExtensionManifestInput>[0]): void {
  // The authority is the registry's own validation — the identical gate
  // a human registration passes (one rule set, no builder bypass).
  validateRegisterExtensionManifestInput(input);
}

// ---------------------------------------------------------------------------
// The builder's input/query validation surface
// ---------------------------------------------------------------------------

describe('builder input validation (the house discipline)', () => {
  const agentId = newId();

  it('validates and normalizes a build request', () => {
    const valid = validateRequestExtensionBuildInput({
      extensionKey: 'invoice-ocr',
      version: '2.0.0',
      brief: 'Read invoices into the world model',
      agentId,
      idempotencyKey: 'build-42',
    });
    expect(valid).toEqual({
      extensionKey: 'invoice-ocr',
      version: '2.0.0',
      brief: 'Read invoices into the world model',
      agentId: agentId.toLowerCase(),
      idempotencyKey: 'build-42',
    });
  });

  it('rejects unknown fields, bad keys, bad semver, bad uuids and oversized briefs', () => {
    expect(() =>
      validateRequestExtensionBuildInput({
        extensionKey: 'invoice-ocr',
        version: '2.0.0',
        brief: 'b',
        agentId,
        tenantId: 'smuggled',
      } as never),
    ).toThrow(ExtensionsError);
    expect(() =>
      validateRequestExtensionBuildInput({ extensionKey: 'Bad Key', version: '2.0.0', brief: 'b', agentId }),
    ).toThrow(/must be a lowercase slug/);
    expect(() =>
      validateRequestExtensionBuildInput({ extensionKey: 'k', version: '2.0', brief: 'b', agentId }),
    ).toThrow(/release semver/);
    expect(() =>
      validateRequestExtensionBuildInput({ extensionKey: 'k', version: '2.0.0', brief: 'b', agentId: 'not-a-uuid' }),
    ).toThrow(/must be a uuid/);
    expect(() =>
      validateRequestExtensionBuildInput({
        extensionKey: 'k',
        version: '2.0.0',
        brief: 'x'.repeat(MAX_BRIEF_CHARS + 1),
        agentId,
      }),
    ).toThrow(new RegExp(`at most ${MAX_BRIEF_CHARS} characters`));
  });

  it('validates the pump, cancel, get and list queries', () => {
    const buildId = newId();
    expect(validateRunExtensionBuildInput({ buildId })).toEqual({ buildId: buildId.toLowerCase() });
    expect(validateGetExtensionBuildQuery({ buildId })).toEqual({ buildId: buildId.toLowerCase() });
    expect(validateListExtensionBuildArtifactsQuery({ buildId })).toEqual({ buildId: buildId.toLowerCase() });
    expect(validateCancelExtensionBuildInput({ buildId, reason: 'not needed' })).toEqual({
      buildId: buildId.toLowerCase(),
      reason: 'not needed',
    });
    expect(validateListExtensionBuildsQuery({ extensionKey: 'k', phase: 'deploying', limit: 10 })).toEqual({
      extensionKey: 'k',
      phase: 'deploying',
      limit: 10,
    });
    expect(validateListExtensionBuildsQuery({})).toEqual({
      extensionKey: null,
      phase: null,
      limit: 50,
    });

    expect(() => validateRunExtensionBuildInput({ buildId: 'nope' })).toThrow(/must be a uuid/);
    expect(() => validateCancelExtensionBuildInput({ buildId, reason: '' })).toThrow(/non-empty/);
    expect(() =>
      validateCancelExtensionBuildInput({ buildId, reason: 'x'.repeat(MAX_CANCEL_REASON_CHARS + 1) }),
    ).toThrow(new RegExp(`at most ${MAX_CANCEL_REASON_CHARS} characters`));
    expect(() =>
      validateListExtensionBuildsQuery({ phase: 'dreaming' } as never),
    ).toThrow(/query.phase must be one of/);
    expect(() => validateListExtensionBuildsQuery({ limit: 0 })).toThrow(/query.limit/);
  });
});

// ---------------------------------------------------------------------------
// Bounds sanity (the custody bound)
// ---------------------------------------------------------------------------

describe('builder bounds', () => {
  it('pins the artifact custody bound at 256 KiB', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(262_144);
  });
});
