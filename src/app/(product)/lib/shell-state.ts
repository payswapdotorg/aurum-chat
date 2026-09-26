// Product shell (W057) — the shell-state view builder.
//
// The shell chrome (tenant/workspace switcher, notification entry, presence
// pill) reads ONE composed view. It is built from module contracts only
// (lock 31/32; IMPLEMENTATION-STACK §5 "React pages reading only module
// contracts via route handlers/server code"):
//
//   * organizations  — getTenant + listWorkspaces (the switcher's data);
//   * notifications  — listNotifications (the attention entry's data).
//
// Every section degrades QUIETLY and independently: a company read that
// fails (for example a non-member principal — organizations deliberately
// makes that indistinguishable from a missing tenant, ADR-0001) becomes
// `ok: false` with a generic reason; the notifications feed still renders.
// The shell never pretends a degraded section is empty data.
//
// This file is the server-side composition; the chrome fetches it through
// the /api/product/shell route handler (lib/api.ts), the same
// thin-adapter discipline the tower follows.

import type { TenantContext } from '@/infra/tenant';
import type { AuthPrincipal, UserCompany } from '@/modules/auth/contract';
import { getTenant, listWorkspaces } from '@/modules/organizations/contract';
import type { Tenant, Workspace } from '@/modules/organizations/contract';
import {
  listNotifications,
  recipientLabel,
} from '@/modules/notifications/contract';
import type {
  Notification,
  NotificationStatus,
} from '@/modules/notifications/contract';
import type { PillTone } from './states';

/** How many recent notifications the entry carries. */
export const SHELL_NOTIFICATION_LIMIT = 12;

// ---------------------------------------------------------------------------
// Notification view model
// ---------------------------------------------------------------------------

export interface NotificationItemView {
  id: string;
  kind: string;
  subject: string;
  status: NotificationStatus;
  statusLabel: string;
  deliveryClass: 'urgent' | 'digest' | 'escalation';
  deliveryClassLabel: string;
  tone: PillTone;
  needsAttention: boolean;
  createdAt: string;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  requireAcknowledgment: boolean;
  recipient: string;
}

export interface NotificationsSection {
  ok: boolean;
  reason: string | null;
  items: NotificationItemView[];
  totalShown: number;
  attentionCount: number;
}

export type CompanySection =
  | {
      ok: true;
      tenant: { id: string; name: string; slug: string };
      workspaces: { id: string; name: string; slug: string }[];
    }
  | { ok: false; reason: 'unavailable' };

export interface ShellStateView {
  generatedAt: string;
  tenantId: string;
  principalId: string;
  /** The active workspace id (uuid) inside the company; null = tenant default (W058: session selection). */
  workspace: string | null;
  company: CompanySection;
  notifications: NotificationsSection;
  /** The signed-in principal (W058 — session-sourced, for the account UI). */
  principal: { displayName: string; email: string } | null;
  /** The principal's verified companies (W058 — the switcher's data). */
  companies: UserCompany[];
  /** The verified role behind the session's derived claims (W058). */
  role: string | null;
}

/** Human copy for a notification status. */
export function notificationStatusLabel(status: NotificationStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'delivered':
      return 'Delivered';
    case 'escalating':
      return 'Escalating';
    case 'escalated':
      return 'Escalated';
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Blocked';
    case 'suppressed':
      return 'Suppressed';
    case 'escalation_failed':
      return 'Escalation failed';
  }
}

/** Human copy for a delivery class. */
export function deliveryClassLabel(
  deliveryClass: 'urgent' | 'digest' | 'escalation',
): string {
  switch (deliveryClass) {
    case 'urgent':
      return 'Urgent';
    case 'digest':
      return 'Digest';
    case 'escalation':
      return 'Escalation';
  }
}

/** Status → pill tone (warning is reserved for degraded/escalating states). */
export function notificationTone(status: NotificationStatus): PillTone {
  switch (status) {
    case 'delivered':
      return 'positive';
    case 'escalating':
    case 'escalated':
      return 'warning';
    case 'failed':
    case 'escalation_failed':
      return 'error';
    case 'blocked':
    case 'suppressed':
      return 'neutral';
    case 'pending':
      return 'info';
  }
}

/**
 * Which statuses deserve the attention badge on the notification entry:
 * anything not yet settled (pending) or demanding a look (escalation
 * family, failures). Delivered, blocked and suppressed are settled.
 */
export function notificationNeedsAttention(status: NotificationStatus): boolean {
  switch (status) {
    case 'pending':
    case 'escalating':
    case 'escalated':
    case 'failed':
    case 'escalation_failed':
      return true;
    case 'delivered':
    case 'blocked':
    case 'suppressed':
      return false;
  }
}

function toNotificationItemView(
  notification: Notification,
): NotificationItemView {
  return {
    id: notification.id,
    kind: notification.notificationKind,
    subject: notification.subject,
    status: notification.status,
    statusLabel: notificationStatusLabel(notification.status),
    deliveryClass: notification.deliveryClass,
    deliveryClassLabel: deliveryClassLabel(notification.deliveryClass),
    tone: notificationTone(notification.status),
    needsAttention: notificationNeedsAttention(notification.status),
    createdAt: notification.createdAt,
    deliveredAt: notification.deliveredAt,
    acknowledgedAt: notification.acknowledgedAt,
    requireAcknowledgment: notification.requireAcknowledgment,
    recipient: recipientLabel(
      notification.recipient.provider,
      notification.recipient.providerAccountId,
    ),
  };
}

// ---------------------------------------------------------------------------
// Company view
// ---------------------------------------------------------------------------

function toTenantView(tenant: Tenant): { id: string; name: string; slug: string } {
  return { id: tenant.id, name: tenant.name, slug: tenant.slug };
}

function toWorkspaceView(workspace: Workspace): { id: string; name: string; slug: string } {
  return { id: workspace.id, name: workspace.name, slug: workspace.slug };
}

async function buildCompanySection(
  ctx: TenantContext,
): Promise<CompanySection> {
  try {
    const [tenant, workspaces] = await Promise.all([
      getTenant(ctx),
      listWorkspaces(ctx),
    ]);
    return {
      ok: true,
      tenant: toTenantView(tenant),
      workspaces: workspaces.map(toWorkspaceView),
    };
  } catch {
    // Membership/tenant failures are indistinguishable by design
    // (ADR-0001 no-existence-leak) — the shell shows one quiet reason.
    return { ok: false, reason: 'unavailable' };
  }
}

async function buildNotificationsSection(
  ctx: TenantContext,
): Promise<NotificationsSection> {
  try {
    const notifications = await listNotifications(ctx, {
      limit: SHELL_NOTIFICATION_LIMIT,
    });
    const items = notifications.map(toNotificationItemView);
    return {
      ok: true,
      reason: null,
      items,
      totalShown: items.length,
      attentionCount: items.filter((item) => item.needsAttention).length,
    };
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      items: [],
      totalShown: 0,
      attentionCount: 0,
    };
  }
}

/**
 * The anonymous shell view (W101): the chrome's honest no-session state.
 *
 * The shell chrome exists for anonymous visitors too — the product layout
 * resolves the session read-only and renders the quiet "no company" state
 * (W076). A session-scoped chrome fetch can still race a session END while
 * the page is live: the sign-out navigation (the POST clears the cookie,
 * the SPA shell is still mounted), a hydration completing after a fast
 * sign-out click, or a session expiring mid-view. Those racing fetches used
 * to 401 — a console error visible to real users on every such transition.
 * The anonymous view answers them with 200 and zero tenant data, exactly
 * what the layout renders server-side for anonymous visitors.
 */
export function buildAnonymousShellView(): ShellStateView {
  return {
    generatedAt: new Date().toISOString(),
    tenantId: '',
    principalId: '',
    workspace: null,
    company: { ok: false, reason: 'unavailable' },
    notifications: {
      ok: false,
      reason: null,
      items: [],
      totalShown: 0,
      attentionCount: 0,
    },
    principal: null,
    companies: [],
    role: null,
  };
}

/**
 * Compose the shell state for one request. Never throws: every section
 * degrades on its own. `generatedAt` is the assembly time of the view.
 *
 * The `extras` (W058) carry the session-resolved principal, company
 * directory and role — omitted by older callers, they degrade to the
 * honest empty values.
 */
export async function buildShellState(
  ctx: TenantContext,
  workspace: string | null,
  extras: {
    principal?: AuthPrincipal;
    companies?: UserCompany[];
    role?: string;
  } = {},
): Promise<ShellStateView> {
  const [company, notifications] = await Promise.all([
    buildCompanySection(ctx),
    buildNotificationsSection(ctx),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    tenantId: ctx.tenantId,
    principalId: ctx.principalId,
    workspace,
    company,
    notifications,
    principal:
      extras.principal === undefined
        ? null
        : { displayName: extras.principal.displayName, email: extras.principal.email },
    companies: extras.companies ?? [],
    role: extras.role ?? null,
  };
}
