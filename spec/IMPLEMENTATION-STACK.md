# Aurum Implementation Stack (Architect Addendum v1)

Status: ACCEPTED · Lock: 2.1 · Scope: binds all work items W000–W056.
This addendum materializes the frozen architecture; it does not change it. Where prose here appears to conflict with ARCHITECTURE.md / ARCHITECTURE-LOCK.md, the frozen architecture wins and the conflict must be escalated per GOVERNANCE.md.

## 1. Runtime and language

- TypeScript 5 (strict) on Node.js/Bun. One package (modular monolith), Bun as package manager and script runner.
- PostgreSQL is domain truth (lock 35). SQL migrations are the schema's source of record.

## 2. Repository layout

```
package.json  tsconfig.json  vitest.config.ts  eslint.config.js  next.config.ts
scripts/
  migrate.ts            # applies all module migrations in dependency order
  check-architecture.ts # module-boundary + tenant-scoping + provider-isolation checks
  worker.ts             # long-running cognition/investigation job runner (W013+)
  dev-db.ts             # boots the embedded postgres (PGlite) for dev
src/
  infra/                # db, queue, cache, lock, clock, ids, config — NO domain concepts
  modules/<module>/     # domain module: contract.ts + internals + migrations/ + tests
  app/                  # Next.js App Router only (API routes + Control Tower UI)
  mcp/                  # MCP server entrypoint (W039)
```

- `src/modules/<m>/contract.ts` is the ONLY public surface of a module. Cross-module imports of internals are forbidden and detected by `scripts/check-architecture.ts`.
- Domain modules must not import `next/*`, `react`, or any UI framework.
- Each module owns its tables: SQL migrations live in `src/modules/<m>/migrations/NNN-*.sql`, applied in module-dependency order then filename order; applied migrations are recorded in the `_migrations` table (idempotent).

## 3. Database port (PostgreSQL, two runtimes)

`src/infra/db.ts` exposes one typed query surface over parameterized SQL:

- `AURUM_DB=embedded` (default; dev + test): **PGlite** — real PostgreSQL 16 compiled to WASM, file-backed (`.data/`) or `:memory:` per test. Same SQL dialect as server Postgres.
- `DATABASE_URL` set (staging/production): **node-postgres Pool** against a real PostgreSQL server.

Rules: one SQL code path (no dialect forks); core PostgreSQL features only (no server-extension SQL beyond `gen_random_uuid()`); every domain table carries `tenant_id` (except the platform allow-list in `scripts/arch-allowlist.json`); schema changes only via module migrations (no runtime DDL outside migration runner).

## 4. Redis port (queues/cache/locks ONLY — never domain truth, lock 35)

`src/infra/{queue,cache,lock}.ts` define small ports with two backends: `redis` (ioredis when `REDIS_URL` is set) and `memory` (default dev/test). Because Redis holds no domain truth, the memory backend is architecturally legal. Domain modules consume the ports; they never import ioredis directly (enforced).

## 5. HTTP, UI, workers, MCP

- Public API (W038): Next.js App Router route handlers under `src/app/api/v1/**` — thin adapters that authenticate, scope tenant, delegate to module contracts, audit. No raw persistence (lock 31).
- Control Tower (W033): `src/app/(tower)/**` React pages reading only module contracts via route handlers/server code.
- Long-running cognition (W013+): `scripts/worker.ts` process consuming `infra/queue` jobs; jobs are resumable, traceable execution records (lock 36).
- MCP (W039): `src/mcp/server.ts` with `@modelcontextprotocol/sdk` (stdio) calling module contracts only.

## 6. Provider isolation (locks 24, 28, 30)

Provider SDKs (LLM, channel, source, destination, agent-runtime) may be imported ONLY inside the owning gateway module's adapter subfolder (`src/modules/llm/`, `src/modules/agents/`, `src/modules/channels/`, `src/modules/sources/`, `src/modules/destinations/`). `check-architecture.ts` enforces the allow-list. Adapters normalize to provider-neutral contracts; provider objects never cross their gateway.

## 7. Testing doctrine

- vitest. Per module: unit tests (pure logic, no DB) and integration tests (embedded Postgres via the db port; isolated `:memory:` or file-per-test database).
- Cross-cutting fixtures live in `tests/` at repo root (tenant isolation sweeps W044, end-to-end W049/W050, longitudinal benchmark W056).
- Gates (run by every worker, re-run by the Tech Lead; prose is not evidence — GOVERNANCE.md):
  1. `bun run typecheck` (tsc --noEmit)
  2. `bun run test` (vitest run)
  3. `bun run arch` (check-architecture)
  4. `bun run lint` (eslint)

## 8. Conventions

- IDs: `uuid` primary keys (`gen_random_uuid()`); correlation/causation ids on event envelope (W003).
- Time: `timestamptz`; app code reads clock via `src/infra/clock.ts` (test-controllable).
- Money/quantities: integer minor units + ISO currency code.
- Enums: TEXT + CHECK constraints (PGlite-compatible), mirrored TS union types in contracts.
- Secrets/credentials: never in domain tables beyond opaque references; never in chat transcripts or reports.
- Tenant context: every contract call takes an explicit `TenantContext` (tenant id + principal + authority claims); no ambient global.

## 9. Delivery protocol (workers)

1. Clone `https://github.com/payswapdotorg/aurum-chat.git` at the SHA given in your brief; create branch `work/W<NNN>-<slug>`.
2. Implement ONLY your work item scope; read the cited spec files first; verify declared dependencies exist in code before building on them.
3. Add unit + integration tests; run all four gates; fix until green.
4. Commit with message `W<NNN>: <summary>`; push the branch using the push URL provided in your brief (credentials embedded; NEVER print, commit or echo the token).
5. Post the final report in the EXACT format your brief mandates. Do not attach file cards; the branch is the delivery.

## 10. Module map (frozen; W000 scaffolds it)

auth, organizations (tenants/workspaces), identity, people, world, events, observations, sources, destinations, memory, epistemics, freshness, goals, attention, investigation, missions, knowledge-acquisition, cognition, environment, opportunities, presence, processes, capabilities, automation, workforce, suppliers, actions, agents, extensions, marketplace, learning, rewards, conversations, channels, notifications, briefings, llm, audit, api, mcp — per ARCHITECTURE.md §26. Workers create a module folder only when their work item owns it.

## Post-S002 implementation addendum

This addendum does not change frozen Architecture v2.1. It operationalizes the post-S002 handoff.

### Persistent organizational actor
Aurum's identity and state remain application-owned. Durable workflow execution is accessed through an application-owned workflow port. Vercel Workflows is the current deployment-compatible implementation; alternative durable workflow engines remain replaceable adapters.

### Communications kernel
The communications kernel remains below organizational intelligence and must not introduce a second identity authority, authorization system, organization model, billing system, analytics truth store or AI cognition loop.

### Provider-independent reachability
Communication routing supports ordinary connected channels plus SMS/voice cellular fallback. The recipient does not need Internet or an Aurum account. Provider-specific telecom, meeting and realtime transports remain adapters.

### Edge execution
Customer-controlled Aurum Edge runtime may reach private/on-prem APIs, MCP/OpenAPI services, files, databases and approved browser adapters through signed, tenant-scoped jobs. Credentials should remain customer-side where possible.

### Progressive provider selection
Ordinary product UX chooses outcomes such as quality, speed, privacy, cost and organization-managed control rather than provider/technology names. Provider selection occurs automatically or when a capability requires it. Advanced settings may expose technical details.

### Provider billing
Provider payment is abstracted behind Aurum where contracts permit platform-mediated settlement. Provider-specific commercial constraints may require direct customer billing; this remains an adapter-level exception.

### Open-source reuse gate
Before implementing substantial infrastructure, the Tech Lead must consult spec/TECHNOLOGY-RESEARCH-2026-09-23.md and the W089 technology registry. Any proposed OSS dependency requires explicit review of license, security, maintenance, data handling, operational complexity and exit strategy.

### Work-item execution
The post-S002 work catalog is spec/work-items/WORK-ITEM-CATALOG.md; the dependency/parallelization DAG is spec/WORK-ITEM-DEPENDENCY-GRAPH.md; the self-contained handoff is spec/FINAL-TECH-LEAD-HANDOFF-POST-S002-2026-09-23.md.