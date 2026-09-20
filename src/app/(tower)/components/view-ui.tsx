// Management Control Tower (W033) — shared server-side view primitives.
//
// Small, semantic, presentational building blocks shared by all fifteen
// surface pages. Server components by design (no interactivity); the one
// interactive piece of the tower is the approvals decision form.

import type { ReactNode } from 'react';

/** Surface title block. */
export function SurfaceHeader({
  title,
  description,
  meta,
}: {
  title: string;
  description: string;
  meta?: ReactNode;
}): ReactNode {
  return (
    <header className="surface-header">
      <h2>{title}</h2>
      <p>{description}</p>
      {meta === undefined ? null : <div className="surface-meta">{meta}</div>}
    </header>
  );
}

/** A row of metric tiles. */
export function StatTiles({
  items,
}: {
  items: { label: string; value: ReactNode; hint?: string }[];
}): ReactNode {
  return (
    <div className="stat-row">
      {items.map((item) => (
        <div className="stat" key={item.label}>
          <div className="stat-value">{item.value}</div>
          <div className="stat-label">{item.label}</div>
          {item.hint === undefined ? null : (
            <div className="stat-hint">{item.hint}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export type BadgeKind = 'risk' | 'ok' | 'warn' | 'info' | 'muted' | 'accent';

/** Map domain statuses to badge tones (central so surfaces stay consistent). */
export function badgeKind(value: string): BadgeKind {
  switch (value) {
    case 'critical':
    case 'risk':
    case 'rejected':
    case 'refused':
    case 'failed':
    case 'error':
    case 'terminated':
    case 'uncovered':
    case 'open':
      return 'risk';
    case 'active':
    case 'approved':
    case 'succeeded':
    case 'covered':
    case 'completed':
    case 'resolved':
      return 'ok';
    case 'pending':
    case 'awaiting_approval':
    case 'awaiting_input':
    case 'abandoned':
    case 'cancelled':
    case 'level_shortfall':
    case 'capacity_shortfall':
    case 'retired':
    case 'on_leave':
    case 'stale':
      return 'warn';
    case 'running':
    case 'queued':
    case 'manual_effort':
    case 'bottleneck':
    case 'duplication':
      return 'info';
    default:
      return 'muted';
  }
}

export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }): ReactNode {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  return <Badge kind={badgeKind(status)}>{status.replaceAll('_', ' ')}</Badge>;
}

/** A titled card section. */
export function Card({
  title,
  meta,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="card">
      <h3 className="card-title">
        <span>{title}</span>
        {meta === undefined ? null : <span className="card-meta">{meta}</span>}
      </h3>
      {children}
    </section>
  );
}

/** Honest empty state. */
export function Empty({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}): ReactNode {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint === undefined ? null : (
        <>
          <br />
          {hint}
        </>
      )}
    </div>
  );
}

/** Callout note (warnings, scope limits, dev seams). */
export function Notice({
  children,
  neutral,
}: {
  children: ReactNode;
  neutral?: boolean;
}): ReactNode {
  return (
    <div className={neutral === true ? 'notice notice-neutral' : 'notice'}>
      {children}
    </div>
  );
}

/**
 * The not-scoped state. Since W058 the session owns tenant scope, so a
 * visitor should never land here (anonymous/no-company requests redirect
 * to the auth flows); kept as the honest fallback with the right guidance.
 */
export function NotScoped({ detail }: { detail: string }): ReactNode {
  return (
    <>
      <SurfaceHeader
        title="Not scoped to a company"
        description="The Control Tower reads tenant-scoped state through module contracts, and every contract call carries an explicit TenantContext (no ambient global)."
      />
      <Notice>
        {detail}. Company scope comes from your signed-in session — sign in
        and select a company; there is no query parameter for it.
      </Notice>
    </>
  );
}

/** Standard item row pieces used by list-heavy surfaces. */
export function ItemHead({
  title,
  badges,
}: {
  title: ReactNode;
  badges?: ReactNode;
}): ReactNode {
  return (
    <div className="item-head">
      <span className="item-title">{title}</span>
      {badges}
    </div>
  );
}

export function ItemText({ children }: { children: ReactNode }): ReactNode {
  return <p className="item-text">{children}</p>;
}

export function ItemFoot({ children }: { children: ReactNode }): ReactNode {
  return <div className="item-foot">{children}</div>;
}
