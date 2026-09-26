// DEV ONLY: dump the full canonical S003 results (the deterministic
// measured inputs) for the offline calibration script.
//   bunx tsx tests/longitudinal/s003/dev-dump-results.ts /tmp/s003-results.json
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../../scripts/migrate';
import { canonicalJson, runS003Cohort } from './runner';

async function main(): Promise<void> {
  const out = process.argv[2] ?? '/tmp/s003-results.json';
  await runMigrations(getDb());
  const { results } = await runS003Cohort({});
  const fs = await import('node:fs');
  fs.writeFileSync(out, canonicalJson(results));
  console.log('written', out);
  await closeDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
