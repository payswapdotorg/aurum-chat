// DEV ONLY (not part of the battery): run the FULL cohort once and print
// the calibration view (baseline vs mature by industry/size) plus the
// measured wall-clock runtime. Usage:
//   bunx tsx tests/longitudinal/s003/dev-cohort.ts
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../../scripts/migrate';
import { runS003Cohort } from './runner';

async function main(): Promise<void> {
  await runMigrations(getDb());
  const started = Date.now();
  const outcome = await runS003Cohort({
    determinismFirmKeys: ['sales-small', 'defense-large'],
  });
  const elapsed = Date.now() - started;
  const { baseline, mature, headline } = outcome.results.cohort;
  console.log('=== cohort ===');
  console.log('wall clock (ms):', elapsed, ' runner-reported (ms):', outcome.wallClockMs);
  console.log('professionals:', baseline.professionals);
  console.log('--- baseline by industry ---');
  for (const row of baseline.byIndustry) {
    console.log(
      row.industryKey.padEnd(16),
      'only', (row.aurumOnlyShare * 100).toFixed(1).padStart(6),
      'primary', (row.aurumPrimaryShare * 100).toFixed(1).padStart(6),
    );
  }
  console.log('--- baseline mean/percentile scores per industry ---');
  for (const firm of outcome.results.firms) {
    const scores = firm.baseline.professionals.map((p) => p.score).sort((a, b) => a - b);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(
      firm.key.padEnd(22),
      'mean', mean.toFixed(3),
      'p10', scores[Math.floor(scores.length * 0.1)]!.toFixed(3),
      'p50', scores[Math.floor(scores.length * 0.5)]!.toFixed(3),
      'p90', scores[Math.floor(scores.length * 0.9)]!.toFixed(3),
    );
  }
  console.log('--- baseline by size ---');
  for (const row of baseline.bySize) {
    console.log(
      row.sizeKey.padEnd(16),
      'only', (row.aurumOnlyShare * 100).toFixed(1).padStart(6),
      'primary', (row.aurumPrimaryShare * 100).toFixed(1).padStart(6),
    );
  }
  console.log('--- mature by industry ---');
  for (const row of mature.byIndustry) {
    console.log(
      row.industryKey.padEnd(16),
      'only', (row.aurumOnlyShare * 100).toFixed(1).padStart(6),
      'primary', (row.aurumPrimaryShare * 100).toFixed(1).padStart(6),
    );
  }
  console.log('--- mature by size ---');
  for (const row of mature.bySize) {
    console.log(
      row.sizeKey.padEnd(16),
      'only', (row.aurumOnlyShare * 100).toFixed(1).padStart(6),
      'primary', (row.aurumPrimaryShare * 100).toFixed(1).padStart(6),
    );
  }
  console.log('--- headline ---');
  console.log(JSON.stringify(headline, null, 1));
  console.log('--- determinism (byte-identical per re-run firm) ---');
  for (const [key, json] of Object.entries(outcome.determinismFirmJson)) {
    console.log(key, 'length', json.length, '(compare in test)');
  }
  await closeDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
