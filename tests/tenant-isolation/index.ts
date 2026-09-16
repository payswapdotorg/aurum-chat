// W044 — Tenant Isolation Verification: the complete probe registry.
//
// The runner (tests/tenant-isolation.test.ts) asserts that this registry
// covers EVERY information-bearing module discovered in src/modules — a new
// module with migrations fails the suite until it gets a probe, which is
// what keeps "every information-bearing module is tenant-safe" true rather
// than a snapshot of the modules that existed when W044 was delivered.

import type { ModuleProbe } from './harness';
import { foundationProbes } from './probes-foundation';
import { knowledgeProbes } from './probes-knowledge';
import { experienceProbes } from './probes-experience';

export const PROBES: ModuleProbe[] = [...foundationProbes, ...knowledgeProbes, ...experienceProbes]
  .sort((left, right) => left.module.localeCompare(right.module));

export { type ModuleProbe, type ModuleScene } from './harness';
