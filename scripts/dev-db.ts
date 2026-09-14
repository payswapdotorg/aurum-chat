// Dev convenience: boots the embedded (PGlite) database, applies all
// migrations, and prints the resulting table list.

import { closeDb, getDb } from '../src/infra/db';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  process.env.AURUM_DB = 'embedded'; // dev-db always boots the embedded database
  const db = getDb();
  const report = await runMigrations(db);
  const order = report.order.length > 0 ? report.order.join(' -> ') : '(no modules found)';
  console.log(`module order: ${order}`);
  console.log(`applied ${report.applied.length} migration(s), skipped ${report.skipped.length}`);
  const tables = (
    await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    )
  ).rows;
  console.log(`tables (${tables.length}):`);
  for (const table of tables) console.log(`  - ${table.table_name}`);
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
})();
