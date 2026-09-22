// W076 — the browser suite's global setup: the deterministic launch of the
// REAL application the journeys run against.
//
// Order of operations (each step fails loudly — a silent degradation here
// would fabricate the whole suite's meaning):
//
//   1. kill any stale server a crashed previous run left on the dedicated
//      port (scripts/browser-server.ts owns that glue);
//   2. RESET the demo world — remove .data (the embedded dev database)
//      and re-seed through the repository's own `bun run seed:demo`, so
//      every run walks the SAME deterministic W068 world with fresh ids
//      (journeys must discover ids through the UI, never hardcode them);
//   3. WIPE the evidence tree (screens/transcripts/errors) so whatever
//      lands there can only have come from THIS run — the structural
//      guarantee against recycled or fabricated screenshots;
//   4. START the dev server (next dev -p 3105, embedded backend) and
//      wait for /api/health;
//   5. PRE-WARM the dev compiler for the major routes (dev compiles on
//      first hit; warming keeps first navigation deterministic). The
//      pre-warm session is throwaway glue — the journeys themselves
//      authenticate through the real /signin quick-access panel;
//   6. return the teardown: stop the server deterministically.
//
// Why the server is managed HERE and not through Playwright's `webServer`
// config: the webServer plugin starts BEFORE globalSetup (verified against
// the installed runner's task order), and the server must never open the
// embedded database before the reset+seed completes.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  BROWSER_SERVER_BASE_URL,
  killStaleBrowserServer,
  startBrowserServer,
} from '../../scripts/browser-server';
import type { RunningBrowserServer } from '../../scripts/browser-server';

// The repo root is resolved from process.cwd() (the Playwright CLI runs
// from the repository root) — import.meta.url under Playwright's
// transform points at the cache copy, not this file.
const REPO_ROOT = (() => {
  const root = process.cwd();
  if (!existsSync(path.join(root, 'package.json'))) {
    throw new Error(`the browser suite must run from the repository root (cwd: ${root})`);
  }
  return root;
})();
/** The evidence artifacts directory (wiped every run — see the header). */
const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs/productization-evidence/W076');

/** The dev-clean environment for repo scripts (embedded backend only). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  delete env.REDIS_URL;
  env.AURUM_DB = 'embedded';
  return env;
}

/** Run one repository script to completion, failing loudly on anything else. */
async function runRepoScript(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (typeof child.stdout === 'object' && child.stdout !== null) {
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(`[w076-setup] ${String(chunk)}`);
    });
  }
  if (typeof child.stderr === 'object' && child.stderr !== null) {
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[w076-setup] ${String(chunk)}`);
    });
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${String(code)}`);
  }
}

/** Wipe and recreate the evidence tree (this run's artifacts only). */
async function resetEvidenceTree(): Promise<void> {
  for (const leaf of ['screens', 'transcripts', 'errors']) {
    await rm(path.join(EVIDENCE_DIR, leaf), { recursive: true, force: true });
    await mkdir(path.join(EVIDENCE_DIR, leaf), { recursive: true });
  }
}

/** One throwaway authenticated session for pre-warming (glue, not proof). */
async function prewarmSessionCookie(): Promise<string> {
  const response = await fetch(`${BROWSER_SERVER_BASE_URL}/api/auth/quick-sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ persona: 'manager' }),
  });
  if (!response.ok) {
    throw new Error(`pre-warm sign-in failed (${response.status})`);
  }
  const cookie = response.headers.get('set-cookie');
  if (cookie === null) {
    throw new Error('pre-warm sign-in issued no session cookie');
  }
  return /aurum_session=([^;]+)/.exec(cookie)?.[1] ?? '';
}

/**
 * Pre-warm the dev compiler: GET the major routes (anonymous + one
 * authenticated pass) so first test navigation is a warm cache hit.
 * Failures are tolerated per-route (permission-gated routes still warm
 * their compile on a 40x) — warming is latency hygiene, not proof.
 */
async function prewarmRoutes(): Promise<void> {
  const anonymous = ['/signin', '/signup', '/marketplace'];
  const token = await prewarmSessionCookie();
  const authenticated = [
    '/chat',
    '/more',
    '/intelligence',
    '/interventions',
    '/approvals',
    '/learning',
    '/explain',
    '/connections',
    '/ai',
    '/developer',
    '/people',
    '/today',
    '/goals',
    '/marketplace/installed',
  ];
  const get = async (route: string): Promise<void> => {
    try {
      await fetch(`${BROWSER_SERVER_BASE_URL}${route}`, {
        headers: { cookie: `aurum_session=${token}` },
        redirect: 'manual',
      });
    } catch {
      // Pre-warming only — a transport hiccup here is not a journey event.
    }
  };
  for (let index = 0; index < anonymous.length; index += 4) {
    await Promise.all(anonymous.slice(index, index + 4).map(get));
  }
  for (let index = 0; index < authenticated.length; index += 4) {
    await Promise.all(authenticated.slice(index, index + 4).map(get));
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  console.log(`[w076-setup] resetting the demo world (${BROWSER_SERVER_BASE_URL})`);
  await killStaleBrowserServer();

  // A fresh embedded database + the deterministic demo world.
  await rm(path.join(REPO_ROOT, '.data'), { recursive: true, force: true });
  await runRepoScript('bun', ['run', 'seed:demo'], 300_000);

  // This run's evidence only.
  await resetEvidenceTree();

  // The real application, on the dedicated port, healthy.
  const server: RunningBrowserServer = await startBrowserServer();
  await prewarmRoutes();
  console.log('[w076-setup] the application is live, seeded, and pre-warmed');

  return async () => {
    await server.stop();
    console.log('[w076-setup] the dev server was torn down');
  };
}
