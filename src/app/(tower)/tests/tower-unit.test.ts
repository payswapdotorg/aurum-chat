// Unit tests for the Management Control Tower's pure logic (W033) —
// no database, no contracts, no React: the context-resolution rules, the
// display helpers, the surface registry and the API request parsing /
// error mapping. The integration behavior (real contracts, real
// embedded Postgres, tenant isolation) is tower-integration.test.ts.

import { describe, expect, it } from 'vitest';
import { firstValue, withQuery } from '../lib/page-context';
import {
  SESSION_COOKIE_NAME,
  sessionTokenFromCookieHeader,
} from '@/app/lib/session-cookie';
import {
  formatConfidence,
  formatCount,
  formatDuration,
  formatInstant,
  formatMinorUnits,
  formatShare,
  joinList,
  priorityRank,
  titleCase,
  titleCaseKebab,
  truncate,
} from '../lib/format';
import { TOWER_SURFACES, isTowerSurface } from '../lib/surfaces';
import {
  parseDecideApprovalBody,
  towerApiError,
} from '../lib/api';

describe('tower page context (W058 — the session replaces the dev seam)', () => {
  it('withQuery preserves NON-scope parameters and applies overrides', () => {
    expect(withQuery({ status: 'archived', q: 'attention' })).toBe(
      '?status=archived&q=attention',
    );
    expect(withQuery({ status: 'archived' }, { status: null })).toBe('');
    expect(withQuery({})).toBe('');
  });

  it('firstValue takes the first of array parameters', () => {
    expect(firstValue(['a', 'b'])).toBe('a');
    expect(firstValue('solo')).toBe('solo');
    expect(firstValue(undefined)).toBeNull();
  });

  it('the tower reads its scope from the session cookie only', () => {
    // The seam module was REMOVED with W058: the tower resolves its
    // TenantContext from the session cookie (@/app/lib/page-session →
    // the auth contract), never from ?tenant=/x-aurum-tenant. This pins
    // the seam's absence so it cannot silently return.
    expect(sessionTokenFromCookieHeader(`${SESSION_COOKIE_NAME}=tok; x=1`)).toBe('tok');
    expect(sessionTokenFromCookieHeader('?tenant=globex')).toBeNull();
  });
});

describe('display helpers', () => {
  it('title-cases slugs from every convention', () => {
    expect(titleCase('manual_effort')).toBe('Manual Effort');
    expect(titleCase('approval_required')).toBe('Approval Required');
    expect(titleCase('langgraph')).toBe('Langgraph');
    expect(titleCaseKebab('risk-opportunity-capability-analysis')).toBe(
      'Risk Opportunity Capability Analysis',
    );
  });

  it('truncates with a single ellipsis character', () => {
    expect(truncate('abcdef', 6)).toBe('abcdef');
    expect(truncate('abcdef', 3)).toBe('ab…');
    expect(truncate('', 3)).toBe('');
  });

  it('formats instants in UTC without ambiguity', () => {
    expect(formatInstant('2026-09-14T09:15:00.000Z')).toBe('2026-09-14 09:15 UTC');
    expect(formatInstant('2026-12-31T23:59:59.999Z')).toBe('2026-12-31 23:59 UTC');
    expect(formatInstant('not-a-date')).toBe('not-a-date');
  });

  it('formats money from integer minor units', () => {
    expect(formatMinorUnits(12345, 'USD')).toBe('$123.45');
    expect(formatMinorUnits(0, 'EUR')).toBe('€0.00');
    expect(formatMinorUnits(120000, 'SEK')).toBe('SEK 1,200.00');
  });

  it('formats confidences, shares, counts and durations', () => {
    expect(formatConfidence(0.87)).toBe('87%');
    expect(formatShare(0.4249)).toBe('42%');
    expect(formatCount(200, true)).toBe('200+');
    expect(formatCount(12, false)).toBe('12');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(60 * 45)).toBe('45m');
    expect(formatDuration(60 * 60 * 3 + 60 * 12)).toBe('3h 12m');
    expect(formatDuration(60 * 60 * 25)).toBe('1d 1h');
  });

  it('bounds list joins with an overflow marker', () => {
    expect(joinList([], 2)).toBe('—');
    expect(joinList(['a', 'b'], 2)).toBe('a, b');
    expect(joinList(['a', 'b', 'c'], 2)).toBe('a, b, +1 more');
  });

  it('ranks priorities canonically with unknown values last', () => {
    expect(priorityRank('critical')).toBe(1);
    expect(priorityRank('low')).toBe(4);
    expect(priorityRank('mystery')).toBeGreaterThan(4);
  });
});

describe('the surface registry', () => {
  it('names all fifteen management surfaces exactly once', () => {
    expect(TOWER_SURFACES).toEqual([
      'today',
      'goals',
      'situation',
      'unknowns',
      'missions',
      'risks',
      'opportunities',
      'capabilities',
      'processes',
      'automation',
      'workforce',
      'agents',
      'evidence',
      'recommendations',
      'approvals',
    ]);
    expect(new Set(TOWER_SURFACES).size).toBe(TOWER_SURFACES.length);
  });

  it('guards surface names', () => {
    for (const surface of TOWER_SURFACES) expect(isTowerSurface(surface)).toBe(true);
    expect(isTowerSurface('')).toBe(false);
    expect(isTowerSurface('dashboards')).toBe(false);
    expect(isTowerSurface('approvals/decide')).toBe(false);
  });
});

describe('API request parsing and error mapping', () => {
  it('validates the decide body exactly', () => {
    expect(parseDecideApprovalBody(null).ok).toBe(false);
    expect(parseDecideApprovalBody('approve').ok).toBe(false);
    expect(parseDecideApprovalBody({ decision: 'maybe' }).ok).toBe(false);
    expect(parseDecideApprovalBody({ decision: 'approve', note: 5 }).ok).toBe(false);
    const good = parseDecideApprovalBody({ decision: 'reject' });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value).toEqual({ decision: 'reject', note: null });
    const withNote = parseDecideApprovalBody({ decision: 'approve', note: 'ok' });
    expect(withNote.ok).toBe(true);
    if (withNote.ok) expect(withNote.value.note).toBe('ok');
  });

  it('maps module error codes to HTTP-ish outcomes', () => {
    expect(towerApiError(codeError('forbidden', 'no')).status).toBe(403);
    expect(towerApiError(codeError('action_request_not_found', 'no')).status).toBe(404);
    expect(towerApiError(codeError('not_pending', 'no')).status).toBe(409);
    expect(towerApiError(codeError('invalid_context', 'no')).status).toBe(400);
    expect(towerApiError(codeError('contradiction_conflict', 'no')).status).toBe(400);
    expect(towerApiError(new Error('boom')).status).toBe(500);
    expect(towerApiError(undefined).status).toBe(500);
  });
});

function codeError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
