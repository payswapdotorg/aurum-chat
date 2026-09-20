'use client';

// Auth surfaces (W058) — the onboarding company picker.
//
// Lists the principal's VERIFIED companies (server-resolved through the
// auth contract's directory). Selecting one POSTs the session selection
// (the server re-verifies membership before the session is touched), then
// routes to chat and refreshes the shell chrome so the switcher reflects
// the new active company.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { dispatchShellRefresh } from '@/app/(product)/lib/shell-events';
import { postAuthJson } from './auth-fetch';

export interface PickerCompany {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  addedVia: 'created' | 'invite' | 'switch';
  lastSelectedAt: string;
}

export function CompanyPicker({
  companies,
  activeTenantId,
}: {
  companies: PickerCompany[];
  activeTenantId: string | null;
}): ReactNode {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = async (tenantId: string) => {
    if (pendingId !== null) return;
    setPendingId(tenantId);
    setError(null);
    const outcome = await postAuthJson('/api/auth/session/selection', { tenantId });
    if (!outcome.ok) {
      const message =
        typeof outcome.body['message'] === 'string' ? outcome.body['message'] : 'the company could not be selected';
      setError(message);
      setPendingId(null);
      return;
    }
    dispatchShellRefresh();
    router.replace('/chat');
  };

  if (companies.length === 0) {
    return (
      <p className="aurum-auth-hint" style={{ margin: 0 }}>
        No companies yet — create one below, or join one with an invitation
        code.
      </p>
    );
  }

  return (
    <div>
      <ul className="aurum-auth-company-list">
        {companies.map((company) => (
          <li key={company.tenantId}>
            <button
              type="button"
              className="aurum-auth-company"
              onClick={() => {
                void select(company.tenantId);
              }}
              disabled={pendingId !== null}
              aria-current={company.tenantId === activeTenantId ? 'true' : undefined}
            >
              <span className="aurum-auth-company-glyph" aria-hidden="true">
                {company.tenantName.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <span className="aurum-auth-company-name">{company.tenantName}</span>
                <br />
                <span className="aurum-auth-company-meta">
                  {company.tenantId === activeTenantId
                    ? 'currently active'
                    : company.addedVia === 'created'
                      ? 'you created this company'
                      : company.addedVia === 'invite'
                        ? 'joined by invitation'
                        : 'recently used'}
                </span>
              </span>
              {pendingId === company.tenantId ? (
                <span className="aurum-auth-company-meta" role="status">
                  switching…
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {error === null ? null : (
        <p className="aurum-auth-error" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </div>
  );
}
