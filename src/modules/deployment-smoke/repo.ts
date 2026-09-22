// The repo-layer smoke checks (read-only filesystem verification of the
// repository's operations surface — never executed against the target).
//
// W078 acceptance obligations that live in the REPOSITORY rather than in
// a running deployment: "deployment rollback is documented", parts of
// "environment separation is verified", and the browser-journey layer's
// registration. These are file-content invariants — the same artifacts
// an operator follows during an incident — verified programmatically so
// the smoke report proves the runbook EXISTS and covers the documented
// cases, rather than trusting prose.
//
// Read-only: node:fs/promises reads under the provided repo root; no
// writes, no execution, no network. The demo-gate check is a PURE call
// into the demo module's public contract (the same gate every seeding
// run passes — W068's "no production backdoor" acceptance).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateDemoSeedGate } from '@/modules/demo/contract';

/** One repo-layer check outcome (empty reasons = pass). */
export interface RepoCheckOutcome {
  reasons: string[];
  evidence: Record<string, unknown>;
}

async function readIfExists(repoRoot: string, relative: string): Promise<string | null> {
  try {
    return await readFile(path.join(repoRoot, relative), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The rollback runbook (docs/DEPLOYMENT.md §12) must document all four
 * recovery cases: promoting a known-good deployment (code-level),
 * fixing a bad environment variable, restoring from a database
 * branch/snapshot (data/migration), and rebuilding the whole
 * environment from code.
 */
export async function checkRollbackRunbook(repoRoot: string): Promise<RepoCheckOutcome> {
  const deployment = await readIfExists(repoRoot, path.join('docs', 'DEPLOYMENT.md'));
  const reasons: string[] = [];
  if (deployment === null) {
    return { reasons: ['docs/DEPLOYMENT.md is absent'], evidence: {} };
  }
  const rollbackSection = /## 12\. Rollback/.exec(deployment);
  if (rollbackSection === null) {
    reasons.push('the deployment runbook has no §12 Rollback section');
  }
  const expectations: [string, string][] = [
    ['code-level promotion', 'Promote to Production'],
    ['known-good redeploy command', 'vercel redeploy'],
    ['environment-variable recovery', 'Environment Variables'],
    ['data/migration recovery', 'Neon branching'],
    ['whole-environment rebuild', 're-creatable from code'],
  ];
  for (const [label, needle] of expectations) {
    if (!deployment.includes(needle)) {
      reasons.push(`the rollback documentation does not cover ${label} ('${needle}' not found)`);
    }
  }
  return { reasons, evidence: { runbook: 'docs/DEPLOYMENT.md §12 (Rollback)' } };
}

/**
 * A known-good production deployment uid must be recorded (the promote
 * target of the code-level rollback path — W077's as-deployed record).
 */
export async function checkKnownGoodDeployment(repoRoot: string): Promise<RepoCheckOutcome> {
  const deployment = await readIfExists(repoRoot, path.join('docs', 'DEPLOYMENT.md'));
  const reasons: string[] = [];
  if (deployment === null) {
    return { reasons: ['docs/DEPLOYMENT.md is absent'], evidence: {} };
  }
  const deploymentUid = /dpl_[A-Za-z0-9]+/.exec(deployment);
  const ready = /READY/.exec(deployment);
  if (deploymentUid === null) {
    reasons.push('no deployment uid (dpl_…) is recorded as the known-good promote target');
  }
  if (ready === null) {
    reasons.push('no READY deployment state is recorded');
  }
  return {
    reasons,
    evidence: { knownGood: deploymentUid === null ? null : deploymentUid[0] },
  };
}

/**
 * CI must run the four repository gates (typecheck, lint, architecture,
 * tests) before anything deploys — the release checks of the delivery
 * protocol (IMPLEMENTATION-STACK §7/§9).
 */
export async function checkCiGates(repoRoot: string): Promise<RepoCheckOutcome> {
  const workflow = await readIfExists(
    repoRoot,
    path.join('.github', 'workflows', 'ci.yml'),
  );
  const reasons: string[] = [];
  if (workflow === null) {
    return { reasons: ['.github/workflows/ci.yml is absent'], evidence: {} };
  }
  for (const gate of ['bun run typecheck', 'bun run lint', 'bun run arch', 'bun run test']) {
    if (!workflow.includes(gate)) {
      reasons.push(`CI does not run '${gate}'`);
    }
  }
  return { reasons, evidence: { gates: ['typecheck', 'lint', 'arch', 'test'] } };
}

/**
 * The deployment configuration must migrate before every build (the
 * free-tier pipeline: `vercel:build` = migrate + next build) and keep
 * the bounded daily worker sweep (cron → /api/worker — recovery, never
 * the primary cognition trigger).
 */
export async function checkDeploymentConfig(repoRoot: string): Promise<RepoCheckOutcome> {
  const reasons: string[] = [];
  const vercelJson = await readIfExists(repoRoot, 'vercel.json');
  if (vercelJson === null) {
    reasons.push('vercel.json is absent');
  } else {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(vercelJson) as unknown;
    } catch {
      reasons.push('vercel.json is not valid JSON');
    }
    if (parsed !== null && typeof parsed === 'object' && parsed !== null) {
      const config = parsed as Record<string, unknown>;
      if (config['buildCommand'] !== 'bun run vercel:build') {
        reasons.push(`unexpected buildCommand '${String(config['buildCommand'])}'`);
      }
      const crons = Array.isArray(config['crons']) ? config['crons'] : [];
      const workerCron = crons.find((entry) => {
        if (typeof entry !== 'object' || entry === null) return false;
        return (entry as Record<string, unknown>)['path'] === '/api/worker';
      });
      if (workerCron === undefined) {
        reasons.push('no cron sweeps /api/worker (the bounded recovery mechanism)');
      } else if (
        (workerCron as Record<string, unknown>)['schedule'] !== '0 3 * * *'
      ) {
        reasons.push(
          `the worker sweep schedule is '${String((workerCron as Record<string, unknown>)['schedule'])}' (expected the bounded daily 0 3 * * *)`,
        );
      }
    }
  }
  const packageJson = await readIfExists(repoRoot, 'package.json');
  if (packageJson === null) {
    reasons.push('package.json is absent');
  } else {
    try {
      const pkg = JSON.parse(packageJson) as { scripts?: Record<string, string> };
      const vercelBuild = pkg.scripts?.['vercel:build'];
      if (vercelBuild === undefined || !vercelBuild.includes('migrate')) {
        reasons.push("the 'vercel:build' script does not run migrations before the build");
      }
    } catch {
      reasons.push('package.json is not valid JSON');
    }
  }
  return { reasons, evidence: { buildCommand: 'bun run vercel:build', cron: '0 3 * * * → /api/worker' } };
}

/**
 * The real-browser journey layer (W076) must be wired and evidenced in
 * this repository — the suite that re-runs against the hosted dogfood
 * once the documented provider gaps close (bullet: "browser journeys
 * pass on production dogfood").
 */
export async function checkBrowserSuiteRegistered(repoRoot: string): Promise<RepoCheckOutcome> {
  const reasons: string[] = [];
  const packageJson = await readIfExists(repoRoot, 'package.json');
  if (packageJson === null) {
    reasons.push('package.json is absent');
    return { reasons, evidence: {} };
  }
  try {
    const pkg = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    const journeyScript = pkg.scripts?.['browser:journeys'];
    if (journeyScript === undefined) {
      reasons.push("the 'browser:journeys' command is not registered");
    }
  } catch {
    reasons.push('package.json is not valid JSON');
    return { reasons, evidence: {} };
  }
  const playwrightConfig = await readIfExists(repoRoot, 'playwright.config.ts');
  if (playwrightConfig === null) {
    reasons.push('playwright.config.ts is absent');
  } else if (!playwrightConfig.includes('tests/browser')) {
    reasons.push('the playwright config does not target tests/browser');
  }
  const evidence = await readIfExists(
    repoRoot,
    path.join('docs', 'productization-evidence', 'W076', 'W076-CONFORMANCE-REPORT.md'),
  );
  if (evidence === null) {
    reasons.push('the W076 browser conformance evidence is absent');
  }
  return {
    reasons,
    evidence: {
      command: 'bun run browser:journeys',
      suite: 'tests/browser/** (desktop 1280×800 + mobile 390×844/touch)',
    },
  };
}

/**
 * Environment separation, demo-gate side (pure — the W068 contract every
 * seeding run passes): the demo world must be refused on production
 * runtimes and production-like backends, and allowed only in the
 * isolated memory test mode — the demo population can never reach a
 * hosted production environment ("no production backdoor").
 */
export async function checkDemoGateSeparation(): Promise<RepoCheckOutcome> {
  const reasons: string[] = [];
  const gate = (input: Partial<Parameters<typeof evaluateDemoSeedGate>[0]>) =>
    evaluateDemoSeedGate({
      backend: undefined,
      databaseUrl: undefined,
      memoryMode: false,
      optIn: false,
      nodeEnv: 'development',
      ...input,
    });
  if (gate({ nodeEnv: 'production' }).allowed) {
    reasons.push('the demo seed gate does not refuse a production runtime');
  }
  if (gate({ databaseUrl: 'postgres://example/aurum' }).allowed) {
    reasons.push('the demo seed gate does not refuse a server database');
  }
  if (gate({ backend: 'postgres' }).allowed) {
    reasons.push('the demo seed gate does not refuse AURUM_DB=postgres');
  }
  if (!gate({ memoryMode: true }).allowed) {
    reasons.push('the demo seed gate refuses the legal memory test mode');
  }
  return {
    reasons,
    evidence: { gate: 'evaluateDemoSeedGate (src/modules/demo/contract)' },
  };
}

/**
 * Environment separation, runbook side: the deployment runbook must
 * document the preview/staging/production matrix (docs/DEPLOYMENT.md §3).
 */
export async function checkEnvironmentMatrix(repoRoot: string): Promise<RepoCheckOutcome> {
  const reasons: string[] = [];
  const deployment = await readIfExists(repoRoot, path.join('docs', 'DEPLOYMENT.md'));
  if (deployment === null) {
    return { reasons: ['docs/DEPLOYMENT.md is absent'], evidence: {} };
  }
  if (!/## 3\. Environment separation/.test(deployment)) {
    reasons.push('the runbook has no §3 environment-separation section');
  }
  for (const row of ['preview', 'staging', 'production']) {
    if (!deployment.includes(row)) {
      reasons.push(`the environment matrix does not mention '${row}'`);
    }
  }
  return { reasons, evidence: { matrix: 'docs/DEPLOYMENT.md §3' } };
}
