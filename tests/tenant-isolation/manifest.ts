// W044 — Tenant Isolation Verification · coverage manifest.
//
// Maps every module under src/modules to the sweep file that proves it
// tenant-safe. The coverage test below fails whenever:
//   * a NEW module directory appears under src/modules without a sweep
//     entry (a future work item must extend the sweeps — "every
//     information-bearing module is tenant-safe" is a living obligation,
//     not a one-time snapshot);
//   * a manifest entry goes stale (module removed or sweep file deleted).
// Module code is never imported here — this is a static repository check.

export const SWEEP_COVERAGE: Record<string, string> = {
  actions: 'capability-sweep.test.ts',
  agents: 'capability-sweep.test.ts',
  attention: 'evidence-sweep.test.ts',
  capabilities: 'cognition-sweep.test.ts',
  channels: 'experience-sweep.test.ts',
  cognition: 'cognition-sweep.test.ts',
  conversations: 'experience-sweep.test.ts',
  epistemics: 'evidence-sweep.test.ts',
  events: 'foundation-sweep.test.ts',
  extensions: 'capability-sweep.test.ts',
  freshness: 'evidence-sweep.test.ts',
  goals: 'evidence-sweep.test.ts',
  identity: 'foundation-sweep.test.ts',
  'knowledge-acquisition': 'cognition-sweep.test.ts',
  learning: 'capability-sweep.test.ts',
  llm: 'experience-sweep.test.ts',
  memory: 'evidence-sweep.test.ts',
  missions: 'cognition-sweep.test.ts',
  notifications: 'experience-sweep.test.ts',
  observations: 'evidence-sweep.test.ts',
  organizations: 'foundation-sweep.test.ts',
  people: 'foundation-sweep.test.ts',
  processes: 'cognition-sweep.test.ts',
  sources: 'experience-sweep.test.ts',
  world: 'foundation-sweep.test.ts',
};
