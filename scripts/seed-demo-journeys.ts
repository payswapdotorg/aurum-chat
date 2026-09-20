// W068 — the demo journey seed script.
//
// Boots the file-backed embedded dev database (PGlite at .data/aurum.pg —
// the same database `bun run dev` serves), applies all module migrations,
// seeds the deterministic demo dataset (guarded — see
// src/modules/demo/guard.ts) and prints the verification manifest: the
// demo companies, the four sign-in accounts and what each role can see.
//
// Usage:
//   AURUM_DEMO_SEED=1 bun run seed:demo
//
// The opt-in is explicit on purpose: the demo dataset must never appear
// in an ordinary dev database as a side effect, and the harness itself
// additionally refuses to run whenever DATABASE_URL points at a real
// server (no production backdoor). Re-running is idempotent — every
// anchor is matched and reused, never duplicated.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '';
process.env.AURUM_DEMO_SEED = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { closeDb, getDb } from '../src/infra/db';
import { runMigrations } from './migrate';
import {
  capabilitiesForRole,
  demoRoleDirectory,
  demoSharedPassword,
  seedDemoHarness,
} from '../src/modules/demo/contract';

async function main(): Promise<void> {
  const db = getDb();
  await runMigrations(db);
  const report = await seedDemoHarness();

  const line = '-'.repeat(72);
  console.log(line);
  console.log(
    report.status === 'created'
      ? `demo harness seeded — ${report.createdAnchors.length} anchor(s) created, ${report.reusedAnchors.length} reused`
      : 'demo dataset already present — every anchor reused (idempotent re-run)',
  );
  console.log(line);

  const { manifest } = report;
  console.log('DEMO COMPANIES');
  for (const company of Object.values(manifest.companies)) {
    console.log(`  ${company.name} (${company.tenantId})`);
  }

  console.log('DEMO ACCOUNTS (sign in at /signin)');
  for (const entry of demoRoleDirectory()) {
    const account = manifest.accounts[entry.role];
    console.log(`  [${entry.role}] ${account.email} — ${account.displayName}`);
    console.log(`      company: ${account.tenantName} · verified tenant role: ${account.tenantRole}`);
  }
  console.log(`  shared demo password: ${demoSharedPassword()}`);
  console.log('  (non-production credential: the guard refuses to seed any server database)');

  console.log('ROLE CAPABILITY VISIBILITY');
  for (const role of ['manager', 'employee', 'developer', 'platform-reviewer'] as const) {
    const visible = capabilitiesForRole(role)
      .filter((capability) => capability.visible)
      .map((capability) => capability.key);
    console.log(`  ${role}: ${visible.join(', ')}`);
  }

  console.log('JOURNEY ANCHORS');
  console.log(`  goals:            ${manifest.goals.map((goal) => goal.title).join(' | ')}`);
  console.log(`  unknown:          ${manifest.unknown?.question ?? '—'}`);
  console.log(`  mission:          ${manifest.mission?.title ?? '—'} (${manifest.mission?.status ?? '—'})`);
  console.log(`  process:          ${manifest.process?.name ?? '—'} v${manifest.process?.version ?? 0} (${manifest.process?.findingCount ?? 0} findings)`);
  console.log(`  conversation:     ${manifest.conversation?.messageCount ?? 0} message(s)`);
  console.log(`  pending approvals:${manifest.pendingApprovals.map((request) => request.actionKind).join(', ') || '—'}`);
  console.log(`  contribution:     ${manifest.contribution?.status ?? '—'}`);
  console.log(`  reward:           ${manifest.reward?.status ?? '—'} (${manifest.reward?.kind ?? '—'})`);
  console.log(`  marketplace:      installable=${manifest.marketplace.installableExtension?.state}, pending-review=${manifest.marketplace.pendingReview?.state}`);
  console.log(`  installed:        extension=${manifest.marketplace.installedExtensionKey} (${manifest.marketplace.installedExtensionState}), agent=${manifest.marketplace.installedAgentSlug}`);
  console.log(`  llm account:      ${manifest.llmAccount?.provider}:${manifest.llmAccount?.label} (${manifest.llmExecution?.status})`);
  console.log(`  api key:          ${manifest.apiKey?.label ?? '—'} · webhook: ${manifest.webhook?.label ?? '—'}`);
  console.log(`  invite:           ${manifest.invite?.email ?? '—'} (${manifest.invite?.status ?? '—'})`);
  console.log(line);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
