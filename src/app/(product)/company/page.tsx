// Company query plane (W126) — the /company product surface.
//
// THE OPERATOR-DIRECTIVE SURFACE: "a feature not discoverable by the user
// is considered absent" — this page makes the query plane a first-class
// product experience, not just an API. One page in the existing product
// shell:
//
//   * a query box (the client workspace below);
//   * the two-layer response rendered honestly: the deterministic summary
//     and the optional LLM paragraph marked as presentation, material
//     claims with claim-level provenance chips (source · observed-at ·
//     freshness), retained contradictions with BOTH sides, surfaced
//     unknowns with their consequence;
//   * a visible coverage-context panel: surfaces seen and missing, the
//     contributing sources, freshness/authorization caveats, and the
//     material gaps that could change the answer — plus the §7 honesty
//     answer whenever the question is a coverage question.
//
// Composition is read-only through module contracts (lock 31/32/34): the
// page itself performs no data assembly (the query runs on demand through
// the capability-shaped API route), so the server render stays a calm
// shell around the workspace. Styling is scoped (company.css — no new
// global styles).

import type { Metadata } from 'next';
import './company.css';
import { requireAuthenticatedPage } from '@/app/lib/page-session';
import { PageHead } from '../components/states';
import { CompanyQueryForm } from './components/query-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Company — Aurum',
  description:
    'Ask the company a question: evidence-backed answers with provenance, freshness, retained contradictions and honest coverage context.',
};

export default async function CompanyPage() {
  await requireAuthenticatedPage();

  return (
    <>
      <PageHead
        title="Company"
        description="Ask a question about the company. Every answer shows where its evidence came from, how fresh it is, what disagrees, and what Aurum cannot yet see."
      />
      <div className="aurum-company">
        <CompanyQueryForm />
      </div>
    </>
  );
}
