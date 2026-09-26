// DEV ONLY (not part of the battery): run a single firm through both
// scenarios and dump the canonical result, to iterate on the composed
// chain and measure per-firm runtime. Usage:
//   bunx tsx tests/longitudinal/s003/dev-one.ts [firmKey]
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../../scripts/migrate';
import { canonicalJson, runS003Cohort } from './runner';

async function main(): Promise<void> {
  const firmKey = process.argv[2] ?? 'sales-small';
  await runMigrations(getDb());
  const started = Date.now();
  const outcome = await runS003Cohort({ firmKeys: [firmKey] });
  const elapsed = Date.now() - started;
  const firm = outcome.results.firms[0]!;
  console.log('=== firm', firm.key, 'seed', firm.seed, '===');
  console.log(
    JSON.stringify(
      {
        headline: outcome.results.cohort.headline,
        baselineOnly: firm.baseline.professionals.filter((p) => p.willingOnly).length,
        baselinePrimary: firm.baseline.professionals.filter((p) => p.willingPrimary).length,
        matureOnly: firm.mature.professionals.filter((p) => p.willingOnly).length,
        maturePrimary: firm.mature.professionals.filter((p) => p.willingPrimary).length,
        roster: firm.baseline.professionals.length,
        loopBaseline: {
          months: firm.baseline.months.map((m) => [m.month, m.steps]),
          factors: firm.baseline.factors,
        },
        firstProfessionals: firm.baseline.professionals.slice(0, 3),
        loopRaw: {
          meanSteps: firm.baseline.loop.meanSteps,
          firstChoiceCorrectRate: firm.baseline.loop.firstChoiceCorrectRate,
          meanPredictionError: firm.baseline.loop.meanPredictionError,
          evidenceMeanConfidence: firm.baseline.loop.evidenceMeanConfidence,
          month1Error: firm.baseline.months[0]?.predictionErrorMean,
          participation: firm.baseline.loop.participationByRole,
        },
        composedMature: firm.mature.composed,
        measurementsMature: firm.mature.measurements,
        wallClockMs: elapsed,
      },
      null,
      1,
    ),
  );
  console.log('--- canonical json length:', canonicalJson(firm).length);
  await closeDb();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
