'use client';

// Company query plane (W126) — the query workspace (the surface's client
// root).
//
// THE PRODUCT CONTRACT (spec §6 + §14): a query box; the answer rendered
// with CLAIM-LEVEL PROVENANCE CHIPS (source, observed-at, freshness) on
// every material claim; a visible COVERAGE-CONTEXT panel (surfaces seen
// and missing, contributing sources, caveats, the material gaps that could
// change the answer); contradictions with BOTH sides and unknowns called
// out — never merged away. The optional LLM paragraph is visually marked
// as presentation only.
//
// Real <form> semantics, 44px+ touch targets, focus-visible from the
// shell, pending/error states announced via aria-live — the same
// discipline the chat and intelligence surfaces apply.

import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type {
  CompanyQueryResponse,
  CompanySurface,
} from '@/modules/company-query/contract';
import { COMPANY_SURFACES } from '@/app/(product)/company/lib/surfaces';

interface QueryBody {
  question?: string;
  surfaces?: string[];
  error?: string;
  message?: string;
}

const SURFACE_LABELS: Record<CompanySurface, string> = {
  'people-organization': 'People & organization',
  'customer-interactions': 'Customer interactions',
  'support-tickets': 'Support tickets',
  'sales-opportunities': 'Sales opportunities',
  'projects-tasks': 'Projects & tasks',
  meetings: 'Meetings',
  'internal-communications': 'Internal communications',
  finance: 'Finance',
  operations: 'Operations',
  suppliers: 'Suppliers',
  'documents-knowledge': 'Documents & knowledge',
  'external-environment': 'External environment',
  'agent-activity': 'Agent activity',
};

const KIND_LABELS: Record<string, string> = {
  'observed-fact': 'Observed fact',
  'derived-belief': 'Working belief',
  hypothesis: 'Hypothesis',
  unknown: 'Unknown',
};

function surfaceLabel(surface: CompanySurface): string {
  return SURFACE_LABELS[surface] ?? surface;
}

function whenLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A provenance chip: source · observed-at · freshness (§6 step 6). */
function ProvenanceChip({
  chip,
}: {
  chip: NonNullable<CompanyQueryResponse['answer']['claims'][number]['provenance'][number]>;
}): ReactNode {
  return (
    <li>
      <span>{chip.sourceLabel}</span>
      <span aria-hidden="true">·</span>
      <span>observed {whenLabel(chip.observedAt)}</span>
      <span aria-hidden="true">·</span>
      <span
        className="aurum-company-freshness"
        data-freshness={chip.freshness}
      >
        {chip.freshness}
      </span>
    </li>
  );
}

/** One material claim with its provenance chips. */
function ClaimRow({
  claim,
}: {
  claim: CompanyQueryResponse['answer']['claims'][number];
}): ReactNode {
  return (
    <li className="aurum-company-claim">
      <div className="aurum-company-claim-head">
        <span className="aurum-company-claim-kind">{KIND_LABELS[claim.kind] ?? claim.kind}</span>
        {claim.confidence === null ? null : (
          <span className="aurum-company-claim-kind">
            confidence {Math.round(claim.confidence * 100)}%
          </span>
        )}
      </div>
      <p className="aurum-company-claim-text">{claim.text}</p>
      {claim.provenance.length === 0 ? null : (
        <ul className="aurum-company-provenance">
          {claim.provenance.map((chip) => (
            <ProvenanceChip key={chip.observationId} chip={chip} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One retained contradiction — both sides, both provenances (§6 step 8). */
function ContradictionRow({
  contradiction,
}: {
  contradiction: CompanyQueryResponse['answer']['contradictions'][number];
}): ReactNode {
  return (
    <li className="aurum-company-contradiction">
      <p className="aurum-company-contradiction-note">
        Retained contradiction ({contradiction.status}): {contradiction.note}
      </p>
      {[contradiction.sideA, contradiction.sideB].map((side, index) => (
        <div key={`${side.evidenceId}-${index}`} className="aurum-company-contradiction-side">
          <strong>
            Side {index === 0 ? 'A' : 'B'} — {side.evidenceKind}
          </strong>
          <p className="aurum-company-claim-text">{side.text}</p>
          {side.provenance.length === 0 ? null : (
            <ul className="aurum-company-provenance">
              {side.provenance.map((chip) => (
                <ProvenanceChip key={chip.observationId} chip={chip} />
              ))}
            </ul>
          )}
        </div>
      ))}
    </li>
  );
}

/** The coverage-context panel (§6 layer 2 + §14's calm operational signal). */
function CoverageContextPanel({
  context,
}: {
  context: CompanyQueryResponse['coverageContext'];
}): ReactNode {
  return (
    <div className="aurum-company-coverage">
      {context.honesty === null ? null : (
        <p className="aurum-company-honesty">
          <em>Coverage answer — </em>
          {context.honesty.text}
        </p>
      )}

      {context.materialGaps.length === 0 ? null : (
        <div>
          <h3 className="aurum-company-claim-kind">Blind spots that could change this answer</h3>
          {context.materialGaps.map((gap) => (
            <p key={`${gap.surface}-${gap.kind}`} className="aurum-company-gap">
              <span className="aurum-company-gap-kind">
                {gap.kind} — {surfaceLabel(gap.surface)}
              </span>
              {gap.why}
            </p>
          ))}
        </div>
      )}

      {context.caveats.length === 0 ? null : (
        <div>
          <h3 className="aurum-company-claim-kind">Caveats</h3>
          <ul className="aurum-company-caveats">
            {context.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="aurum-company-claim-kind">
          What Aurum can see ({context.surfaces.filter((s) => s.state === 'covered').length}/
          {context.surfaces.length} covered · derived {context.derivation})
        </h3>
        <ul className="aurum-company-surfaces-list">
          {context.surfaces.map((summary) => (
            <li key={summary.surface} className="aurum-company-surface-row">
              <div className="aurum-company-surface-row-head">
                <span className="aurum-company-surface-name">{surfaceLabel(summary.surface)}</span>
                <span className="aurum-pill" data-tone={summary.state === 'covered' ? 'positive' : summary.state === 'stale' || summary.state === 'unauthorized' ? 'warning' : 'info'}>
                  {summary.state}
                </span>
              </div>
              <span className="aurum-company-surface-meta">
                {summary.observationCount} observation(s)
                {summary.contributingSources.length === 0
                  ? ' · no connected source'
                  : ` · ${summary.contributingSources
                      .map((source) => source.displayName ?? source.provider)
                      .join(', ')}`}
              </span>
              <p className="aurum-company-surface-explanation">{summary.explanation}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The query workspace: the form + the two-layer result. */
export function CompanyQueryForm(): ReactNode {
  const [question, setQuestion] = useState('');
  const [selected, setSelected] = useState<CompanySurface[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<CompanyQueryResponse | null>(null);

  const toggleSurface = (surface: CompanySurface): void => {
    setSelected((current) =>
      current.includes(surface)
        ? current.filter((entry) => entry !== surface)
        : [...current, surface],
    );
  };

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const trimmed = question.trim();
    if (trimmed === '') return;
    setPending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { question: trimmed };
      if (selected.length > 0) body.surfaces = selected;
      const result = await fetch('/api/product/company/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const parsed = (await result.json().catch(() => null)) as QueryBody | CompanyQueryResponse | null;
      if (!result.ok || parsed === null || !('answer' in parsed)) {
        const failure = parsed as QueryBody | null;
        throw new Error(
          failure?.message ?? failure?.error ?? `the query failed (HTTP ${result.status})`,
        );
      }
      setResponse(parsed as CompanyQueryResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the query failed');
      setResponse(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="aurum-company">
      <form className="aurum-company-form" onSubmit={submit}>
        <label className="aurum-company-claim-kind" htmlFor="aurum-company-question">
          Ask a question about the company
        </label>
        <textarea
          id="aurum-company-question"
          value={question}
          maxLength={2000}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="e.g. How many support tickets are open? What is our revenue picture? How much of our customer support history can you see?"
          required
        />
        <div className="aurum-company-form-row" role="group" aria-label="Optional company scope">
          <span className="aurum-company-claim-kind" id="aurum-company-surfaces-label">
            Scope (all surfaces when none picked):
          </span>
          <div className="aurum-company-surfaces" aria-labelledby="aurum-company-surfaces-label">
            {COMPANY_SURFACES.map((surface) => (
              <button
                key={surface}
                type="button"
                className="aurum-company-surface-chip"
                aria-pressed={selected.includes(surface)}
                onClick={() => toggleSurface(surface)}
              >
                {surfaceLabel(surface)}
              </button>
            ))}
          </div>
        </div>
        <div className="aurum-company-form-row">
          <button type="submit" className="aurum-company-submit" disabled={pending || question.trim() === ''}>
            {pending ? 'Assembling the answer…' : 'Ask Aurum'}
          </button>
          <span aria-live="polite" className="aurum-company-claim-kind">
            {pending ? 'Working — retrieving evidence and coverage…' : null}
            {error === null ? null : ` ${error}`}
          </span>
        </div>
      </form>

      {response === null ? null : (
        <div className="aurum-company-grid">
          <div>
            <p className="aurum-company-summary">{response.answer.summary}</p>
            {response.answer.llm.used && response.answer.llm.text !== null ? (
              <p className="aurum-company-llm">
                {response.answer.llm.text}
                <span className="aurum-company-llm-note">
                  Presentation layer (LLM) — the structured answer above is the authority
                </span>
              </p>
            ) : null}

            {response.answer.claims.length === 0 ? (
              <p className="aurum-company-summary">No material claims were visible for this question.</p>
            ) : (
              <ul className="aurum-company-claims" aria-label="Material claims with provenance">
                {response.answer.claims.map((claim, index) => (
                  <ClaimRow key={`${index}-${claim.text.slice(0, 40)}`} claim={claim} />
                ))}
              </ul>
            )}

            {response.answer.contradictions.length === 0 ? null : (
              <section>
                <h3 className="aurum-company-claim-kind">Retained contradictions</h3>
                <ul className="aurum-company-contradictions">
                  {response.answer.contradictions.map((contradiction, index) => (
                    <ContradictionRow key={index} contradiction={contradiction} />
                  ))}
                </ul>
              </section>
            )}

            {response.answer.unknowns.length === 0 ? null : (
              <section>
                <h3 className="aurum-company-claim-kind">Open unknowns</h3>
                <ul className="aurum-company-unknowns">
                  {response.answer.unknowns.map((unknown, index) => (
                    <li key={index} className="aurum-company-unknown">
                      <p className="aurum-company-unknown-question">{unknown.question}</p>
                      <p className="aurum-company-unknown-consequence">
                        Why it matters: {unknown.consequence}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <aside aria-label="Coverage context">
            <CoverageContextPanel context={response.coverageContext} />
          </aside>
        </div>
      )}
    </div>
  );
}
