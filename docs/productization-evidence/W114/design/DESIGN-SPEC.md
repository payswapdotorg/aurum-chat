# W114 Design Spec — "Everything Is a Conversation" (app-wide messenger harmonization)

**Goal:** the WHOLE app looks and feels like a messaging app (the aurum-chat.vercel.app reference paradigm), while every existing feature, route, dataset and action stays fully functional. NOT just /chat — every surface.

**Reference paradigm** (screenshots in `docs/productization-evidence/W114/design/reference/`): a single persistent messenger shell — left nav (items styled like a contact/chat list: colored icon dot + title + one-line subtitle), center conversation thread, optional right context rail. Everything is presented as conversations, channels, contacts, or briefings — never as an admin dashboard.

## The design token system (EXTEND the existing W113 set — do not replace)

The W113 DNA already lives in `src/app/(product)/product.css`, `chat.css`, `connections.css`, `src/app/(tower)/tower.css`, `src/app/(auth)/auth.css`. Extend it with these messenger-surface tokens (add to product.css `:root`, dark variant in the existing dark block):

```css
/* messenger surfaces — the WhatsApp-style set (already partly in chat.css; HOIST to product.css :root so every surface can use them) */
--wa-bg: #f7ede0;            /* thread background (warm sand) */
--wa-bubble-out: #ffeccb;    /* outgoing/user bubbles + active list rows */
--wa-bubble-in: #fffdf9;     /* incoming/AI/system bubbles */
--wa-header: #241e19;        /* dark ink headers/bars (exists as --primary) */
--wa-send: #d9952a;          /* gold accent (exists as --aurum) */
--wa-chat-bg: #f7ede0;
--wa-divider: #eadbca;       /* date/section separators, hairlines */
--wa-meta: #8a7a66;          /* timestamps, meta text on sand */
--list-row-hover: #f3e6d4;
--status-on: #3da35d;        /* connected/available dot */
--status-warn: #d9952a;      /* attention dot */
--status-off: #b9a999;       /* inactive dot */
```

Typography stays: Fraunces (display/headings), Geist Sans (body), Geist Mono (numbers/code) — already wired in `src/app/layout.tsx`.

## The shared messenger shell (all product surfaces)

Every surface under `src/app/(product)/` adopts the same frame `/chat` already uses:
1. **Left pane** = the existing primary nav, restyled to the reference pattern: each item gets a small colored icon tile (rounded square, tinted background — one stable hue per item), the label, and a one-line subtitle (see per-surface subtitles below). Active row = `--wa-bubble-out` background + gold left-edge indicator. This is a restyle of the existing nav component — do not remove/rename anything, keep the ARIA `navigation "Primary"` semantics and every link target.
2. **Center pane** = the surface content, on `--wa-bg` (sand) — or on cream `#fdfaf6` for settings-like surfaces (see per-surface). A surface header bar in dark ink `--wa-header` with the surface title (Fraunces), a status word, and the existing actions.
3. **Mobile** — keep the existing responsive patterns; the bottom tab bar pattern already present stays.

## Per-surface reframing (STYLE + JSX LAYOUT ONLY — zero logic/data/API changes)

### /intelligence — "the intelligence channel"
- Reframe as a message timeline: each finding/decision/goal entry becomes a chat message — left-aligned avatar tile (colored by type), a `--wa-bubble-in` bubble carrying the existing title/body/meta, timestamp as `--wa-meta`, and the existing actions ("Deliver to chat", drill-downs) as reply-style chips under the bubble.
- The section grouping (Findings → Decisions → Goals → Capabilities) becomes WhatsApp-style date separators: a centered pill on `--wa-divider` with the section name, sticky at top of its group.
- The goal-chain pills and counters become compact chips in the surface header.
- Keep every link, button, and datum. Keep the `Deliver to chat` action prominent.

### /today (Tower) — "the daily briefing chat"
- The briefing becomes a thread: a date separator chip ("Today"), then Aurum's briefing as a sequence of `--wa-bubble-in` messages — the KPI counters become inline stat chips inside the first message; each pending item (approvals, missions, opportunities…) becomes a message card with reply-style action buttons (Approve/Decline/etc. styled as chat quick-reply chips, gold for the primary).
- Empty states become honest chat bubbles from Aurum ("No pending approvals — nothing needs you right now."), keeping the existing empty-state semantics.
- Keep the dark sidebar nav of the Tower group but harmonize tokens (same hues as the product nav).

### /more — "settings"
- The link grid becomes a WhatsApp-Settings-style list: grouped rows (existing categories as section headers), each row = icon tile + title + short subtitle + chevron. Cream background (`#fdfaf6`), sand hover rows. Same links, same destinations.

### /people — "contacts" (may land in W115 — coordinate)
- Workforce/agents/interventions become contact sections: rows with initials-avatar (colored), name, role/status line; the existing cards' actions become row trailing buttons or a detail affordance.

### /connections — "channels"
- Each connectable system becomes a channel card: icon tile, name, status dot (`--status-on/off/warn`), one-line description; KPI counters become compact chips; the connect form stays inline (framed as "start a conversation with your systems").

### /marketplace — "the directory"
- Package rows become contact/directory cards: icon tile, name, description, version + status as pills; Install = gold primary chip. Tabs become a segmented control on sand.

## Hard boundaries (the existing program law)

1. **ZERO changes under `src/modules/**`** — the domain boundary is absolute (arch gate (b)/(c) enforces imports; do not touch module files at all).
2. **Zero logic changes**: no new API calls, no changed props/contracts, no schema/migration changes, no new dependencies, no `package.json` changes.
3. **Every feature stays**: all buttons, forms, links, datasets, empty states, and their behavior. If a reframing would hide something, DON'T — reframe it instead.
4. **Test-referenced selectors stay stable** (grep before you touch): at minimum `.aurum-starter`, `.aurum-chat-listempty`, `.aurum-auth-quick` (must remain absent), the SHELL/CHAT_LISTPANE/CHAT_THREAD/CHAT_COMPOSER/CHAT_INPUT markers in `tests/browser/production/*`, and the route paths `/chat /intelligence /people /connections /marketplace /today /more /evidence`. The e2e platform-surface tests (`tests/e2e/platform/platform-surface.e2e.test.ts`) and tenant-isolation sweeps probe routes for content — keep the semantic headings and key content they assert (read them first).
5. **Accessibility**: keep semantic HTML (headings hierarchy, nav/region landmarks, ARIA labels, sr-only where present); interactive elements keep names.
6. **The chat surface (/chat) is the reference implementation** — align the other surfaces TO it; only touch /chat for token hoisting if needed (no visual regression there).

## Gates (all four, from the repo root)

```
bun run typecheck
bun run lint
bun run arch
bun run test          # full suite must stay green (5734+ passed, 0 failed)
```

## Evidence

`docs/productization-evidence/W114/DELIVERY.md` — per-surface summary of what changed (file list + rationale), the token sheet as implemented, gates output tails, and any honest deviations from this spec with reasons. Before screenshots already committed under `design/before/`; reference under `design/reference/`.
