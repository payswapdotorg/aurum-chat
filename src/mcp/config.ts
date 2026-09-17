// ============================================================================
// mcp — server principal configuration (W039).
//
// "Capability-oriented MCP server with tenant/principal context" (work
// item): an MCP server instance is launched FOR ONE tenant principal.
// The binding is explicit environment configuration supplied by the
// operator that hosts the stdio process — the same discipline the db
// port applies (src/infra/config.ts: configuration is read through
// function calls, never ambiently at import time).
//
//   AURUM_MCP_TENANT_ID    — uuid of the tenant every tool call is scoped
//                             to (ADR-0001: tenant identity is mandatory).
//   AURUM_MCP_PRINCIPAL_ID — uuid of the authenticated principal acting
//                             through this server (the events/actions
//                             precedent: opaque principal ids owned by the
//                             future auth module).
//   AURUM_MCP_AUTHORITY    — optional comma-separated authority claims
//                             granted to this principal (e.g.
//                             'actions:approve'). Claims are capability
//                             grants, NOT role membership — modules gate
//                             their own claim-required operations on them.
//
// Deliberately NO database access here: parsing is pure and unit-tested;
// membership of the configured principal in the configured tenant is
// verified against the organizations contract at server startup
// (context.ts), not at parse time.
// ============================================================================

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Environment names recognized by the MCP server. */
export const MCP_TENANT_ID_ENV = 'AURUM_MCP_TENANT_ID';
export const MCP_PRINCIPAL_ID_ENV = 'AURUM_MCP_PRINCIPAL_ID';
export const MCP_AUTHORITY_ENV = 'AURUM_MCP_AUTHORITY';

/** The tenant/principal binding one MCP server process serves. */
export interface McpServerConfig {
  tenantId: string;
  principalId: string;
  /** Authority claims granted to this principal (may be empty). */
  authority: string[];
}

export type McpConfigResult =
  | { ok: true; config: McpServerConfig }
  | { ok: false; error: string };

/** Raw env value, normalized: undefined when missing or blank. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parse authority claims: comma-separated, trimmed, empty entries and
 * duplicates dropped. A claim is any non-empty token without commas
 * (the existing claim vocabulary: 'actions:approve', kind-scoped
 * 'actions:approve:<kind>', 'agents:administer', ...).
 */
export function parseAuthorityClaims(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const claims: string[] = [];
  for (const piece of raw.split(',')) {
    const claim = piece.trim();
    if (claim !== '' && !claims.includes(claim)) claims.push(claim);
  }
  return claims;
}

/**
 * Load the server principal configuration from an environment map.
 * Pure: no process.env access, no IO — tests inject the map. Returns a
 * single error message naming every problem (operators fix config in
 * one round-trip).
 */
export function loadMcpServerConfig(env: Record<string, string | undefined>): McpConfigResult {
  const problems: string[] = [];

  const tenantId = envValue(env, MCP_TENANT_ID_ENV);
  if (tenantId === undefined) {
    problems.push(`${MCP_TENANT_ID_ENV} is required (the tenant every tool call is scoped to)`);
  } else if (!UUID_PATTERN.test(tenantId)) {
    problems.push(`${MCP_TENANT_ID_ENV} must be a uuid (got '${tenantId}')`);
  }

  const principalId = envValue(env, MCP_PRINCIPAL_ID_ENV);
  if (principalId === undefined) {
    problems.push(
      `${MCP_PRINCIPAL_ID_ENV} is required (the authenticated principal acting through this server)`,
    );
  } else if (!UUID_PATTERN.test(principalId)) {
    problems.push(`${MCP_PRINCIPAL_ID_ENV} must be a uuid (got '${principalId}')`);
  }

  if (problems.length > 0) {
    return { ok: false, error: `invalid MCP server configuration: ${problems.join('; ')}` };
  }

  const authorityRaw = envValue(env, MCP_AUTHORITY_ENV);
  const authority = parseAuthorityClaims(authorityRaw);
  for (const claim of authority) {
    if (/\s/.test(claim)) {
      return {
        ok: false,
        error: `invalid MCP server configuration: ${MCP_AUTHORITY_ENV} claims must not contain whitespace (got '${claim}')`,
      };
    }
  }

  return {
    ok: true,
    config: { tenantId: tenantId!, principalId: principalId!, authority },
  };
}
