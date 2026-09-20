// Unit tests of the demo module's PURE halves (W068): the non-production
// gate, the role/capability visibility matrix, the journey catalog and
// the deterministic manifest. No database — everything here must hold
// from source alone.

import { describe, expect, it } from 'vitest';
import { claimsForRole, MANAGEMENT_CLAIMS } from '@/modules/auth/contract';
import { evaluateDemoSeedGate } from '../gate';
import {
  DEMO_CAPABILITIES,
  DEMO_ROLES,
  capabilityVisibilityForRole,
  demoCapability,
  demoRole,
  roleSeesCapability,
} from '../roles';
import { DEMO_JOURNEYS, demoAnchorKeys, demoJourney } from '../journeys';
import {
  DEMO_KEYS,
  DEMO_PASSWORD_FRAGMENTS,
  DEMO_PERSONAS,
  DEMO_TENANTS,
  DEMO_TIME,
  assertManifestConsistency,
  demoPersonaPassword,
  demoPersonaSpec,
  demoTenantSpec,
} from '../manifest';

// ---------------------------------------------------------------------------
// The gate — "no production backdoor"
// ---------------------------------------------------------------------------

describe('the demo seed gate (no production backdoor)', () => {
  const base = {
    backend: undefined as undefined | 'embedded' | 'postgres',
    databaseUrl: undefined as string | undefined,
    memoryMode: false,
    optIn: false,
    nodeEnv: undefined as string | undefined,
  };

  it('refuses a server database (DATABASE_URL)', () => {
    const decision = evaluateDemoSeedGate({ ...base, databaseUrl: 'postgresql://demo.example/prod' });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.code).toBe('production_backend');
  });

  it('refuses an explicit postgres backend', () => {
    const decision = evaluateDemoSeedGate({ ...base, backend: 'postgres' });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.code).toBe('production_backend');
  });

  it('refuses a production runtime even on the embedded backend with opt-in', () => {
    const decision = evaluateDemoSeedGate({
      ...base,
      nodeEnv: 'production',
      backend: 'embedded',
      optIn: true,
    });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.code).toBe('production_runtime');
  });

  it('allows the test-harness memory mode', () => {
    expect(evaluateDemoSeedGate({ ...base, memoryMode: true }).allowed).toBe(true);
  });

  it('allows the explicit opt-in on the embedded backend', () => {
    expect(evaluateDemoSeedGate({ ...base, backend: 'embedded', optIn: true }).allowed).toBe(true);
  });

  it('refuses everything else — nobody seeds by accident', () => {
    const decision = evaluateDemoSeedGate({ ...base, backend: 'embedded' });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.code).toBe('opt_in_required');
  });

  it('never lets a database url sneak past the opt-in', () => {
    const decision = evaluateDemoSeedGate({
      ...base,
      backend: 'embedded',
      optIn: true,
      databaseUrl: 'postgresql://demo.example/prod',
    });
    expect(decision.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The role / capability visibility matrix
// ---------------------------------------------------------------------------

describe('the demo capability matrix', () => {
  it('has exactly the four work-item roles', () => {
    expect(DEMO_ROLES.map((role) => role.id)).toEqual([
      'manager',
      'employee',
      'developer',
      'platform-reviewer',
    ]);
  });

  it('maps the roles onto the real tenant-role ladder', () => {
    expect(demoRole('manager').tenantRole).toBe('owner');
    expect(demoRole('developer').tenantRole).toBe('admin');
    expect(demoRole('employee').tenantRole).toBe('member');
    expect(demoRole('platform-reviewer').tenantRole).toBe('admin');
  });

  it('every tenant-role capability is really derivable from a session role at this base', () => {
    for (const capability of DEMO_CAPABILITIES.filter((entry) => entry.claimSource === 'tenant-role')) {
      for (const claim of capability.requiredClaims) {
        expect(claimsForRole('owner')).toContain(claim);
        expect(claimsForRole('admin')).toContain(claim);
        expect(claimsForRole('member')).not.toContain(claim);
      }
    }
  });

  it('harness-only claims never ride a tenant session at this base', () => {
    for (const capability of DEMO_CAPABILITIES.filter((entry) => entry.claimSource === 'harness-only')) {
      for (const claim of capability.requiredClaims) {
        expect(MANAGEMENT_CLAIMS).not.toContain(claim);
        expect(claimsForRole('owner')).not.toContain(claim);
      }
    }
  });

  it('open capabilities need no claims', () => {
    for (const capability of DEMO_CAPABILITIES.filter((entry) => entry.claimSource === 'open')) {
      expect(capability.requiredClaims).toEqual([]);
    }
  });

  it('the employee sees no claim-gated capability', () => {
    const gated = DEMO_CAPABILITIES.filter(
      (capability) => capability.claimSource === 'tenant-role' || capability.claimSource === 'harness-only',
    );
    for (const capability of gated) {
      expect(roleSeesCapability('employee', capability.id)).toBe(false);
    }
  });

  it('the manager sees the approval and policy capabilities', () => {
    expect(roleSeesCapability('manager', 'approve-actions')).toBe(true);
    expect(roleSeesCapability('manager', 'administer-policies')).toBe(true);
    expect(roleSeesCapability('manager', 'platform-review')).toBe(false);
  });

  it('the developer sees the develop/publish and API capabilities', () => {
    expect(roleSeesCapability('developer', 'marketplace-develop')).toBe(true);
    expect(roleSeesCapability('developer', 'developer-api')).toBe(true);
  });

  it('the platform reviewer sees the platform review capability (harness-claim scoped at this base)', () => {
    expect(roleSeesCapability('platform-reviewer', 'platform-review')).toBe(true);
    expect(demoCapability('platform-review').claimSource).toBe('harness-only');
  });

  it('every role sees the chat capability', () => {
    for (const role of DEMO_ROLES) {
      expect(roleSeesCapability(role.id, 'chat')).toBe(true);
    }
  });

  it('capability visibility is stable and complete per role', () => {
    for (const role of DEMO_ROLES) {
      const visible = capabilityVisibilityForRole(role.id);
      expect(visible.map((capability) => capability.id)).toEqual([...role.capabilities]);
    }
  });
});

// ---------------------------------------------------------------------------
// The journey catalog — "deterministic data for every major journey"
// ---------------------------------------------------------------------------

describe('the demo journey catalog', () => {
  it('covers every plan §2 journey A–L exactly once, plus the substrate', () => {
    expect(DEMO_JOURNEYS).toHaveLength(13);
    const letters = DEMO_JOURNEYS.map((journey) => journey.ref).sort();
    expect(letters).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', '·']);
  });

  it('every journey names a valid primary role and seeds at least one anchor', () => {
    for (const journey of DEMO_JOURNEYS) {
      expect(() => demoRole(journey.primaryRole)).not.toThrow();
      expect(journey.anchorKeys.length).toBeGreaterThan(0);
    }
  });

  it('anchor keys are unique across the whole catalog', () => {
    const keys = demoAnchorKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the approval journey leaves pending gate data; the marketplace journey reaches both sides', () => {
    expect(demoJourney('consequential-approval').anchorKeys).toContain('cognition-execution');
    expect(demoJourney('marketplace').anchorKeys).toContain('vendor-package');
    expect(demoJourney('marketplace').anchorKeys).toContain('developer-package');
  });
});

// ---------------------------------------------------------------------------
// The deterministic manifest
// ---------------------------------------------------------------------------

describe('the deterministic manifest', () => {
  it('three tenants with unique, demo-marked slugs', () => {
    const slugs = DEMO_TENANTS.map((tenant) => tenant.slug);
    expect(new Set(slugs).size).toBe(3);
    for (const slug of slugs) expect(slug.endsWith('-demo')).toBe(true);
  });

  it('four personas with stable, demo-TLD emails', () => {
    expect(DEMO_PERSONAS).toHaveLength(4);
    for (const persona of DEMO_PERSONAS) {
      expect(persona.email.endsWith('.demo')).toBe(true);
      expect(persona.email).toContain('@');
    }
  });

  it('persona tenant roles mirror the demo roles (the matrix and reality stay in lockstep)', () => {
    expect(() => assertManifestConsistency()).not.toThrow();
    for (const persona of DEMO_PERSONAS) {
      expect(persona.tenantRole).toBe(demoRole(persona.role).tenantRole);
    }
  });

  it('the demo password is assembled from fragments at runtime, never one literal', () => {
    expect(DEMO_PASSWORD_FRAGMENTS.length).toBeGreaterThanOrEqual(2);
    const password = demoPersonaPassword();
    expect(password).toBe(DEMO_PASSWORD_FRAGMENTS.join(''));
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(password).not.toMatch(/\s/);
    // No single fragment is the password, and the password never appears
    // as a fragment.
    for (const fragment of DEMO_PASSWORD_FRAGMENTS) {
      expect(fragment).not.toBe(password);
    }
  });

  it('fixed narrative time parses as ISO instants', () => {
    for (const value of Object.values(DEMO_TIME)) {
      expect(Number.isNaN(Date.parse(value))).toBe(false);
    }
  });

  it('natural keys are stable and demo-flavored', () => {
    expect(demoTenantSpec('company').slug).toBe('meridian-roasters-demo');
    expect(demoPersonaSpec('platform-reviewer').email).toBe(
      'rosa.lindqvist@aurum-platform-review.demo',
    );
    expect(DEMO_KEYS.capabilityName).toBe('cold-chain-logistics');
    expect(DEMO_KEYS.agentSlug).toBe('freshness-monitor');
  });
});
