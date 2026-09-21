'use client';

// Capability, workforce & agent interventions (W063) — the team compose
// form (team topology/budget authoring).
//
// THE ACCEPTANCE CORE: "team topology/budget". Management composes one
// DRAFT team through the agent-teams contract ('agents:administer'):
// the roster (which agent fills which team role, and the reporting
// lines a hierarchical topology carries), the shared objective, and the
// budget envelope (integer minor units + ISO currency). A draft carries
// no authority — activation is the gated transition
// (team-lifecycle-form.tsx).
//
// The member rows come from the ACTIVE agents the page loaded (the
// module's compose-time liveness invariant: an active team is composed
// of active agents). Real <form> semantics, labeled inputs, aria-live
// feedback, 44px+ targets.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';
// CLIENT-SAFE imports only: lib/form.ts imports NOTHING.
import {
  MAX_TEAM_DESCRIPTION_CHARS,
  MAX_TEAM_DISPLAY_NAME_CHARS,
  MAX_TEAM_OBJECTIVE_CHARS,
  MAX_TEAM_ROLE_CHARS,
  MAX_TEAM_SUCCESS_CRITERIA_CHARS,
  TEAM_TOPOLOGIES,
} from '../lib/form';

interface ComposeBody {
  team?: { id?: string; slug?: string; status?: string; version?: number };
  created?: boolean;
  error?: string;
  message?: string;
}

export function TeamComposeForm({
  agents,
}: {
  agents: readonly { id: string; slug: string; role: string }[];
}): ReactNode {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [topology, setTopology] = useState<'flat' | 'hierarchical'>('flat');
  const [objective, setObjective] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [budgetAmount, setBudgetAmount] = useState('0');
  const [budgetCurrency, setBudgetCurrency] = useState('USD');
  const [ownerPrincipal, setOwnerPrincipal] = useState('');
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ComposeBody | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(null);
    const members = agents
      .filter((agent) => included[agent.id] === true)
      .map((agent) => ({
        agentId: agent.id,
        role: roles[agent.id]?.trim() || agent.role,
      }));
    if (members.length === 0) {
      setError('a team needs at least one member — include at least one agent');
      setPending(false);
      return;
    }
    try {
      const response = await fetch('/api/product/interventions/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName,
          description,
          topology,
          members,
          objective,
          successCriteria,
          budgetAmount,
          budgetCurrency,
          ownerPrincipal,
        }),
      });
      const body = (await response.json().catch(() => null)) as ComposeBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `the composition failed (HTTP ${response.status})`);
      }
      setDone(body);
      setDisplayName('');
      setDescription('');
      setObjective('');
      setSuccessCriteria('');
      setBudgetAmount('0');
      setOwnerPrincipal('');
      setIncluded({});
      setRoles({});
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the composition failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="aurum-learn-form" onSubmit={(event) => void submit(event)}>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Team display name</span>
        <input
          className="aurum-learn-input"
          name="displayName"
          required
          maxLength={MAX_TEAM_DISPLAY_NAME_CHARS}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Cold-chain monitoring cell"
        />
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Description (optional)</span>
        <textarea
          className="aurum-learn-input"
          name="description"
          rows={2}
          maxLength={MAX_TEAM_DESCRIPTION_CHARS}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Topology</span>
        <select
          className="aurum-learn-input"
          name="topology"
          value={topology}
          onChange={(event) => setTopology(event.target.value === 'hierarchical' ? 'hierarchical' : 'flat')}
        >
          {TEAM_TOPOLOGIES.map((option) => (
            <option key={option} value={option}>
              {option === 'flat' ? 'Flat — peers' : 'Hierarchical — reporting lines'}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="aurum-int-form-choices aurum-int-form-roster">
        <legend className="aurum-learn-field-label">Roster — include agents and their team roles</legend>
        {agents.length === 0 ? (
          <span className="aurum-learn-hint">
            No active agents yet — recruit and activate one first (an approved proposal’s recruit
            alternative activates above).
          </span>
        ) : (
          agents.map((agent) => (
            <div key={agent.id} className="aurum-int-form-member">
              <label className="aurum-int-form-choice">
                <input
                  type="checkbox"
                  checked={included[agent.id] === true}
                  onChange={() =>
                    setIncluded((current) => ({ ...current, [agent.id]: !current[agent.id] }))
                  }
                />
                <span>{agent.slug}</span>
              </label>
              <input
                className="aurum-learn-input"
                aria-label={`Team role for ${agent.slug}`}
                maxLength={MAX_TEAM_ROLE_CHARS}
                placeholder={agent.role}
                value={roles[agent.id] ?? ''}
                onChange={(event) =>
                  setRoles((current) => ({ ...current, [agent.id]: event.target.value }))
                }
              />
            </div>
          ))
        )}
      </fieldset>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Shared objective</span>
        <textarea
          className="aurum-learn-input"
          name="objective"
          required
          rows={2}
          maxLength={MAX_TEAM_OBJECTIVE_CHARS}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Keep wholesale freshness above the goal floor through the Q4 peak."
        />
        <span className="aurum-learn-hint">
          A team exists for one shared objective — team outcomes measure against it.
        </span>
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Success criteria (optional)</span>
        <textarea
          className="aurum-learn-input"
          name="successCriteria"
          rows={2}
          maxLength={MAX_TEAM_SUCCESS_CRITERIA_CHARS}
          value={successCriteria}
          onChange={(event) => setSuccessCriteria(event.target.value)}
        />
      </label>
      <div className="aurum-int-form-pair">
        <label className="aurum-learn-field">
          <span className="aurum-learn-field-label">Budget envelope</span>
          <input
            className="aurum-learn-input"
            name="budgetAmount"
            required
            inputMode="decimal"
            value={budgetAmount}
            onChange={(event) => setBudgetAmount(event.target.value)}
          />
        </label>
        <label className="aurum-learn-field">
          <span className="aurum-learn-field-label">Currency</span>
          <input
            className="aurum-learn-input"
            name="budgetCurrency"
            required
            maxLength={3}
            value={budgetCurrency}
            onChange={(event) => setBudgetCurrency(event.target.value.toUpperCase())}
          />
        </label>
      </div>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Accountable owner principal (optional)</span>
        <input
          className="aurum-learn-input"
          name="ownerPrincipal"
          maxLength={200}
          value={ownerPrincipal}
          onChange={(event) => setOwnerPrincipal(event.target.value)}
          placeholder="The human escalations routed to the owner land with."
        />
      </label>
      <div className="aurum-learn-form-actions">
        <button type="submit" className="aurum-btn" disabled={pending}>
          {pending ? 'Composing…' : 'Compose the draft team'}
        </button>
        <span className="aurum-learn-hint">
          A draft carries no authority — activating it is a gated, human-approved transition.
        </span>
      </div>
      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 10 }}>
            <strong>The team was not composed</strong>
            <span>{error}</span>
          </div>
        )}
        {done === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }} role="status">
            <strong>The draft team is composed.</strong>{' '}
            <Link className="aurum-learn-link" href={`/interventions/teams/${done.team?.id ?? ''}`}>
              Open its topology and budget surface
            </Link>{' '}
            — request its activation there when the roster is right.
          </div>
        )}
      </div>
    </form>
  );
}
