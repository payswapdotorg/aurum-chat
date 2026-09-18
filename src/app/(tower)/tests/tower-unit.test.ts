// Unit tests for the Management Control Tower's pure logic (W033) —
// no database, no contracts, no React: the context-resolution rules, the
// display helpers, the surface registry and the API request parsing /
// error mapping. The integration behavior (real contracts, real
// embedded Postgres, tenant isolation) is tower-integration.test.ts.

import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_HEADER,
  TOWER_OPERATOR_PRINCIPAL,
  resolveTowerContext,
  towerContextFromHeaders,
  towerContextFromSearchParams,
} from '../lib/tower-context';
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

const TENANT = '0f0c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';
const TENANT_UPPER = '0F0C1D2E-3B4A-4C5D-8E9F-0A1B2C3D4E5F';
const PRINCIPAL = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('tower context resolution (the documented dev seam)', () => {
  it('fails honestly without a tenant', () => {
    const result = resolveTowerContext({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('missing_tenant');
    expect(result.detail).toContain(AUTHORITY_HEADER === 'x-aurum-authority' ? 'tenant' : '');
  });

  it('rejects non-uuid tenants and principals', () => {
    const badTenant = resolveTowerContext({ tenant: 'acme' });
    expect(badTenant.ok).toBe(false);
    if (badTenant.ok) return;
    expect(badTenant.failure).toBe('invalid_tenant');

    const badPrincipal = resolveTowerContext({ tenant: TENANT, principal: 'me' });
    expect(badPrincipal.ok).toBe(false);
    if (badPrincipal.ok) return;
    expect(badPrincipal.failure).toBe('invalid_principal');
  });

  it('defaults to the well-known tower operator principal when none is given', () => {
    const result = resolveTowerContext({ tenant: TENANT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.tenantId).toBe(TENANT);
    expect(result.context.principalId).toBe(TOWER_OPERATOR_PRINCIPAL);
    expect(result.principalExplicit).toBe(false);
    expect(result.context.authority).toEqual([]);
  });

  it('normalizes uuids to lowercase and parses comma-separated authority claims', () => {
    const result = resolveTowerContext({
      tenant: TENANT_UPPER,
      principal: PRINCIPAL.toUpperCase(),
      authority: 'actions:approve, agents:administer ,, actions:approve',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.tenantId).toBe(TENANT);
    expect(result.context.principalId).toBe(PRINCIPAL);
    expect(result.principalExplicit).toBe(true);
    expect(result.context.authority).toEqual(['actions:approve', 'agents:administer']);
  });

  it('adapts page search params (first value of arrays wins)', () => {
    const result = towerContextFromSearchParams({
      tenant: [TENANT, 'ignored'],
      principal: PRINCIPAL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.tenantId).toBe(TENANT);
    expect(result.context.principalId).toBe(PRINCIPAL);
  });

  it('adapts fetch headers (case-insensitive)', () => {
    const headers = new Headers();
    headers.set('X-Aurum-Tenant', TENANT);
    headers.set('x-aurum-principal', PRINCIPAL);
    const result = towerContextFromHeaders(headers);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.tenantId).toBe(TENANT);
    expect(result.context.principalId).toBe(PRINCIPAL);
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
