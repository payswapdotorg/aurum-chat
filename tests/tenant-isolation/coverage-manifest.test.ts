// W044 — Tenant Isolation Verification · coverage tripwire.
//
// "Automated ... tests proving EVERY information-bearing module is
// tenant-safe" (work item W044). The sweeps prove the modules that exist
// TODAY; this test keeps that set honest tomorrow: every module directory
// under src/modules must be claimed by exactly one sweep file in
// tests/tenant-isolation/, and every claimed sweep file must exist.
//
// A failure here is not a bug in a module — it is a missing isolation proof:
// either a new module shipped without entering the coverage manifest, or an
// entry went stale. Both require action before review can pass.

import { describe, expect, it } from 'vitest';
import { existingModules, repoFileExists } from './harness';
import { SWEEP_COVERAGE } from './manifest';

describe('W044 coverage — every module is claimed by a tenant-isolation sweep', () => {
  it('claims every existing module exactly once', async () => {
    const modules = await existingModules();
    expect(modules.length).toBeGreaterThan(0);

    const claimed = Object.keys(SWEEP_COVERAGE).sort();
    const unclaimed = modules.filter((module) => !(module in SWEEP_COVERAGE));
    const stale = claimed.filter((module) => !modules.includes(module));

    expect(unclaimed, `modules without a tenant-isolation sweep: ${unclaimed.join(', ')}`).toEqual(
      [],
    );
    expect(stale, `manifest entries for modules that do not exist: ${stale.join(', ')}`).toEqual(
      [],
    );
    expect(claimed).toEqual(modules.sort());
  });

  it('points every claim at a sweep file that exists', () => {
    for (const [module, sweepFile] of Object.entries(SWEEP_COVERAGE)) {
      expect(
        repoFileExists(`tests/tenant-isolation/${sweepFile}`),
        `module '${module}' claims '${sweepFile}' but that file does not exist`,
      ).toBe(true);
    }
  });
});
