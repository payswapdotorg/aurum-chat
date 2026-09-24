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
//
// v2 (attempt 5): the manifest is rebuilt against CURRENT main — the prior
// delivery (PR #64) claimed only the 25 modules of its stale W034-era base
// and was reverted because this very tripwire fails on combined main. The
// 18 modules merged since (W031…W056 families) are now claimed; the two
// platform-surface modules (api, marketplace) get a dedicated
// platform-sweep file alongside the five domain-family sweeps.

export const SWEEP_COVERAGE: Record<string, string> = {
  actions: 'capability-sweep.test.ts',
  auth: 'foundation-sweep.test.ts',
  'agent-evaluation': 'capability-sweep.test.ts',
  'agent-recruitment': 'capability-sweep.test.ts',
  'agent-teams': 'capability-sweep.test.ts',
  agents: 'capability-sweep.test.ts',
  api: 'platform-sweep.test.ts',
  attention: 'evidence-sweep.test.ts',
  audit: 'foundation-sweep.test.ts',
  automation: 'cognition-sweep.test.ts',
  briefings: 'experience-sweep.test.ts',
  capabilities: 'cognition-sweep.test.ts',
  channels: 'experience-sweep.test.ts',
  cognition: 'cognition-sweep.test.ts',
  contributions: 'evidence-sweep.test.ts',
  conversations: 'experience-sweep.test.ts',
  demo: 'foundation-sweep.test.ts',
  'deployment-smoke': 'deployment-smoke-sweep.test.ts',
  destinations: 'experience-sweep.test.ts',
  environment: 'evidence-sweep.test.ts',
  epistemics: 'evidence-sweep.test.ts',
  events: 'foundation-sweep.test.ts',
  extensions: 'capability-sweep.test.ts',
  freshness: 'evidence-sweep.test.ts',
  goals: 'evidence-sweep.test.ts',
  identity: 'foundation-sweep.test.ts',
  'integration-intelligence': 'integration-intelligence-sweep.test.ts',
  'knowledge-acquisition': 'cognition-sweep.test.ts',
  'journey-proof': 'journey-proof-sweep.test.ts',
  learning: 'capability-sweep.test.ts',
  llm: 'experience-sweep.test.ts',
  marketplace: 'platform-sweep.test.ts',
  memory: 'evidence-sweep.test.ts',
  missions: 'cognition-sweep.test.ts',
  notifications: 'experience-sweep.test.ts',
  observations: 'evidence-sweep.test.ts',
  opportunities: 'cognition-sweep.test.ts',
  organizations: 'foundation-sweep.test.ts',
  outcomes: 'evidence-sweep.test.ts',
  people: 'foundation-sweep.test.ts',
  processes: 'cognition-sweep.test.ts',
  'provider-sdk': 'provider-sdk-sweep.test.ts',
  quality: 'evidence-sweep.test.ts',
  'release-certification': 'release-certification-sweep.test.ts',
  rewards: 'capability-sweep.test.ts',
  simulator: 'foundation-sweep.test.ts',
  sources: 'experience-sweep.test.ts',
  suppliers: 'cognition-sweep.test.ts',
  workforce: 'cognition-sweep.test.ts',
  workflow: 'workflow-sweep.test.ts',
  world: 'foundation-sweep.test.ts',
};
