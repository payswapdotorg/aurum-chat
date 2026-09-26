// W100 — the S003 raw-results generator: runs the full cohort (both
// scenarios for every firm of the S002 population) through the real
// module contracts and writes the canonical, deterministic results
// document committed at tests/longitudinal/s003/results/s003-results.json.
//
//   bunx tsx tests/longitudinal/s003/generate.ts
//
// The document is a pure function of the committed seeds (no ids, no
// timestamps) — re-running reproduces it byte-identically, which the
// harness test asserts. The wall-clock runtime is measured and reported
// (never scored).

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../../scripts/migrate';
import { canonicalJson, runS003Cohort } from './runner';
import { interpretS003Results } from './interpret';

async function main(): Promise<void> {
  console.log('S003 generation: running the full cohort (11 industries x 3 sizes x 2 scenarios)...');
  await runMigrations(getDb());
  const { results, wallClockMs } = await runS003Cohort({});

  // Interpret against the schema of record BEFORE writing — the refusing
  // interpreter is the gate the committed document must pass.
  interpretS003Results(results);
  console.log('schema interpretation: PASSED (schemaVersion 1)');

  const outDir = fileURLToPath(new URL('./results/', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}s003-results.json`;
  const json = canonicalJson(results);
  writeFileSync(outPath, json);

  console.log(`written ${outPath} (${json.length} bytes)`);
  console.log(`wall-clock runtime: ${(wallClockMs / 1000).toFixed(1)}s for ${results.firms.length} firms x 2 scenarios`);
  console.log('--- headline ---');
  console.log(JSON.stringify(results.cohort.headline, null, 1));
  await closeDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
