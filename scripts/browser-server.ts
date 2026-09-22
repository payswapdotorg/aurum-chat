// W076 — the real-browser suite's server launch glue.
//
// Owns exactly what the work item's harness requirements demand:
//   * a DEDICATED PORT (3105, overridable via W076_PORT) for the dev
//     server, never the default 3000;
//   * `next dev` on the embedded backend with a cleaned environment
//     (DATABASE_URL/REDIS_URL stripped, AURUM_DB=embedded) so the app
//     runs exactly as the repository's dev flow does against the seeded
//     demo world at .data/aurum.pg;
//   * a wait-for-health gate (GET /api/health until 200);
//   * deterministic teardown (SIGTERM to the server's process group,
//     escalate to SIGKILL, then wait for the port to actually close);
//   * stale-server recovery: a crashed previous run leaves its pid file —
//     the next run kills it before binding (the port is dedicated to
//     this harness, so a process holding it can only be ours).
//
// The module is imported by tests/browser/global-setup.ts and is also a
// small CLI for manual use:
//   bun scripts/browser-server.ts start   (blocks until healthy)
//   bun scripts/browser-server.ts stop

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The dedicated port of the W076 browser-verification server. */
export const BROWSER_SERVER_PORT = Number(process.env.W076_PORT ?? 3105);
/** The base URL every browser journey runs against. */
export const BROWSER_SERVER_BASE_URL = `http://localhost:${BROWSER_SERVER_PORT}`;
/** Where the running server's pid is recorded (killed by the next run). */
const PID_FILE = path.join('tests/browser', '.server.pid');

function repoRoot(): string {
  // NOTE: deliberately resolved from process.cwd(), never import.meta.url —
  // Playwright transpiles imported TS through its transform cache, where
  // import.meta.url points at the cached copy and a cwd derived from it
  // makes every spawn fail with a misleading ENOENT.
  const root = process.cwd();
  if (!existsSync(path.join(root, 'package.json'))) {
    throw new Error(`the browser-server glue must run from the repository root (cwd: ${root})`);
  }
  return root;
}

/** The child-process environment: the embedded backend, nothing external. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  delete env.REDIS_URL;
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;
  delete env.KV_REST_API_URL;
  delete env.KV_REST_API_TOKEN;
  env.AURUM_DB = 'embedded';
  // W074 note (same launch-glue fix family): bound the dev server's V8
  // heap on small verification hosts. V8 grows lazily toward its
  // ceiling before collecting; unbounded, the route worker's RSS climbs
  // ~2-3MB per request and the kernel OOM-kills it mid-suite on a 4GB
  // host sharing memory with the browser pool (observed at ~2.5GB after
  // ~25 journeys, ERR_CONNECTION_REFUSED for every later test). A tight
  // ceiling (700MB) forces collection early and keeps the worker flat
  // (~250MB of growth over 1000 mixed requests, decelerating); PGlite's
  // WASM/buffers live outside V8 below the kill threshold. An
  // operator-provided NODE_OPTIONS always wins.
  if (env.NODE_OPTIONS === undefined || env.NODE_OPTIONS === '') {
    env.NODE_OPTIONS = '--max-old-space-size=700';
  }
  return env;
}

function pidFile(): string {
  return path.join(repoRoot(), PID_FILE);
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${BROWSER_SERVER_BASE_URL}/api/health`;
  for (;;) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // Not up yet — keep polling until the deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(`the dev server did not become healthy within ${timeoutMs}ms (${healthUrl})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** True while the dedicated port still answers (someone is listening). */
async function portIsLive(): Promise<boolean> {
  try {
    const response = await fetch(`${BROWSER_SERVER_BASE_URL}/api/health`);
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

/** Kill a stale server left behind by a crashed run (pid file + pattern). */
export async function killStaleBrowserServer(): Promise<void> {
  const file = pidFile();
  if (existsSync(file)) {
    const raw = (await readFile(file, 'utf8')).trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone — the pid file is stale, nothing to kill.
      }
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // Not a group leader (or gone) — the direct kill above suffices.
      }
    }
    await rm(file, { force: true });
  }
  // Belt and braces: wait for the port to close before binding again.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await portIsLive())) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `something is still listening on ${BROWSER_SERVER_BASE_URL} — the W076 port is dedicated to this harness; stop it and re-run`,
  );
}

export interface RunningBrowserServer {
  /** The dev-server child process. */
  child: import('node:child_process').ChildProcess;
  /** Deterministic teardown: SIGTERM the group, escalate, verify closed. */
  stop: () => Promise<void>;
}

/**
 * Start the dev server on the dedicated port and wait for health.
 * Console output is piped through with a prefix so a server-side crash
 * is visible in the suite's own log.
 *
 * W074 note (launch-glue fix, documented in the delivery report): the
 * dev-server CHILD is spawned with `node` (falling back to `bun` only
 * when node is absent). Bun remains the runner of the harness itself
 * (`bun run browser:journeys` → playwright CLI → this global setup), but
 * as the dev-server process runtime bun cannot resolve Next 16
 * turbopack's external-module ids — `serverExternalPackages` members
 * load through `require("<pkg>-<turbopack-hash>")`, which node's loader
 * resolves through Next's dev bootstrap and bun's does not (reproducible
 * 500s on /api/health: "Cannot find package 'pg-<hash>'"). Node is the
 * runtime Next.js targets for `next dev`; using it for the child changes
 * no harness semantics — same command, same port, same health gate.
 */
export async function startBrowserServer(): Promise<RunningBrowserServer> {
  const root = repoRoot();
  // Prefer node for the child (see the W074 note above); bun only when a
  // node runtime is genuinely unavailable on this host.
  let serverRuntime = 'node';
  try {
    const probe = spawnSync('node', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0 || typeof probe.stdout !== 'string') serverRuntime = 'bun';
  } catch {
    serverRuntime = 'bun';
  }
  const child = spawn(
    serverRuntime,
    ['node_modules/next/dist/bin/next', 'dev', '-p', String(BROWSER_SERVER_PORT)],
    { cwd: root, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (typeof child.stdout === 'object' && child.stdout !== null) {
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(`[w076-server] ${String(chunk)}`);
    });
  }
  if (typeof child.stderr === 'object' && child.stderr !== null) {
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[w076-server] ${String(chunk)}`);
    });
  }
  await writeFile(pidFile(), `${String(child.pid)}\n`, 'utf8');

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  const watchdog = new Promise<never>((_, reject) => {
    void exited.then((code) => {
      reject(new Error(`the dev server exited during startup (code ${String(code)})`));
    });
  });
  await Promise.race([waitForHealth(180_000), watchdog]);

  return {
    child,
    stop: async () => {
      await rm(pidFile(), { force: true });
      if (child.pid === undefined) return;
      const exit = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code));
      });
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
      }
      const grace = Date.now() + 15_000;
      let exitedEarly = false;
      void exit.then(() => {
        exitedEarly = true;
      });
      while (Date.now() < grace && !exitedEarly && (await portIsLive())) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (!exitedEarly && (await portIsLive())) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await exit.catch(() => undefined);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The manual CLI (launch glue for a human/CI shell)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'start';
  if (command === 'stop') {
    await killStaleBrowserServer();
    console.log('W076 browser server: stopped (stale pid killed, port free)');
    return;
  }
  if (command !== 'start') {
    console.error('usage: bun scripts/browser-server.ts start|stop');
    process.exit(1);
  }
  await killStaleBrowserServer();
  const server = await startBrowserServer();
  console.log(`W076 browser server: healthy at ${BROWSER_SERVER_BASE_URL}`);
  const shutdown = async (): Promise<void> => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
