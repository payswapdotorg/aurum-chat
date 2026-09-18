// Unit tests for the audit module's pure logic (no database): input/query
// validation, the §24 chain-stage vocabulary, the idempotency-key link
// back to a driving cognitive execution, the model/provider derivation
// and the per-link completeness report.

import { describe, expect, it } from 'vitest';
import { AuditError } from '../errors';
import * as auditContract from '../contract';
import {
  CHAIN_STAGES,
  chainCompleteness,
  deriveExtractors,
  executionIdFromIdempotencyKey,
  validateListAuditRecordsQuery,
  validateRecordAuditInput,
  validateReconstructDecisionQuery,
} from '../validation';
import type { DecisionChain, EvidenceObservation } from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e90';
const UUID_C = '2d4f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e91';

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(AuditError);
    expect((error as AuditError).code).toBe(code);
  }
}

function minimalRecordInput(): Record<string, unknown> {
  return {
    subjectKind: 'actions.policy',
    subjectId: UUID_A,
    event: 'policy-changed',
    chainStage: 'policy',
    summary: 'ASK on employee-messaging now requires approval',
  };
}

function emptyChain(): DecisionChain {
  return {
    input: { trigger: null, observation: null },
    evidence: { observations: [], knowledge: [], transactive: [] },
    claimsBeliefs: { claims: [], beliefs: [] },
    unknownMission: { unknowns: [], missions: [] },
    policy: { authorityEvaluation: null, events: [] },
    modelProvider: { extractors: [], events: [] },
    recommendation: { actionRequest: null },
    approval: { decisions: [] },
    execution: { executions: [], directAuthorization: false },
    result: { gate: null, resolution: null, requestStatus: null, decidedAt: null },
    outcome: { outcomes: [] },
    learning: { knowledge: [] },
  };
}

describe('the §24 chain-stage vocabulary (frozen)', () => {
  it('is exactly the ARCHITECTURE.md §24 chain, in order', () => {
    // `input → evidence → claims/beliefs → unknown/mission → policy →
    //  model/provider → recommendation → approval → execution → result →
    //  outcome → learning`
    expect([...CHAIN_STAGES]).toEqual([
      'input',
      'evidence',
      'claims-beliefs',
      'unknown-mission',
      'policy',
      'model-provider',
      'recommendation',
      'approval',
      'execution',
      'result',
      'outcome',
      'learning',
    ]);
  });

  it('guards the vocabulary through the contract', () => {
    expect(auditContract.isChainStage('policy')).toBe(true);
    expect(auditContract.isChainStage('Policy')).toBe(false);
    expect(auditContract.isChainStage('nope')).toBe(false);
    expect(auditContract.isChainStage(null)).toBe(false);
  });
});

describe('validateRecordAuditInput', () => {
  it('accepts a minimal record and normalizes the optionals', () => {
    const valid = validateRecordAuditInput(minimalRecordInput());
    expect(valid).toEqual({
      subjectKind: 'actions.policy',
      subjectId: UUID_A,
      event: 'policy-changed',
      chainStage: 'policy',
      correlationId: null,
      summary: 'ASK on employee-messaging now requires approval',
      detail: {},
    });
  });

  it('accepts a tenant-wide subject (null id) and a correlation id', () => {
    const valid = validateRecordAuditInput({
      ...minimalRecordInput(),
      subjectId: null,
      correlationId: UUID_B,
      detail: { levels: ['ASK'] },
    });
    expect(valid.subjectId).toBeNull();
    expect(valid.correlationId).toBe(UUID_B);
    expect(valid.detail).toEqual({ levels: ['ASK'] });
  });

  it('rejects unknown fields — callers cannot smuggle identity, tenancy, principal or time', () => {
    for (const smuggled of ['id', 'tenantId', 'principalId', 'recordedAt', 'replaces']) {
      expectCode('invalid_record_input', () =>
        validateRecordAuditInput({ ...minimalRecordInput(), [smuggled]: UUID_A }),
      );
    }
  });

  it('rejects non-object input, bad slugs, bad uuids, bad stages and bad summaries', () => {
    expectCode('invalid_record_input', () => validateRecordAuditInput(null));
    expectCode('invalid_record_input', () => validateRecordAuditInput('record'));
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), subjectKind: 'not a kind' }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), subjectKind: 'x'.repeat(129) }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), subjectId: 'not-a-uuid' }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), event: 'not an event' }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), event: 'x'.repeat(65) }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), chainStage: 'policies' }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), correlationId: 'nope' }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), summary: '   ' }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), summary: 'x'.repeat(2049) }),
    );
  });

  it('bounds the detail snapshot: plain objects only, at most 32 KiB serialized', () => {
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), detail: ['array'] }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({ ...minimalRecordInput(), detail: 'string' }),
    );
    expectCode('invalid_record_input', () =>
      validateRecordAuditInput({
        ...minimalRecordInput(),
        detail: { blob: 'x'.repeat(32769) },
      }),
    );
    // Exactly at the cap is fine.
    expect(
      validateRecordAuditInput({ ...minimalRecordInput(), detail: { blob: 'x'.repeat(32750) } })
        .detail.blob,
    ).toBe('x'.repeat(32750));
  });
});

describe('validateListAuditRecordsQuery', () => {
  it('defaults to the plain chronological trail', () => {
    const valid = validateListAuditRecordsQuery({});
    expect(valid).toMatchObject({
      subjectKind: null,
      subjectId: null,
      subjectIdIsNull: false,
      correlationId: null,
      chainStage: null,
      event: null,
      recordedFrom: null,
      recordedTo: null,
      limit: 100,
    });
  });

  it('requires a subject kind before a subject id (both id and null forms)', () => {
    expectCode('invalid_query', () => validateListAuditRecordsQuery({ subjectId: UUID_A }));
    expectCode('invalid_query', () => validateListAuditRecordsQuery({ subjectId: null }));
    expect(validateListAuditRecordsQuery({ subjectKind: 'actions.policy' }).subjectKind).toBe(
      'actions.policy',
    );
    expect(
      validateListAuditRecordsQuery({ subjectKind: 'actions.policy', subjectId: UUID_A }).subjectId,
    ).toBe(UUID_A);
    expect(
      validateListAuditRecordsQuery({ subjectKind: 'actions.policy', subjectId: null })
        .subjectIdIsNull,
    ).toBe(true);
  });

  it('validates the vocabulary, uuid, instant and limit filters', () => {
    expectCode('invalid_query', () =>
      validateListAuditRecordsQuery({ subjectKind: 'actions.policy', subjectId: 'nope' }),
    );
    expectCode('invalid_query', () => validateListAuditRecordsQuery({ correlationId: 'nope' }));
    expectCode('invalid_query', () => validateListAuditRecordsQuery({ chainStage: 'inputx' }));
    expectCode('invalid_query', () => validateListAuditRecordsQuery({ event: 'nope nope' }));
    expectCode('invalid_query', () =>
      validateListAuditRecordsQuery({ recordedFrom: '2026-09-14 09:15' }),
    );
    expectCode('invalid_query', () =>
      validateListAuditRecordsQuery({
        recordedFrom: '2026-09-14T09:15:00.000Z',
        recordedTo: '2026-09-13T09:15:00.000Z',
      }),
    );
    expectCode('invalid_query', () => validateListAuditRecordsQuery({ limit: 0 }));
    expectCode('invalid_query', () => validateListAuditRecordsQuery({ limit: 501 }));
    expectCode('invalid_query', () => validateListAuditRecordsQuery({ limit: 2.5 }));
    expect(
      validateListAuditRecordsQuery({
        recordedFrom: '2026-09-14T09:15:00.000Z',
        recordedTo: '2026-09-15T09:15:00.000Z',
        chainStage: 'approval',
        event: 'approval-decided',
        correlationId: UUID_A,
        limit: 500,
      }).limit,
    ).toBe(500);
  });
});

describe('validateReconstructDecisionQuery', () => {
  it('requires exactly one anchor', () => {
    expectCode('invalid_anchor', () => validateReconstructDecisionQuery({}));
    expectCode('invalid_anchor', () => validateReconstructDecisionQuery({}));
    expectCode('invalid_anchor', () =>
      validateReconstructDecisionQuery({ executionId: UUID_A, correlationId: UUID_B }),
    );
    expectCode('invalid_anchor', () =>
      validateReconstructDecisionQuery({
        executionId: UUID_A,
        actionRequestId: UUID_B,
        correlationId: UUID_C,
      }),
    );
  });

  it('maps each single anchor to its DecisionAnchor form', () => {
    expect(validateReconstructDecisionQuery({ executionId: UUID_A }).anchor).toEqual({
      kind: 'execution',
      id: UUID_A,
    });
    expect(validateReconstructDecisionQuery({ actionRequestId: UUID_B }).anchor).toEqual({
      kind: 'action-request',
      id: UUID_B,
    });
    expect(validateReconstructDecisionQuery({ correlationId: UUID_C }).anchor).toEqual({
      kind: 'correlation',
      id: UUID_C,
    });
  });

  it('rejects non-uuid and unknown fields', () => {
    expectCode('invalid_query', () => validateReconstructDecisionQuery({ executionId: 'nope' }));
    expectCode('invalid_query', () => validateReconstructDecisionQuery({ decisionId: UUID_A }));
  });
});

describe('executionIdFromIdempotencyKey (the cognition link)', () => {
  it('recognizes the documented stable key format', () => {
    expect(executionIdFromIdempotencyKey(`cognition:${UUID_A}:action`)).toBe(UUID_A);
  });

  it('returns null for foreign or absent keys', () => {
    expect(executionIdFromIdempotencyKey(null)).toBeNull();
    expect(executionIdFromIdempotencyKey('random-emitter-key')).toBeNull();
    expect(executionIdFromIdempotencyKey(`cognition:not-a-uuid:action`)).toBeNull();
    expect(executionIdFromIdempotencyKey(`cognition:${UUID_A}:action:extra`)).toBeNull();
  });
});

describe('deriveExtractors (the §24 model/provider link)', () => {
  function readable(
    id: string,
    provider: string | null,
    model: string | null,
  ): EvidenceObservation {
    if (provider === null || model === null) {
      return {
        id,
        unreadable: true,
      };
    }
    return {
      id,
      unreadable: false,
      kind: 'channel.message',
      observedAt: '2026-09-14T09:15:00.000Z',
      recordedAt: '2026-09-14T09:15:01.000Z',
      channel: 'ingestion',
      sourceLabel: null,
      confidenceValue: 0.8,
      payload: {},
      extractor: { provider, model },
    };
  }

  it('returns nothing for an empty or extractor-free evidence base', () => {
    expect(deriveExtractors([])).toEqual([]);
    expect(
      deriveExtractors([
        {
          id: UUID_A,
          unreadable: false,
          kind: 'channel.message',
          observedAt: '2026-09-14T09:15:00.000Z',
          recordedAt: '2026-09-14T09:15:01.000Z',
          channel: 'ingestion',
          sourceLabel: null,
          confidenceValue: 0.8,
          payload: {},
          extractor: null,
        },
      ]),
    ).toEqual([]);
    expect(deriveExtractors([readable(UUID_A, null, null)])).toEqual([]);
  });

  it('deduplicates provider+model pairs and collects their observations', () => {
    const extractors = deriveExtractors([
      readable(UUID_A, 'z-ai', 'glm-4.6'),
      readable(UUID_B, 'z-ai', 'glm-4.6'),
      readable(UUID_C, 'other', 'model-x'),
    ]);
    expect(extractors).toEqual([
      { provider: 'other', model: 'model-x', observationIds: [UUID_C] },
      { provider: 'z-ai', model: 'glm-4.6', observationIds: [UUID_A, UUID_B] },
    ]);
  });
});

describe('chainCompleteness (what is absent is stated, never silent)', () => {
  it('reports every §24 stage, all absent, for an empty chain', () => {
    const report = chainCompleteness(emptyChain());
    expect(report.map((link) => link.stage)).toEqual([...CHAIN_STAGES]);
    expect(report.every((link) => link.present === false && link.itemCount === 0)).toBe(true);
  });

  it('marks links present as their content arrives', () => {
    const chain = emptyChain();
    chain.input.trigger = { kind: 'system', id: null, label: 'nightly' };
    chain.evidence.observations.push({
      id: UUID_A,
      unreadable: true,
    });
    chain.claimsBeliefs.claims.push({
      id: UUID_B,
      proposition: 'p',
      confidenceValue: 0.5,
      evidenceObservationIds: [],
    });
    chain.policy.authorityEvaluation = {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      outcome: 'approval_required',
      resolvedVia: 'kind',
      policyNote: null,
    };
    chain.recommendation.actionRequest = {
      id: UUID_C,
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: {},
      justification: null,
      requestedBy: 'p1',
      requestedAt: '2026-09-14T09:15:00.000Z',
      idempotencyKey: null,
      status: 'pending',
    };
    chain.approval.decisions.push({
      id: UUID_A,
      requestId: UUID_C,
      decision: 'approve',
      decidedBy: 'principal',
      principalId: 'p2',
      note: null,
      decidedAt: '2026-09-14T09:16:00.000Z',
    });
    chain.result.gate = 'approval_required';
    chain.result.resolution = 'approved';
    chain.result.requestStatus = 'approved';

    const byStage = new Map(chainCompleteness(chain).map((link) => [link.stage, link]));
    expect(byStage.get('input')).toMatchObject({ present: true, itemCount: 1 });
    expect(byStage.get('evidence')).toMatchObject({ present: true, itemCount: 1 });
    expect(byStage.get('claims-beliefs')).toMatchObject({ present: true, itemCount: 1 });
    expect(byStage.get('unknown-mission')).toMatchObject({ present: false, itemCount: 0 });
    expect(byStage.get('policy')).toMatchObject({ present: true, itemCount: 1 });
    expect(byStage.get('model-provider')).toMatchObject({ present: false, itemCount: 0 });
    expect(byStage.get('recommendation')).toMatchObject({ present: true, itemCount: 1 });
    expect(byStage.get('approval')).toMatchObject({ present: true, itemCount: 1 });
    expect(byStage.get('execution')).toMatchObject({ present: false, itemCount: 0 });
    expect(byStage.get('result')).toMatchObject({ present: true, itemCount: 3 });
    expect(byStage.get('outcome')).toMatchObject({ present: false, itemCount: 0 });
    expect(byStage.get('learning')).toMatchObject({ present: false, itemCount: 0 });
  });
});
