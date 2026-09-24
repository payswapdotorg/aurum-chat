// Unit tests for the workflow module's PURE layer (W080): the cron
// evaluator, the run/step state machine and the input validation — no
// database, no clock, no side effects. The integration behavior
// (durable runs, resumption, waits) lives in workflow-service.test.ts
// and workflow-resumption.test.ts.

import { describe, expect, it } from 'vitest';
import {
  CRON_HORIZON_YEARS,
  cronMatches,
  cronOccurrencesBetween,
  isValidCron,
  nextCronOccurrence,
  parseCron,
} from '../cron';
import {
  ATTEMPT_OUTCOMES,
  RUN_STATUSES,
  STEP_STATUSES,
  TRIGGER_KINDS,
  WAIT_KINDS,
  approvalIdempotencyKey,
  claimableStepPredicate,
  classifyStepResult,
  eventRunIdempotencyKey,
  isDeterministicStepFailure,
  isRunTerminal,
  retryBackoffSeconds,
  runStatusAfterCancelRequest,
  scheduleRunIdempotencyKey,
  stepIdempotencyKey,
  stepStatusAfterRunCancelled,
} from '../machine';
import { WorkflowStepError } from '../errors';
import {
  DEFAULT_MAX_ATTEMPTS,
  MAX_IDEM_KEY_LENGTH,
  MAX_PAYLOAD_BYTES,
  isUuid,
  validateCreateScheduleInput,
  validateDispatchEventInput,
  validateRegisterWorkflowInput,
  validateStartRunInput,
} from '../validation';

// ---------------------------------------------------------------------------
// cron — grammar
// ---------------------------------------------------------------------------

describe('cron: parseCron grammar', () => {
  it('accepts the canonical forms', () => {
    expect(parseCron('* * * * *')).toEqual({
      minutes: Array.from({ length: 60 }, (_, i) => i),
      hours: Array.from({ length: 24 }, (_, i) => i),
      daysOfMonth: Array.from({ length: 31 }, (_, i) => i + 1),
      months: Array.from({ length: 12 }, (_, i) => i + 1),
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      domAny: true,
      dowAny: true,
    });
    expect(parseCron('0 0 * * *').minutes).toEqual([0]);
    expect(parseCron('30 9 * * *').hours).toEqual([9]);
    expect(parseCron('*/5 * * * *').minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(parseCron('0 9-17 * * *').hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(parseCron('0 9,12,17 * * *').hours).toEqual([9, 12, 17]);
    expect(parseCron('0 0 1 * *').daysOfMonth).toEqual([1]);
    expect(parseCron('0 0 * 3 *').months).toEqual([3]);
    expect(parseCron('0 0 * * 1').daysOfWeek).toEqual([1]);
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0]); // 7 normalizes to Sunday 0
    expect(parseCron('0 0 * * 0-4').daysOfWeek).toEqual([0, 1, 2, 3, 4]);
    expect(parseCron('10-30/10 * * * *').minutes).toEqual([10, 20, 30]);
    // Extra whitespace between fields is tolerated.
    expect(parseCron('  0   0 *  *  * ').minutes).toEqual([0]);
  });

  it('rejects malformed expressions deterministically', () => {
    for (const bad of [
      '',
      '  ',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 0 *',
      '* * * 13 *',
      '* * * * 8',
      'a * * * *',
      '*/0 * * * *',
      '5-1 * * * *',
      '1,,2 * * * *',
      '-1 * * * *',
    ]) {
      expect(isValidCron(bad)).toBe(false);
      expect(() => parseCron(bad)).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// cron — matching and next occurrence
// ---------------------------------------------------------------------------

describe('cron: matching and occurrence math', () => {
  const at = (iso: string): Date => new Date(iso);

  it('matches minutes/hours/months exactly', () => {
    const everyFive = parseCron('*/5 * * * *');
    expect(cronMatches(everyFive, at('2026-09-24T12:00:00Z'))).toBe(true);
    expect(cronMatches(everyFive, at('2026-09-24T12:03:00Z'))).toBe(false);
    const nineThirty = parseCron('30 9 * * *');
    expect(cronMatches(nineThirty, at('2026-09-24T09:30:00Z'))).toBe(true);
    expect(cronMatches(nineThirty, at('2026-09-24T21:30:00Z'))).toBe(false);
  });

  it('applies the Vixie day rule (both restricted → either matches)', () => {
    // Both DOM and DOW restricted: the 13th OR any Friday matches.
    const fridayOr13th = parseCron('0 0 13 * 5');
    expect(cronMatches(fridayOr13th, at('2026-09-24T00:00:00Z'))).toBe(false); // Thursday the 24th
    expect(cronMatches(fridayOr13th, at('2026-09-25T00:00:00Z'))).toBe(true); // Friday
    expect(cronMatches(fridayOr13th, at('2026-09-13T00:00:00Z'))).toBe(true); // the 13th (a Sunday)
    const friday = parseCron('0 0 * * 5');
    expect(cronMatches(friday, at('2026-09-25T00:00:00Z'))).toBe(true); // 2026-09-25 is a Friday
    expect(cronMatches(friday, at('2026-09-24T00:00:00Z'))).toBe(false); // Thursday
    // DOM-only restriction must match exactly.
    const thirteenth = parseCron('0 0 13 * *');
    expect(cronMatches(thirteenth, at('2026-09-13T00:00:00Z'))).toBe(true);
    expect(cronMatches(thirteenth, at('2026-09-14T00:00:00Z'))).toBe(false);
  });

  it('computes the next occurrence strictly after the given instant', () => {
    expect(nextCronOccurrence(parseCron('*/5 * * * *'), at('2026-09-24T11:57:30Z'))?.toISOString()).toBe(
      '2026-09-24T12:00:00.000Z',
    );
    expect(nextCronOccurrence(parseCron('0 0 * * *'), at('2026-09-24T12:00:00Z'))?.toISOString()).toBe(
      '2026-09-25T00:00:00.000Z',
    );
    expect(nextCronOccurrence(parseCron('30 9 * * *'), at('2026-09-24T09:30:00Z'))?.toISOString()).toBe(
      '2026-09-25T09:30:00.000Z',
    );
    expect(nextCronOccurrence(parseCron('30 9 * * *'), at('2026-09-24T09:29:59Z'))?.toISOString()).toBe(
      '2026-09-24T09:30:00.000Z',
    );
  });

  it('returns null for a never-matching expression within the horizon', () => {
    // February 31st never exists.
    expect(nextCronOccurrence(parseCron('0 0 31 2 *'), new Date('2026-01-01T00:00:00Z'))).toBeNull();
    expect(CRON_HORIZON_YEARS).toBe(4);
  });

  it('enumerates occurrences in a window, capped', () => {
    const parsed = parseCron('*/5 * * * *');
    const occurrences = cronOccurrencesBetween(parsed, at('2026-09-24T11:57:30Z'), at('2026-09-24T12:13:00Z'));
    expect(occurrences.map((d) => d.toISOString())).toEqual([
      '2026-09-24T12:00:00.000Z',
      '2026-09-24T12:05:00.000Z',
      '2026-09-24T12:10:00.000Z',
    ]);
    // The window is exclusive of the from instant.
    const exact = cronOccurrencesBetween(parsed, at('2026-09-24T12:00:00Z'), at('2026-09-24T12:00:00Z'));
    expect(exact).toEqual([]);
    // The cap bounds runaway enumerations.
    const capped = cronOccurrencesBetween(parsed, at('2026-01-01T00:00:00Z'), at('2026-12-31T00:00:00Z'), 3);
    expect(capped).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// machine — transitions, retries, idempotency derivations
// ---------------------------------------------------------------------------

describe('machine: cancellation transitions', () => {
  it('cancels pending/waiting runs outright and running runs cooperatively', () => {
    expect(runStatusAfterCancelRequest('pending')).toBe('cancelled');
    expect(runStatusAfterCancelRequest('waiting')).toBe('cancelled');
    expect(runStatusAfterCancelRequest('running')).toBe('cancelling');
    expect(runStatusAfterCancelRequest('succeeded')).toBeNull();
    expect(runStatusAfterCancelRequest('failed')).toBeNull();
    expect(runStatusAfterCancelRequest('cancelled')).toBeNull();
  });

  it('retires only non-terminal steps when the run is finalized as cancelled', () => {
    expect(stepStatusAfterRunCancelled('pending')).toBe('cancelled');
    expect(stepStatusAfterRunCancelled('running')).toBe('cancelled');
    expect(stepStatusAfterRunCancelled('waiting')).toBe('cancelled');
    expect(stepStatusAfterRunCancelled('succeeded')).toBeNull();
    expect(stepStatusAfterRunCancelled('failed')).toBeNull();
    expect(stepStatusAfterRunCancelled('cancelled')).toBeNull();
  });
});

describe('machine: retry policy', () => {
  it('backoff grows exponentially off the base and caps at one day', () => {
    expect(retryBackoffSeconds(30, 1)).toBe(30);
    expect(retryBackoffSeconds(30, 2)).toBe(60);
    expect(retryBackoffSeconds(30, 3)).toBe(120);
    expect(retryBackoffSeconds(30, 8)).toBe(3840);
    expect(retryBackoffSeconds(86_400, 1)).toBe(86_400);
    expect(retryBackoffSeconds(86_400, 3)).toBe(86_400);
    expect(retryBackoffSeconds(0, 5)).toBe(0);
  });

  it('classifies deterministic failures exactly', () => {
    expect(isDeterministicStepFailure(new WorkflowStepError('bad_input', 'no'))).toBe(true);
    expect(isDeterministicStepFailure(new Error('network blip'))).toBe(false);
    expect(isDeterministicStepFailure('string error')).toBe(false);
    expect(isDeterministicStepFailure(null)).toBe(false);
  });
});

describe('machine: idempotency key derivations (stable across retries)', () => {
  it('derives the documented key shapes', () => {
    expect(stepIdempotencyKey('11111111-1111-1111-1111-111111111111', 2)).toBe(
      'wf:11111111-1111-1111-1111-111111111111:2',
    );
    expect(approvalIdempotencyKey('11111111-1111-1111-1111-111111111111', 2)).toBe(
      'wf:11111111-1111-1111-1111-111111111111:2:approval',
    );
    expect(eventRunIdempotencyKey('e', 'd')).toBe('event:e:d');
    expect(scheduleRunIdempotencyKey('s', 1234)).toBe('sched:s:1234');
    // All well under the shared agents-module cap.
    expect(MAX_IDEM_KEY_LENGTH).toBe(200);
  });
});

describe('machine: executor result classification', () => {
  it('classifies done / checkpoint / wait shapes', () => {
    expect(classifyStepResult({ type: 'done' })).toEqual({ type: 'done', output: null });
    expect(classifyStepResult({ type: 'done', output: { x: 1 } })).toEqual({ type: 'done', output: { x: 1 } });
    expect(classifyStepResult({ type: 'checkpoint', progress: { n: 2 } })).toEqual({
      type: 'checkpoint',
      progress: { n: 2 },
      resumeInSeconds: null,
    });
    expect(classifyStepResult({ type: 'checkpoint', progress: 1, resumeInSeconds: 60 })).toEqual({
      type: 'checkpoint',
      progress: 1,
      resumeInSeconds: 60,
    });
    expect(
      classifyStepResult({ type: 'wait', wait: { kind: 'timer', resumeAt: '2026-09-24T12:01:00Z' } }),
    ).toEqual({ type: 'wait', wait: { kind: 'timer', resumeAt: new Date('2026-09-24T12:01:00Z') } });
    expect(
      classifyStepResult({
        type: 'wait',
        wait: { kind: 'approval', approval: { actionKind: 'source-access', authorityLevel: 'EXECUTE', payload: { a: 1 } } },
      }),
    ).toEqual({
      type: 'wait',
      wait: { kind: 'approval', actionKind: 'source-access', authorityLevel: 'EXECUTE', payload: { a: 1 }, justification: null },
    });
    expect(
      classifyStepResult({ type: 'wait', wait: { kind: 'employee_response', resumeOnEvent: 'employee.replied' } }),
    ).toEqual({
      type: 'wait',
      wait: { kind: 'employee_response', note: null, resumeOnEvent: 'employee.replied' },
    });
  });

  it('rejects malformed results deterministically (null)', () => {
    expect(classifyStepResult(null)).toBeNull();
    expect(classifyStepResult(undefined)).toBeNull();
    expect(classifyStepResult('done')).toBeNull();
    expect(classifyStepResult({})).toBeNull();
    expect(classifyStepResult({ type: 'nope' })).toBeNull();
    expect(classifyStepResult({ type: 'checkpoint', resumeInSeconds: -1 })).toBeNull();
    expect(classifyStepResult({ type: 'checkpoint', resumeInSeconds: 100_000 })).toBeNull();
    expect(classifyStepResult({ type: 'wait', wait: { kind: 'timer', resumeAt: 'not-a-date' } })).toBeNull();
    expect(classifyStepResult({ type: 'wait', wait: { kind: 'mystery' } })).toBeNull();
    expect(
      classifyStepResult({ type: 'wait', wait: { kind: 'approval', approval: { actionKind: '', authorityLevel: 'EXECUTE' } } }),
    ).toBeNull();
    expect(classifyStepResult({ type: 'wait', wait: null })).toBeNull();
  });
});

describe('machine: claimability predicate', () => {
  const at = new Date('2026-09-24T12:00:00Z');

  it('claims fresh and backoff-elapsed pending steps', () => {
    expect(claimableStepPredicate({ status: 'pending', leaseExpiresAt: null, retryNotBefore: null }, at)).toBe(true);
    expect(
      claimableStepPredicate({ status: 'pending', leaseExpiresAt: null, retryNotBefore: '2026-09-24T11:59:00Z' }, at),
    ).toBe(true);
    expect(
      claimableStepPredicate({ status: 'pending', leaseExpiresAt: null, retryNotBefore: '2026-09-24T12:01:00Z' }, at),
    ).toBe(false);
  });

  it('claims unclaimed and lease-expired running steps, never live ones', () => {
    expect(claimableStepPredicate({ status: 'running', leaseExpiresAt: null, retryNotBefore: null }, at)).toBe(true);
    expect(
      claimableStepPredicate({ status: 'running', leaseExpiresAt: '2026-09-24T11:59:00Z', retryNotBefore: null }, at),
    ).toBe(true);
    expect(
      claimableStepPredicate({ status: 'running', leaseExpiresAt: '2026-09-24T12:01:00Z', retryNotBefore: null }, at),
    ).toBe(false);
  });

  it('never claims terminal or waiting steps', () => {
    for (const status of ['waiting', 'succeeded', 'failed', 'cancelled'] as const) {
      expect(claimableStepPredicate({ status, leaseExpiresAt: null, retryNotBefore: null }, at)).toBe(false);
    }
  });
});

describe('machine: vocabularies', () => {
  it('pins the frozen status vocabularies', () => {
    expect(RUN_STATUSES).toEqual([
      'pending',
      'running',
      'waiting',
      'cancelling',
      'cancelled',
      'succeeded',
      'failed',
    ]);
    expect(STEP_STATUSES).toEqual(['pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled']);
    expect(WAIT_KINDS).toEqual(['timer', 'approval', 'employee_response']);
    expect(TRIGGER_KINDS).toEqual(['manual', 'event', 'schedule']);
    expect(ATTEMPT_OUTCOMES).toEqual(['completed', 'checkpoint', 'wait', 'failed', 'abandoned']);
    expect(isRunTerminal('succeeded')).toBe(true);
    expect(isRunTerminal('failed')).toBe(true);
    expect(isRunTerminal('cancelled')).toBe(true);
    expect(isRunTerminal('running')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe('validation: registerWorkflow', () => {
  const validSpec = {
    steps: [
      { key: 'prepare' },
      { key: 'execute', maxAttempts: 5, retryBackoffSeconds: 10, leaseSeconds: 60 },
    ],
    eventTriggers: ['invoice.registered'],
  };

  it('accepts and normalizes a valid registration', () => {
    const result = validateRegisterWorkflowInput({
      key: 'demo.onboarding',
      title: 'Onboarding',
      description: null,
      spec: validSpec,
    });
    expect(result.key).toBe('demo.onboarding');
    expect(result.spec.steps[0]).toEqual({
      key: 'prepare',
      title: null,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      retryBackoffSeconds: 30,
      leaseSeconds: 3600,
    });
    expect(result.spec.steps[1]!.maxAttempts).toBe(5);
    expect(result.spec.eventTriggers).toEqual(['invoice.registered']);
  });

  it('rejects malformed keys, empty steps, duplicate step keys, out-of-range policies', () => {
    expect(() => validateRegisterWorkflowInput({ key: 'Bad Key', title: 'T', spec: validSpec })).toThrow();
    expect(() => validateRegisterWorkflowInput({ key: '', title: 'T', spec: validSpec })).toThrow();
    expect(() => validateRegisterWorkflowInput({ key: 'a'.repeat(129), title: 'T', spec: validSpec })).toThrow();
    expect(() => validateRegisterWorkflowInput({ key: 'ok.key', title: '', spec: validSpec })).toThrow();
    expect(() =>
      validateRegisterWorkflowInput({ key: 'ok.key', title: 'T', spec: { steps: [] } }),
    ).toThrow();
    expect(() =>
      validateRegisterWorkflowInput({ key: 'ok.key', title: 'T', spec: { steps: [{ key: 'Bad Key' }] } }),
    ).toThrow();
    expect(() =>
      validateRegisterWorkflowInput({
        key: 'ok.key',
        title: 'T',
        spec: { steps: [{ key: 'a' }, { key: 'a' }] },
      }),
    ).toThrow();
    expect(() =>
      validateRegisterWorkflowInput({
        key: 'ok.key',
        title: 'T',
        spec: { steps: [{ key: 'a', maxAttempts: 0 }] },
      }),
    ).toThrow();
    expect(() =>
      validateRegisterWorkflowInput({
        key: 'ok.key',
        title: 'T',
        spec: { steps: [{ key: 'a', maxAttempts: 21 }] },
      }),
    ).toThrow();
    expect(() =>
      validateRegisterWorkflowInput({
        key: 'ok.key',
        title: 'T',
        spec: { steps: [{ key: 'a', leaseSeconds: 1 }] },
      }),
    ).toThrow();
    expect(() =>
      validateRegisterWorkflowInput({
        key: 'ok.key',
        title: 'T',
        spec: { steps: [{ key: 'a', retryBackoffSeconds: -1 }] },
      }),
    ).toThrow();
    expect(() =>
      validateRegisterWorkflowInput({ key: 'ok.key', title: 'T', spec: { steps: validSpec.steps, eventTriggers: ['NO'] } }),
    ).toThrow();
    // Too many steps.
    expect(() =>
      validateRegisterWorkflowInput({
        key: 'ok.key',
        title: 'T',
        spec: { steps: Array.from({ length: 51 }, (_, i) => ({ key: `s${i}` })) },
      }),
    ).toThrow();
  });
});

describe('validation: startRun / dispatch / schedule inputs', () => {
  it('validates startRun shapes and caps', () => {
    expect(validateStartRunInput({ definitionKey: 'demo.x' })).toEqual({
      definitionKey: 'demo.x',
      input: {},
      idempotencyKey: null,
      triggerReference: null,
    });
    expect(validateStartRunInput({ definitionKey: 'demo.x', input: { a: 1 }, idempotencyKey: 'k' }).input).toEqual({
      a: 1,
    });
    expect(() => validateStartRunInput({ definitionKey: 'BAD' })).toThrow();
    expect(() => validateStartRunInput({ definitionKey: 'demo.x', idempotencyKey: 'x'.repeat(201) })).toThrow();
    expect(() =>
      validateStartRunInput({ definitionKey: 'demo.x', input: 'y'.repeat(MAX_PAYLOAD_BYTES + 1) }),
    ).toThrow();
  });

  it('validates event dispatch inputs', () => {
    expect(validateDispatchEventInput({ eventType: 'invoice.registered' })).toEqual({
      eventType: 'invoice.registered',
      payload: {},
      idempotencyKey: null,
      domainEventId: null,
    });
    expect(() => validateDispatchEventInput({ eventType: 'Nope' })).toThrow();
    expect(() => validateDispatchEventInput({ eventType: 'ok.event', domainEventId: 'not-a-uuid' })).toThrow();
    expect(() => validateDispatchEventInput({ eventType: 'ok.event', idempotencyKey: '' })).toThrow();
  });

  it('validates schedule inputs (including cron grammar)', () => {
    expect(validateCreateScheduleInput({ definitionKey: 'demo.x', cron: '*/5 * * * *' })).toEqual({
      definitionKey: 'demo.x',
      cron: '*/5 * * * *',
      input: {},
      active: true,
    });
    expect(() => validateCreateScheduleInput({ definitionKey: 'demo.x', cron: 'nope' })).toThrow();
    expect(() => validateCreateScheduleInput({ definitionKey: 'demo.x', cron: '60 * * * *' })).toThrow();
    expect(() => validateCreateScheduleInput({ definitionKey: 'BAD', cron: '* * * * *' })).toThrow();
  });

  it('shares the agents-module idempotency cap and provides isUuid', () => {
    expect(MAX_IDEM_KEY_LENGTH).toBe(200);
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });
});
