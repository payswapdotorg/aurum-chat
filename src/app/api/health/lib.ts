// The health/readiness endpoint's handling logic (W069). Tested directly
// without booting Next.js; route.ts is a thin NextResponse adapter.
//
// Unauthenticated by design (readiness probes must not depend on
// sessions) and safe because it exposes ONLY deployment shape: component
// backend labels, guardrail numbers, db liveness and the applied
// migration count. No tenant data, no secrets, no domain content.
//
//   status 'ok'       200 — db answers, no production-readiness refusals.
//   status 'degraded' 200 — db answers, but production-readiness notes
//                          exist (e.g. missing REDIS_URL warning) — the
//                          app serves, the operator should look.
//   status 'error'    503 — the domain-truth database does not answer,
//                          or the schema is not applied (not ready).
//
// The db check is `SELECT 1`, the `_migrations` count, and — since W102
// — a TABLE CENSUS: the `_migrations` ledger proves only that migration
// NAMES were recorded, never that their content produced the schema (the
// W102 incident: preview deployments of superseded parallel-lineage
// branches ran different DDL under the same migration filenames against
// the shared production database; the ledger stayed complete while the
// surfaces served 500s). The census counts public BASE TABLEs and checks
// a small representative set, so a diverged database reports NOT READY
// instead of a green-but-broken `ok`.

import { now } from '@/infra/clock';
import { getDb } from '@/infra/db';
import { assertProductionReadiness, resolveDeploymentProfile } from '@/infra/deployment';
import { getWorkerMetrics } from '@/infra/worker';

/**
 * The number of public BASE TABLEs a fully-migrated database must carry:
 * every distinct table created by the module migration files (the
 * migrate.ts verification pass guards the same expectation at build
 * time) plus the `_migrations` ledger itself. A stale value fails the
 * health suite, which re-migrates a fresh embedded database and asserts
 * the census — extend it whenever a migration adds a table.
 */
export const EXPECTED_TABLE_CENSUS = 260; // W126: company_query_log

/**
 * The full expected public-BASE-TABLE name set (W118 diagnostic): every
 * table the module migrations create plus the `_migrations` ledger —
 * generated from the migrate.ts verification pass. When the census
 * drifts, `extra` names the surplus tables so the operator can drop the
 * debris (or bless it) without database access. Kept in lockstep with
 * EXPECTED_TABLE_CENSUS: this.size === EXPECTED_TABLE_CENSUS.
 */
export const EXPECTED_TABLE_NAMES = new Set([
  '_migrations', 'acquisition_outcomes', 'acquisition_plans', 'action_approval_decisions',
  'action_authority_policies', 'action_requests', 'agent_definitions',
  'agent_evaluation_replacement_options', 'agent_evaluations', 'agent_execution_attempts',
  'agent_executions', 'agent_lifecycle_decisions', 'agent_recruitment_alternatives',
  'agent_recruitment_proposals', 'agent_runtime_accounts', 'agent_runtime_availability_events',
  'agent_supervision_budget_entries', 'agent_supervision_events', 'agent_supervision_records',
  'agent_supervision_reviews', 'agent_supervisor_sessions', 'agent_team_outcomes',
  'agent_team_versions', 'agent_teams', 'ai_provider_accounts', 'api_keys',
  'api_webhook_deliveries', 'api_webhook_delivery_attempts', 'api_webhook_subscriptions',
  'audit_records', 'auth_invites', 'auth_sessions', 'auth_user_companies', 'auth_users',
  'auth_waitlist', // W116 — the access waitlist (platform table)
  'automation_measurements', 'automation_opportunities', 'automation_opportunity_versions',
  'beliefs', 'briefing_policies', 'briefing_sections', 'briefings', 'broker_checkpoint_history',
  'broker_checkpoints', 'broker_connection_events', 'broker_connections',
  'broker_hot_swap_verifications', 'broker_provider_health_events', 'broker_records',
  'browser_sessions', 'browser_task_events', 'browser_task_idempotency', 'browser_task_steps',
  'browser_tasks', 'capabilities', 'capability_access', 'capability_grant_events',
  'capability_grant_requests', 'capability_grants', 'capability_invocations',
  'capability_requirement_versions', 'capability_requirements', 'capability_supplies',
  'capability_supply_versions', 'capability_versions', 'cellular_attempts',
  'cellular_connections', 'cellular_events', 'cellular_inbound_authority', 'cellular_policies',
  'cellular_reach_requests', 'cellular_replies', 'channel_connections', 'channel_threads',
  'claims', 'cognitive_execution_steps', 'cognitive_executions', 'company_learning_versions',
  'company_learnings', 'company_model_assertions', 'company_model_updates',
  'company_query_log', 'contradictions',
  'contribution_impacts', 'contribution_validations', 'contributions',
  'conversation_execution_links', 'conversation_messages', 'conversations',
  'deep_action_events', 'deep_action_idempotency', 'deep_action_operations',
  'deep_action_surface', 'deep_action_tasks', 'demo_journey_anchors', 'destination_deliveries',
  'destination_delivery_attempts', 'destinations', 'discovery_candidates', 'discovery_runs',
  'edge_auth_nonces', 'edge_capability_allowlist', 'edge_events', 'edge_heartbeats',
  'edge_jobs', 'edge_runtimes', 'employees', 'event_sequences', 'events',
  'extension_build_artifacts', 'extension_builds', 'extension_deployments',
  'extension_event_deliveries', 'extension_external_calls', 'extension_lifecycle_events',
  'extension_manifest_verifications', 'extension_manifests', 'extension_schedule_runs',
  'extension_state', 'extension_telemetry_events', 'extension_ui', 'extensions',
  'freshness_policies', 'goal_versions', 'goals', 'hypotheses', 'identities',
  'identity_challenges', 'integration_discovery_grants', 'integration_recommendation_batches',
  'integration_recommendations', 'integration_systems', 'integration_verification_runs',
  'intervention_priors', 'intervention_realizations', 'interventions',
  'llm_availability_events', 'llm_executions', 'llm_hot_swap_verifications',
  'marketplace_package_lifecycle_events', 'marketplace_package_reviews',
  'marketplace_package_verifications', 'marketplace_packages', 'meeting_access_events',
  'meeting_artifacts', 'meeting_connections', 'meeting_ingestion', 'meeting_ingestion_cursors',
  'meeting_participants', 'meeting_sessions', 'meeting_transcripts', 'meetings',
  'memory_knowledge_entries', 'memory_transactive_entries', 'migration_comparison_entries',
  'migration_comparison_rounds', 'migration_events', 'migration_identifier_map',
  'migration_identity_conflicts', 'migration_imported_records', 'migration_migrations',
  'migration_reader_rejections', 'migration_rounds', 'mission_versions', 'missions',
  'notification_acknowledgments', 'notification_attempts', 'notification_policies',
  'notifications', 'observation_lineage', 'observations', 'opportunities',
  'opportunity_conversion_candidates', 'opportunity_conversion_runs', 'opportunity_versions',
  'outcome_measurements', 'outcome_realizations', 'outcomes', 'persons', 'process_findings',
  'process_versions', 'processes', 'provider_budget_events', 'provider_budgets',
  'provider_payment_arrangements', 'provider_personal_preferences',
  'provider_preference_events', 'provider_preference_settings',
  'provider_selection_explanations', 'provider_settlement_events', 'provider_settlement_lines',
  'provider_settlements', 'provider_technical_overrides', 'provider_usage_records',
  'quality_judgments', 'quality_metric_results', 'quality_snapshots', 'realtime_artifacts',
  'realtime_connections', 'realtime_events', 'realtime_participants', 'realtime_responses',
  'realtime_sessions', 'realtime_turns', 'reward_policies', 'reward_settlements', 'rewards',
  'role_assignment_versions', 'role_assignments', 'role_expectation_versions',
  'role_expectations', 'sim_companies', 'sim_hidden_facts', 'sim_month_reports',
  'source_checkpoint_history', 'source_checkpoints', 'source_rankings', 'source_records',
  'sources', 'supplier_scorecard_versions', 'supplier_scorecards', 'supplier_versions',
  'suppliers', 'temporal_revisions', 'tenant_members', 'tenants', 'unified_ambiguities',
  'unified_identities', 'unified_identity_events', 'unknowns', 'vertical_kit_edge_actions',
  'vertical_kit_events', 'vertical_kit_grants', 'vertical_kit_installations',
  'vertical_kit_invocations', 'vertical_kit_verifications', 'vertical_kit_versions',
  'watch_entries', 'watch_escalations', 'watch_signals', 'watchlists',
  'workflow_definition_versions', 'workflow_definitions', 'workflow_events',
  'workflow_run_signals', 'workflow_run_steps', 'workflow_runs', 'workflow_schedule_firings',
  'workflow_schedules', 'workflow_step_attempts', 'workforce_assessment_versions',
  'workforce_assessments', 'workforce_decisions', 'workforce_signals', 'workspace_members',
  'workspaces', 'world_entities', 'world_entity_kinds', 'world_relationship_types',
  'world_relationships',
]);

/**
 * A small representative set spanning the incident's modules and the
 * core product/auth path — belt-and-braces under the census: even a
 * census that adds up must hold these specific tables.
 */
export const REPRESENTATIVE_TABLES = [
  'provider_preference_settings', // W091 — the /ai/preferences surface
  'vertical_kit_versions', // W092 — vertical extension kits
  'edge_runtimes', // W088 — the edge connector
  'conversations', // the core product loop
  'auth_users', // the auth path
] as const;

interface HealthDbTables {
  census: number;
  expected: number;
  missing: string[];
  extra: string[];
}

interface HealthDbState {
  ok: boolean;
  migrations: number | null;
  tables: HealthDbTables | null;
  error: string | null;
}

async function checkDb(): Promise<HealthDbState> {
  try {
    const db = getDb();
    await db.query('SELECT 1');
    let migrations: number | null = null;
    try {
      const applied = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM _migrations`,
      );
      const parsed = Number.parseInt(applied.rows[0]?.count ?? '0', 10);
      migrations = Number.isFinite(parsed) ? parsed : null;
    } catch {
      // Database answers but the schema is not applied — not ready.
      return {
        ok: false,
        migrations: null,
        tables: null,
        error: '_migrations table missing — run the migration runner (bun run migrate)',
      };
    }
    // W102 table census: one cheap information_schema read carries both
    // the count and the representative presence check.
    const present = new Set(
      (
        await db.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        )
      ).rows.map((row) => row.table_name.toLowerCase()),
    );
    const missing = REPRESENTATIVE_TABLES.filter((table) => !present.has(table));
    const extra = [...present]
      .filter((table) => !EXPECTED_TABLE_NAMES.has(table))
      .sort();
    const census = present.size;
    if (census !== EXPECTED_TABLE_CENSUS || missing.length > 0) {
      const problems: string[] = [];
      if (census !== EXPECTED_TABLE_CENSUS) {
        problems.push(`table census ${census} differs from the expected ${EXPECTED_TABLE_CENSUS}`);
      }
      if (missing.length > 0) problems.push(`missing core tables: ${missing.join(', ')}`);
      if (extra.length > 0) problems.push(`extra tables (debris): ${extra.join(', ')}`);
      return {
        ok: false,
        migrations,
        tables: { census, expected: EXPECTED_TABLE_CENSUS, missing: [...missing], extra },
        error:
          `schema drift — ${problems.join('; ')}; the _migrations ledger is complete ` +
          `but the schema is not (run the migration runner; see W102)`,
      };
    }
    return {
      ok: true,
      migrations,
      tables: { census, expected: EXPECTED_TABLE_CENSUS, missing: [], extra: [] },
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      migrations: null,
      tables: null,
      error: error instanceof Error ? error.message.slice(0, 200) : 'database unreachable',
    };
  }
}

export interface HealthResult {
  status: number;
  body: Record<string, unknown>;
}

/** GET /api/health — readiness + deployment shape (no tenant data). */
export async function handleHealthGet(): Promise<HealthResult> {
  const profile = resolveDeploymentProfile();
  const db = await checkDb();
  const notes = assertProductionReadiness(profile);
  const refusals = notes.filter((note) => note.level === 'refusal');
  const warnings = notes.filter((note) => note.level === 'warning');

  const status = !db.ok ? 'error' : notes.length > 0 ? 'degraded' : 'ok';
  const httpStatus = status === 'error' ? 503 : 200;

  return {
    status: httpStatus,
    body: {
      status,
      checkedAt: now().toISOString(),
      environment: {
        environment: profile.environment,
        hostedOnVercel: profile.hostedOnVercel,
        commercial: profile.commercial,
        dogfoodNotice: profile.dogfood
          ? 'internal/non-commercial dogfood while the free tier is used (plan §7)'
          : null,
      },
      components: {
        db: { backend: profile.backends.db, ...db },
        queue: { backend: profile.backends.queue },
        cache: { backend: profile.backends.cache },
        lock: { backend: profile.backends.lock },
        email: { backend: profile.backends.email },
        blob: { backend: profile.backends.blob },
      },
      guardrails: profile.guardrails,
      readiness: {
        refusals: refusals.map((note) => note.message),
        warnings: warnings.map((note) => note.message),
      },
      worker: getWorkerMetrics(),
      processUptimeSeconds: Math.round(process.uptime()),
    },
  };
}
