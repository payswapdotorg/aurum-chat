// W044 — Tenant Isolation Verification: shared harness.
//
// This file defines the probe protocol every information-bearing module is
// verified against (WORK-ITEM-CATALOG.md W044: "Automated authorization and
// integration tests proving every information-bearing module is
// tenant-safe"), plus the helpers the probes and the runner share:
//
//   * the probe protocol (ModuleProbe/ModuleScene + read/list/write/check
//     attempts) — a uniform, module-independent statement of ADR-0001:
//       - reads:  a record of another tenant is indistinguishable from a
//                 missing one (uniform not-found) while the owning tenant
//                 still resolves it;
//       - lists:  the owning tenant sees its records, the other tenant sees
//                 none of them (and still sees its own);
//       - writes: referencing another tenant's records fails exactly like
//                 referencing missing ones, leaves storage untouched and
//                 the target tenant's data intact;
//       - every contract call validates its TenantContext before any data
//                 access (`invalid_context`);
//       - module-specific invariants (same natural key in two tenants,
//         policy/vocabulary isolation, …) run as named checks.
//   * context factories matching the sibling module tests' conventions;
//   * the storage-sweep helpers (tenant-scoped table discovery, per-tenant
//     row counting) used by the repository-boundary proof;
//   * the process-wide fake transports for the channels/llm provider seams
//     (installed once by tests/tenant-isolation.test.ts, exactly like the
//     sibling module tests install theirs).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { recordObservation } from '@/modules/observations/contract';
import type {
  CanonicalDeliveryRequest,
  ChannelTransport,
  TransportReceipt,
} from '@/modules/channels/contract';
import type {
  LlmTransport,
  LlmTransportReceipt,
  LlmTransportRequest,
} from '@/modules/llm/contract';

// ---------------------------------------------------------------------------
// Probe protocol
// ---------------------------------------------------------------------------

/** A read of one record by id: must reject with `code` for foreign/missing ids. */
export interface ReadAttempt {
  name: string;
  /** Typed error code expected for another tenant's id AND for a missing id (uniform not-found). */
  code: string;
  /**
   * Must read ids out of the map DYNAMICALLY (never capture values at setup
   * time): the runner substitutes fresh uuids for the missing-id pass.
   */
  run: (ctx: TenantContext, ids: Record<string, string>) => Promise<unknown>;
}

/** A resolving list: the owning tenant sees its records; the other tenant never does. */
export interface ListAttempt {
  name: string;
  run: (ctx: TenantContext, ids: Record<string, string>) => Promise<unknown[]>;
}

/** A write referencing another tenant's records: must reject with `code`, no side effects. */
export interface WriteAttempt {
  name: string;
  code: string;
  run: (ctx: TenantContext, ids: Record<string, string>) => Promise<unknown>;
}

/** A module-specific invariant proven on top of the seeded scene. */
export interface CheckAttempt {
  name: string;
  run: () => Promise<void>;
}

/** Everything the uniform runner needs to prove one module tenant-safe. */
export interface ModuleScene {
  module: string;
  /** Acting contexts; every seeded record of `ids` belongs to ctxA's tenant. */
  ctxA: TenantContext;
  ctxB: TenantContext;
  /** Tenant A's seeded record ids — the foreign targets tenant B probes. */
  ids: Record<string, string>;
  /** Tenant B's seeded record ids (mirror of `ids`) — tenant B's positive controls. */
  idsB: Record<string, string>;
  /** Keys of the id maps holding opaque uuids (substituted on the missing-id pass). */
  idKeys: string[];
  /** One representative ctx-consuming operation; a malformed context must yield `invalid_context`. */
  contextProbe: (ctx: TenantContext) => Promise<unknown>;
  reads: ReadAttempt[];
  lists: ListAttempt[];
  writes: WriteAttempt[];
  checks: CheckAttempt[];
}

/** One information-bearing module's tenant-isolation probe. */
export interface ModuleProbe {
  module: string;
  /** Seeds both tenants through the PUBLIC CONTRACTS ONLY and returns the scene. */
  setup: () => Promise<ModuleScene>;
}

// ---------------------------------------------------------------------------
// Context factories (sibling module tests' conventions)
// ---------------------------------------------------------------------------

export function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

/** The fixed instant the W044 fixtures observe/record at (strict ISO 8601). */
export const W044_T0 = '2026-09-14T09:15:00.000Z';

/** W044_T0 plus `seconds`, as a strict ISO 8601 instant. */
export function t0Plus(seconds: number): string {
  return new Date(Date.parse(W044_T0) + seconds * 1_000).toISOString();
}

/** Records one tenant-visible observation (the evidence anchor several probes cite). */
export async function seedEvidence(ctx: TenantContext, note: string): Promise<string> {
  const recorded = await recordObservation(ctx, {
    kind: 'channel.message',
    payload: { text: `w044 evidence: ${note}` },
    observedAt: W044_T0,
    source: { kind: 'person', label: 'w044-probe' },
    channel: 'whatsapp',
    confidence: { value: 0.9, method: 'source_trust', basis: 'w044 harness' },
  });
  return recorded.id;
}

// ---------------------------------------------------------------------------
// Storage sweep (repository boundary)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES_DIR = path.join(REPO_ROOT, 'src', 'modules');

/** Every module that owns migrations — the information-bearing module set. */
export function discoverInformationModules(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(path.join(MODULES_DIR, entry.name, 'migrations')))
    .map((entry) => entry.name)
    .sort();
}

const CREATE_TABLE_RE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi;

let tenantTableCache: Set<string> | null = null;

/** All base tables carrying a tenant_id column (the tenant-scoped tables). */
export async function tenantScopedTables(): Promise<Set<string>> {
  if (tenantTableCache !== null) return tenantTableCache;
  const tables = (
    await getDb().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )
  ).rows.map((row) => row.table_name);
  const withTenant = new Set(
    (
      await getDb().query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
      )
    ).rows.map((row) => row.table_name),
  );
  tenantTableCache = new Set(tables.filter((table) => withTenant.has(table)));
  return tenantTableCache;
}

/** The tenant-scoped tables created by one module's migrations. */
export async function moduleTables(module: string): Promise<string[]> {
  const migrationsDir = path.join(MODULES_DIR, module, 'migrations');
  const owned = new Set<string>();
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const match of sql.matchAll(CREATE_TABLE_RE)) {
      owned.add(match[1]!.toLowerCase());
    }
  }
  const scoped = await tenantScopedTables();
  return [...owned].filter((table) => scoped.has(table)).sort();
}

/** Per-tenant row counts of the given tables (missing key = 0 rows). */
export async function tenantCounts(
  tables: string[],
  tenants: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of tables) {
    const grouped = await getDb().query<{ tenant_id: string; n: string }>(
      `SELECT tenant_id, count(*)::text AS n FROM "${table}"
         WHERE tenant_id = ANY($1::uuid[]) GROUP BY tenant_id`,
      [tenants],
    );
    for (const row of grouped.rows) counts.set(`${table}|${row.tenant_id}`, Number(row.n));
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Provider-seam fakes (channels + llm), mirroring the sibling module tests
// ---------------------------------------------------------------------------

let deliveryCounter = 0;

/** Provider-neutral channel transport: accepts every delivery with unique provider ids. */
export const w044ChannelTransport: ChannelTransport = {
  async deliver(_request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    deliveryCounter += 1;
    return {
      status: 'delivered',
      providerMessageId: `w044-out-${String(deliveryCounter).padStart(6, '0')}`,
      detail: null,
    };
  },
};

let llmExecutionCounter = 0;

/** OpenAI-dialect LLM transport (parsed by the llm module's openai adapter). */
export const w044LlmTransport: LlmTransport = {
  async send(request: LlmTransportRequest): Promise<LlmTransportReceipt> {
    llmExecutionCounter += 1;
    const executionId = `w044-llm-${String(llmExecutionCounter).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload:
        request.kind === 'completion'
          ? {
              id: `chat_${executionId}`,
              choices: [{ message: { content: 'w044 canonical answer.' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }
          : {
              id: `emb_${executionId}`,
              data: [{ embedding: [0.25, 0.5, 0.75] }],
              usage: { prompt_tokens: 10 },
            },
      providerExecutionId: executionId,
      detail: null,
    };
  },
};
