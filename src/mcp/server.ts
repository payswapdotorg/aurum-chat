// ============================================================================
// mcp/server — the MCP server entrypoint (W039).
//
// IMPLEMENTATION-STACK §5: "MCP (W039): src/mcp/server.ts with
// @modelcontextprotocol/sdk (stdio) calling module contracts only."
//
// This is the low-level protocol adapter ONLY: it speaks JSON-RPC/MCP,
// maps protocol requests onto registry.runTool, and serializes results.
// All substance (policy, audit, tenant scoping, capability shape) lives
// in the registry and the tool definitions; this file adds no domain
// logic and opens no database tables of its own.
//
// Launch (after `bun run migrate`):
//   AURUM_MCP_TENANT_ID=<uuid> AURUM_MCP_PRINCIPAL_ID=<uuid> \
//   [AURUM_MCP_AUTHORITY='actions:approve'] \
//   bun run mcp
//
// Startup is fail-closed: the configured principal must be verifiably a
// member of the configured tenant (organizations contract) before the
// transport starts serving. Migrations are NOT auto-applied here —
// schema changes run through the migration runner only (§3).
//
// console.log is RESERVED for the protocol (stdio transport writes
// JSON-RPC frames to stdout); all operator logging goes to stderr.
// ============================================================================

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { loadMcpServerConfig } from './config';
import { buildMcpTenantContext, verifyMcpPrincipal } from './context';
import { AURUM_MCP_TOOLS, findTool, runTool } from './registry';

const SERVER_NAME = 'aurum-mcp';
const SERVER_VERSION = '1.0.0';
const SERVER_INSTRUCTIONS =
  'Aurum organizational intelligence surface: query goals, unknowns, beliefs, claims, evidence, ' +
  'missions, agents and approval workflows; propose investigations and consequential actions ' +
  'through the tenant approval gates. Every call is tenant-scoped, policy-checked and audited; ' +
  'there are no raw database tools.';

/** Protocol metadata for one registered tool. */
export function toolDescriptor(tool: (typeof AURUM_MCP_TOOLS)[number]): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

/**
 * Create the Aurum MCP server for one tenant principal. Verifies the
 * principal's membership first (fail-closed), then wires the protocol
 * handlers onto the registry.
 */
export async function createAurumMcpServer(ctx: TenantContext): Promise<Server> {
  await verifyMcpPrincipal(ctx);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: AURUM_MCP_TOOLS.map(toolDescriptor),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const name = request.params.name;
      const tool = findTool(name);
      if (tool === undefined) {
        const result: CallToolResult = {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                tool: name,
                error: {
                  code: 'invalid_arguments',
                  message: `unknown tool '${String(name)}' — call tools/list for the capability surface`,
                },
              }),
            },
          ],
        };
        return result;
      }

      const outcome = await runTool(tool, ctx, request.params.arguments);
      const text = JSON.stringify(outcome);
      const result: CallToolResult = {
        isError: outcome.ok === false,
        content: [{ type: 'text', text }],
      };
      return result;
    },
  );

  return server;
}

/** Entry point: read launch configuration, serve stdio until close. */
async function main(): Promise<void> {
  const loaded = loadMcpServerConfig(process.env);
  if (!loaded.ok) {
    process.stderr.write(`aurum-mcp: ${loaded.error}\n`);
    process.exitCode = 1;
    return;
  }
  const ctx = buildMcpTenantContext(loaded.config);
  try {
    const server = await createAurumMcpServer(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(
      `aurum-mcp: serving tenant ${ctx.tenantId} for principal ${ctx.principalId} ` +
        `(claims: ${ctx.authority.length === 0 ? 'none' : ctx.authority.join(',')})\n`,
    );
    await new Promise<void>((resolve) => {
      server.onclose = () => resolve();
    });
  } finally {
    // The embedded database handle keeps the event loop alive — closing
    // it lets a fail-closed startup actually exit (migrate.ts precedent),
    // and flushes the file-backed database on normal shutdown.
    await closeDb().catch(() => undefined);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `aurum-mcp: fatal — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
