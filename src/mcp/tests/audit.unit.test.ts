// Unit tests for the audit event payload assembly (W039) — pure, no
// database. The payload is the reconstructable record of WHAT was asked,
// WHICH policy decided and WHAT happened (ARCHITECTURE.md §24).

import { describe, expect, it } from 'vitest';
import {
  MCP_AUDIT_EVENT_TYPE,
  MCP_AUDIT_EVENT_TYPE_VERSION,
  MCP_EVENT_SOURCE,
  buildToolInvocationPayload,
} from '../audit';

describe('buildToolInvocationPayload', () => {
  it('assembles the executed shape with the policy snapshot and summary', () => {
    const payload = buildToolInvocationPayload({
      tool: 'list_goals',
      outcome: 'executed',
      args: { status: 'active' },
      policy: {
        actionKind: 'mcp.read',
        authorityLevel: 'OBSERVE',
        outcome: 'allowed',
        resolvedVia: 'built-in',
      },
      resultSummary: { count: 2 },
    });
    expect(payload).toEqual({
      tool: 'list_goals',
      outcome: 'executed',
      args: { status: 'active' },
      policy: {
        actionKind: 'mcp.read',
        authorityLevel: 'OBSERVE',
        outcome: 'allowed',
        resolvedVia: 'built-in',
      },
      requestId: null,
      error: null,
      resultSummary: { count: 2 },
    });
  });

  it('collapses absent fragments to null and stays JSON-serializable', () => {
    const payload = buildToolInvocationPayload({
      tool: 'request_investigation',
      outcome: 'approval_required',
      args: { title: 'x' },
    });
    expect(payload).toEqual({
      tool: 'request_investigation',
      outcome: 'approval_required',
      args: { title: 'x' },
      policy: null,
      requestId: null,
      error: null,
      resultSummary: null,
    });
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it('records the denial error fragment', () => {
    const payload = buildToolInvocationPayload({
      tool: 'list_goals',
      outcome: 'denied_by_policy',
      args: {},
      error: { code: 'policy_denied', message: 'matrix outcome forbidden' },
    });
    expect(payload.error).toEqual({ code: 'policy_denied', message: 'matrix outcome forbidden' });
    expect(payload.outcome).toBe('denied_by_policy');
  });
});

describe('audit event identity', () => {
  it('uses the namespaced event type and versioned payload contract', () => {
    expect(MCP_AUDIT_EVENT_TYPE).toBe('mcp.tool_invoked');
    expect(MCP_AUDIT_EVENT_TYPE_VERSION).toBe(1);
  });

  it('provenance source marks the MCP delivery surface', () => {
    expect(MCP_EVENT_SOURCE).toEqual({ kind: 'api', label: 'mcp' });
  });
});
