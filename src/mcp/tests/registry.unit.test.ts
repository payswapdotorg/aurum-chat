// Unit tests for the MCP registry surface (W039) — pure metadata and
// mapping logic, no database, no transport. Pins:
//   * the exact capability surface (tool names — no raw database tools,
//     no SQL-shaped operations);
//   * per-tool policy metadata (every tool declares a policy class; read
//     tools carry the read matrix kind; gated tools declare their flow);
//   * JSON Schema sanity for every tool (object type, properties, required
//     subset of properties);
//   * the domain-error mapping convention (not_found / forbidden /
//     domain_error with the module code preserved; unknowns collapse to
//     upstream_error without leaking internals).

import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors';
import { AURUM_MCP_TOOLS, findTool } from '../registry';
import { MCP_READ_ACTION_KIND } from '../policy';

describe('the MCP capability surface (pinned)', () => {
  it('exposes exactly the declared tools — all capabilities, no raw database tools', () => {
    expect(AURUM_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      // goals (§23 "inspecting goals")
      'list_goals',
      'get_goal',
      // epistemics (§23 "querying company knowledge", "unknowns", findings)
      'list_unknowns',
      'list_beliefs',
      'list_claims',
      'get_belief',
      // observations (§23 "retrieving evidence")
      'list_observations',
      'get_observation',
      // missions (§23 "inspecting ... missions", "requesting investigation")
      'list_missions',
      'get_mission',
      'request_investigation',
      // agents (§23 "inspecting agents")
      'list_agents',
      'list_agent_executions',
      // approval workflows (§23 "proposing agent recruitment",
      // "interacting with approval workflows")
      'list_action_requests',
      'get_action_request',
      'propose_action',
      'decide_approval',
    ]);
  });

  it('has unique tool names', () => {
    const names = AURUM_MCP_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('findTool resolves names and nothing else', () => {
    expect(findTool('list_goals')?.name).toBe('list_goals');
    expect(findTool('drop_table')).toBeUndefined();
    expect(findTool('query')).toBeUndefined();
    expect(findTool('')).toBeUndefined();
  });

  it('no tool name, title or description advertises persistence operations', () => {
    // Word boundaries: 'immutable' must never trip a naive 'table' search.
    const bannedPatterns: RegExp[] = [
      /\bsql\b/i,
      /\bselect\b/i,
      /\binsert\b/i,
      /\bupdate\b/i,
      /\bdelete\b/i,
      /\btruncate\b/i,
      /\btable\b/i,
      /\bdatabase\b/i,
      /\bmigration\b/i,
    ];
    for (const tool of AURUM_MCP_TOOLS) {
      const surface = `${tool.name} ${tool.title} ${tool.description}`;
      for (const pattern of bannedPatterns) {
        expect(surface, `tool '${tool.name}' surfaces persistence language`).not.toMatch(pattern);
      }
    }
  });
});

describe('per-tool policy metadata (policy checks are structural)', () => {
  it('every read tool is evaluated under the shared read matrix kind at OBSERVE', () => {
    for (const tool of AURUM_MCP_TOOLS) {
      if (tool.annotations.readOnlyHint === true) {
        expect(tool.policy).toEqual({ kind: 'read' });
      }
    }
    expect(AURUM_MCP_TOOLS.filter((tool) => tool.policy.kind === 'read').length).toBeGreaterThan(0);
  });

  it('every gated tool fixes its action kind or normalizes one from arguments', () => {
    const gated = AURUM_MCP_TOOLS.filter((tool) => tool.policy.kind === 'gate');
    // request_investigation fixes its kind; propose_action takes the
    // caller's canonical kind.
    expect(gated.map((tool) => tool.name).sort()).toEqual(['propose_action', 'request_investigation']);
    expect(findTool('request_investigation')?.policy).toEqual({
      kind: 'gate',
      actionKind: 'mcp.request-investigation',
    });
    expect(findTool('propose_action')?.policy).toEqual({ kind: 'gate' });
  });

  it('every tool declares a known policy class', () => {
    for (const tool of AURUM_MCP_TOOLS) {
      expect(['read', 'gate', 'claim']).toContain(tool.policy.kind);
    }
  });

  it('read matrix kind is namespaced to this surface', () => {
    expect(MCP_READ_ACTION_KIND).toBe('mcp.read');
  });
});

describe('input schemas are structurally sound', () => {
  it('every tool has an object schema with known properties', () => {
    for (const tool of AURUM_MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties).length).toBeGreaterThan(0);
      for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
        expect(typeof property).toBe('object');
        expect(property).not.toBeNull();
        expect((property as Record<string, unknown>).type).toBeDefined();
        void name;
      }
    }
  });

  it('required fields exist in properties', () => {
    for (const tool of AURUM_MCP_TOOLS) {
      const required = tool.inputSchema.required ?? [];
      for (const field of required) {
        expect(tool.inputSchema.properties[field]).toBeDefined();
      }
    }
  });
});

describe('error mapping (the module error convention)', () => {
  class GoalsErrorLike extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  it("maps '*_not_found' codes to not_found (uniform, no existence leaks)", async () => {
    const { errorEnvelope } = await import('../registry');
    const envelope = errorEnvelope(new GoalsErrorLike('goal_not_found', 'no goal'));
    expect(envelope.code).toBe('not_found');
    expect(envelope.details).toEqual({ domainCode: 'goal_not_found' });
    expect(envelope.message).toBe('no goal');
  });

  it("maps 'forbidden' to forbidden (claim gates)", async () => {
    const { errorEnvelope } = await import('../registry');
    const envelope = errorEnvelope(new GoalsErrorLike('forbidden', 'claim required'));
    expect(envelope.code).toBe('forbidden');
  });

  it('maps other coded module errors to domain_error preserving the module code', async () => {
    const { errorEnvelope } = await import('../registry');
    const envelope = errorEnvelope(new GoalsErrorLike('goal_conflict', 'raced'));
    expect(envelope.code).toBe('domain_error');
    expect(envelope.details).toEqual({ domainCode: 'goal_conflict' });
  });

  it('maps McpToolError directly', async () => {
    const { errorEnvelope } = await import('../registry');
    const envelope = errorEnvelope(
      new McpToolError('invalid_arguments', 'bad args', { field: 'limit' }),
    );
    expect(envelope.code).toBe('invalid_arguments');
    expect(envelope.details).toEqual({ field: 'limit' });
  });

  it('collapses unknown failures to upstream_error with a generic message', async () => {
    const { errorEnvelope } = await import('../registry');
    const envelope = errorEnvelope(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(envelope.code).toBe('upstream_error');
    expect(envelope.message).not.toContain('ECONNREFUSED');
    expect(Object.keys(envelope.details ?? {})).toEqual([]);
  });
});
