// W076 — the browser-journey fixture: one REAL browser page per test with
//
//   * the console/pageerror/requestfailed/HTTP violation collectors
//     attached from the very first navigation (helpers/errors.ts);
//   * a journey TRANSCRIPT recorder (every named step + URL);
//   * the screenshot archiver — full-page PNGs from THIS run, written to
//     docs/productization-evidence/W076/screens/ (the directory is wiped
//     by the global setup on every run, so recycled/fabricated evidence
//     is structurally impossible: what is there came from this run);
//   * the zero-violation assertion (callable in-test, and enforced again
//     at fixture teardown so no journey can escape the contract).
//
// The fixture deliberately does NOT cache sessions across tests: every
// test authenticates through the real /signin quick-access panel, exactly
// as the work item requires.

import { expect, test as baseTest } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachViolationCollectors } from './helpers/errors';
import type { Violation } from './helpers/errors';

/** The evidence tree root (repo-relative). */
export const EVIDENCE_ROOT = 'docs/productization-evidence/W076';
/** Full-page screenshots land here (one PNG per decisive moment). */
export const SCREEN_DIR = path.join(EVIDENCE_ROOT, 'screens');
/** Journey transcripts land here (one JSON per test). */
export const TRANSCRIPT_DIR = path.join(EVIDENCE_ROOT, 'transcripts');
/** Error captures land here (one JSON per test — the zero-violation record). */
export const ERROR_DIR = path.join(EVIDENCE_ROOT, 'errors');

/** One recorded journey step. */
export interface TranscriptEntry {
  at: string;
  step: string;
  url: string;
  /** The screenshot this step captured (repo-relative path). */
  shot: string | null;
}

/** The journey object the specs drive. */
export interface Journey {
  /** The real browser page of this test. */
  page: Page;
  /** Every violation captured so far (the zero-error contract's subject). */
  violations: Violation[];
  /** The journey transcript recorded so far. */
  transcript: TranscriptEntry[];
  /** Record a named step in the transcript. */
  step: (name: string) => Promise<void>;
  /** Capture a full-page screenshot (the decisive moments) + record it. */
  shot: (name: string) => Promise<void>;
  /** Assert ZERO console/network violations for the journey so far. */
  expectZeroViolations: () => void;
}

/** Turn a spec file path into a stable slug (no extension, path dashes). */
function fileSlug(file: string): string {
  const base = path.basename(file, path.extname(file)).replace(/\.spec$/, '');
  return base.replace(/[^a-z0-9.-]+/gi, '-').replace(/-+/g, '-');
}

/** Turn a test title into a stable slug (bounded length). */
function titleSlug(title: string): string {
  return title
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
}

/** Write one JSON artifact, creating the directory as needed. */
async function writeJson(relativeDir: string, name: string, body: unknown): Promise<void> {
  const dir = path.resolve(process.cwd(), relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/**
 * The W076 browser-journey test. Use in place of the bare `test`:
 *
 *   import { journeyTest as test } from '../fixtures';
 */
export const journeyTest = baseTest.extend<{ journey: Journey }>({
  journey: async ({ page }, use, testInfo) => {
    const violations: Violation[] = [];
    attachViolationCollectors(page, violations);
    const transcript: TranscriptEntry[] = [];
    const slug = `${fileSlug(testInfo.file)}__${titleSlug(testInfo.title)}`;

    const journey: Journey = {
      page,
      violations,
      transcript,
      step: async (name: string) => {
        transcript.push({
          at: new Date().toISOString(),
          step: name,
          url: page.url(),
          shot: null,
        });
      },
      shot: async (name: string) => {
        const file = path.join(SCREEN_DIR, `${slug}__${titleSlug(name)}.png`);
        await page.screenshot({ path: path.resolve(process.cwd(), file), fullPage: true });
        transcript.push({
          at: new Date().toISOString(),
          step: `screenshot: ${name}`,
          url: page.url(),
          shot: file,
        });
      },
      expectZeroViolations: () => {
        expect(
          violations,
          'the journey produced browser errors (console/pageerror/requestfailed/http)',
        ).toEqual([]);
      },
    };

    await use(journey);

    // Finalize: the evidence artifacts are written for EVERY outcome
    // (pass or fail), and the zero-violation contract is enforced once
    // more so no journey can end dirty after its last assertion.
    await writeJson(TRANSCRIPT_DIR, slug, {
      spec: testInfo.file,
      title: testInfo.title,
      project: testInfo.project.name,
      steps: transcript,
    });
    await writeJson(ERROR_DIR, slug, {
      spec: testInfo.file,
      title: testInfo.title,
      project: testInfo.project.name,
      violationCount: violations.length,
      violations,
      documentedFilter: [
        'favicon 404s (/favicon.ico — no favicon asset ships; browser-automatic request noise)',
        'net::ERR_ABORTED request cancellations (navigation/close mid-request bookkeeping)',
        'Chromium password-manager caret-color hydration warnings (browser-injected style attribute; every other hydration mismatch fails)',
      ],
    });
    expect(
      violations,
      `[teardown] the journey ended with browser violations: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  },
});

export { expect };
