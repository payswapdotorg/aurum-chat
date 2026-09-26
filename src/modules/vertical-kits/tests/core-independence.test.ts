// The core-independence probe (W092's acceptance clause: "core modules
// remain industry-independent") — a grep-level repository scan this
// module OWNS, reading its OWN kit data:
//
//   1. REPOSITORY SCAN — no kit-content term (derived mechanically from
//      the registered kit records: kit keys, industry labels, extension
//      keys, recipe keys, connection keys/labels, system-of-record
//      labels, synthetic origins) may appear in ANY other module under
//      src/modules or ANY product/tower surface under src/app — with
//      exactly two sanctioned exceptions, this module itself and the
//      W092 route tree that renders it (both excluded from the scan).
//      Vertical semantics never enter core.
//
//   2. MODULE-LOGIC SCAN — the same terms may not appear in this
//      module's OWN logic files either (contract, errors, service,
//      validation, types, compose, the migration): the terms live in
//      kits.ts — the DATA — and nowhere else. The module's code is
//      industry-blind by construction; a term leaking into logic would
//      be vertical branching smuggled into generic code.
//
// (The module's and the route tree's TESTS legitimately exercise the
// kit data by key — tests are proof obligations, not shipped logic —
// and the repository-level test harnesses under tests/ that install
// kits are this module's own acceptance probes. Neither is core.)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KIT_REGISTRY } from '../contract';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Every source file under a root, recursively. */
function sourceFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        out.push(entryPath);
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// The terms: derived mechanically from the module's own kit data
// ---------------------------------------------------------------------------

/** Distinctive kit-content terms — never module/route naming. */
function kitContentTerms(): string[] {
  const terms = new Set<string>();
  for (const kit of KIT_REGISTRY) {
    terms.add(kit.kitKey);
    terms.add(kit.metadata.industry);
    for (const connection of kit.connectionRequirements) {
      terms.add(connection.key);
      terms.add(connection.label);
    }
    for (const spec of kit.extensionManifests) {
      terms.add(spec.manifest.extensionKey);
      terms.add(spec.systemOfRecord);
      for (const participant of spec.manifest.externalParticipants ?? []) {
        terms.add(participant.origin);
      }
    }
    for (const recipe of kit.deepActionRecipes) {
      terms.add(recipe.recipeKey);
    }
  }
  return [...terms].filter((term) => term.length >= 8); // nothing trivially generic
}

const TERMS = kitContentTerms();

/** The module's own tree and its route tree — the sanctioned homes of the content. */
const OWN_MODULE_DIR = join(REPO_ROOT, 'src/modules/vertical-kits');
const OWN_ROUTE_DIR = join(REPO_ROOT, 'src/app/(tower)/vertical-kits');

/** The module's LOGIC files (the data file kits.ts is the term's home). */
function moduleLogicFiles(): string[] {
  return sourceFilesUnder(OWN_MODULE_DIR).filter(
    (file) =>
      !file.includes(`${join('vertical-kits', 'kits.ts')}`) &&
      !file.includes(join('vertical-kits', 'tests')),
  );
}

function relative(file: string): string {
  return file.slice(REPO_ROOT.length + 1);
}

// ---------------------------------------------------------------------------
// 1. The repository scan — vertical semantics never enter core
// ---------------------------------------------------------------------------

describe('the core-independence repository scan (W092 acceptance)', () => {
  it('derives real kit-content terms from the shipped data (the probe has teeth)', () => {
    expect(TERMS.length).toBeGreaterThanOrEqual(12);
    expect(TERMS).toContain('professional-services');
    expect(TERMS).toContain('logistics-operations');
    expect(TERMS.some((term) => term.includes('example.test'))).toBe(true);
  });

  it('no kit-content term appears in ANY other module under src/modules', () => {
    const offenders: string[] = [];
    for (const file of sourceFilesUnder(join(REPO_ROOT, 'src/modules'))) {
      if (file.startsWith(OWN_MODULE_DIR)) continue; // this module's own tree
      const content = readFileSync(file, 'utf8');
      for (const term of TERMS) {
        if (content.includes(term)) offenders.push(`${relative(file)} → '${term}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no kit-content term appears in ANY product or tower surface under src/app', () => {
    const offenders: string[] = [];
    for (const file of sourceFilesUnder(join(REPO_ROOT, 'src/app'))) {
      if (file.startsWith(OWN_ROUTE_DIR)) continue; // the W092 route tree's own files
      const content = readFileSync(file, 'utf8');
      for (const term of TERMS) {
        if (content.includes(term)) offenders.push(`${relative(file)} → '${term}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // 2. The module-logic scan — this module's code is industry-blind too.

  it('no kit-content term appears in this module\'s own LOGIC (the terms live in kits.ts, the data)', () => {
    const offenders: string[] = [];
    for (const file of moduleLogicFiles()) {
      const content = readFileSync(file, 'utf8');
      for (const term of TERMS) {
        if (content.includes(term)) offenders.push(`${relative(file)} → '${term}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
