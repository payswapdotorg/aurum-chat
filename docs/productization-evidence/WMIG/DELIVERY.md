# WMIG — Migration-Runner Content-Checksum Hardening — Delivery Record

**Work item:** WMIG (TL work order: content-checksum hardening of the `_migrations` ledger — the W102 seam closure)
**Base SHA:** 53bd2711982a7016fc36e1376e375d7551142652 (W108)
**Branch:** `work/migration-checksum-hardening`
**Delivery type:** DELIVERED (deterministic; all gates green; no new dependencies)

---

## 1. What was delivered

The W102 incident proved a diverged database can record the same migration
NAME with DIFFERENT content. The existing guards catch only the
MISSING-TABLE half of that class (`verifyMigratedSchema` at apply time,
`/api/health` census at runtime). Content mutation under an
already-recorded name remained undetectable. This work closes the seam in
`scripts/migrate.ts` — additive only, on the runner's own bookkeeping
table:

1. **THE LEDGER RECORDS CONTENT** — the `_migrations` bootstrap now
   creates the table with a `content_sha text` column AND runs
   `ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS content_sha text`
   in the same bootstrap step (legacy ledgers gain the column
   idempotently). At apply time each migration's ledger row is INSERTed
   together with the sha256 hex digest of its file content
   (`node:crypto` — no new dependency), inside the SAME transaction as
   the migration's DDL: no hash without the DDL, no DDL without the hash.

2. **CONTENT DRIFT — THE NEW REFUSAL CLASS** — on every run, for each
   migration the ledger records as applied within the discovered set,
   the runner compares the stored `content_sha` against the current
   file's sha256. A mismatch is "content drift": the run REFUSES to
   migrate or deploy, throwing
   `content drift REFUSED — … (… refusing to migrate or deploy …)` and
   listing EVERY drifted migration with its name, stored hash and
   current file hash:
   `  - <module>/<file>.sql (ledger sha256: <stored>, file sha256: <current>)`.
   The refusal fires BEFORE anything is applied and WITHOUT touching the
   ledger (the pre-pass is read-only; drift is collected for the whole
   set before any backfill write) — a refused run leaves the ledger
   byte-identical, and pending migrations do not apply.

3. **LEGACY BACKFILL — PIN FORWARD, EXPLICITLY** — a stored NULL hash
   (a row recorded before this hardening) is unverifiable against
   history; the runner pins it FORWARD to the current file's hash and
   records the pin in the run report (`MigrationReport.pinned:
   { name, contentSha }[]`), printed by `bun run migrate` as
   `pinned N legacy ledger row(s) to current content hashes (historical
   content unverifiable — pinned forward)`. Never silent.

4. **UNCHANGED, BY DESIGN** — the name-skip logic, the W102
   missing-table guard (`verifyMigratedSchema`), and
   `EXPECTED_TABLE_CENSUS` are untouched. The ledger is runner
   infrastructure, not canonical schema: the only schema change is the
   ledger's own new column.

## 2. Proofs (tests/e2e/platform/schema-reconciliation.test.ts)

- **`WMIG — content drift: a mutated applied migration refuses the run >
  apply → mutate → re-run REFUSES with the name and both hashes; nothing
  else applies`** — applies the drift-fixture module to the ledger,
  proves the stored `content_sha` equals the file's sha256 (recomputed
  independently in the test with `node:crypto`), adds a pending 002,
  mutates the applied 001's content, re-runs and asserts the refusal
  message carries the exact drift line (name + ledger sha256 + file
  sha256); then proves the refusal was total: 002 NOT applied (no ledger
  row, no `drift_gamma` table) and the stored hash NOT clobbered.
- **`WMIG — the backfill path: legacy NULL rows are pinned forward > a
  legacy row (name recorded, content_sha NULL) is pinned to the current
  hash and reported; the second run is clean`** — seeds the legacy row
  shape (name present, no hash), runs the runner: skipped by name (no
  re-apply), row pinned to the current file's sha256, pin present in
  `report.pinned`; the second run is clean (nothing applied, nothing
  pinned, no drift).
- The suite's existing 25 W102 proofs all still pass (27/27 total) —
  including the organic backfill: the file-level seeded legacy ledger
  (three 001 rows, no hashes) is now pinned by the repair run instead of
  silently skipped.

## 3. CLI proof (fresh embedded dev db, `.data/aurum.pg`)

```
$ bun run migrate                          # fresh db
applied 137 migration(s), skipped 0
schema verification passed — 256 expected table(s) all present (public table census: 257)

$ bun run migrate                          # re-run — idempotence
applied 0 migration(s), skipped 137
schema verification passed — 256 expected table(s) all present (public table census: 257)

$ <mutate src/modules/demo/migrations/001-demo-harness.sql>; bun run migrate
Error: content drift REFUSED — the _migrations ledger records 1 applied migration(s) whose
current file content hash differs from the recorded hash (a migration name was recorded
against DIFFERENT content; refusing to migrate or deploy; restore the recorded file content
or reconcile the ledger deliberately):
  - demo/001-demo-harness.sql (ledger sha256: 57d294e…, file sha256: 6029c2…)
error: script "migrate" exited with code 1       # file restored afterwards; clean again

$ ledger check: SELECT count(*), count(content_sha) FROM _migrations
  → 137 rows, 137 hashed
```

## 4. Census impact

NONE. The fresh-db census is 257 — exactly `EXPECTED_TABLE_CENSUS`
(W108's pin); `_migrations` was already counted; a column addition does
not change any table count. No count pin was touched.

## 5. Gates

- `bun run typecheck` — PASS
- `bun run lint` — PASS
- `bun run arch` — PASS (`module files: 676, app/mcp files: 308, tables checked: 249`)
- `bun run test -- schema-reconciliation` — PASS (filter: `schema-reconciliation`; 27/27)
- `bun run migrate` — PASS (fresh apply + idempotent re-run + refusal proof above)
- Representative runner-dependent regression set — PASS (44/44:
  scaffold, health, platform-surface, schema-boundary-sweep, worker)

## 6. Files changed

- `scripts/migrate.ts` — the hardening (ledger column, apply-time hash,
  drift refusal, legacy pin-forward, run-report extension).
- `tests/e2e/platform/schema-reconciliation.test.ts` — the drift-class
  and backfill proofs (plus header/comment updates; the final
  drop-a-table proof stays last among schema-health-dependent tests).
- `docs/productization-evidence/WMIG/DELIVERY.md` — this record.

Single-file ownership honored: the two work-order files plus this
delivery record (the repo convention — see
`docs/productization-evidence/W108/DELIVERY.md`).
