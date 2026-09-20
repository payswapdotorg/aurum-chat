// Auth surfaces (W058) — the quiet brand header of the auth cards.

import type { ReactNode } from 'react';

export function AuthBrand({ tag }: { tag: string }): ReactNode {
  return (
    <div className="aurum-auth-brand">
      <span className="aurum-auth-brand-tile" aria-hidden="true">
        A
      </span>
      <span>
        <span className="aurum-auth-brand-name">Aurum</span>
        <br />
        <span className="aurum-auth-brand-tag">{tag}</span>
      </span>
    </div>
  );
}
