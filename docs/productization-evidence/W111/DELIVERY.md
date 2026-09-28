# W111 — Production Migration Reader / Native-Reader Adapters — Delivery

**Work item:** W111 (spec/work-items/WORK-ITEM-CATALOG.md)
**Base:** `53bd2711982a7016fc36e1376e375d7551142652` (W108 head)
**Branch:** `work/w111-migration-readers`
**Status:** DELIVERED (hosted-Postgres leg ENVIRONMENT-BLOCKED — exact prerequisite below)

W111: *"Provide one real incumbent reader and one real/native Aurum reader behind the W094
ports. Acceptance: staged import, explicit human conflict resolution, W084
comparison/reconciliation, progressive retirement and sequestration rollback work in a real
environment; if an external prerequisite is unavailable, mark it BLOCKED with the exact
prerequisite."*

---

## 1. What shipped

### 1.1 The REAL incumbent reader — the CSV export-library adapter

`src/modules/migration/adapters/csv-export-incumbent-reader.ts` (+ the format core
`csv-export-format.ts`) implements the W094 `MigrationIncumbentReader` port for the real
private/on-prem incumbent pattern: the incumbent's export job drops **versioned full-state
CSV snapshots** onto a share (`csv-export-<NNN>/records.csv`), and the reader answers from
whatever is on disk right now (no caching).

The documented export format (real CSV, as legacy CRMs export):
- **RFC 4180 parsing** (quoted fields, embedded commas/quotes/line breaks, CRLF/LF/CR, UTF-8
  BOM, missing trailing separator, blank-line tolerance) via a small in-repo state machine —
  no third-party parser pulled in.
- **Columns** (any order, no unknowns/duplicates): `external_id`* and `payload_json`*
  required; `match_key`, `entity_type`, `deleted_at` optional. Multi-value fields are JSON
  arrays inside `payload_json` (the format's answer to real CRM multi-value cells).
  Tombstones are soft-delete rows (`deleted_at` set, `payload_json` empty) — records stay in
  the export, exactly how real systems export deletes.
- **Per-row canonicalization with the module's own rules** — every row crosses
  `canonicalizeIncumbentRecord` (the same validation the module applies): a row that cannot
  canonicalize is **explicitly rejected**, never silently dropped and never allowed to poison
  the round.
- **Delta by row-diff**: `sinceSnapshotRef csv-export-<N>` diffs version N against the
  LATEST version by canonical row equality (changed/added/tombstones returned); a row present
  in the base but absent from the latest **without a tombstone** is surfaced as an explicit
  `disappeared-without-tombstone` rejection (the export format's honest answer to a vanished
  row). The format's no-interim-journal limitation is documented in the adapter header.
- **Honest failures**: unknown/garbage base references, broken headers, an empty share and
  the per-round cap all fail loudly (`invalid_reader_result` / `snapshot_too_large`) — the
  module never fakes a snapshot.
- **Credential discipline** (W082): the request's opaque `credentialRef` passes straight
  through, recorded on `reader.requests` for the pass-through proofs, never interpreted,
  never stored in the rejection ledger.

### 1.2 The rejection ledger — no silent data loss, made durable

The module-level canonicalization is all-or-nothing per snapshot, so a real incumbent with
malformed rows must reject **per row** — and those rejections need a durable audit home.
This is the ONE sanctioned W111 storage addition:

- `src/modules/migration/migrations/002-w111-migration-readers.sql` — table
  `migration_reader_rejections` (tenant-scoped, round-linked, append-only semantics; the
  reason-code vocabulary is deliberately adapter-owned bounded text, not an enum — future
  first-party readers extend their own vocabularies without migration churn).
- `captureSnapshot` (service.ts) drains the wired reader's rejections (the optional
  `IncumbentRejectionSource` capability — the fixture double and third-party readers
  simply don't implement it) and persists them **inside the round's transaction**, linked
  to the round; the round's audit event carries the rejection count; the
  `captureSnapshot` result returns them; `listReaderRejections` is the tenant-scoped read.
- **The count reconciliation** (asserted in tests, per round):
  `export data rows = staged records + rejected rows (+ conflicted, where conflicts exist)`.

Rejection reason codes the CSV adapter owns: `wrong-field-count`, `invalid-record` (the
module canonicalization's own message — missing/oversized external id, bad `deleted_at`,
invalid/non-object/oversized payload, tombstone-with-payload, live-without-payload),
`duplicate-external-id` (first row wins, the duplicate surfaced), `invalid-encoding`
(per-row invalid UTF-8 — never whole-file poisoning, never silent mangling),
`disappeared-without-tombstone` (delta). Every rejection carries its raw source row
(bounded to 4000 chars, marked when truncated) and its 1-based data-row position.

### 1.3 The REAL native Aurum reader — world entities

`src/modules/migration/adapters/world-native-reader.ts` implements the W094
`MigrationNativeReader` port reading the **real W005 `world_entities` schema** through the
db port (whatever backend the deployment pins — the embedded PGlite PostgreSQL 16 engine, or
node-postgres against hosted Postgres). States are **keyed by `world_entities.id`**; a
world entity's canonical current state is its `attributes` object (the W005 "mutable
current picture"; kind/category/name are classification metadata; temporal versioning is
W006's separate scope).

The port request carries no tenant (the W094 port shape is frozen), so the adapter is
constructed with its tenant binding — the env-driven wiring wires one native reader per
process for the tenant under migration. **Convergence rides the fixture mirror model made
real**: the migration's commit mints the identifier map's `aurum_entity_id` values, the
native side's catch-up (the customer's native-side import tool — see the test's
`nativeCatchUp`) writes `world_entities` rows carrying THOSE minted ids, and the comparison
then agrees field-for-field.

### 1.4 The W088 verification leg — a REAL file-share edge adapter

`src/modules/migration/adapters/file-share-verify.ts` is a real
`EdgeConnectivityAdapter` (connectivity `file-share`, from the edge-connector contract)
whose **inspect side really re-reads the incumbent's CSV export from the file system**, and
whose **execute side is permanently refused by policy** (`rejected` receipt — Aurum never
writes back to the incumbent through the migration module; the golden-path test asserts
every edge job was an inspect).

Composed exactly as W094 designed: `createEdgeDeepActionTransport` + the in-memory edge
runtime (signed, tenant-scoped edge jobs, dial-home driven) with the REAL file-share adapter
serving the reads. The delta-round commit in the golden path verifies through it
(`verification: 'verified'`, `verifiedCount: 2`, edge targets = the live records).

### 1.5 Env-driven wiring — the W108 Family A precedent

`src/modules/migration/adapters/env-wiring.ts` — `ensureMigrationReadersWired()`
(globalThis-guarded lazy singleton, idempotent per process):
- `MIGRATION_CSV_EXPORT_ROOT` → wires the CSV incumbent reader;
- `MIGRATION_NATIVE_TENANT_ID` (a uuid) → wires the world native reader;
- unset/invalid → **honestly unwired** (`reader_unavailable` /
  `native_reader_unavailable`; `incomplete` for a non-uuid tenant id).

### 1.6 A W094 gap found and fixed within ownership

`listCurrentImportedStates` did not exclude sequestered migrations' imports — a live-query
leak of quarantined state that the W111 rollback proof surfaced. Fixed additively
(mirroring `listImportedRecords`): sequestered migrations' states are excluded unless
`includeSequestered: true` (the audit view). Also made `commitImportRound`'s
`mapEntries` result deterministic (`ORDER BY external_id` — it previously rode an unordered
`id = ANY(...)` heap scan, a latent flake class).

---

## 2. The real environment

- **Embedded real PostgreSQL (PGlite) — REAL-PROVEN.** The full migration path runs against
  the repo's embedded PostgreSQL 16 engine with the **full production migration chain**
  (138 migrations, 258 tables — see `db-dev-full-chain.txt` for the complete fresh-boot
  table list from `bun run db:dev`, and `gates-migrate.txt` for the deployment
  `bun run migrate` path applying `migration/002-w111-migration-readers.sql` cleanly +
  idempotent re-run). A real SQL engine with the real schema — not a fixture.
- **Hosted Postgres (Neon) — ENVIRONMENT-BLOCKED.** The operator-provisioned Neon keys were
  unusable from this sandbox: **`api.neon.tech` is DNS-unresolvable** (verified by the tech
  lead, by the prior worker, and re-probed here — see `neon-dns-probes.txt`:
  `getent` exit 2, node `dns.lookup` `ENOTFOUND`, curl `(6) Could not resolve host`, with
  `github.com` resolving as the control). **The exact external prerequisite: network
  egress to `api.neon.tech` (or any reachable hosted PostgreSQL connection string) from the
  execution environment.** The hosted leg stands ready:
  `src/modules/migration/tests/migration-readers-hosted.test.ts` activates on
  `AURUM_TEST_DATABASE_URL` (the `worker-realpostgres` precedent — the same node-postgres
  backend CI uses) and walks the same path (staged import with rejection-ledger
  reconciliation → native catch-up through real SQL → clean comparison → full retirement
  chain).
- **The incumbent leg's environment is genuinely real by construction:** real files on the
  real file system, real RFC 4180 bytes (including an invalid-UTF-8 row), read live on
  every round; the verification leg re-reads the same real files through signed edge jobs.
- Sandbox note: this sandbox exports an ambient non-Postgres `DATABASE_URL`; every gate
  below pins `AURUM_DB=embedded` explicitly (the repo's default dev backend) so nothing
  leaks from the hosting environment.

## 3. The full path (proven in `migration-readers-real.test.ts`)

`staged import → W084 comparison/reconciliation → verification → progressive retirement →
sequestration rollback`, in one golden-path test over the real adapters:

1. **Staged import** of a real export (4 canonical rows + 1 malformed → 4 staged + 1
   rejected, ledger-linked; count reconciliation asserted).
2. **No duplicate authority**: the `world_entities` census is asserted unchanged across
   every import phase (the module writes only its own tables — the world rows come solely
   from the explicit native catch-up).
3. **W088 verification**: the delta commit re-reads the real CSV through signed edge jobs
   served by the real file-share adapter → `verified`, every job an inspect.
4. **Delta round**: changed + new + tombstone rows return; the vanished row is an explicit
   `disappeared-without-tombstone` rejection; the re-issued/unchanged semantics hold.
5. **Native catch-up** writes world rows carrying the map's minted ids (one entity seeded
   divergent).
6. **W084 comparison** surfaces the divergence with the reconciliation's own mismatch
   enumeration (`path 'stage', expected 'active', actual 'churned'`) and a deterministic
   reason; the retirement chain **refuses** to advance on it; after the native side
   converges, the next comparison is clean (5/5 agreements).
7. **Progressive retirement**: `advanceToCompareClean` (evidence round frozen) →
   `advanceToIncumbentReadOnly` → `retireIncumbent`; the identifier map stays live
   (`resolveExternalId` resolves after retirement).
8. **Explicit conflict, human-decided**: a second incumbent system exporting the same
   natural key raises a `cross-system-collision` conflict — no map entry, the external id
   resolves to nothing, the record is `conflicted`; only `resolveIdentityConflict` (the
   audited human decision) links it, minting a `conflict-resolution` map entry.
9. **Rollback (proof by doing)**: a third migration with committed imports, a native world
   row and an open round is **sequestered**: the open round force-abandoned; live views
   (`listCurrentImportedStates`, `listImportedRecords`, `listIdentifierMappings`,
   `resolveExternalId`) all exclude; the audit views (`includeSequestered`) retain
   everything; the identifier-map rows are untouched at the storage level; **the native
   world row and census are exactly as before** (native Aurum data never touched); a fresh
   migration for the same system mints fresh ids while the sequestered ones remain stored
   as audit; the sequestered migration is terminal.

## 4. Gates (real tails in this directory)

| gate | result | evidence |
| --- | --- | --- |
| `bun run typecheck` | PASS | `gates-typecheck-lint-arch.txt` |
| `bun run lint` | PASS | `gates-typecheck-lint-arch.txt` |
| `bun run arch` | PASS (684 module files, 250 tables checked) | `gates-typecheck-lint-arch.txt` |
| `bun run test -- migration` | 56 passed, 1 skipped (hosted leg), 0 failed — filter `migration` (6 files: migration-unit, migration-service, migration-readers, migration-readers-real, migration-readers-hosted, tenant-isolation/migration-sweep) | `gates-tests-migration.txt` |
| full suite (chunked, W101 precedent) | 5657 passed + the 13 new-file tests + 1 new skip = **5670 passed, 7 skipped, 0 failed** (273 tracked files in 6 batches + the 3 new files run directly) | `gates-full-suite.txt` |
| `AURUM_DB=embedded bun run migrate` | PASS — fresh apply incl. `migration/002-w111-migration-readers.sql`, idempotent re-run, drift guard `census 258` | `gates-migrate.txt`, `db-dev-full-chain.txt` |

## 5. Storage + count pins (the W102 discipline, W108 precedent)

- New migration: `src/modules/migration/migrations/002-w111-migration-readers.sql`
  (`migration_reader_rejections`; tenant-scoped per arch rule (d)).
- `src/app/api/health/lib.ts` — `EXPECTED_TABLE_CENSUS` 257 → 258 (commented).
- `tests/e2e/platform/schema-reconciliation.test.ts` — deliberate count-pin extensions
  134 → 135 / 137 → 138 / 137 → 138 (commented). Nothing else in those files touched.

## 6. Files

New: `adapters/csv-export-format.ts`, `adapters/csv-export-incumbent-reader.ts`,
`adapters/world-native-reader.ts`, `adapters/file-share-verify.ts`,
`adapters/env-wiring.ts`, `migrations/002-w111-migration-readers.sql`,
`tests/migration-readers.test.ts`, `tests/migration-readers-real.test.ts`,
`tests/migration-readers-hosted.test.ts`, this evidence directory.
Amended (all within §3 ownership or the sanctioned count pins):
`contract.ts`, `types.ts`, `validation.ts`, `service.ts` (rejection drain + ledger read +
the two fixes in §1.6), `src/app/api/health/lib.ts`,
`tests/e2e/platform/schema-reconciliation.test.ts`.

## 7. Frontier notes for W112

- The resident worker does not yet pump migration lifecycles — the composition of
  `ensureMigrationReadersWired()` into a deployment entry point (or the worker pump) is a
  W112 certification item, as it was for W108's cellular transports.
- The hosted-Postgres leg needs one reachable `AURUM_TEST_DATABASE_URL` run (CI's
  postgres:16 service container qualifies) to upgrade the hosted leg from
  ENVIRONMENT-BLOCKED to REAL-PROVEN.
- A SaaS incumbent reader (broker-backed reads) remains unimplemented — W111's scope
  deliberately shipped the private/on-prem CSV pattern (the W088 path); the port takes
  any future adapter additively.
