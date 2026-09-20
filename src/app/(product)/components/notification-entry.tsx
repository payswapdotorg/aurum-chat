'use client';

// Product shell (W057) — the global notification entry.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Global": "global notification/attention
// entry". The bell lives in the rail cluster (desktop) and the top bar
// (mobile); opening it fetches fresh state and renders the attention feed —
// real notifications from the notifications contract (W031) via the shell
// state. Items with unsettled lifecycle carry the attention treatment; the
// "Details" affordance opens the CONTEXT DRAWER with the notification's
// policy snapshot and lifecycle — the drawer doing real progressive-
// disclosure work in this work item, ready for chat/evidence payloads from
// W060/W061.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useProductShell } from './product-shell-provider';
import { useShellState } from './shell-state-context';
import { Sheet } from './sheet';
import { StatusPill } from './states';
import { ShellGlyph } from './icons';
import { OPEN_NOTIFICATIONS_EVENT } from '../lib/shell-events';
import type { NotificationItemView } from '../lib/shell-state';

function formatWhen(iso: string): string {
  const when = new Date(iso);
  const invalid = Number.isNaN(when.getTime());
  return invalid ? iso : when.toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

function relativeLine(item: NotificationItemView): string {
  const bits: string[] = [`created ${formatWhen(item.createdAt)}`];
  if (item.deliveredAt !== null) bits.push(`delivered ${formatWhen(item.deliveredAt)}`);
  if (item.acknowledgedAt !== null) bits.push(`acknowledged ${formatWhen(item.acknowledgedAt)}`);
  return bits.join(' · ');
}

/** The drawer payload for one notification: policy snapshot + lifecycle. */
export function notificationContextPayload(
  item: NotificationItemView,
): {
  title: string;
  subtitle: string | null;
  tone: 'positive' | 'warning' | 'error' | 'neutral' | 'info' | null;
  source: string | null;
  sections: {
    kind: 'summary' | 'policy' | 'approval' | 'detail';
    title: string;
    lines: string[];
  }[];
} {
  return {
    title: item.subject,
    subtitle: item.kind,
    tone: item.tone,
    source: 'notifications module (W031 contract read)',
    sections: [
      {
        kind: 'summary',
        title: 'Summary',
        lines: [
          `Status: ${item.statusLabel} (${item.deliveryClassLabel.toLowerCase()} delivery class).`,
          `Recipient: ${item.recipient}.`,
          item.requireAcknowledgment
            ? 'This kind requires an acknowledgment once delivered.'
            : 'This kind does not require an acknowledgment.',
        ],
      },
      {
        kind: 'policy',
        title: 'Policy that governs it',
        lines: [
          `Delivery class: ${item.deliveryClassLabel.toLowerCase()} — the resolved policy snapshot at creation time; later policy edits never rewrite a recorded notification.`,
          `Attention: ${item.needsAttention ? 'this notification is not settled yet.' : 'this notification is settled.'}`,
        ],
      },
      {
        kind: 'detail',
        title: 'Lifecycle',
        lines: [relativeLine(item), `Notification id: ${item.id}`],
      },
    ],
  };
}

export function NotificationEntry({
  variant,
}: {
  /** `button` (rail cluster, with label) or `icon` (top bar, icon-only). */
  variant: 'button' | 'icon';
}): ReactNode {
  const { status, refresh } = useShellState();
  const { openContext } = useProductShell();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_NOTIFICATIONS_EVENT, onOpen);
    return () => {
      window.removeEventListener(OPEN_NOTIFICATIONS_EVENT, onOpen);
    };
  }, []);

  const notifications =
    status.phase === 'ready' ? status.envelope.view.notifications : null;
  const attentionCount = notifications?.attentionCount ?? 0;

  const openPanel = () => {
    setOpen(true);
    refresh();
  };

  const body: ReactNode = (() => {
    if (status.phase === 'loading') {
      return (
        <div aria-busy="true">
          <span className="aurum-sr-only">Loading notifications…</span>
          <span className="aurum-skel aurum-skel-pill" aria-hidden="true" />
          <span className="aurum-skel aurum-skel-line" aria-hidden="true" />
          <span className="aurum-skel aurum-skel-line" aria-hidden="true" />
          <span className="aurum-skel aurum-skel-line" style={{ width: '58%' }} aria-hidden="true" />
        </div>
      );
    }
    if (status.phase === 'error') {
      return (
        <div className="aurum-error" role="alert">
          <strong>Attention unavailable</strong>
          <span>
            The notification feed could not be read ({status.message}). Try
            again in a moment.
          </span>
        </div>
      );
    }
    if (notifications !== null && !notifications.ok) {
      return (
        <div className="aurum-error" role="alert">
          <strong>Attention unavailable</strong>
          <span>The notification feed could not be read for this company.</span>
        </div>
      );
    }
    if (notifications === null || notifications.items.length === 0) {
      return (
        <div className="aurum-empty">
          <strong>Nothing needs your attention</strong>
          <span className="aurum-empty-hint">
            Policy-controlled urgent, digest and escalation deliveries appear
            here the moment they exist.
          </span>
        </div>
      );
    }
    return (
      <ul className="aurum-item-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {notifications.items.map((item) => (
          <li key={item.id} className="aurum-notif" data-attention={item.needsAttention}>
            <div className="aurum-notif-head">
              <span className="aurum-notif-kind">{item.kind}</span>
              <StatusPill tone={item.tone}>{item.statusLabel}</StatusPill>
              <span className="aurum-tag">{item.deliveryClassLabel}</span>
            </div>
            <p className="aurum-notif-subject">{item.subject}</p>
            <div className="aurum-notif-meta">
              <span>{relativeLine(item)}</span>
              <span>{item.recipient}</span>
            </div>
            <div className="aurum-notif-details">
              <button
                type="button"
                className="aurum-btn"
                data-variant="quiet"
                style={{ minHeight: 34, fontSize: 12.5 }}
                onClick={() => {
                  openContext(notificationContextPayload(item));
                }}
              >
                Details
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  })();

  const trigger = (() => {
    const badge =
      attentionCount > 0 ? (
        <span className="aurum-badge-count" aria-hidden="true">
          {attentionCount > 99 ? '99+' : attentionCount}
        </span>
      ) : null;
    const label = `Notifications${
      attentionCount > 0 ? `, ${attentionCount} need attention` : ', nothing needs attention'
    }`;
    if (variant === 'icon') {
      return (
        <button
          type="button"
          className="aurum-icon-btn"
          aria-label={label}
          aria-expanded={open}
          onClick={openPanel}
        >
          <ShellGlyph name="bell" size={20} />
          {badge}
        </button>
      );
    }
    return (
      <button
        type="button"
        className="aurum-cluster-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={openPanel}
      >
        <ShellGlyph name="bell" size={16} />
        <span>Alerts</span>
        {badge}
      </button>
    );
  })();

  return (
    <>
      {trigger}
      {open ? (
        <Sheet
          title="Attention"
          subtitle="Policy-controlled urgent, digest and escalation deliveries"
          closeLabel="Close notifications"
          onClose={() => setOpen(false)}
          footer="Delivery is authority-gated and audited — every attempt is reconstructable."
        >
          {body}
        </Sheet>
      ) : null}
    </>
  );
}
