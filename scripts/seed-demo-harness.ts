// W068 demo-harness seed — populates the file-backed embedded dev database
// (`.data/aurum.pg`) with the deterministic demo world so the product
// surfaces can be verified in the browser:
//
//   * three seeded tenants — the demo company (Meridian Roasters), a
//     marketplace vendor (Copperline Labs) and the platform review tenant;
//   * four sign-in personas mapped onto the real tenant-role ladder —
//     manager (owner), employee (member), developer (admin) and the
//     platform reviewer (platform-tenant admin);
//   * deterministic journey data for every major journey (plan §2 A–L):
//     goals, an unprompted discovery run (unknown + mission), a canonical
//     cognition cycle suspended at the approval gate, process findings, a
//     capability gap, a retained contradiction, a validated contribution
//     with a gated reward, connections, two BYOA accounts, an agent and a
//     recruitment proposal, a governed marketplace chain (one INSTALLABLE
//     package installed, one PENDING_REVIEW package for the platform
//     queue) and the developer API/webhook surface.
//
// Everything goes through module contracts only. The run is idempotent
// per anchor: re-running skips what the first run recorded. If a run is
// interrupted in the single-await window between provisioning a tenant
// and recording its anchor, re-running cannot recover that tenant —
// reset the demo database (`rm -rf .data`) and re-seed.
//
// NON-PRODUCTION ONLY (the work item's "no production backdoor"
// acceptance): the script refuses loudly when a server database is
// configured (DATABASE_URL / AURUM_DB=postgres) — it never silently
// retargets a caller's production configuration — and then forces the
// embedded backend with the explicit AURUM_DEMO_SEED opt-in. The
// module-side gate re-checks everything regardless of what the caller
// sets.

if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL.trim() !== '') {
  console.error(
    'REFUSED: DATABASE_URL is set — the demo harness never seeds a server database. ' +
      'Unset it to seed the embedded dev database (.data/aurum.pg).',
  );
  process.exit(1);
}
if (process.env.AURUM_DB === 'postgres') {
  console.error(
    'REFUSED: AURUM_DB=postgres — the demo harness never seeds a server database. ' +
      'Use the embedded backend to seed the embedded dev database (.data/aurum.pg).',
  );
  process.exit(1);
}

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
process.env.AURUM_DEMO_SEED = process.env.AURUM_DEMO_SEED ?? '1';

import { closeDb, getDb } from '../src/infra/db';
import { runMigrations } from './migrate';
import { seedDemoHarness } from '../src/modules/demo/contract';
import { demoPersonaPassword } from '../src/modules/demo/contract';

async function main(): Promise<void> {
  const db = getDb();
  await runMigrations(db);
  const report = await seedDemoHarness();

  console.log('--- demo harness seeded ---');
  console.log(`anchors: ${String(report.created)} created, ${String(report.skipped)} skipped (idempotent re-run)`);
  console.log('tenants:');
  for (const tenant of report.tenants) {
    console.log(`  ${tenant.key.padEnd(9)} ${tenant.name} (slug ${tenant.slug}, id ${tenant.id})`);
  }
  console.log('personas (sign in at /signin):');
  for (const persona of report.personas) {
    const tenant =
      persona.tenantKey === 'platform' ? 'aurum-platform-review-demo' : 'meridian-roasters-demo';
    console.log(
      `  ${persona.role.padEnd(17)} ${persona.email}  (tenant role ${persona.tenantRole} in ${tenant})`,
    );
  }
  console.log(`demo password (all personas): ${demoPersonaPassword()}`);
  console.log('journeys:');
  for (const journey of report.journeys) {
    console.log(`  ${journey.id.padEnd(24)} ${String(journey.anchors.length)} anchors`);
  }
  console.log('pending approvals (the manager decides these in the browser):');
  for (const approval of report.pendingApprovals) {
    console.log(`  ${approval.actionKind.padEnd(22)} ${approval.requestId}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
