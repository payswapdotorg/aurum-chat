// Product shell (W057) — the quiet state-pattern components.
//
// The frozen UX direction: "quiet skeleton, empty and error states" and
// "restrained motion and accessible focus treatment". These are plain
// presentational components (no hooks, no 'use client') so both server
// pages and client chrome can render them. Color never carries meaning
// alone: every pill pairs its dot with a label, skeletons are
// aria-hidden with an explicit loading label, and errors always say what
// to do next.

import type { ReactNode } from 'react';
import { PILL_TONE_LABEL } from '../lib/states';
import type { PillTone } from '../lib/states';

/** A status pill: colored dot + text label (never color alone). */
export function StatusPill({
  tone,
  children,
}: {
  tone: PillTone;
  children: ReactNode;
}): ReactNode {
  return (
    <span className="aurum-pill" data-tone={tone}>
      <span className="aurum-pill-dot" aria-hidden="true" />
      {children}
      <span className="aurum-sr-only">{` (${PILL_TONE_LABEL[tone]})`}</span>
    </span>
  );
}

/** A quiet tag (provider names, small metadata chips). */
export function Tag({ children }: { children: ReactNode }): ReactNode {
  return <span className="aurum-tag">{children}</span>;
}

/** One skeleton line (aria-hidden; the parent carries the loading label). */
export function SkeletonLine({ width }: { width?: string }): ReactNode {
  return (
    <span className="aurum-skel aurum-skel-line" style={{ width }} aria-hidden="true" />
  );
}

/** A quiet loading block: explicit label + a few skeleton lines. */
export function LoadingState({
  label,
  lines = 3,
}: {
  label: string;
  lines?: number;
}): ReactNode {
  return (
    <div className="aurum-loading" role="status" aria-live="polite" aria-busy="true">
      <span className="aurum-sr-only">{label}</span>
      <span className="aurum-skel aurum-skel-pill" aria-hidden="true" />
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonLine key={index} width={index === lines - 1 ? '62%' : undefined} />
      ))}
    </div>
  );
}

/** A quiet empty state: dashed hairline, title, hint, optional action. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="aurum-empty">
      <strong>{title}</strong>
      {hint === undefined ? null : (
        <span className="aurum-empty-hint">{hint}</span>
      )}
      {action === undefined ? null : <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

/** A quiet error state: what happened, what to do next, optional retry link. */
export function ErrorState({
  title,
  detail,
  retryHref,
  retryLabel = 'Try again',
}: {
  title: string;
  detail: string;
  retryHref?: string;
  retryLabel?: string;
}): ReactNode {
  return (
    <div className="aurum-error" role="alert">
      <strong>{title}</strong>
      <span>{detail}</span>
      {retryHref === undefined ? null : (
        <a className="aurum-error-retry" href={retryHref}>
          {retryLabel}
        </a>
      )}
    </div>
  );
}

/** The typing/working indicator pattern (restrained three-dot motion). */
export function WorkingIndicator({
  label = 'Aurum is working…',
}: {
  label?: string;
}): ReactNode {
  return (
    <span className="aurum-working" role="status" aria-live="polite">
      <span className="aurum-working-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label}
    </span>
  );
}

/** A standard panel with title, blurb and content. */
export function Panel({
  title,
  blurb,
  meta,
  children,
}: {
  title: string;
  blurb?: string;
  meta?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="aurum-panel">
      <h2 className="aurum-panel-title">
        <span>{title}</span>
        {meta === undefined ? null : <span className="aurum-meta">{meta}</span>}
      </h2>
      {blurb === undefined ? null : <p className="aurum-panel-blurb">{blurb}</p>}
      {children}
    </section>
  );
}

/** The shared page header for product surfaces. */
export function PageHead({
  title,
  description,
  meta,
}: {
  title: string;
  description: string;
  meta?: ReactNode;
}): ReactNode {
  return (
    <header className="aurum-page-head">
      <h1>{title}</h1>
      <p>{description}</p>
      {meta === undefined ? null : <div className="aurum-page-meta">{meta}</div>}
    </header>
  );
}


