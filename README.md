# Aurum Chat — Organizational Intelligence Employee

Aurum is an always-on organizational intelligence employee. It ingests authorized company and external signals, maintains a provenance-aware world model, learns what matters to the company, investigates consequential unknowns, communicates with employees through their existing channels, exposes intelligence to management, and—only when authorized—recruits or orchestrates specialist agents and software capabilities.

## Mission

Aurum's primary job is **information gathering, organizational understanding, and agent/capability orchestration**. Industry-specific operational work belongs to authorized specialist agents and extensions.

Core loop:

**observe → remember → understand → compare with goals → identify unknowns → launch learning missions → acquire evidence → update understanding → identify gaps/opportunities → recommend → act when authorized → measure outcomes → learn**

Conversation is an experience/channel, not the cognitive center.

## Repository contract

- `spec/ARCHITECTURE.md` — canonical frozen architecture.
- `spec/ARCHITECTURE-LOCK.md` — non-negotiable invariants.
- `spec/MISSION-ALIGNMENT.md` — mapping from product mission to architecture.
- `spec/MODULE-DEPENDENCY-MAP.md` — module ownership and dependency rules.
- `spec/WORK-ITEM-DEPENDENCY-GRAPH.md` — implementation DAG.
- `spec/work-items/WORK-ITEM-CATALOG.md` — implementation work orders.
- `spec/ADR/` — accepted architecture decisions.
- `spec/GOVERNANCE.md` — implementation and evidence rules.
- `docs/superpowers/plans/2026-09-14-aurum-mission-alignment.md` — implementation plan.

## Development (W000 skeleton)

Aurum is built as a TypeScript modular monolith on Bun and Next.js with PostgreSQL as the single source of truth: one parameterized-SQL db port (`src/infra/db.ts` — embedded PGlite by default, node-postgres via `DATABASE_URL`), infra-owned queue/cache/lock ports (memory by default, redis via `REDIS_URL`, never domain truth), SQL migrations recorded in `_migrations` and applied in module-dependency order, and an architecture gate that keeps domain modules framework-free, cross-module imports contract-only, and every domain table tenant-scoped. Domain modules (W001+) land under `src/modules/<m>/` with a `contract.ts` public surface. Copy `.env.example` to `.env` for local development.

| Command | Purpose |
| --- | --- |
| `bun install` | install dependencies (`bun.lock` is committed) |
| `bun run dev` | run the Next.js dev server |
| `bun run build` | build the Next.js shell |
| `bun run start` | serve the production build |
| `bun run typecheck` | `tsc --noEmit` over `src/`, `scripts/`, `tests/` |
| `bun run test` | `vitest run` |
| `bun run arch` | architecture gate (`scripts/check-architecture.ts`) |
| `bun run lint` | `eslint .` |
| `bun run migrate` | apply module migrations (`scripts/migrate.ts`) |
| `bun run db:dev` | boot the embedded db, migrate, print tables |

## Non-goals

Aurum is not itself the CRM, PM system, construction supervisor, customer-support agent, ERP, or vertical workflow engine. Those capabilities are acquired through authorized agents, extensions, integrations, or marketplace packages.
