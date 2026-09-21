// Unit tests for the evidence/audit surface's pure logic (W065) — the
// anchor grammar, the label layer and the view builders' pure helpers.
// No database, no Next.js: everything here is deterministic derivation.

import { describe, expect, it } from 'vitest';
import {
  ANCHOR_KIND_LABEL,
  anchorHref,
  anchorKindForSegment,
  isAnchorSegment,
  isUuidShape,
  reconstructQuery,
  segmentForAnchorKind,
} from '../lib/anchors';
import {
  CAUSAL_STEPS,
  asFreshnessStatus,
  ageLabel,
  beliefStatusLabel,
  beliefStatusTone,
  causalLabel,
  clip,
  contradictionLabel,
  contradictionTone,
  dateTimeLabel,
  executionStateLabel,
  executionStateTone,
  freshnessLabel,
  freshnessTone,
  gateLabel,
  gateTone,
  payloadSummary,
  percent,
  requestStatusLabel,
  requestStatusTone,
  slugLabel,
  sourceStatusLabel,
  sourceStatusTone,
  spanLabel,
} from '../lib/labels';
import {
  actionRequestTitle,
  executionTitle,
} from '../lib/views';
import type { ActionRequest, ActionRequestStatus } from '@/modules/actions/contract';
import type { CognitiveExecution } from '@/modules/cognition/contract';
import { buildShellCommands } from '../../lib/command-registry';

// ---------------------------------------------------------------------------
// The anchor grammar
// ---------------------------------------------------------------------------

describe('the explain surface anchor grammar', () => {
  it('accepts exactly the three anchor segments', () => {
    expect(isAnchorSegment('execution')).toBe(true);
    expect(isAnchorSegment('action')).toBe(true);
    expect(isAnchorSegment('correlation')).toBe(true);
    expect(isAnchorSegment('action-request')).toBe(false);
    expect(isAnchorSegment('flow')).toBe(false);
    expect(isAnchorSegment('')).toBe(false);
  });

  it('maps segments onto the audit contract anchor kinds', () => {
    expect(anchorKindForSegment('execution')).toBe('execution');
    expect(anchorKindForSegment('action')).toBe('action-request');
    expect(anchorKindForSegment('correlation')).toBe('correlation');
    expect(anchorKindForSegment('other')).toBeNull();
  });

  it('segment ↔ kind round-trips', () => {
    for (const kind of ['execution', 'action-request', 'correlation'] as const) {
      expect(anchorKindForSegment(segmentForAnchorKind(kind))).toBe(kind);
    }
  });

  it('builds deep links with the short segments', () => {
    expect(anchorHref('execution', 'x')).toBe('/explain/execution/x');
    expect(anchorHref('action-request', 'y')).toBe('/explain/action/y');
    expect(anchorHref('correlation', 'z')).toBe('/explain/correlation/z');
  });

  it('builds the reconstructDecision query per anchor kind', () => {
    expect(reconstructQuery('execution', 'e1')).toEqual({ executionId: 'e1' });
    expect(reconstructQuery('action-request', 'r1')).toEqual({ actionRequestId: 'r1' });
    expect(reconstructQuery('correlation', 'c1')).toEqual({ correlationId: 'c1' });
  });

  it('validates uuid shapes (a shape check, not existence)', () => {
    expect(isUuidShape('30d691a8-1500-4295-a625-cd10d5de329d')).toBe(true);
    expect(isUuidShape('not-a-uuid')).toBe(false);
    expect(isUuidShape('')).toBe(false);
    expect(isUuidShape("30d691a8-1500-4295-a625-cd10d5de329d' OR 1=1--")).toBe(false);
  });

  it('labels every anchor kind for humans (no naked vocabulary)', () => {
    expect(ANCHOR_KIND_LABEL.execution).toMatch(/cycle/i);
    expect(ANCHOR_KIND_LABEL['action-request']).toMatch(/request/i);
    expect(ANCHOR_KIND_LABEL.correlation).toMatch(/flow/i);
  });
});

// ---------------------------------------------------------------------------
// The label layer
// ---------------------------------------------------------------------------

describe('the causal rail vocabulary', () => {
  it('carries the twelve §24 stages in frozen order', () => {
    expect(CAUSAL_STEPS.map((step) => step.stage)).toEqual([
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

  it('labels and hints every stage (foreign values pass through)', () => {
    expect(causalLabel('input')).toBe('Input');
    expect(causalLabel('claims-beliefs')).toBe('Claims & beliefs');
    expect(causalLabel('learning')).toBe('Learning');
    expect(causalLabel('martian')).toBe('martian');
    for (const step of CAUSAL_STEPS) {
      expect(causalLabel(step.stage).length).toBeGreaterThan(0);
    }
  });
});

describe('freshness and source reliability labels', () => {
  it('coerces contract statuses into the labeled vocabulary', () => {
    expect(asFreshnessStatus('current')).toBe('current');
    expect(asFreshnessStatus('aging')).toBe('aging');
    expect(asFreshnessStatus('stale')).toBe('stale');
    expect(asFreshnessStatus('unknown')).toBe('unknown');
    expect(asFreshnessStatus('martian')).toBe('unknown');
  });

  it('pairs every freshness status with a tone AND a label (never color alone)', () => {
    expect(freshnessTone('current')).toBe('positive');
    expect(freshnessLabel('current')).toBe('Current');
    expect(freshnessTone('aging')).toBe('warning');
    expect(freshnessLabel('aging')).toBe('Aging');
    expect(freshnessTone('stale')).toBe('error');
    expect(freshnessLabel('stale')).toBe('Stale');
    expect(freshnessTone('unknown')).toBe('neutral');
    expect(freshnessLabel('unknown')).toBe('Freshness unknown');
  });

  it('labels source connection status (the reliability signal)', () => {
    expect(sourceStatusTone('active')).toBe('positive');
    expect(sourceStatusLabel('active')).toBe('Connected');
    expect(sourceStatusTone('disabled')).toBe('neutral');
    expect(sourceStatusLabel('disabled')).toBe('Disconnected');
  });
});

describe('state, gate and conflict labels', () => {
  it('labels execution states', () => {
    expect(executionStateTone('completed')).toBe('positive');
    expect(executionStateLabel('completed')).toBe('Completed');
    expect(executionStateTone('awaiting_approval')).toBe('warning');
    expect(executionStateLabel('awaiting_approval')).toMatch(/approval/i);
    expect(executionStateLabel('abandoned')).toBe('Abandoned');
    expect(executionStateTone('running')).toBe('info');
  });

  it('labels action request statuses', () => {
    expect(requestStatusTone('approved')).toBe('positive');
    expect(requestStatusLabel('pending')).toBe('Pending decision');
    expect(requestStatusTone('rejected')).toBe('error');
  });

  it('labels authority gate outcomes', () => {
    expect(gateTone('allowed')).toBe('positive');
    expect(gateLabel('allowed')).toBe('Allowed by policy');
    expect(gateTone('approval_required')).toBe('warning');
    expect(gateLabel('approval_required')).toMatch(/human/i);
    expect(gateTone('forbidden')).toBe('error');
    expect(gateLabel('forbidden')).toBe('Forbidden by policy');
  });

  it('labels contradictions (open conflict warns, resolved is positive)', () => {
    expect(contradictionTone('open')).toBe('warning');
    expect(contradictionLabel('open')).toMatch(/retained/i);
    expect(contradictionTone('resolved')).toBe('positive');
    expect(contradictionLabel('resolved')).toMatch(/weighed/i);
  });

  it('labels belief statuses', () => {
    expect(beliefStatusTone('active')).toBe('positive');
    expect(beliefStatusLabel('active')).toBe('Current understanding');
    expect(beliefStatusLabel('retired')).toBe('Retired');
  });
});

describe('text, time and payload formatting', () => {
  it('clips long text with an ellipsis and flattens whitespace', () => {
    expect(clip('a b  c\n d', 10)).toBe('a b c d');
    expect(clip('abcdefghij', 10)).toBe('abcdefghij');
    expect(clip('abcdefghijk', 10)).toBe('abcdefghi…');
  });

  it('summarizes payloads of every shape', () => {
    expect(payloadSummary({ account: 'harbor', score: 86 })).toContain('harbor');
    expect(payloadSummary('plain text')).toBe('plain text');
    expect(payloadSummary(86)).toBe('86');
    expect(payloadSummary(null)).toBe('—');
    expect(payloadSummary({ deep: { value: 'x'.repeat(400) } }, 40).length).toBeLessThanOrEqual(40);
  });

  it('renders confidence as percent', () => {
    expect(percent(0.9)).toBe('90%');
    expect(percent(0.871)).toBe('87%');
    expect(percent(0)).toBe('0%');
  });

  it('formats compact time spans', () => {
    expect(spanLabel(0.4)).toBe('<1s');
    expect(spanLabel(30)).toBe('30s');
    expect(spanLabel(90)).toBe('2m');
    expect(spanLabel(3600 * 5)).toBe('5h');
    expect(spanLabel(3600 * 72)).toBe('3d');
    expect(spanLabel(Number.NaN)).toBe('—');
    expect(spanLabel(-5)).toBe('—');
  });

  it('labels evidence age honestly (null means no evidence)', () => {
    expect(ageLabel(null)).toBe('no evidence yet');
    expect(ageLabel(3600)).toBe('1h old');
  });

  it('formats stable UTC date-times', () => {
    expect(dateTimeLabel('2026-10-03T14:05:00.000Z')).toMatch(/Oct 3, 14:05 UTC/);
    expect(dateTimeLabel('nonsense')).toBe('nonsense');
  });
});

// ---------------------------------------------------------------------------
// The index rows' pure title derivation
// ---------------------------------------------------------------------------

describe('decision titles (human text first — uuids are addresses)', () => {
  const executionBase = {
    id: 'e1',
    trigger: { kind: 'conversation', id: null, label: null },
    state: 'completed' as const,
    completedStages: 12,
    outcome: null,
    abandonment: null,
    rationale: null,
    startedByPrincipal: 'p',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    completedAt: null,
  };

  it('titles an execution by its trigger label when present', () => {
    const execution = {
      ...executionBase,
      trigger: { kind: 'management', id: null, label: 'October ops review' },
    } as unknown as CognitiveExecution;
    expect(executionTitle(execution)).toBe('October ops review');
  });

  it('falls back to a humanized trigger kind', () => {
    const execution = {
      ...executionBase,
      trigger: { kind: 'scheduled', id: null, label: null },
    } as unknown as CognitiveExecution;
    expect(executionTitle(execution)).toBe('Scheduled');
  });

  it('humanizes action kinds (never a naked slug)', () => {
    const request = {
      actionKind: 'employee-messaging',
    } as unknown as ActionRequest;
    expect(actionRequestTitle(request)).toBe('Employee Messaging');
    expect(slugLabel('customer-outreach')).toBe('Customer Outreach');
    expect(slugLabel('simple')).toBe('Simple');
  });

  it('slug humanization survives odd shapes without crashing', () => {
    expect(slugLabel('')).toBe('');
    expect(slugLabel('a--b')).toBe('A B');
  });

  it('an action request of foreign status shape still renders a label', () => {
    // The label layer must never throw on contract evolution.
    expect(requestStatusLabel('pending' as ActionRequestStatus)).toBe('Pending decision');
    expect(requestStatusLabel('weird' as ActionRequestStatus)).toBe('weird');
  });
});

// ---------------------------------------------------------------------------
// Cross-surface registration (the shell's single registry)
// ---------------------------------------------------------------------------

describe('the surface is registered in the command search exactly once', () => {
  it('carries the evidence/audit destination, reachable by its core names', () => {
    const commands = buildShellCommands();
    const evidence = commands.filter((command) => command.id.startsWith('evidence:'));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.target).toEqual({ kind: 'navigate', href: '/explain' });
    for (const keyword of ['evidence', 'audit', 'explain', 'why', 'decision']) {
      expect(evidence[0]!.keywords).toContain(keyword);
    }
    // Unique ids overall (the registry's own invariant).
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
  });
});
