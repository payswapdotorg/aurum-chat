-- W102 · drop the preserved pre-W088 debris (schema reconciliation, step 2).
--
-- CONTEXT: the W101 repair (002-repair-migration-name-collision.sql, PRs
-- #122 + #123) converged production's diverged schema by RENAMING the
-- superseded generation's tables/indexes/triggers to __orphaned_pre_w088
-- names — renames only, nothing dropped, preserving the audited state
-- while the current W088 schema was created beside it. That repair is
-- deployed; what remains is the debris itself: 5 preserved tables (with
-- their renamed constraint indexes) permanently skewing the public
-- schema against every fresh environment.
--
-- THE CLEANUP (idempotent on every environment):
--   * DROP each __orphaned table when it exists AND carries 0 rows.
--     CASCADE takes its renamed constraint/index objects with it
--     (they are table-attached and nothing references the debris).
--   * The emptiness guard is belt-and-braces: after the W101 renames
--     nothing in the codebase references these names, so a NON-empty
--     orphan can only be human-made — in that case the drop is skipped
--     and the schema census (/api/health, W102) fails LOUDLY instead of
--     destroying data.
--   * fresh environments (001 + 002 applied, no orphans ever renamed):
--     to_regclass is NULL and the loop body no-ops.
--
-- EVIDENCE OF EMPTINESS (the W101 deployment-integrity audit + tech-lead
-- direct production inspection, 2026-09-26): every pre-W088 orphan table
-- carried 0 rows in production. The renames froze them — no code path
-- can write a table named *__orphaned_pre_w088.

DO $$
DECLARE
  orphan_name text;
  orphan_rows bigint;
BEGIN
  FOREACH orphan_name IN ARRAY ARRAY[
    'edge_jobs__orphaned_pre_w088',
    'edge_registrations__orphaned_pre_w088',
    'edge_allowlist_events__orphaned_pre_w088',
    'edge_health_events__orphaned_pre_w088',
    'edge_job_events__orphaned_pre_w088'
  ] LOOP
    IF to_regclass('public.' || orphan_name) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', orphan_name) INTO orphan_rows;
      IF orphan_rows = 0 THEN
        EXECUTE format('DROP TABLE public.%I CASCADE', orphan_name);
      ELSE
        RAISE NOTICE 'W102: keeping non-empty orphan table % (%) — inspect manually; the schema census will fail loudly',
          orphan_name, orphan_rows;
      END IF;
    END IF;
  END LOOP;
END $$;
