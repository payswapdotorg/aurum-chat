'use client';

// Learning missions, contributions & rewards (W062) — the ask trigger.
//
// THE "ASK" HALF of "ask/answer knowledge requests": one button that
// asks Aurum to target the NEXT knowledge acquisition for a mission.
// The W012 planner — not this button — decides who/what to ask, composes
// the targeted question and records the ask-policy evaluation (§7 "when
// policy permits", §20 authority matrix); the button merely requests the
// next pass and renders the planner's honest decision:
//   * a person was selected → the knowledge request is live in Learning;
//   * another source was selected → the planner chose elsewhere (the
//     rationale is on the mission's acquisition trail);
//   * no candidate → nothing eligible remains to ask.
//
// 44px+ touch target, pending state announced via aria-live, and a
// router refresh so the server-rendered state (the new request row)
// catches up — the server page stays the source of truth.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';

interface AskBody {
  decision?: string;
  chosen?: { kind?: string; label?: string | null } | null;
  question?: string | null;
  askPolicy?: string | null;
  error?: string;
  message?: string;
}

export function AskNextSourceButton({ missionId }: { missionId: string }): ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AskBody | null>(null);

  async function ask(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    setOutcome(null);
    try {
      const response = await fetch(
        `/api/product/learning/missions/${missionId}/ask`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      const body = (await response.json().catch(() => null)) as AskBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `the request failed (HTTP ${response.status})`);
      }
      setOutcome(body);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the request failed');
    } finally {
      setPending(false);
    }
  }

  const askedPerson = outcome?.chosen?.kind === 'person';

  return (
    <div className="aurum-learn-ask">
      <button
        type="button"
        className="aurum-btn"
        data-variant="quiet"
        onClick={() => void ask()}
        disabled={pending}
        aria-label="Ask Aurum to plan the next knowledge acquisition for this mission"
      >
        {pending ? 'Planning…' : 'Ask the next source'}
      </button>
      <span className="aurum-learn-hint">
        Aurum’s planner decides who to ask, composes the question and records
        whether policy permits asking — nothing is sent by this surface.
      </span>
      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 10 }}>
            <strong>The planner did not run</strong>
            <span>{error}</span>
          </div>
        )}
        {outcome === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }} role="status">
            {outcome.decision === 'no_candidate' ? (
              <>The planner found no eligible candidate to ask next — the mission’s menu has nothing available under policy and budget.</>
            ) : askedPerson ? (
              <>
                The planner chose to ask{' '}
                <strong>{outcome.chosen?.label ?? 'the selected person'}</strong>
                {outcome.question === null || outcome.question === undefined ? '' : (
                  <>
                    {' '}— “{outcome.question}”
                  </>
                )}
                .{' '}
                <Link className="aurum-learn-link" href="/learning">
                  The knowledge request is live in Learning
                </Link>
                .
              </>
            ) : (
              <>
                The planner chose a {outcome.chosen?.kind ?? 'source'} next — the
                decision and its rationale are on this mission’s planner trail.
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
