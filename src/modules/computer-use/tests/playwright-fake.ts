// The deterministic Playwright-surface DOUBLE (W110) — the shared test
// fixture both Playwright-adapter suites inject at the vendor seam: a
// fake of exactly the Playwright surface the adapter drives (the
// structural handles of adapters/playwright-driver.ts). NO real browser,
// NO network (the fixtures/doubles doctrine). The fake models a tiny
// site the way the module's scripted driver double does — seeded pages,
// form fields keyed by canonical selectors, form submits, one-shot
// network failures, strict-mode violations — but at the VENDOR layer,
// so the tests prove the ADAPTER's canonical-envelope → vendor →
// canonical-result mapping itself.

import { createHash } from 'node:crypto';
import {
  canonicalSelectorKey,
  type PlaywrightArtifactRecord,
  type PlaywrightArtifactStore,
  type PlaywrightBrowserHandle,
  type PlaywrightContextHandle,
  type PlaywrightCredentialSource,
  type PlaywrightLauncher,
  type PlaywrightLocatorHandle,
  type PlaywrightPageHandle,
  type PlaywrightProfileStore,
} from '../adapters/playwright-driver';

// ---------------------------------------------------------------------------
// The tiny site (the fake external world)
// ---------------------------------------------------------------------------

export interface FakeFieldEntry {
  /** The canonical selector key ('#id' or '[name="…"]'). */
  key: string;
  id: string | null;
  name: string | null;
  type: string | null;
  value: string;
  checked: boolean;
  clickable: boolean;
  /** Where a submit-click navigates to (the fake form POST + redirect). */
  submitTo: string | null;
}

export interface FakePageModel {
  title: string;
  heading: string | null;
  fields: FakeFieldEntry[];
}

export class FakeSite {
  readonly pages = new Map<string, FakePageModel>();
  /** URLs whose NEXT navigation throws a one-shot network error. */
  readonly netFailuresOnce = new Set<string>();
  /** Every form submit (the collected field values + the target). */
  readonly submits: Array<{ target: string; form: Record<string, string> }> = [];
  /** Click side-effects the site models (selector → mutation of a field). */
  readonly clickEffects = new Map<string, { selector: string; value: string }>();
}

export function fakeField(key: string, overrides: Partial<FakeFieldEntry> = {}): FakeFieldEntry {
  const idMatch = /^#(.+)$/.exec(key);
  const nameMatch = /^\[name="(.+)"\]$/.exec(key);
  return {
    key,
    id: idMatch !== null ? idMatch[1]! : null,
    name: nameMatch !== null ? nameMatch[1]! : null,
    type: 'text',
    value: '',
    checked: false,
    clickable: false,
    submitTo: null,
    ...overrides,
  };
}

/** The seeded vendor-portal fixture site (login + dashboard). */
export function fakeVendorPortalSite(): FakeSite {
  const site = new FakeSite();
  site.pages.set('https://vendor.example/login', {
    title: 'Vendor portal',
    heading: 'Sign in',
    fields: [
      fakeField('#username'),
      fakeField('#password', { type: 'password' }),
      fakeField('#submit', { type: 'submit', clickable: true, submitTo: 'https://vendor.example/app' }),
    ],
  });
  site.pages.set('https://vendor.example/app', {
    title: 'Dashboard',
    heading: 'Dashboard',
    fields: [
      fakeField('[name="loggedIn"]', { type: 'hidden', value: 'true' }),
      fakeField('[name="tick"]', { type: 'hidden' }),
      fakeField('#refresh', { type: 'button', clickable: true }),
    ],
  });
  site.clickEffects.set('#refresh', { selector: '[name="tick"]', value: 'refreshed' });
  return site;
}

// ---------------------------------------------------------------------------
// The fake Playwright surface (locator → page → context → browser)
// ---------------------------------------------------------------------------

class FakeFieldLocator implements PlaywrightLocatorHandle {
  constructor(private readonly entry: FakeFieldEntry) {}
  async count(): Promise<number> {
    return 1;
  }
  nth(): PlaywrightLocatorHandle {
    return this;
  }
  async getAttribute(name: string): Promise<string | null> {
    if (name === 'id') return this.entry.id;
    if (name === 'name') return this.entry.name;
    if (name === 'type') return this.entry.type;
    return null;
  }
  async inputValue(): Promise<string> {
    return this.entry.value;
  }
  async isChecked(): Promise<boolean> {
    return this.entry.checked;
  }
  async textContent(): Promise<string | null> {
    return null;
  }
}

class FakeFieldListLocator implements PlaywrightLocatorHandle {
  constructor(private readonly entries: FakeFieldEntry[]) {}
  async count(): Promise<number> {
    return this.entries.length;
  }
  nth(index: number): PlaywrightLocatorHandle {
    const entry = this.entries[index];
    if (entry === undefined) throw new Error(`fake locator nth(${index}) out of range`);
    return new FakeFieldLocator(entry);
  }
  async getAttribute(): Promise<string | null> {
    throw new Error('the adapter never reads attributes from the field list itself');
  }
  async inputValue(): Promise<string> {
    throw new Error('the adapter never reads a value from the field list itself');
  }
  async isChecked(): Promise<boolean> {
    throw new Error('the adapter never reads checked from the field list itself');
  }
  async textContent(): Promise<string | null> {
    return null;
  }
}

class FakeHeadingLocator implements PlaywrightLocatorHandle {
  constructor(private readonly heading: string | null) {}
  async count(): Promise<number> {
    return this.heading === null ? 0 : 1;
  }
  nth(): PlaywrightLocatorHandle {
    return this;
  }
  async getAttribute(): Promise<string | null> {
    return null;
  }
  async inputValue(): Promise<string> {
    throw new Error('h1 has no value');
  }
  async isChecked(): Promise<boolean> {
    return false;
  }
  async textContent(): Promise<string | null> {
    return this.heading;
  }
}

export class FakePage implements PlaywrightPageHandle {
  currentUrl: string | null = null;
  readonly fills: Array<{ selector: string; value: string }> = [];
  readonly clicks: string[] = [];

  constructor(
    private readonly site: FakeSite,
    private readonly context: FakeContext,
  ) {}

  private get model(): FakePageModel | null {
    if (this.currentUrl === null) return null;
    return this.site.pages.get(this.currentUrl) ?? null;
  }

  private matchFields(selector: string): FakeFieldEntry[] {
    const fields = this.model?.fields ?? [];
    return fields.filter(
      (entry) => entry.key === selector || canonicalSelectorKey(selector) === entry.key,
    );
  }

  async goto(url: string): Promise<unknown> {
    if (this.site.netFailuresOnce.delete(url)) {
      throw new Error(`net::ERR_CONNECTION_RESET ${url} (one-shot scripted network failure)`);
    }
    if (!this.site.pages.has(url)) {
      throw new Error(`net::ERR_NAME_NOT_RESOLVED ${url} — the fake site has no such page`);
    }
    this.currentUrl = url;
    return null;
  }

  url(): string {
    return this.currentUrl ?? 'about:blank';
  }

  async title(): Promise<string> {
    return this.model?.title ?? '';
  }

  async fill(selector: string, value: string): Promise<void> {
    const matches = this.matchFields(selector);
    if (matches.length === 0) {
      const error = new Error(`Timeout 15000ms exceeded waiting for locator '${selector}'`);
      error.name = 'TimeoutError';
      throw error;
    }
    if (matches.length > 1) {
      throw new Error(
        `strict mode violation: locator '${selector}' resolved to ${matches.length} elements`,
      );
    }
    matches[0]!.value = value;
    this.fills.push({ selector, value });
  }

  async click(selector: string): Promise<void> {
    const matches = this.matchFields(selector);
    if (matches.length === 0 || !matches[0]!.clickable) {
      const error = new Error(`Timeout 15000ms exceeded waiting for locator '${selector}'`);
      error.name = 'TimeoutError';
      throw error;
    }
    this.clicks.push(selector);
    const entry = matches[0]!;
    if (entry.submitTo !== null) {
      const form: Record<string, string> = {};
      for (const field of this.model?.fields ?? []) {
        if (field.type !== 'password') form[field.key] = field.value;
      }
      this.site.submits.push({ target: entry.submitTo, form });
      await this.goto(entry.submitTo);
      return;
    }
    const effect = this.site.clickEffects.get(selector);
    if (effect !== undefined) {
      const target = this.matchFields(effect.selector);
      if (target.length > 0) target[0]!.value = effect.value;
    }
  }

  locator(selector: string): PlaywrightLocatorHandle {
    if (selector === 'h1') return new FakeHeadingLocator(this.model?.heading ?? null);
    if (selector === 'input, textarea, select') {
      return new FakeFieldListLocator([...(this.model?.fields ?? [])]);
    }
    throw new Error(`the adapter never locates '${selector}' directly`);
  }

  async content(): Promise<string> {
    return `<html><head><title>${this.model?.title ?? ''}</title></head><body><h1>${
      this.model?.heading ?? ''
    }</h1></body></html>`;
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(`fake-png-${this.context.browserShotSeq.value++}`, 'utf8');
  }
}

export class FakeContext implements PlaywrightContextHandle {
  readonly pages: FakePage[] = [];
  closed = false;
  readonly initialStorageState: unknown;

  constructor(
    private readonly site: FakeSite,
    initialStorageState: unknown,
    readonly browserShotSeq: { value: number },
  ) {
    this.initialStorageState = initialStorageState;
  }

  async newPage(): Promise<PlaywrightPageHandle> {
    const page = new FakePage(this.site, this);
    this.pages.push(page);
    return page;
  }

  async storageState(): Promise<unknown> {
    // The fake models the login cookie: a storage state the profile can
    // persist and a fresh context on the same profile would resume with.
    return { cookies: [{ name: 'w110session', value: 'ok' }] };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeBrowser implements PlaywrightBrowserHandle {
  readonly contexts: FakeContext[] = [];
  closed = false;
  private readonly shotSeq = { value: 0 };

  constructor(private readonly site: FakeSite) {}

  async newContext(options: { storageState?: unknown }): Promise<PlaywrightContextHandle> {
    const context = new FakeContext(this.site, options.storageState ?? null, this.shotSeq);
    this.contexts.push(context);
    return context;
  }

  version(): string {
    return 'fake-chromium/143.0.7499.4 (deterministic double of the Playwright surface)';
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** The injectable launcher seam over the fake site. */
export function fakeLauncher(site: FakeSite): PlaywrightLauncher {
  return async () => new FakeBrowser(site);
}

// ---------------------------------------------------------------------------
// The in-memory configuration seams
// ---------------------------------------------------------------------------

export class MemoryArtifactStore implements PlaywrightArtifactStore {
  readonly records: PlaywrightArtifactRecord[] = [];
  readonly blobs = new Map<string, Uint8Array>();

  async put(
    kind: 'screenshot' | 'dom-snapshot',
    data: Uint8Array,
  ): Promise<PlaywrightArtifactRecord> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const record = {
      ref: `computer-use-playwright://${kind}/${sha256.slice(0, 16)}`,
      sha256,
      bytes: data.byteLength,
    };
    this.records.push(record);
    this.blobs.set(record.ref, data);
    return record;
  }
}

export class MemoryProfileStore implements PlaywrightProfileStore {
  readonly states = new Map<string, unknown>();
  async load(profileKey: string): Promise<unknown> {
    return this.states.get(profileKey) ?? null;
  }
  async save(profileKey: string, storageState: unknown): Promise<void> {
    this.states.set(profileKey, storageState);
  }
}

/** A static credential map as an injectable credential source. */
export function staticCredentialSource(
  map: Record<string, Record<string, string>>,
): PlaywrightCredentialSource {
  return {
    fields: (ref) => Object.keys(map[ref] ?? {}),
    resolve: (ref, field) => map[ref]?.[field],
  };
}
