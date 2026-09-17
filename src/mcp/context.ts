// ============================================================================
// mcp — tenant/principal context establishment (W039).
//
// GOVERNANCE.md mandatory security invariant: "every API/MCP operation
// carries tenant and principal context". IMPLEMENTATION-STACK §8: tenant
// context is an EXPLICIT TenantContext argument on contract calls — no
// ambient global. The MCP layer therefore does exactly two things:
//
//   1. buildMcpTenantContext — translate the launch configuration
//      (config.ts) into the canonical TenantContext that is then passed
//      EXPLICITLY as the first argument of every module-contract call.
//      The context is captured per server instance, not in a global.
//   2. verifyMcpPrincipal — prove, through the organizations contract
//      (W001), that the configured tenant exists AND the configured
//      principal is a member of it. `getTenant` resolves tenant scope
//      including membership (the organizations module's own
//      requireTenantScope), so a wrong tenant/principal pairing fails
//      closed BEFORE any tool is served: an MCP server for a principal
//      that is not in the tenant must not answer a single query.
//
// Authority claims come from launch configuration (an operator grants a
// principal's MCP binding its claims); role membership and tenant scope
// come from the organizations module. Modules gate claim-required
// operations themselves (actions: actions:administer / actions:approve;
// agents: agents:administer) — the MCP layer never re-implements an
// authorization rule it does not own.
// ============================================================================

import type { TenantContext } from '@/infra/tenant';
import { getTenant } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import { McpToolError } from './errors';
import type { McpServerConfig } from './config';

/**
 * The explicit TenantContext every tool call of this server passes to
 * module contracts (tenant + principal + granted authority claims).
 */
export function buildMcpTenantContext(config: McpServerConfig): TenantContext {
  return {
    tenantId: config.tenantId,
    principalId: config.principalId,
    authority: [...config.authority],
  };
}

/**
 * Verify the configured principal is a member of the configured tenant,
 * through the organizations contract. Throws McpToolError('invalid_config')
 * otherwise — the server must fail closed at startup.
 */
export async function verifyMcpPrincipal(ctx: TenantContext): Promise<Tenant> {
  try {
    return await getTenant(ctx);
  } catch {
    // The organizations module reports a missing tenant, a non-member
    // principal and a foreign tenant uniformly as tenant_not_found
    // (ADR-0001 — no existence leaks). One mapped error covers all three.
    throw new McpToolError(
      'invalid_config',
      'the configured principal is not a member of the configured tenant — refusing to serve MCP requests',
      { tenantId: ctx.tenantId },
    );
  }
}
