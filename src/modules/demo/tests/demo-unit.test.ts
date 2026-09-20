// W068 — the demo harness's UNIT tests (pure logic, no database).
//
// Covered:
//   * the production-backdoor guard (every branch — pure env objects);
//   * the four demo roles and their account/company bindings;
//   * the demo credential discipline (fragments assembled at runtime; the
//     full literal never appears in source — GitHub push protection);
//   * the role→capability visibility model and its DERIVATION from the
//     real authority model (auth/claims.ts), including the honest
//     platform-claim exception.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEMO_ACCOUNTS,
  DEMO_CAPABILITIES,
  DEMO_COMPANIES,
  DEMO_ROLES,
  capabilitiesForRole,
  demoRoleDirectory,
  demoSessionClaims,
  demoSharedPassword,
  demoTenantRole,
  isDemoRole,
  visibleCapabilityKeys,
} from '../contract';
import {
  assertDemoSeedAllowed,
  DEMO_SEED_ENV,
  isDemoOptedIn,
  isDemoSeedAllowed,
  isEmbeddedDatabase,
  type DemoSeedEnvironment,
} from '../contract';
import { DemoError } from '../contract';

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('the production-backdoor guard', () => {
  const embedded: DemoSeedEnvironment = {
    databaseUrl: undefined,
    aurumDb: undefined,
    demoSeed: '1',
  };

  it('allows the embedded database with the explicit opt-in', () => {
    expect(isDemoSeedAllowed(embedded)).toBe(true);
    expect(isDemoSeedAllowed({ ...embedded, aurumDb: 'embedded' })).toBe(true);
    expect(() => assertDemoSeedAllowed(embedded)).not.toThrow();
  });

  it('refuses a server database (DATABASE_URL set) even with the opt-in', () => {
    const env: DemoSeedEnvironment = {
      databaseUrl: 'postgres://user:pass@db.example.com:5432/aurum',
      aurumDb: undefined,
      demoSeed: '1',
    };
    expect(isEmbeddedDatabase(env)).toBe(false);
    expect(isDemoSeedAllowed(env)).toBe(false);
    expect(() => assertDemoSeedAllowed(env)).toThrow(DemoError);
    try {
      assertDemoSeedAllowed(env);
      expect.unreachable('the guard must throw');
    } catch (error) {
      expect((error as DemoError).code).toBe('production_backdoor');
      expect((error as Error).message).toContain('DATABASE_URL');
    }
  });

  it('refuses the embedded database without the explicit opt-in', () => {
    const env: DemoSeedEnvironment = { databaseUrl: undefined, aurumDb: undefined, demoSeed: undefined };
    expect(isDemoOptedIn(env)).toBe(false);
    expect(isDemoSeedAllowed(env)).toBe(false);
    expect(() => assertDemoSeedAllowed(env)).toThrow(DemoError);
    try {
      assertDemoSeedAllowed(env);
      expect.unreachable('the guard must throw');
    } catch (error) {
      expect((error as DemoError).code).toBe('production_backdoor');
      expect((error as Error).message).toContain(DEMO_SEED_ENV);
    }
  });

  it('refuses a non-embedded explicit db mode', () => {
    expect(isEmbeddedDatabase({ databaseUrl: undefined, aurumDb: 'server' })).toBe(false);
    expect(isDemoSeedAllowed({ databaseUrl: undefined, aurumDb: 'server', demoSeed: '1' })).toBe(false);
  });

  it('treats an empty DATABASE_URL as unset (the embedded default holds)', () => {
    expect(isEmbeddedDatabase({ databaseUrl: '', aurumDb: undefined })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The four roles
// ---------------------------------------------------------------------------

describe('the four demo roles', () => {
  it('is exactly manager, employee, developer and platform reviewer', () => {
    expect([...DEMO_ROLES]).toEqual(['manager', 'employee', 'developer', 'platform-reviewer']);
    expect(isDemoRole('manager')).toBe(true);
    expect(isDemoRole('intern')).toBe(false);
  });

  it('binds each role to a distinct deterministic account under the reserved .example domain', () => {
    const emails = DEMO_ROLES.map((role) => DEMO_ACCOUNTS[role].email);
    expect(new Set(emails).size).toBe(4);
    for (const role of DEMO_ROLES) {
      const account = DEMO_ACCOUNTS[role];
      expect(account.email).toMatch(/@.*\.example$/);
      expect(account.displayName.trim().length).toBeGreaterThan(2);
      expect(account.purpose.length).toBeGreaterThan(10);
    }
  });

  it('binds manager and employee to the company, developer to the vendor, reviewer to the platform', () => {
    expect(DEMO_ACCOUNTS.manager.company).toBe('company');
    expect(DEMO_ACCOUNTS.employee.company).toBe('company');
    expect(DEMO_ACCOUNTS.developer.company).toBe('vendor');
    expect(DEMO_ACCOUNTS['platform-reviewer'].company).toBe('platform');
  });

  it('maps the roles onto real tenant roles (owner/member/admin)', () => {
    expect(demoTenantRole('manager')).toBe('owner');
    expect(demoTenantRole('employee')).toBe('member');
    expect(demoTenantRole('developer')).toBe('owner');
    expect(demoTenantRole('platform-reviewer')).toBe('admin');
  });

  it('names the three demo companies deterministically (all obviously demo)', () => {
    expect(DEMO_COMPANIES.company.name).toBe('Meridian Freight (Demo)');
    expect(DEMO_COMPANIES.vendor.name).toBe('Cobalt Labs (Demo)');
    expect(DEMO_COMPANIES.platform.name).toBe('Aurum Platform (Demo)');
    for (const company of Object.values(DEMO_COMPANIES)) {
      expect(company.name).toContain('Demo');
    }
  });
});

// ---------------------------------------------------------------------------
// The demo credential discipline
// ---------------------------------------------------------------------------

describe('the demo credential', () => {
  it('assembles the shared demo password at runtime from fragments', () => {
    const password = demoSharedPassword();
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(password).toBe(demoSharedPassword()); // deterministic
    // The word 'demo' is part of it: it reads as a demo credential, not a
    // realistic production secret.
    expect(password.toLowerCase()).toContain('demo');
  });

  it('never carries the full credential as a literal in source (push protection)', () => {
    const password = demoSharedPassword();
    const sources = [
      readFileSync(fileURLToPath(new URL('../roles.ts', import.meta.url)), 'utf8'),
      readFileSync(fileURLToPath(new URL('./demo-unit.test.ts', import.meta.url)), 'utf8'),
    ];
    for (const source of sources) {
      expect(source).not.toContain(password);
    }
  });
});

// ---------------------------------------------------------------------------
// The capability visibility model
// ---------------------------------------------------------------------------

describe('the role→capability visibility model', () => {
  const keysOf = (role: Parameters<typeof capabilitiesForRole>[0]) =>
    Object.fromEntries(capabilitiesForRole(role).map((capability) => [capability.key, capability]));

  it('carries the real product vocabulary (the shell areas + the authority-gated capabilities)', () => {
    const keys = DEMO_CAPABILITIES.map((capability) => capability.key);
    for (const area of ['chat', 'today', 'intelligence', 'people', 'connections', 'marketplace', 'more']) {
      expect(keys).toContain(area);
    }
    for (const gated of [
      'marketplace-developer',
      'marketplace-install',
      'approvals-decide',
      'api-keys',
      'platform-review',
    ]) {
      expect(keys).toContain(gated);
    }
  });

  it('gives every member the seven product areas', () => {
    for (const role of DEMO_ROLES) {
      const visible = visibleCapabilityKeys(role);
      for (const area of ['chat', 'today', 'intelligence', 'people', 'connections', 'marketplace', 'more']) {
        expect(visible).toContain(area);
      }
    }
  });

  it('shows the manager the management capabilities through session claims', () => {
    const manager = keysOf('manager');
    expect(manager['approvals-decide']!.visible).toBe(true);
    expect(manager['approvals-decide']!.via).toBe('session');
    expect(manager['marketplace-developer']!.visible).toBe(true);
    expect(manager['marketplace-install']!.visible).toBe(true);
    expect(manager['api-keys']!.visible).toBe(true);
    // Platform governance is NOT a tenant capability — not even for the owner.
    expect(manager['platform-review']!.visible).toBe(false);
    expect(manager['platform-review']!.via).toBeNull();
  });

  it('hides every management capability from the employee (a plain member carries no claims)', () => {
    expect(demoSessionClaims('employee')).toEqual([]);
    const employee = keysOf('employee');
    expect(employee['approvals-decide']!.visible).toBe(false);
    expect(employee['marketplace-developer']!.visible).toBe(false);
    expect(employee['marketplace-install']!.visible).toBe(false);
    expect(employee['api-keys']!.visible).toBe(false);
    expect(employee['platform-review']!.visible).toBe(false);
    for (const capability of capabilitiesForRole('employee')) {
      if (capability.visible) {
        expect(capability.via).toBe('session');
      }
    }
  });

  it('gives the developer the vendor-side capabilities (owner of the vendor company)', () => {
    const developer = keysOf('developer');
    expect(developer['marketplace-developer']!.visible).toBe(true);
    expect(developer['marketplace-install']!.visible).toBe(true);
    expect(developer['approvals-decide']!.visible).toBe(true);
    expect(developer['api-keys']!.visible).toBe(true);
    expect(developer['platform-review']!.visible).toBe(false);
  });

  it('reaches platform review only through the platform pipeline (never a session)', () => {
    const reviewer = keysOf('platform-reviewer');
    // The reviewer's admin session carries the vendor-side claims too...
    expect(reviewer['marketplace-developer']!.visible).toBe(true);
    expect(reviewer['api-keys']!.visible).toBe(true);
    // ...but the platform review capability is the documented exception:
    // the platform claim never rides a tenant session.
    const platformReview = reviewer['platform-review']!;
    expect(platformReview.visible).toBe(true);
    expect(platformReview.via).toBe('platform-pipeline');
    expect(platformReview.note).toContain('never rides a tenant session');
    // No OTHER role reaches the platform pipeline.
    for (const role of ['manager', 'employee', 'developer'] as const) {
      expect(keysOf(role)['platform-review']!.visible).toBe(false);
    }
  });

  it('derives visibility from the real W058 claims mapping (never a parallel model)', () => {
    // The employee's session claims are exactly claimsForRole('member').
    expect(demoSessionClaims('employee')).toEqual([]);
    // The manager's are exactly claimsForRole('owner') — and the
    // approvals-decide capability rides 'actions:approve' from that set.
    const managerClaims = demoSessionClaims('manager');
    expect(managerClaims).toContain('actions:approve');
    expect(managerClaims).toContain('extensions:administer');
    expect(managerClaims).toContain('api:administer');
    // A capability is visible iff a required claim is derived — recompute
    // the model's rule independently for every gated capability.
    for (const role of DEMO_ROLES) {
      const claims = demoSessionClaims(role);
      for (const capability of DEMO_CAPABILITIES) {
        if (capability.platformClaim || capability.requiredClaims.length === 0) continue;
        const expected = capability.requiredClaims.some((claim) => claims.includes(claim));
        const actual = capabilitiesForRole(role).find((entry) => entry.key === capability.key)!;
        expect(actual.visible, `${role}/${capability.key}`).toBe(expected);
      }
    }
  });

  it('exposes the full directory for browser verification (W070 journey matrix)', () => {
    const directory = demoRoleDirectory();
    expect(directory).toHaveLength(4);
    for (const entry of directory) {
      expect(entry.account).toBe(DEMO_ACCOUNTS[entry.role]);
      expect(entry.company).toBe(DEMO_COMPANIES[entry.account.company]);
      expect(entry.capabilities.length).toBe(DEMO_CAPABILITIES.length);
      expect(entry.sessionClaims).toEqual(demoSessionClaims(entry.role));
    }
  });
});
