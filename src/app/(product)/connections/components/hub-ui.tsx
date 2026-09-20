// Connection & Integration Hub (W059) — shared server-side view primitives.
//
// Small, semantic, presentational building blocks for the hub page.
// Server components by design (no interactivity of their own — the client
// side is components/interaction.tsx). ShareNet-dominant visual language:
// hairline cards, status pills, quiet empty/notice states.

import type { ReactNode } from 'react';
import type { Health, HealthLevel } from '../lib/health';
import { humanAge } from '../lib/health';

/** Status pill tone. */
export type PillTone = 'ok' | 'warn' | 'risk' | 'info' | 'muted';

/** Map a derived health level to a pill tone. */
export function healthTone(level: HealthLevel): PillTone {
  switch (level) {
    case 'ok':
      return 'ok';
    case 'attention':
      return 'warn';
    case 'degraded':
      return 'risk';
    case 'disabled':
      return 'muted';
  }
}

export function Pill({
  tone,
  children,
  dot = false,
}: {
  tone: PillTone;
  children: ReactNode;
  dot?: boolean;
}): ReactNode {
  return (
    <span className={`pill pill-${tone}`}>
      {dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function HealthPill({ health }: { health: Health }): ReactNode {
  const label =
    health.level === 'ok'
      ? 'healthy'
      : health.level === 'attention'
        ? 'needs attention'
        : health.level === 'degraded'
          ? 'degraded'
          : 'disconnected';
  return <Pill tone={healthTone(health.level)} dot>{label}</Pill>;
}

export function StatusPill({ status }: { status: string }): ReactNode {
  const tone: PillTone =
    status === 'active' || status === 'delivered' || status === 'current' || status === 'verified'
      ? 'ok'
      : status === 'pending' || status === 'aging' || status === 'unverified'
        ? 'info'
        : status === 'stale' || status === 'failed'
          ? 'risk'
          : status === 'rejected' || status === 'revoked'
            ? 'risk'
            : 'muted';
  return <Pill tone={tone}>{status.replaceAll('_', ' ')}</Pill>;
}

/** A titled card section. */
export function SectionCard({
  id,
  title,
  description,
  meta,
  children,
}: {
  id: string;
  title: string;
  description: string;
  meta?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="conn-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="card-head">
        <h2 className="card-title" id={`${id}-title`}>
          {title}
        </h2>
        {meta === undefined ? null : <span className="card-meta">{meta}</span>}
      </div>
      <p className="card-desc">{description}</p>
      {children}
    </section>
  );
}

/** A row of metric tiles. */
export function StatRow({
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
          {item.hint === undefined ? null : <div className="stat-hint">{item.hint}</div>}
        </div>
      ))}
    </div>
  );
}

/** Quiet empty state. */
export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}): ReactNode {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint === undefined ? null : <>{hint}</>}
    </div>
  );
}

/** Callout note (warnings, scope limits, dev seams). */
export function Notice({
  children,
  neutral = false,
}: {
  children: ReactNode;
  neutral?: boolean;
}): ReactNode {
  return <div className={neutral ? 'notice notice-neutral' : 'notice'}>{children}</div>;
}

/** Render a relative age with the absolute instant as tooltip/title. */
export function When({ at, now, fallback }: { at: string | null; now: string; fallback?: string }): ReactNode {
  if (at === null) {
    return <span>{fallback ?? 'never'}</span>;
  }
  return (
    <span title={at}>
      {humanAge(at, now)} ago
    </span>
  );
}

/** Derived-health reasons list (quiet). */
export function HealthReasons({ health }: { health: Health }): ReactNode {
  if (health.reasons.length === 0) return null;
  return (
    <ul className="reasons">
      {health.reasons.map((reason, index) => (
        <li
          key={index}
          className={
            reason.level === 'degraded'
              ? 'r-degraded'
              : reason.level === 'attention'
                ? 'r-attention'
                : reason.level === 'disabled'
                  ? 'r-disabled'
                  : undefined
          }
        >
          {reason.text}
        </li>
      ))}
    </ul>
  );
}

/** Key/value detail grid inside a disclosure. */
export function DetailGrid({
  rows,
}: {
  rows: { key: string; value: ReactNode }[];
}): ReactNode {
  return (
    <dl className="detail-grid">
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'contents' }}>
          <dt>{row.key}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
