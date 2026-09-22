// W078 — the post-deployment smoke operator CLI.
//
//   bun run smoke:dogfood -- --target https://aurum-chat-livid.vercel.app \
//        --profile hosted --expect-environment production --quick-sign-in off
//
//   bun run smoke:dogfood -- --target http://localhost:3130 \
//        --profile full --expect-environment preview \
//        --worker-token <WORKER_TOKEN> --label deployment-artifact-preview
//
// Runs the deployment-smoke module's driver against a hosted deployment
// and writes the evidence (JSON + markdown) under
// docs/productization-evidence/W078/<label>/ by default. Exit codes:
//   0 — green (skipped checks allowed; blocked acknowledged via --allow-blocked)
//   1 — at least one FAIL
//   2 — BLOCKED checks remain (documented external preconditions — see the
//       report; --allow-blocked acknowledges a known gap)
//
// Environment fallbacks: AURUM_SMOKE_BASE_URL, AURUM_SMOKE_WORKER_TOKEN,
// AURUM_SMOKE_PROFILE, AURUM_SMOKE_EXPECT_ENVIRONMENT,
// AURUM_SMOKE_QUICK_SIGN_IN, AURUM_SMOKE_OUT, AURUM_SMOKE_LABEL.
//
// The credentials rule: this script takes the worker seam token from a
// flag or the environment and NEVER prints it (reports carry counters
// and verdicts only — the same discipline as every other surface).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reportToJson,
  reportToMarkdown,
  runDeploymentSmoke,
  smokeExitCode,
} from '../src/modules/deployment-smoke/contract';
import type { QuickSignInExpectation, SmokeProfile } from '../src/modules/deployment-smoke/contract';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

interface CliArgs {
  target: string | null;
  profile: SmokeProfile;
  expectedEnvironment: string | null;
  workerToken: string | null;
  quickSignIn: QuickSignInExpectation;
  label: string | null;
  out: string;
  allowBlocked: boolean;
  timeoutMs: number;
  noRepo: boolean;
}

function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    target: env('AURUM_SMOKE_BASE_URL') ?? null,
    profile: (env('AURUM_SMOKE_PROFILE') as SmokeProfile | undefined) ?? 'hosted',
    expectedEnvironment: env('AURUM_SMOKE_EXPECT_ENVIRONMENT') ?? null,
    workerToken: env('AURUM_SMOKE_WORKER_TOKEN') ?? null,
    quickSignIn: (env('AURUM_SMOKE_QUICK_SIGN_IN') as QuickSignInExpectation | undefined) ?? 'unchecked',
    label: env('AURUM_SMOKE_LABEL') ?? null,
    out: env('AURUM_SMOKE_OUT') ?? path.join(REPO_ROOT, 'docs', 'productization-evidence', 'W078'),
    allowBlocked: false,
    timeoutMs: 30_000,
    noRepo: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`missing value for ${arg}`);
        process.exit(1);
      }
      i += 1;
      return value;
    };
    if (arg === '--target') args.target = next();
    else if (arg === '--profile') {
      const value = next();
      if (value !== 'hosted' && value !== 'full') {
        console.error(`--profile must be hosted|full (got '${value}')`);
        process.exit(1);
      }
      args.profile = value;
    } else if (arg === '--expect-environment') args.expectedEnvironment = next();
    else if (arg === '--worker-token') args.workerToken = next();
    else if (arg === '--quick-sign-in') {
      const value = next();
      if (value !== 'off' && value !== 'on' && value !== 'unchecked') {
        console.error(`--quick-sign-in must be off|on|unchecked (got '${value}')`);
        process.exit(1);
      }
      args.quickSignIn = value;
    } else if (arg === '--label') args.label = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--allow-blocked') args.allowBlocked = true;
    else if (arg === '--no-repo') args.noRepo = true;
    else if (arg === '--timeout-ms') args.timeoutMs = Number.parseInt(next(), 10);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'usage: bun run smoke:dogfood -- --target <url> [--profile hosted|full]',
          '         [--expect-environment production|preview|staging|development]',
          '         [--worker-token <t>] [--quick-sign-in off|on|unchecked]',
          '         [--label <name>] [--out <dir>] [--allow-blocked] [--no-repo]',
          '         [--timeout-ms <n>]',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      console.error(`unknown argument '${arg}'`);
      process.exit(1);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.target === null) {
    console.error(
      'no target: pass --target <url> (or set AURUM_SMOKE_BASE_URL) — e.g. the dogfood deployment URL',
    );
    return 1;
  }
  let target: URL;
  try {
    target = new URL(args.target);
  } catch {
    console.error(`--target is not a URL: '${args.target}'`);
    return 1;
  }
  const label =
    args.label ??
    (args.profile === 'full' ? `full-${target.host}` : `hosted-${target.host}`);

  const report = await runDeploymentSmoke({
    target: args.target,
    profile: args.profile,
    expectedEnvironment: args.expectedEnvironment ?? undefined,
    workerToken: args.workerToken,
    expectQuickSignIn: args.quickSignIn,
    repoRoot: args.noRepo ? null : REPO_ROOT,
    label,
    timeoutMs: args.timeoutMs,
  });

  const outDir = path.join(args.out, label);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'smoke-report.json'), `${reportToJson(report)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'smoke-report.md'), `${reportToMarkdown(report)}\n`, 'utf8');

  const s = report.summary;
  console.log(`--- W078 deployment smoke: ${label} ---`);
  console.log(`target: ${report.target} (profile ${report.profile})`);
  console.log(
    `health: ${report.health?.status ?? 'unreachable'} · environment '${report.health?.environment ?? '?'}'`,
  );
  console.log(`summary: ${s.passed} passed · ${s.failed} failed · ${s.blocked} blocked · ${s.skipped} skipped`);
  for (const result of report.results) {
    if (result.status === 'pass') continue;
    console.log(`  ${result.status.toUpperCase()} ${result.id}: ${result.detail}`);
  }
  console.log(`report: ${path.relative(REPO_ROOT, path.join(outDir, 'smoke-report.md'))}`);

  const code = smokeExitCode(s, args.allowBlocked);
  if (code === 2) {
    console.log(
      '(blocked checks point at documented external preconditions — see docs/DEPLOYMENT.md §11; --allow-blocked acknowledges a known gap)',
    );
  }
  return code;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
