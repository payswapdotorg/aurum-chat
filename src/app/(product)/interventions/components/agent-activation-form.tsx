'use client';

// Capability, workforce & agent interventions (W063) — the agent
// activation form (proposal → approval → ACTIVATION).
//
// An APPROVED proposal whose comparison carries a recruit alternative
// renders this form: management registers the agent through the agents
// module's claim-gated contract ('agents:administer' — the session's
// own derived claims), granting exactly the permission scopes the
// approved comparison proposed (the future grant visible at approval
// time becomes the actual grant; the §20 level it implies is derived
// and shown). Registering is idempotent per (tenant, slug) — a retry
// replays the same agent.
//
// The defaults come from the proposal (server-computed suggested slug,
// role and instructions), so the form starts from the approved
// comparison, not from a blank page. Real <form> semantics, labeled
// inputs, aria-live feedback, 44px+ targets.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ReactNode } from 'react';
// CLIENT-SAFE imports only: lib/form.ts imports NOTHING.
import {
  AGENT_PERMISSIONS,
  AGENT_PROVIDER_OPTIONS,
  MAX_AGENT_INSTRUCTIONS_CHARS,
  MAX_AGENT_ROLE_CHARS,
  MAX_AGENT_SLUG_LENGTH,
} from '../lib/form';

interface ActivationBody {
  agent?: { id?: string; slug?: string; status?: string; permissions?: string[] };
  created?: boolean;
  error?: string;
  message?: string;
}

export function AgentActivationForm({
  proposalId,
  suggestedSlug,
  suggestedRole,
  suggestedInstructions,
  defaultPermissions,
}: {
  proposalId: string;
  suggestedSlug: string;
  suggestedRole: string;
  suggestedInstructions: string;
  defaultPermissions: string[];
}): ReactNode {
  const router = useRouter();
  const [slug, setSlug] = useState(suggestedSlug);
  const [displayName, setDisplayName] = useState(suggestedRole);
  const [role, setRole] = useState(suggestedRole);
  const [provider, setProvider] = useState('langgraph');
  const [instructions, setInstructions] = useState(suggestedInstructions);
  const [permissions, setPermissions] = useState<string[]>(defaultPermissions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ActivationBody | null>(null);

  function togglePermission(scope: string): void {
    setPermissions((current) =>
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope],
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch(
        `/api/product/interventions/proposals/${proposalId}/activate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slug,
            displayName,
            role,
            provider,
            instructions,
            permissions,
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as ActivationBody | null;
      if (!response.ok || body === null) {
        throw new Error(body?.message ?? body?.error ?? `the activation failed (HTTP ${response.status})`);
      }
      setDone(body);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the activation failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="aurum-learn-form" onSubmit={(event) => void submit(event)}>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Agent slug</span>
        <input
          className="aurum-learn-input"
          name="slug"
          required
          maxLength={MAX_AGENT_SLUG_LENGTH}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
        <span className="aurum-learn-hint">
          The stable identity the roster, executions and outcomes key on — lowercase letters,
          digits and hyphens.
        </span>
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Display name</span>
        <input
          className="aurum-learn-input"
          name="displayName"
          maxLength={128}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Role</span>
        <input
          className="aurum-learn-input"
          name="role"
          required
          maxLength={MAX_AGENT_ROLE_CHARS}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        />
        <span className="aurum-learn-hint">What this agent is for, in the organization’s words.</span>
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Runtime provider</span>
        <select
          className="aurum-learn-input"
          name="provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {AGENT_PROVIDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="aurum-learn-hint">
          The agent gateway hides the provider behind its contract — it can be swapped later
          without changing the agent’s authority.
        </span>
      </label>
      <label className="aurum-learn-field">
        <span className="aurum-learn-field-label">Operating instructions</span>
        <textarea
          className="aurum-learn-input"
          name="instructions"
          required
          maxLength={MAX_AGENT_INSTRUCTIONS_CHARS}
          rows={4}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <span className="aurum-learn-hint">
          Pre-filled from the approved proposal — edit freely; this is the agent’s contract.
        </span>
      </label>
      <fieldset className="aurum-int-form-choices">
        <legend className="aurum-learn-field-label">Permission scopes</legend>
        {AGENT_PERMISSIONS.map((scope) => (
          <label key={scope} className="aurum-int-form-choice">
            <input
              type="checkbox"
              name="permissions"
              value={scope}
              checked={permissions.includes(scope)}
              onChange={() => togglePermission(scope)}
            />
            <span>{scope}</span>
          </label>
        ))}
        <span className="aurum-learn-hint">
          Pre-selected from the approved recruit alternative. Every scope the agent is granted
          implies its authority level — the gate reviews the grant at every execution.
        </span>
      </fieldset>
      <div className="aurum-learn-form-actions">
        <button type="submit" className="aurum-btn" disabled={pending}>
          {pending ? 'Activating…' : 'Activate the agent'}
        </button>
        <span className="aurum-learn-hint">
          Registering makes the agent an organizational actor — its executions still pass the
          authority gate, and its termination stays a human decision.
        </span>
      </div>
      <div aria-live="polite">
        {error === null ? null : (
          <div className="aurum-error" role="alert" style={{ marginTop: 10 }}>
            <strong>The agent was not activated</strong>
            <span>{error}</span>
          </div>
        )}
        {done === null ? null : (
          <div className="aurum-notice" style={{ marginTop: 10 }} role="status">
            <strong>
              {done.created === false ? 'The agent already stood — replayed, not re-created.' : 'The agent is active.'}
            </strong>{' '}
            <Link className="aurum-learn-link" href={`/interventions/agents/${done.agent?.id ?? ''}`}>
              Open its lifecycle surface
            </Link>{' '}
            to see its measured evaluation, tied outcomes and the retain/modify/terminate
            decisions it may face.
          </div>
        )}
      </div>
    </form>
  );
}
