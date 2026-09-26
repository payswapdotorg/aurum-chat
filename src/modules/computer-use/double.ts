// The deterministic BROWSER DRIVER DOUBLE (W093) — the repository's
// fixture implementation of the BrowserDriver port (the W082 adapter
// precedent: first-party doubles are exported through the contract).
// NO live network, NO real browser (IMPLEMENTATION-STACK §7: the
// fixtures/doubles doctrine). A REAL browser automation runtime (an
// approved edge browser adapter, W088, or a governed in-process browser)
// implements the same port CUSTOMER-SIDE — that path is
// environment-dependent and deliberately not exercised by this
// repository's test suite.
//
// What the double models (deterministically, in memory):
//   * A TINY SITE — seeded pages keyed by URL, each with a title and a
//     field map. 'goto' navigates (an unseeded URL observes found:false —
//     the honest "the page was not there" evidence); 'type' writes into
//     the current page's fields (a secret field writes only a REDACTION
//     marker: pages never echo passwords back); 'click'/'submit' act on
//     the current page; 'read' observes it.
//   * ISOLATED PER-(tenant,task) PROFILES — the profile key the service
//     mints (tenant + task) scopes a persistent profile: the
//     MATERIALIZED credential store (the opaque reference is resolved
//     once, inside the profile, and never crosses back) and the LAST
//     PAGE (a fresh session on the same profile resumes on the profile's
//     page — the browser-profile continuity a resume needs).
//   * THE DRIVER-SIDE ALLOWLIST COPY (the W088 twice-checked discipline):
//     the double enforces the frozen allowlist it received at session
//     start; a non-conforming action is permanently refused with the
//     driver's own reason.
//   * HONORING IDEMPOTENCY — an ACCEPTED action is memoized by its
//     idempotency key: a retry after a crash between accept-and-record
//     replays the SAME result (never a second external effect). Failures
//     and refusals are not memoized — a transient failure may be retried
//     into success (the resume path).
//   * SCRIPTABLE FAILURE MODES — failStepOnce (a transient 'failed'
//     receipt, the resume path), refuseStep (a permanent 'rejected'
//     receipt), crashOnStep (a thrown error — the worker/session death
//     that parks the task resumable), divergeStep (an observed state
//     that diverges from the expected shape — the verification-failure
//     evidence) and staleStateOnStep (an accepted action whose observed
//     state is the PREVIOUS step's — the "accepted but the page never
//     moved" divergence).
//
// Everything the double records (performed requests, session starts,
// materializations, typed secret fields, crashes) is exposed read-only so
// tests can prove exactly-once execution, credential isolation and
// disposability — the provider side stays behind the seam.

import { newId } from '@/infra/ids';
import type {
  BrowserAction,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserAllowlist,
  BrowserDriver,
  BrowserSessionEndRequest,
  BrowserSessionStartRequest,
  BrowserSessionStartResult,
} from './types';
import { urlMatchesGlob } from './verify';

/** A seeded page of the tiny site. */
export interface ScriptedPage {
  title: string;
  /** The observed fields of the page (merged into the observed state). */
  fields: Record<string, unknown>;
}

/** The persistent, ISOLATED per-(tenant,task) browser profile. */
export interface ScriptedProfile {
  /** The last page this profile visited (the resume continuity). */
  lastPageUrl: string | null;
  /** The MATERIALIZED credential store (field → value) — driver-side only. */
  credentialStore: Map<string, string>;
}

interface ScriptedSession {
  profileKey: string;
  currentUrl: string | null;
  /** The frozen allowlist copy this session received at start. */
  allowlist: BrowserAllowlist | null;
  closed: boolean;
}

export interface ScriptedBrowserDriverOptions {
  /** Pre-seeded pages, keyed by absolute URL. */
  pages?: Record<string, ScriptedPage>;
}

/**
 * The deterministic double (fixture) — implements the BrowserDriver port
 * with scriptable failure modes and full call recording. See the file
 * header; NO network, NO browser.
 */
export class ScriptedBrowserDriver implements BrowserDriver {
  // -- the tiny site (shared external world) --
  private readonly pages = new Map<string, ScriptedPage>();

  // -- isolated profiles + live sessions --
  private readonly profiles = new Map<string, ScriptedProfile>();
  private readonly sessions = new Map<string, ScriptedSession>();
  private sessionCounter = 0;
  private receiptCounter = 0;
  private screenshotCounter = 0;

  // -- honoring idempotency (accepted actions only) --
  private readonly acceptedEffects = new Map<string, BrowserActionResult>();

  // -- scriptable failure modes --
  /** Step keys whose FIRST perform returns a transient 'failed' receipt. */
  readonly failStepOnce = new Set<string>();
  /** Step keys whose performs are permanently refused. */
  readonly refuseStep = new Set<string>();
  /** Step keys whose perform THROWS (the worker/session death). */
  readonly crashOnStep = new Set<string>();
  /** Step keys whose observed state diverges (verification mismatch). */
  readonly divergeSteps = new Map<string, Record<string, unknown>>();
  /** Step keys whose observed state is the PREVIOUS step's (stale page). */
  readonly staleStateOnStep = new Set<string>();

  // -- the recording surface (test proofs) --
  readonly performRequests: BrowserActionRequest[] = [];
  readonly sessionStarts: BrowserSessionStartRequest[] = [];
  readonly endSessions: BrowserSessionEndRequest[] = [];
  readonly crashedSteps: string[] = [];
  /** Which OPAQUE credential reference each profile materialized. */
  readonly materializedRefs = new Map<string, string>();
  /** Which credential FIELDS were typed inside which profile. */
  readonly typedSecretFields = new Map<string, Set<string>>();

  constructor(options: ScriptedBrowserDriverOptions = {}) {
    for (const [url, page] of Object.entries(options.pages ?? {})) {
      this.pages.set(url, { title: page.title, fields: { ...page.fields } });
    }
  }

  // -----------------------------------------------------------------------
  // Scripting API (tests)
  // -----------------------------------------------------------------------

  seedPage(url: string, page: ScriptedPage): void {
    this.pages.set(url, { title: page.title, fields: { ...page.fields } });
  }

  failStepOnceKey(stepKey: string): void {
    this.failStepOnce.add(stepKey);
  }

  /** The value the profile materialized for a credential field (fixture-only). */
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

  async startSession(
    request: BrowserSessionStartRequest,
  ): Promise<BrowserSessionStartResult> {
    this.sessionStarts.push(request);
    let profile = this.profiles.get(request.profileKey);
    if (profile === undefined) {
      profile = { lastPageUrl: null, credentialStore: new Map() };
      this.profiles.set(request.profileKey, profile);
    }
    // The opaque reference is materialized ONCE, INSIDE the isolated
    // profile — the value never crosses back (the W082 discipline).
    if (request.credentialRef !== null) {
      this.materializedRefs.set(request.profileKey, request.credentialRef);
      if (!profile.credentialStore.has('username')) {
        // Fake materialized fragments (never a realistic token literal).
        profile.credentialStore.set('username', ['materialized-', 'user-of-', request.credentialRef].join(''));
        profile.credentialStore.set('password', ['materialized-', 'secret-of-', request.credentialRef].join(''));
      }
    }
    this.sessionCounter += 1;
    const sessionKey = `browser-session-${this.sessionCounter.toString().padStart(4, '0')}`;
    // A fresh session on the same profile resumes on the profile's page —
    // the browser-profile continuity a resume needs.
    this.sessions.set(sessionKey, {
      profileKey: request.profileKey,
      currentUrl: profile.lastPageUrl,
      allowlist: { urlGlobs: [...request.allowlist.urlGlobs], verbs: [...request.allowlist.verbs] },
      closed: false,
    });
    return { sessionKey };
  }

  async performAction(request: BrowserActionRequest): Promise<BrowserActionResult> {
    const session = this.sessions.get(request.sessionKey);
    if (session === undefined || session.closed) {
      throw new Error(`the scripted browser session '${request.sessionKey}' is not live`);
    }
    this.performRequests.push(request);
    const { action } = request;

    // Honoring idempotency: an accepted action replays its recorded
    // effect — a crash between accept-and-record never double-executes.
    const memoized = this.acceptedEffects.get(request.idempotencyKey);
    if (memoized !== undefined) return memoized;

    // The worker/session death: the driver itself dies mid-run. The task
    // parks resumable; the profile's continuity is what survives.
    if (this.crashOnStep.has(request.stepKey)) {
      this.crashedSteps.push(request.stepKey);
      throw new Error(`simulated browser worker death while performing step '${request.stepKey}'`);
    }

    // The driver-side allowlist copy (the W088 twice-checked discipline):
    // the session's OWN frozen copy, received at start.
    const allowlist = session.allowlist;
    if (allowlist !== null) {
      const matched = allowlist.urlGlobs.find((glob) => urlMatchesGlob(action.url, glob));
      if (matched === undefined) {
        return {
          receipt: {
            status: 'rejected',
            receiptId: null,
            detail: `blocked by the driver-side allowlist copy: the URL '${action.url}' matches none of ${allowlist.urlGlobs.join(', ')}`,
          },
          observedState: null,
          screenshotRef: null,
          actionTrace: null,
        };
      }
      if (!allowlist.verbs.includes(action.verb)) {
        return {
          receipt: {
            status: 'rejected',
            receiptId: null,
            detail: `blocked by the driver-side allowlist copy: the verb '${action.verb}' is not permitted (${allowlist.verbs.join(', ')})`,
          },
          observedState: null,
          screenshotRef: null,
          actionTrace: null,
        };
      }
    }

    if (this.refuseStep.has(request.stepKey)) {
      return {
        receipt: {
          status: 'rejected',
          receiptId: null,
          detail: 'refused by the site (permanent) — the scripted browser refuses this action',
        },
        observedState: null,
        screenshotRef: null,
        actionTrace: null,
      };
    }
    if (this.failStepOnce.has(request.stepKey)) {
      this.failStepOnce.delete(request.stepKey);
      return {
        receipt: {
          status: 'failed',
          receiptId: null,
          detail: 'browser session timeout — transient, retry in a fresh session',
        },
        observedState: null,
        screenshotRef: null,
        actionTrace: null,
      };
    }

    const result = this.applyAction(session, request);
    if (result.receipt.status === 'accepted') {
      this.acceptedEffects.set(request.idempotencyKey, result);
    }
    return result;
  }

  async endSession(request: BrowserSessionEndRequest): Promise<void> {
    this.endSessions.push(request);
    const session = this.sessions.get(request.sessionKey);
    if (session !== undefined) session.closed = true;
  }

  // -----------------------------------------------------------------------
  // The tiny-site semantics (private)
  // -----------------------------------------------------------------------

  private applyAction(
    session: ScriptedSession,
    request: BrowserActionRequest,
  ): BrowserActionResult {
    const { action } = request;
    const profile = this.profiles.get(session.profileKey)!;

    if (action.verb === 'goto') {
      session.currentUrl = action.url;
    }

    if (action.verb === 'type') {
      const page = this.currentPageOf(session);
      const selector = action.selector;
      const secretField = action.secretField;
      if (page !== undefined && typeof selector === 'string') {
        if (typeof secretField === 'string') {
          // The materialized value is typed INSIDE the profile; the page
          // (and therefore the observed state) carries only a redaction
          // marker — pages never echo passwords back.
          const materialized = profile.credentialStore.get(secretField);
          if (materialized === undefined) {
            return this.rejected(
              `the credential field '${secretField}' was not materialized in the isolated profile — the reference resolved to nothing`,
            );
          }
          if (!this.typedSecretFields.has(session.profileKey)) {
            this.typedSecretFields.set(session.profileKey, new Set());
          }
          this.typedSecretFields.get(session.profileKey)!.add(secretField);
          page.fields[selector] = `<redacted secret field '${secretField}'>`;
        } else {
          page.fields[selector] = action.value ?? '';
        }
      }
    }

    // The observed state of the current page (normalized canonical JSON).
    let observed = this.observeCurrent(session);

    // Scripted divergences (verification-failure evidence modes).
    const divergence = this.divergeSteps.get(request.stepKey);
    if (divergence !== undefined && observed.found) {
      observed = {
        found: true,
        state: { ...(observed.state as Record<string, unknown>), ...divergence },
      };
    }
    if (this.staleStateOnStep.has(request.stepKey) && this.lastObservedState !== null) {
      observed = this.lastObservedState;
    }
    this.lastObservedState = observed;

    // The page continuity is recorded on the PROFILE, not the session —
    // sessions are disposable, profiles persist across the task's resumes.
    profile.lastPageUrl = session.currentUrl;

    this.receiptCounter += 1;
    const receiptId = `browser-rcpt-${this.receiptCounter.toString().padStart(4, '0')}`;
    this.screenshotCounter += 1;
    const screenshotRef = `computer-use-screenshot://${this.screenshotCounter.toString().padStart(6, '0')}-${newId()}`;
    return {
      receipt: { status: 'accepted', receiptId, detail: null },
      observedState: observed,
      screenshotRef,
      actionTrace: this.traceOf(action),
    };
  }

  /** The last observed state (the stale-page divergence source). */
  private lastObservedState: { found: boolean; state: unknown } | null = null;

  private currentPageOf(session: ScriptedSession): ScriptedPage | undefined {
    if (session.currentUrl === null) return undefined;
    return this.pages.get(session.currentUrl);
  }

  private observeCurrent(session: ScriptedSession): { found: boolean; state: unknown } {
    const page = this.currentPageOf(session);
    if (page === undefined || session.currentUrl === null) {
      return { found: false, state: null };
    }
    return { found: true, state: { url: session.currentUrl, title: page.title, ...page.fields } };
  }

  private rejected(detail: string): BrowserActionResult {
    return {
      receipt: { status: 'rejected', receiptId: null, detail },
      observedState: null,
      screenshotRef: null,
      actionTrace: null,
    };
  }

  /** The normalized, REDACTED action trace (plain JSON — no secrets). */
  private traceOf(action: BrowserAction): Record<string, unknown> {
    return {
      verb: action.verb,
      url: action.url,
      selector: action.selector ?? null,
      typed:
        action.verb === 'type'
          ? action.secretField !== null
            ? { kind: 'secret-field', field: action.secretField, redacted: true }
            : { kind: 'literal', length: (action.value ?? '').length }
          : null,
    };
  }
}

/**
 * Creates the deterministic scripted browser driver (the fixture double).
 * Tests seed pages and script failure modes; the driver records every
 * call for exactly-once/isolation proofs.
 */
export function createScriptedBrowserDriver(
  options: ScriptedBrowserDriverOptions = {},
): ScriptedBrowserDriver {
  return new ScriptedBrowserDriver(options);
}
