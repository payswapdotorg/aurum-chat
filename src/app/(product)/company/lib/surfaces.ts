// Company query plane (W126) — the client-safe company-surface vocabulary.
//
// CLIENT-SAFETY: the query workspace (components/query-form.tsx) is a
// client component and needs the surface list as a VALUE; importing the
// company-query module's contract would drag the module (→ infra/db → the
// pg driver) into the browser bundle. The same discipline the product
// shell applies to the tower surface slugs (lib/navigation.ts): the list
// is declared HERE as the client-safe copy, and the surface's unit test
// enforces that it matches the module's frozen COMPANY_SURFACES exactly,
// so the two can never drift.

import type { CompanySurface } from '@/modules/company-query/contract';

/** The client-safe surface vocabulary (test-locked to the module's). */
export const COMPANY_SURFACES: readonly CompanySurface[] = [
  'people-organization',
  'customer-interactions',
  'support-tickets',
  'sales-opportunities',
  'projects-tasks',
  'meetings',
  'internal-communications',
  'finance',
  'operations',
  'suppliers',
  'documents-knowledge',
  'external-environment',
  'agent-activity',
];
