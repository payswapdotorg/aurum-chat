// The deterministic demo-world manifest (W068).
//
// Every name, slug, email, key and timestamp of the demo world is a FIXED
// literal here: two runs of the harness (on fresh databases) produce the
// same world, and browser verification (W070) can hard-code these values.
//
// CREDENTIALS — the demo password is assembled from FRAGMENTS at runtime
// (never a single realistic literal in source), and every persona email
// lives under the reserved `.demo` TLD so the demo population is
// unmistakable and can never collide with a real address space. The
// password is a DEMO credential for a database the gate keeps
// non-production; it is not a secret (the whole point is reproducible
// browser sign-in), but it is still never written as one literal.

import type { DemoPersonaSpec, DemoTenantSpec } from './types';
import { demoRole } from './roles';

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

/**
 * The three demo tenants. Slugs are unique in the platform namespace and
 * deliberately distinct from every other fixture of the repository (the
 * W064 marketplace seed uses acme-software / aurum-platform-ops /
 * northwind-traders; the W050 proof uses harbor-robotics).
 */
export const DEMO_TENANTS: readonly DemoTenantSpec[] = [
  {
    key: 'company',
    name: 'Meridian Roasters',
    slug: 'meridian-roasters-demo',
    defaultWorkspaceName: 'Roastery',
  },
  {
    key: 'vendor',
    name: 'Copperline Labs',
    slug: 'copperline-labs-demo',
    defaultWorkspaceName: 'Studio',
  },
  {
    key: 'platform',
    name: 'Aurum Platform Review',
    slug: 'aurum-platform-review-demo',
    defaultWorkspaceName: 'Review Ops',
  },
];

/** One tenant spec by key. */
export function demoTenantSpec(key: DemoTenantSpec['key']): DemoTenantSpec {
  const spec = DEMO_TENANTS.find((tenant) => tenant.key === key);
  if (spec === undefined) {
    throw new Error(`unknown demo tenant key '${key}'`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

/**
 * The four sign-in personas. The employee/developer personas share the
 * company tenant with the manager (one coherent company); the platform
 * reviewer lives in the platform review tenant.
 */
export const DEMO_PERSONAS: readonly DemoPersonaSpec[] = [
  {
    role: 'manager',
    tenantKey: 'company',
    fullName: 'Priya Nair',
    email: 'priya.nair@meridian-roasters.demo',
    title: 'Head of Operations',
    tenantRole: 'owner',
  },
  {
    role: 'employee',
    tenantKey: 'company',
    fullName: 'June Park',
    email: 'june.park@meridian-roasters.demo',
    title: 'Roastery Operations Lead',
    tenantRole: 'member',
  },
  {
    role: 'developer',
    tenantKey: 'company',
    fullName: 'Tom Alvarez',
    email: 'tom.alvarez@meridian-roasters.demo',
    title: 'Integration Engineer',
    tenantRole: 'admin',
  },
  {
    role: 'platform-reviewer',
    tenantKey: 'platform',
    fullName: 'Rosa Lindqvist',
    email: 'rosa.lindqvist@aurum-platform-review.demo',
    title: 'Platform Reviewer',
    tenantRole: 'admin',
  },
];

/** One persona spec by demo role. */
export function demoPersonaSpec(role: DemoPersonaSpec['role']): DemoPersonaSpec {
  const spec = DEMO_PERSONAS.find((persona) => persona.role === role);
  if (spec === undefined) {
    throw new Error(`unknown demo persona role '${role}'`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Credentials (assembled from fragments at runtime)
// ---------------------------------------------------------------------------

/**
 * The shared demo password's fragments. Assembled by
 * `demoPersonaPassword()` — never joined as a literal in source.
 */
export const DEMO_PASSWORD_FRAGMENTS: readonly string[] = [
  'meridian',
  '-roasters-',
  'demo',
  '-seed-2026',
];

/** The demo sign-in password (every persona; deterministic, non-production). */
export function demoPersonaPassword(): string {
  return DEMO_PASSWORD_FRAGMENTS.join('');
}

// ---------------------------------------------------------------------------
// Fixed narrative time
// ---------------------------------------------------------------------------

/**
 * The demo world's fixed narrative window (ISO instants). All seeded
// evidence, messages, goals and beliefs carry these stamps so the DATA is
 * deterministic — never `Date.now()`.
 */
export const DEMO_TIME = {
  /** The Monday the freshness story starts. */
  weekStart: '2026-10-05T00:00:00.000Z',
  freshnessSample1: '2026-10-05T08:10:00.000Z',
  freshnessSample2: '2026-10-06T08:05:00.000Z',
  freshnessSample3: '2026-10-07T07:55:00.000Z',
  courierReading: '2026-10-07T19:30:00.000Z',
  chatTurn1: '2026-10-08T09:12:00.000Z',
  chatTurn2: '2026-10-08T09:13:30.000Z',
  chatTurn3: '2026-10-08T09:16:00.000Z',
  chatTurn4: '2026-10-08T09:17:20.000Z',
  case1Order: '2026-10-05T10:00:00.000Z',
  case1Roast: '2026-10-05T15:00:00.000Z',
  case1Pack: '2026-10-08T11:00:00.000Z',
  case1Ship: '2026-10-08T15:30:00.000Z',
  case1Deliver: '2026-10-09T09:00:00.000Z',
  case2Order: '2026-10-06T09:30:00.000Z',
  case2Roast: '2026-10-06T14:00:00.000Z',
  case2Pack: '2026-10-09T10:00:00.000Z',
  case2Ship: '2026-10-09T14:00:00.000Z',
  case2Deliver: '2026-10-10T08:30:00.000Z',
  /** The belief's valid-time start (before the cognition cycle). */
  beliefValidFrom: '2026-10-07T00:00:00.000Z',
  /** Management horizon: the quarter the goals aim at. */
  goalHorizonEnd: '2027-01-31T00:00:00.000Z',
} as const;

// ---------------------------------------------------------------------------
// Fixed narrative keys (natural keys of seeded artifacts)
// ---------------------------------------------------------------------------

/** Deterministic natural keys of the seeded artifacts (stable identifiers). */
export const DEMO_KEYS = {
  /** The pending invite's email (roster data). */
  inviteEmail: 'new.barista@meridian-roasters.demo',
  /** June's people records. */
  employeePersonEmail: 'june.park@meridian-roasters.demo',
  employeeNumber: 'MR-1042',
  /** June's verified web identity (the demo chat channel). */
  webIdentityAccount: 'june.park',
  /** The fulfillment process name (processes are unique per tenant by name). */
  processName: 'Wholesale order fulfillment',
  /** The fulfillment observation kinds (the process scope). */
  fulfillmentKinds: [
    'fulfillment.order-received',
    'fulfillment.roast-scheduled',
    'fulfillment.packed',
    'fulfillment.shipped',
    'fulfillment.delivered',
  ] as const,
  fulfillmentCases: ['SO-1042', 'SO-1043'] as const,
  /** The capability the cold-chain gap is about. */
  capabilityName: 'cold-chain-logistics',
  /** The seeded agent's slug (unique per tenant). */
  agentSlug: 'freshness-monitor',
  /** The vendor's catalog extension. */
  vendorExtensionKey: 'roast-batch-tracker',
  vendorExtensionVersion: '1.0.0',
  /** The developer's own submitted extension. */
  developerExtensionKey: 'freshness-etag-reader',
  developerExtensionVersion: '0.9.0',
  /** The API key / webhook labels. */
  apiKeyLabel: 'meridian-ops-integration',
  webhookLabel: 'Ops webhook',
  webhookUrl: 'https://ops.meridian-roasters.demo/hooks/aurum',
  webhookEventTypes: ['goal.*'] as const,
  /** The demo goal metric names. */
  freshnessMetric: 'wholesale-freshness-score',
  shipTimeMetric: 'order-to-ship-hours',
} as const;

// ---------------------------------------------------------------------------
// Consistency guard
// ---------------------------------------------------------------------------

/**
 * The personas' tenant roles must mirror the demo roles' declared tenant
 * roles — the capability matrix and the real authority derivation stay
 * in lockstep (unit-tested, but also guarded here for any future edit).
 */
export function assertManifestConsistency(): void {
  for (const persona of DEMO_PERSONAS) {
    const role = demoRole(persona.role);
    if (role.tenantRole !== persona.tenantRole) {
      throw new Error(
        `demo manifest inconsistency: persona '${persona.role}' declares tenant role '${persona.tenantRole}' but the demo role says '${role.tenantRole}'`,
      );
    }
  }
}
