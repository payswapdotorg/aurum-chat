// The REAL BROWSER DRIVER ADAPTER (W110) — Playwright OSS (the repository's
// already-reviewed browser runtime; @playwright/test 1.57.0 ships it and
// the W076 journey suite runs on it) behind the W093 BrowserDriver port.
//
// W110 scope: "add a real browser adapter behind the existing
// BrowserDriver contract; prefer an already-reviewed provider/OSS
// implementation; edge/browser execution stays last-mile and
// tenant-scoped; no second evidence/reconciliation model."
//
// WHAT CROSSES THE PORT (and what never does):
//   The adapter satisfies the BrowserDriver port exactly —
//   startSession/performAction/endSession with the canonical envelopes.
//   Playwright objects (Browser/BrowserContext/Page/Locator) NEVER cross
//   the boundary: every vendor interaction is composed INSIDE this file
//   from the canonical action envelope, and every result is normalized
//   to the port's own shapes before it returns (the service's
//   canonicalization would reject a provider object loudly —
//   `invalid_driver_result`; provider objects never cross, lock 16).
//
// THE VENDOR SEAM (the W108 adapter discipline): the adapter is
// constructed from a CONFIGURATION OBJECT (`PlaywrightBrowserDriverOptions`)
// and every vendor touch goes through four injectable seams —
//   * `launcher`    — launches the browser handle (default: real chromium);
//   * `credentials` — resolves the OPAQUE credentialRef into field
//     values driver-side (default: the BROWSER_CREDENTIALS environment
//     JSON; secrets are read from the environment ONLY, never hardcoded);
//   * `artifacts`   — stores evidence bytes (per-step screenshot PNG +
//     DOM snapshot HTML) behind opaque refs (default: the
//     BROWSER_ARTIFACT_DIR filesystem store);
//   * `profiles`    — persists the per-(tenant,task) browser storage state
//     between disposable sessions (default: the BROWSER_PROFILE_DIR
//     filesystem store).
// The seams are narrow STRUCTURAL interfaces (only the exact Playwright
// surface this adapter uses), so the deterministic test suite injects
// fakes and verifies the adapter's vendor-shape behavior with NO browser
// and NO network (the fixtures/doubles doctrine — the real-browser run
// itself is executed once and recorded as evidence under
// docs/productization-evidence/W110/).
//
// CREDENTIAL ISOLATION (the existing W093 semantics, unweakened): the
// task carries only the OPAQUE credentialRef; the adapter materializes
// the reference's fields ONCE per profile, INSIDE the driver (the
// per-(tenant,task) profile record), and the values never cross back:
//   * a step typing `secretField` fills the materialized value into the
//     page and records ONLY the field name in the trace
//     ({kind:'secret-field', field, redacted:true} — the double's trace
//     shape verbatim);
//   * the observed state NEVER echoes a secret: the typed selector and
//     every password-type input are observed as redaction markers
//     (`<redacted secret field '<field>'>` / `<redacted password input>`);
//     the DOM-snapshot artifact is secret-free the same way — Playwright
//     sets typed text as the element's live VALUE PROPERTY and HTML
//     serialization writes ATTRIBUTES, so a filled password never
//     appears in page.content() (verified against real chromium and
//     proven by the byte-level artifact sweep of the W110 evidence
//     run — docs/productization-evidence/W110/);
//   * an unresolvable field is a PERMANENT refusal (the double's
//     semantics): "the credential field '…' was not materialized in the
//     isolated profile — the reference resolved to nothing".
//
// THE DRIVER-SIDE ALLOWLIST COPY (the W088 twice-checked discipline, at
// every enforcement point): the adapter keeps the frozen allowlist it
// received at session start and re-checks EVERY action's URL glob and
// verb BEFORE any vendor interaction — a non-conforming action is
// permanently refused with the driver's own reason, exactly like the
// deterministic double. There is no bypass path: navigation, typing,
// clicking and submitting all happen only after the copy has consented.
//
// DRIVER-LEVEL OUTCOME MAPPING (failure/retry/resume reuse the EXISTING
// lifecycle machinery; the adapter only maps, it invents nothing):
//   * vendor timeout / network / navigation error → receipt 'failed'
//     (TRANSIENT — the task parks resumable; a fresh session retries);
//   * strict-mode violation (the plan's selector matches several
//     elements — an ambiguous plan) → receipt 'rejected' (PERMANENT);
//   * driver-side allowlist refusal / unresolved credential field →
//     receipt 'rejected' (PERMANENT);
//   * everything else → receipt 'accepted' WITH the observed state (an
//     unobserved action is never a result), the per-step screenshot
//     reference and the redacted action trace.
//   Honoring idempotency: an ACCEPTED action is memoized by its
//   idempotency key and replayed without touching the browser again —
//   a crash between accept-and-record never double-executes.
//
// ENVIRONMENT CONTRACT (the operator surface; see wiring.ts for the
// BROWSER_DRIVER selection and docs/productization-evidence/W110/):
//   BROWSER_CREDENTIALS        — JSON { "<credentialRef>": { "<field>":
//                                 "<value>" } }; the ONLY credential
//                                 channel (never hardcoded).
//   BROWSER_ARTIFACT_DIR       — screenshot/DOM-snapshot store root
//                                 (default: <tmp>/aurum-browser-artifacts).
//   BROWSER_PROFILE_DIR        — browser-profile storage-state root
//                                 (default: <tmp>/aurum-browser-profiles).
//   BROWSER_HEADLESS           — 1/0 (default: 1, headless).
//   BROWSER_ACTION_TIMEOUT_MS  — per-action vendor timeout (default 15000).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContextOptions } from 'playwright';
import { envFlag, envString } from '@/infra/config';
import type {
  BrowserAction,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserAllowlist,
  BrowserDriver,
  BrowserSessionEndRequest,
  BrowserSessionStartRequest,
  BrowserSessionStartResult,
} from '../types';
import { urlMatchesGlob } from '../verify';

// ---------------------------------------------------------------------------
// The vendor seam (structural — only the exact Playwright surface used)
// ---------------------------------------------------------------------------

/** The locator surface the adapter observes pages through. */
export interface PlaywrightLocatorHandle {
  count(): Promise<number>;
  nth(index: number): PlaywrightLocatorHandle;
  getAttribute(name: string): Promise<string | null>;
  inputValue(): Promise<string>;
  isChecked(): Promise<boolean>;
  textContent(): Promise<string | null>;
}

/** The page surface the adapter drives and observes. */
export interface PlaywrightPageHandle {
  goto(
    url: string,
    options: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' },
  ): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  fill(selector: string, value: string, options: { timeout?: number }): Promise<void>;
  click(selector: string, options: { timeout?: number }): Promise<void>;
  locator(selector: string): PlaywrightLocatorHandle;
  content(): Promise<string>;
  screenshot(options: { type: 'png'; fullPage: boolean }): Promise<Buffer>;
}

/** The browser-context surface (one DISPOSABLE session = one context). */
export interface PlaywrightContextHandle {
  newPage(): Promise<PlaywrightPageHandle>;
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

/** The browser surface (one shared engine per driver instance). */
export interface PlaywrightBrowserHandle {
  version(): string;
  newContext(options: { storageState?: unknown }): Promise<PlaywrightContextHandle>;
  close(): Promise<void>;
}

/** Launches the browser engine (the injectable vendor seam). */
export type PlaywrightLauncher = (options: { headless: boolean }) => Promise<PlaywrightBrowserHandle>;

/** The object form of Playwright's storageState (what storageState() produces). */
type ChromiumStorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;

/**
 * The default launcher: the REAL chromium engine (Playwright OSS — the
 * repository's already-reviewed browser runtime). This function is the
 * single, explicit vendor edge: Playwright's own Browser handle is
 * adapted HERE to the seam's narrow structural shape (the only surface
 * the adapter drives). The one cast below is total by construction:
 * the only storageState the adapter ever hands back is what
 * Playwright's own context.storageState() produced (the profile store
 * round-trips it verbatim), so the object form is guaranteed.
 */
export const realChromiumLauncher: PlaywrightLauncher = async (options) => {
  const browser = await chromium.launch({ headless: options.headless });
  return {
    version: () => browser.version(),
    newContext: async (contextOptions) =>
      await browser.newContext({
        storageState:
          contextOptions.storageState === null || contextOptions.storageState === undefined
            ? undefined
            : (contextOptions.storageState as ChromiumStorageState),
      }),
    close: () => browser.close(),
  };
};

// ---------------------------------------------------------------------------
// The configuration seams: credentials, artifacts, profiles
// ---------------------------------------------------------------------------

/**
 * Resolves the OPAQUE credential reference into field values, DRIVER-SIDE
 * ONLY (the W082/W093 discipline: the reference is materialized inside
 * the isolated profile and the values never cross back).
 */
export interface PlaywrightCredentialSource {
  /** The field names a reference can materialize. */
  fields(credentialRef: string): string[];
  /** One field's materialized value (undefined = not resolvable). */
  resolve(credentialRef: string, field: string): string | undefined;
}

/**
 * The environment credential source — the ONLY credential channel of the
 * real adapter (lock: credentials are read from env, never hardcoded).
 *
 *   BROWSER_CREDENTIALS = { "<credentialRef>": { "<field>": "<value>" } }
 *
 * A malformed document fails LOUDLY (a wiring defect must never look
 * like "no credentials"): the error propagates out of materialization,
 * the run parks resumable and the message is visible in the evidence.
 */
export function envCredentialSource(): PlaywrightCredentialSource {
  let parsed: Record<string, Record<string, string>> | null = null;
  const read = (): Record<string, Record<string, string>> => {
    if (parsed === null) {
      const raw = envString('BROWSER_CREDENTIALS');
      if (raw === undefined) {
        parsed = {};
      } else {
        try {
          const document = JSON.parse(raw) as unknown;
          if (typeof document !== 'object' || document === null || Array.isArray(document)) {
            throw new Error('not an object');
          }
          const entries: Record<string, Record<string, string>> = {};
          for (const [ref, fields] of Object.entries(document as Record<string, unknown>)) {
            if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) continue;
            const entry: Record<string, string> = {};
            for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
              if (typeof value === 'string') entry[field] = value;
            }
            entries[ref] = entry;
          }
          parsed = entries;
        } catch {
          throw new Error(
            'BROWSER_CREDENTIALS is set but is not a valid JSON object of { "<credentialRef>": { "<field>": "<value>" } } — fix the environment; the browser driver refuses to guess credentials',
          );
        }
      }
    }
    return parsed;
  };
  return {
    fields: (credentialRef) => {
      const entry = read()[credentialRef];
      return entry === undefined ? [] : Object.keys(entry);
    },
    resolve: (credentialRef, field) => read()[credentialRef]?.[field],
  };
}

/** One stored evidence artifact (the bytes live behind the opaque ref). */
export interface PlaywrightArtifactRecord {
  /** The opaque reference the evidence carries (object storage holds the bytes). */
  ref: string;
  /** The artifact's sha256 — the evidence hash proves the bytes. */
  sha256: string;
  /** The artifact's size in bytes. */
  bytes: number;
}

/** Stores evidence bytes (per-step screenshot / DOM snapshot). */
export interface PlaywrightArtifactStore {
  put(kind: 'screenshot' | 'dom-snapshot', data: Uint8Array): Promise<PlaywrightArtifactRecord>;
}

/**
 * The default filesystem artifact store: writes the bytes under
 * `<rootDir>/<kind>-<sha256-16>.<png|html>` and hands back the opaque
 * reference `computer-use-playwright://<kind>/<sha256-16>`. Content
 * addressing makes the evidence self-verifying (ref → hash → bytes).
 */
export function filesystemArtifactStore(rootDir: string): PlaywrightArtifactStore {
  return {
    put: async (kind, data) => {
      const sha256 = createHash('sha256').update(data).digest('hex');
      await mkdir(rootDir, { recursive: true });
      const extension = kind === 'screenshot' ? 'png' : 'html';
      await writeFile(path.join(rootDir, `${kind}-${sha256.slice(0, 16)}.${extension}`), data);
      return {
        ref: `computer-use-playwright://${kind}/${sha256.slice(0, 16)}`,
        sha256,
        bytes: data.byteLength,
      };
    },
  };
}

/** Persists a profile's browser storage state between disposable sessions. */
export interface PlaywrightProfileStore {
  load(profileKey: string): Promise<unknown>;
  save(profileKey: string, storageState: unknown): Promise<void>;
}

/**
 * The default filesystem profile store: one JSON file per ISOLATED
 * profile key (the key is hashed — the per-(tenant,task) key itself never
 * becomes a path). The storage state is the profile's continuity across
 * disposable sessions (cookies/localStorage); the TASK record, never this
 * file, is the durable resume truth.
 */
export function filesystemProfileStore(rootDir: string): PlaywrightProfileStore {
  const fileOf = (profileKey: string): string =>
    path.join(
      rootDir,
      `profile-${createHash('sha256').update(profileKey).digest('hex').slice(0, 16)}.json`,
    );
  return {
    load: async (profileKey) => {
      try {
        return JSON.parse(await readFile(fileOf(profileKey), 'utf8')) as unknown;
      } catch {
        return null; // no persisted continuity yet — a fresh profile
      }
    },
    save: async (profileKey, storageState) => {
      await mkdir(rootDir, { recursive: true });
      await writeFile(fileOf(profileKey), `${JSON.stringify(storageState)}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Options + resolution
// ---------------------------------------------------------------------------

/** Configuration of the real browser driver (all seams injectable). */
export interface PlaywrightBrowserDriverOptions {
  /** The browser launcher (default: the REAL chromium engine). */
  launcher?: PlaywrightLauncher;
  /** The credential source (default: BROWSER_CREDENTIALS env JSON). */
  credentials?: PlaywrightCredentialSource;
  /** The evidence artifact store (default: BROWSER_ARTIFACT_DIR filesystem). */
  artifacts?: PlaywrightArtifactStore;
  /** The profile store (default: BROWSER_PROFILE_DIR filesystem). */
  profiles?: PlaywrightProfileStore;
  /** Headless engine (default: BROWSER_HEADLESS, else true). */
  headless?: boolean;
  /** Per-action vendor timeout in ms (default: BROWSER_ACTION_TIMEOUT_MS, else 15000). */
  actionTimeoutMs?: number;
}

interface ResolvedPlaywrightOptions {
  launcher: PlaywrightLauncher;
  credentials: PlaywrightCredentialSource;
  artifacts: PlaywrightArtifactStore;
  profiles: PlaywrightProfileStore;
  headless: boolean;
  actionTimeoutMs: number;
}

function resolveOptions(options: PlaywrightBrowserDriverOptions): ResolvedPlaywrightOptions {
  const artifactRoot = envString('BROWSER_ARTIFACT_DIR') ?? path.join(tmpdir(), 'aurum-browser-artifacts');
  const profileRoot = envString('BROWSER_PROFILE_DIR') ?? path.join(tmpdir(), 'aurum-browser-profiles');
  const timeoutEnv = Number(envString('BROWSER_ACTION_TIMEOUT_MS') ?? '15000');
  return {
    launcher: options.launcher ?? realChromiumLauncher,
    credentials: options.credentials ?? envCredentialSource(),
    artifacts: options.artifacts ?? filesystemArtifactStore(artifactRoot),
    profiles: options.profiles ?? filesystemProfileStore(profileRoot),
    headless:
      options.headless ??
      (envString('BROWSER_HEADLESS') === undefined ? true : envFlag('BROWSER_HEADLESS')),
    actionTimeoutMs:
      options.actionTimeoutMs ?? (Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : 15_000),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** One live disposable browser session (one context + one page). */
interface LivePlaywrightSession {
  context: PlaywrightContextHandle;
  page: PlaywrightPageHandle;
  profileKey: string;
  /** The frozen allowlist copy this session received at start (twice-checked). */
  allowlist: BrowserAllowlist;
  closed: boolean;
  /** Selectors typed from a materialized secret THIS session → observation redaction. */
  secretSelectors: Map<string, string>;
}

/** The driver-side per-(tenant,task) profile record (isolated, in-memory). */
interface PlaywrightProfileRecord {
  /** The MATERIALIZED credential store (field → value) — driver-side only. */
  credentialStore: Map<string, string>;
}

/**
 * The real browser driver — Playwright behind the BrowserDriver port.
 * Vendor objects never leave; results are canonical before they return.
 */
export class PlaywrightBrowserDriver implements BrowserDriver {
  private readonly options: ResolvedPlaywrightOptions;

  // -- the shared engine (one per driver instance; sessions are contexts) --
  private browserHandle: PlaywrightBrowserHandle | null = null;
  private browserLaunching: Promise<PlaywrightBrowserHandle> | null = null;

  // -- isolated profiles + live sessions --
  private readonly profiles = new Map<string, PlaywrightProfileRecord>();
  private readonly sessions = new Map<string, LivePlaywrightSession>();
  private sessionCounter = 0;
  private receiptCounter = 0;

  // -- honoring idempotency (accepted actions only) --
  private readonly acceptedEffects = new Map<string, BrowserActionResult>();

  // -- the recording surface (test proofs; canonical shapes only) --
  readonly performRequests: BrowserActionRequest[] = [];
  readonly sessionStarts: BrowserSessionStartRequest[] = [];
  readonly endSessions: BrowserSessionEndRequest[] = [];
  readonly materializedRefs = new Map<string, string>();
  readonly typedSecretFields = new Map<string, Set<string>>();
  /** stepKey → how many times the action REALLY reached the browser. */
  readonly browserExecutions = new Map<string, number>();

  constructor(options: PlaywrightBrowserDriverOptions = {}) {
    this.options = resolveOptions(options);
  }

  /** The engine's own version string (evidence surface). */
  engineVersion(): string {
    return this.browserHandle?.version() ?? 'not-launched';
  }

  // -- the recording surface (fixture-only accessors, like the double) --

  /** The value a profile materialized for a credential field (driver-side only). */
  materializedValueOf(profileKey: string, field: string): string | undefined {
    return this.profiles.get(profileKey)?.credentialStore.get(field);
  }

  /** The profile a session key belongs to (fixture-only). */
  profileKeyOfSession(sessionKey: string): string | undefined {
    return this.sessions.get(sessionKey)?.profileKey;
  }

  // -----------------------------------------------------------------------
  // The driver port
  // -----------------------------------------------------------------------

  async startSession(request: BrowserSessionStartRequest): Promise<BrowserSessionStartResult> {
    this.sessionStarts.push(request);
    let profile = this.profiles.get(request.profileKey);
    if (profile === undefined) {
      profile = { credentialStore: new Map() };
      this.profiles.set(request.profileKey, profile);
    }
    // The opaque reference is materialized ONCE, INSIDE the isolated
    // profile — the values never cross back (the W082/W093 discipline).
    if (request.credentialRef !== null) {
      this.materializedRefs.set(request.profileKey, request.credentialRef);
      for (const field of this.options.credentials.fields(request.credentialRef)) {
        const value = this.options.credentials.resolve(request.credentialRef, field);
        if (value !== undefined && !profile.credentialStore.has(field)) {
          profile.credentialStore.set(field, value);
        }
      }
    }
    const browser = await this.ensureBrowser();
    const storageState = await this.options.profiles.load(request.profileKey);
    const context = await browser.newContext(storageState === null ? {} : { storageState });
    const page = await context.newPage();
    this.sessionCounter += 1;
    const sessionKey = `playwright-session-${this.sessionCounter.toString().padStart(4, '0')}`;
    this.sessions.set(sessionKey, {
      context,
      page,
      profileKey: request.profileKey,
      allowlist: { urlGlobs: [...request.allowlist.urlGlobs], verbs: [...request.allowlist.verbs] },
      closed: false,
      secretSelectors: new Map(),
    });
    return { sessionKey };
  }

  async performAction(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const session = this.sessions.get(request.sessionKey);
    if (session === undefined || session.closed) {
      throw new Error(`the browser session '${request.sessionKey}' is not live`);
    }
    this.performRequests.push(request);
    const { action } = request;

    // Honoring idempotency: an accepted action replays its recorded
    // effect — a crash between accept-and-record never double-executes.
    const memoized = this.acceptedEffects.get(request.idempotencyKey);
    if (memoized !== undefined) return memoized;

    // The driver-side allowlist copy (the W088 twice-checked discipline):
    // the session's OWN frozen copy, received at start. No bypass path.
    const allowlist = session.allowlist;
    const matched = allowlist.urlGlobs.find((glob) => urlMatchesGlob(action.url, glob));
    if (matched === undefined) {
      return this.rejected(
        `blocked by the driver-side allowlist copy: the URL '${action.url}' matches none of ${allowlist.urlGlobs.join(', ')}`,
      );
    }
    if (!allowlist.verbs.includes(action.verb)) {
      return this.rejected(
        `blocked by the driver-side allowlist copy: the verb '${action.verb}' is not permitted (${allowlist.verbs.join(', ')})`,
      );
    }

    const result = await this.executeAgainstBrowser(session, request, action);
    if (result.receipt.status === 'accepted') {
      this.acceptedEffects.set(request.idempotencyKey, result);
    }
    return result;
  }

  async endSession(request: BrowserSessionEndRequest): Promise<void> {
    this.endSessions.push(request);
    const session = this.sessions.get(request.sessionKey);
    if (session === undefined || session.closed) return;
    session.closed = true;
    // Persist the profile's continuity (best effort): the storage state
    // is what a FRESH session resumes with — the task record, never this
    // file, is the durable resume truth.
    try {
      await this.options.profiles.save(session.profileKey, await session.context.storageState());
    } catch {
      /* a dying engine cannot persist — the checkpoint is the task record */
    }
    try {
      await session.context.close();
    } catch {
      /* a dead engine cannot close its own session — expected, not fatal */
    }
  }

  /**
   * Closes the shared engine (runner/test shutdown; NOT part of the port —
   * the service closes sessions, the composition root closes the engine).
   */
  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (!session.closed) {
        session.closed = true;
        try {
          await session.context.close();
        } catch {
          /* best effort */
        }
      }
    }
    this.sessions.clear();
    if (this.browserHandle !== null) {
      try {
        await this.browserHandle.close();
      } catch {
        /* best effort */
      }
      this.browserHandle = null;
    }
    this.browserLaunching = null;
  }

  // -----------------------------------------------------------------------
  // The vendor dispatch (private — Playwright objects live and die here)
  // -----------------------------------------------------------------------

  private async ensureBrowser(): Promise<PlaywrightBrowserHandle> {
    if (this.browserHandle !== null) return this.browserHandle;
    if (this.browserLaunching === null) {
      this.browserLaunching = this.options
        .launcher({ headless: this.options.headless })
        .catch((error: unknown) => {
          this.browserLaunching = null; // a failed launch retries next session
          throw error;
        });
    }
    this.browserHandle = await this.browserLaunching;
    return this.browserHandle;
  }

  private async executeAgainstBrowser(
    session: LivePlaywrightSession,
    request: BrowserActionRequest,
    action: BrowserAction,
  ): Promise<BrowserActionResult> {
    const page = session.page;
    const timeout = this.options.actionTimeoutMs;
    const urlBefore = page.url();
    let navigated: { from: string; to: string } | null = null;
    try {
      // Navigation discipline: 'goto' always navigates (reload included);
      // every other verb navigates only when the target page is not the
      // current one. Either way the URL was allowlist-checked above.
      if (action.verb === 'goto' || urlBefore !== action.url) {
        await page.goto(action.url, { timeout, waitUntil: 'domcontentloaded' });
        navigated = { from: urlBefore, to: action.url };
      }

      switch (action.verb) {
        case 'goto':
        case 'read':
          break; // the navigation/observation IS the action
        case 'type': {
          const selector = action.selector ?? '';
          let value: string;
          if (typeof action.secretField === 'string') {
            const materialized = this.profiles.get(session.profileKey)?.credentialStore.get(action.secretField);
            if (materialized === undefined) {
              return this.rejected(
                `the credential field '${action.secretField}' was not materialized in the isolated profile — the reference resolved to nothing`,
              );
            }
            value = materialized;
            session.secretSelectors.set(selector, action.secretField);
            session.secretSelectors.set(canonicalSelectorKey(selector), action.secretField);
            let typed = this.typedSecretFields.get(session.profileKey);
            if (typed === undefined) {
              typed = new Set();
              this.typedSecretFields.set(session.profileKey, typed);
            }
            typed.add(action.secretField);
          } else {
            value = action.value ?? '';
          }
          await page.fill(selector, value, { timeout });
          break;
        }
        case 'click':
        case 'submit': {
          // Playwright's click auto-awaits the navigation the click
          // triggers (form submits settle before the action resolves).
          await page.click(action.selector ?? '', { timeout });
          break;
        }
      }
      this.browserExecutions.set(request.stepKey, (this.browserExecutions.get(request.stepKey) ?? 0) + 1);

      // VERIFIED OBSERVED STATE REQUIRED: the observation always precedes
      // the receipt — an unobserved action is never a result.
      const observedState = await this.observePage(session);

      // Evidence capture: the per-step screenshot and the DOM snapshot,
      // stored behind opaque refs with their sha256 proofs.
      const png = await page.screenshot({ type: 'png', fullPage: false });
      const screenshot = await this.options.artifacts.put('screenshot', png);
      const html = await page.content();
      const domSnapshot = await this.options.artifacts.put(
        'dom-snapshot',
        new TextEncoder().encode(html),
      );

      this.receiptCounter += 1;
      return {
        receipt: {
          status: 'accepted',
          receiptId: `playwright-rcpt-${this.receiptCounter.toString().padStart(4, '0')}`,
          detail: null,
        },
        observedState,
        screenshotRef: screenshot.ref,
        actionTrace: {
          verb: action.verb,
          url: action.url,
          selector: action.selector ?? null,
          typed:
            action.verb === 'type'
              ? typeof action.secretField === 'string'
                ? { kind: 'secret-field', field: action.secretField, redacted: true }
                : { kind: 'literal', length: (action.value ?? '').length }
              : null,
          navigated,
          screenshot: { ref: screenshot.ref, sha256: screenshot.sha256, bytes: screenshot.bytes },
          domSnapshot: { ref: domSnapshot.ref, sha256: domSnapshot.sha256, bytes: domSnapshot.bytes },
        },
      };
    } catch (error) {
      // The documented driver-level outcome mapping (nothing invented):
      const message = error instanceof Error ? error.message : String(error);
      if (/strict mode violation/i.test(message)) {
        return this.rejected(
          `the plan's selector is ambiguous — it matched more than one element: ${message.slice(0, 320)}`,
        );
      }
      return {
        receipt: {
          status: 'failed',
          receiptId: null,
          detail: `the browser action failed (transient — a fresh session may succeed): ${message.slice(0, 380)}`,
        },
        observedState: null,
        screenshotRef: null,
        actionTrace: null,
      };
    }
  }

  /**
   * Normalizes the CURRENT page into the canonical observed state
   * ({found, state} — the W084/W088 shape): url, title, the first h1's
   * text and every form field keyed by its CANONICAL selector (#id, or
   * [name="…"]). Secrets never echo back: password-type inputs and the
   * selectors typed from materialized secrets are observed as redaction
   * markers (the double's marker format verbatim).
   */
  private async observePage(
    session: LivePlaywrightSession,
  ): Promise<{ found: boolean; state: unknown }> {
    const page = session.page;
    const url = page.url();
    if (url === '' || url === 'about:blank') {
      return { found: false, state: null };
    }
    const state: Record<string, unknown> = { url, title: await page.title() };
    const heading = page.locator('h1');
    if ((await heading.count()) > 0) {
      const text = await heading.nth(0).textContent();
      if (text !== null && text.trim() !== '') state.heading = text.trim();
    }
    const fields = page.locator('input, textarea, select');
    const count = await fields.count();
    for (let index = 0; index < count; index += 1) {
      const field = fields.nth(index);
      const id = await field.getAttribute('id');
      const name = await field.getAttribute('name');
      const key =
        id !== null && id !== ''
          ? `#${id}`
          : name !== null && name !== ''
            ? `[name="${name}"]`
            : null;
      if (key === null) continue; // an id-less, name-less field has no canonical selector
      const secretField = session.secretSelectors.get(key);
      if (secretField !== undefined) {
        state[key] = `<redacted secret field '${secretField}'>`;
        continue;
      }
      const type = await field.getAttribute('type');
      if (type === 'password') {
        state[key] = '<redacted password input>';
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        state[key] = await field.isChecked();
        continue;
      }
      state[key] = await field.inputValue();
    }
    return { found: true, state };
  }

  private rejected(detail: string): BrowserActionResult {
    return {
      receipt: { status: 'rejected', receiptId: null, detail },
      observedState: null,
      screenshotRef: null,
      actionTrace: null,
    };
  }
}

/**
 * Creates the REAL browser driver (Playwright/chromium) behind the
 * BrowserDriver port. All vendor seams injectable; the deterministic
 * test suite injects fakes (no browser, no network), production wiring
 * (wiring.ts) uses the environment defaults.
 */
export function createPlaywrightBrowserDriver(
  options: PlaywrightBrowserDriverOptions = {},
): PlaywrightBrowserDriver {
  return new PlaywrightBrowserDriver(options);
}

// ---------------------------------------------------------------------------
// Pure helpers (selector canonicalization — shared by typing + redaction)
// ---------------------------------------------------------------------------

/**
 * Canonicalizes a plan selector into the observation key form: '#id' and
 * '[name="…"]' survive as-is; '[name=…]' normalizes to the quoted form;
 * anything else is returned unchanged (the adapter adds BOTH the raw and
 * the canonical form to the redaction set, so any plan spelling redacts).
 */
export function canonicalSelectorKey(selector: string): string {
  const idMatch = /^#([A-Za-z][\w.-]*)$/.exec(selector);
  if (idMatch !== null) return `#${idMatch[1]}`;
  const nameMatch = /^\[\s*name\s*=\s*["']?([^"'\]]+)["']?\s*\]$/.exec(selector);
  if (nameMatch !== null) return `[name="${nameMatch[1]}"]`;
  return selector;
}
