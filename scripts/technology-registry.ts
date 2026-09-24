// W089 — the OSS technology registry review CLI (Tech Lead surface).
//
// Reads the committed registry through the provider-sdk contract (the only
// legal import path) and prints entries or the review summary:
//
//   bun scripts/technology-registry.ts                       # every entry
//   bun scripts/technology-registry.ts --summary             # review summary + due-diligence backlog
//   bun scripts/technology-registry.ts --capability realtime-media
//   bun scripts/technology-registry.ts --status candidate
//   bun scripts/technology-registry.ts --priority P0
//   bun scripts/technology-registry.ts --entry livekit
//
// Read-only: the registry changes only through reviewable commits to
// src/modules/provider-sdk/registry/technologies.json.

import {
  findTechnologyEntry,
  listTechnologyEntries,
  listTechnologyEntriesByAdapterStatus,
  listTechnologyEntriesByCapability,
  listTechnologyEntriesByPriority,
  technologyRegistryReviewSummary,
  type TechnologyRegistryEntry,
} from '../src/modules/provider-sdk/contract';

interface CliOptions {
  summary: boolean;
  capability: string | null;
  status: string | null;
  priority: string | null;
  entry: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { summary: false, capability: null, status: null, priority: null, entry: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--summary') options.summary = true;
    else if (arg === '--capability') options.capability = argv[++index] ?? null;
    else if (arg === '--status') options.status = argv[++index] ?? null;
    else if (arg === '--priority') options.priority = argv[++index] ?? null;
    else if (arg === '--entry') options.entry = argv[++index] ?? null;
    else {
      console.error(`unknown argument '${arg}' (usage: --summary | --capability <c> | --status <s> | --priority <p> | --entry <id>)`);
      process.exit(2);
    }
  }
  return options;
}

function line(label: string, value: string | null): string {
  return `  ${label.padEnd(16)}${value ?? '—'}`;
}

function printEntry(entry: TechnologyRegistryEntry): void {
  console.log(`\n◆ ${entry.technology} (${entry.entryId}) — ${entry.capability}`);
  console.log(line('summary', entry.summary));
  console.log(line('priority', entry.priority ?? 'unranked (adopted/not ranked)'));
  console.log(line('license', `${entry.license.source}${entry.license.spdx === null ? '' : ` (${entry.license.spdx})`}`));
  if (entry.license.notes !== null) console.log(line('license notes', entry.license.notes));
  console.log(line('security', entry.security.posture));
  console.log(line('maintenance', entry.maintenance.health));
  console.log(line('operations', `${entry.operations.fit}${entry.operations.deployment === null ? '' : ` · ${entry.operations.deployment}`}`));
  if (entry.operations.notes !== null) console.log(line('ops notes', entry.operations.notes));
  console.log(line('data handling', entry.dataHandling.summary));
  console.log(line('cost/perf', entry.costPerformance.summary));
  for (const mode of entry.failureModes) console.log(line('failure mode', mode));
  console.log(line('exit path', entry.exitStrategy.replacementPath));
  console.log(line('adapter status', entry.adapterStatus));
  console.log(line('adapter module', entry.adapterModule));
  console.log(line('last reviewed', `${entry.lastReviewed} by ${entry.reviewedBy}`));
  for (const source of entry.sources) console.log(line('source', source));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.summary) {
    const summary = technologyRegistryReviewSummary();
    console.log('Aurum OSS technology registry — review summary');
    console.log(`  total entries: ${summary.totalEntries}`);
    console.log(`  by adapter status: ${Object.entries(summary.byAdapterStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`  by priority: ${Object.entries(summary.byPriority).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`  capabilities: ${summary.capabilities.join(', ')}`);
    console.log(`\n  §15 due-diligence backlog (${summary.pendingDueDiligence.length} entries with unassessed fields):`);
    for (const pending of summary.pendingDueDiligence) {
      console.log(`    · ${pending.entryId}: missing ${pending.missingFields.join(', ')}`);
    }
    return;
  }

  let entries: TechnologyRegistryEntry[];
  if (options.entry !== null) {
    const found = findTechnologyEntry(options.entry);
    if (found === null) {
      console.error(`no registry entry '${options.entry}'`);
      process.exit(1);
    }
    entries = [found];
  } else if (options.capability !== null) {
    entries = listTechnologyEntriesByCapability(options.capability);
  } else if (options.status !== null) {
    entries = listTechnologyEntriesByAdapterStatus(options.status as never);
  } else if (options.priority !== null) {
    entries = listTechnologyEntriesByPriority(options.priority as never);
  } else {
    entries = listTechnologyEntries();
  }

  if (entries.length === 0) {
    console.log('no matching registry entries');
    return;
  }
  console.log(`Aurum OSS technology registry — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
  for (const entry of entries) printEntry(entry);
  console.log('');
}

main();
