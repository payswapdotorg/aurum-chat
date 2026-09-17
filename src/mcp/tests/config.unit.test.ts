// Unit tests for the MCP server configuration parser (W039) — pure, no
// database. Covers the launch-binding contract: required env names, uuid
// shape, claim parsing (commas, blanks, duplicates, whitespace).

import { describe, expect, it } from 'vitest';
import {
  MCP_AUTHORITY_ENV,
  MCP_PRINCIPAL_ID_ENV,
  MCP_TENANT_ID_ENV,
  loadMcpServerConfig,
  parseAuthorityClaims,
} from '../config';

const TENANT = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const PRINCIPAL = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    [MCP_TENANT_ID_ENV]: TENANT,
    [MCP_PRINCIPAL_ID_ENV]: PRINCIPAL,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

describe('loadMcpServerConfig', () => {
  it('accepts the minimal valid configuration', () => {
    const result = loadMcpServerConfig(env());
    expect(result).toEqual({ ok: true, config: { tenantId: TENANT, principalId: PRINCIPAL, authority: [] } });
  });

  it('rejects a missing tenant id with the env name', () => {
    const result = loadMcpServerConfig({ [MCP_PRINCIPAL_ID_ENV]: PRINCIPAL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(MCP_TENANT_ID_ENV);
  });

  it('rejects a missing principal id with the env name', () => {
    const result = loadMcpServerConfig({ [MCP_TENANT_ID_ENV]: TENANT });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(MCP_PRINCIPAL_ID_ENV);
  });

  it('rejects a malformed tenant id', () => {
    const result = loadMcpServerConfig(env({ [MCP_TENANT_ID_ENV]: 'not-a-uuid' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must be a uuid');
  });

  it('rejects a malformed principal id', () => {
    const result = loadMcpServerConfig(env({ [MCP_PRINCIPAL_ID_ENV]: '123' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(MCP_PRINCIPAL_ID_ENV);
  });

  it('treats blank values as missing (empty .env-style entries are inert)', () => {
    const result = loadMcpServerConfig({ [MCP_TENANT_ID_ENV]: '  ', [MCP_PRINCIPAL_ID_ENV]: PRINCIPAL });
    expect(result.ok).toBe(false);
  });

  it('parses the authority claim grant', () => {
    const result = loadMcpServerConfig(env({ [MCP_AUTHORITY_ENV]: 'actions:approve, agents:administer' }));
    expect(result).toEqual({
      ok: true,
      config: {
        tenantId: TENANT,
        principalId: PRINCIPAL,
        authority: ['actions:approve', 'agents:administer'],
      },
    });
  });

  it('rejects authority claims containing whitespace', () => {
    const result = loadMcpServerConfig(env({ [MCP_AUTHORITY_ENV]: 'actions: approve' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(MCP_AUTHORITY_ENV);
  });
});

describe('parseAuthorityClaims', () => {
  it('drops blanks and duplicates, trims pieces', () => {
    expect(parseAuthorityClaims(' a , b ,,a,  ')).toEqual(['a', 'b']);
  });

  it('returns an empty grant for undefined or empty input', () => {
    expect(parseAuthorityClaims(undefined)).toEqual([]);
    expect(parseAuthorityClaims('')).toEqual([]);
    expect(parseAuthorityClaims('   ')).toEqual([]);
  });
});
