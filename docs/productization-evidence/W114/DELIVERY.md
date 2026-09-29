# W114 Delivery — "Everything Is a Conversation" (app-wide messenger harmonization)

**Base:** `1726894` (the W114 design pack) · **Scope:** style + JSX layout only —
zero logic, zero route, zero dependency changes; `src/modules/**` untouched.

## What shipped, per surface

| Surface | Reframe | Files |
|---|---|---|
| Shell (all product surfaces) | The desktop rail IS the chat list now: every area row carries a colored icon tile (one stable warm hue per area, keyed `data-area`), a bold label and a one-line messenger-voice subtitle; the active row reads as the open conversation (bubble-out cream + gold left edge). Every surface with a page head rides the thread sand (`--wa-bg`) via `:has()` opt-in; settings-tone surfaces stay cream. `.aurum-page-head` is the dark-ink conversation header bar (gold left edge, cream Fraunces title, muted-cream status line, meta links in soft gold). Panels speak the bubble language (`--wa-bubble-in`, warm divider hairlines, 16px radius). The mobile top bar rides the sand; the bottom tab bar is unchanged. | `product.css`, `components/desktop-rail.tsx`, `components/states.tsx` (PageHead gains a presentational `tone` prop) |
| /chat | **Untouched** (the reference implementation) — verified no visual regression. | — |
| /intelligence | The intelligence **channel**: a message timeline. Panels became thread sections; findings/decisions/goals/capability gaps are chat messages — avatar tile colored by entry type, `--wa-bubble-in` bubble with one sharper corner, `--wa-meta` timestamps, drill-downs and "Deliver to chat" as reply-style chips (gold for the primary). Empty states are honest bubbles from Aurum. The chain pages (goals/unknowns/missions) inherit the same language through the shared row components. | `intelligence/page.tsx`, `intelligence/components/chain-ui.tsx`, `intelligence/intelligence.css` (new) |
| /today (Tower) | The daily **briefing chat**: dark-ink channel header, a "Today" date-separator chip, the KPI tiles as stat chips inside Aurum's first briefing message, every item a message (gold "A" avatar + tailed bubble), decision links as quick-reply chips, empty states as honest Aurum bubbles. The tower's dark sidebar stays (per spec) but its rows are now the **office channel list**: initial tiles per surface, one stable hue per group, active row gold-washed. All fifteen tower surfaces inherit the language through the shared `tower.css`/view-ui classes. | `today/page.tsx`, `tower.css`, `components/nav.tsx` (`data-initial` presentational attr) |
| /more | WhatsApp-**settings**: cream canvas (`tone="settings"`), the capability families as grouped list rows — colored icon tile, title, one-line subtitle, note chip. Account/keyboard sections keep the panel language. | `more/page.tsx` |
| /people | **Contacts**: rides the shared contact-row restyle (tiles + subtitles + note chips) on the sand canvas. | (no page changes needed — verified coherent) |
| /connections | **Channels**: sand canvas, dark-ink header bar, segmented nav pills, stat chips, channel cards with per-family colored initial tiles and status-dot health pills, identities as plum contact avatars, connect forms framed as the user's outgoing message. | `connections.css`, `connections/page.tsx` |
| /marketplace | The **directory**: segmented kind filter with a gold active segment, colored initial tiles on every catalog/kit/registry row, area links in the hub-row language, stat pills, bubble-in notice. | `marketplace.css` (new), `marketplace/page.tsx`, `marketplace/installed/page.tsx` |

## The token sheet as implemented

Hoisted into `product.css` `.aurum-shell` (and mirrored at the same values on
`.tower`, which does not live inside the shell):

```
--wa-bg: #f7ede0            --wa-bubble-in: #fffdf9   --wa-bubble-out: #ffeccb
--wa-header: #241e19        --wa-header-fg: #fdfaf6   --wa-header-meta: #b8ab99
--wa-send: #d9952a          --wa-divider: #eadbca     --wa-meta: #8a7a66
--list-row-hover: #f3e6d4   --status-on: #3da35d      --status-warn: #d9952a
--status-off: #b9a999
```

Per-area tile hues (the warm family — no blue/indigo anywhere): chat gold
`#d9952a`, today green `#3da35d`, intelligence teal `#0f766e`, people rust
`#b4571f`, connections plum `#7c4a5e`, marketplace terracotta `#c0603a`,
more ink `#241e19`; hub rows and directory rows cycle the same six hues.

## Gates (all four, from the repo root)

- `bun run typecheck` → clean.
- `bunx eslint src tests scripts` → 0 problems (CI-equivalent scope — see
  deviation 1).
- `bun run arch` → `architecture check passed — module files: 700, app/mcp
  files: 308, tables checked: 250` (identical to base: zero module drift).
- Full vitest suite, run chunked (the repo's own `run-suite-chunked.sh`
  pattern): **5734 passed · 0 failed · 23 skipped** (batches 1–4 + the
  4th batch's two halves + the 3-file gap: 1390+1776+1516+697+296+59).

## Verification

- Browser walkthrough as the demo manager (real signin → real surfaces), zero
  page errors on desktop and mobile passes; the chat golden path exercised
  end-to-end (composer → Aurum answer, `data-working` flips true→false).
- All ten screenshots (7 surfaces desktop + 3 mobile) independently reviewed
  by a vision model against this spec: every surface PASSES — messenger
  coherence, warm-only palette, no broken layout, clean mobile. Screenshots
  in `delivery/`.
- Targeted e2e re-runs during implementation: Journey G (connections) 3/3,
  Journey J (marketplace) 5/5.

## Honest deviations

1. **Repo-wide `bun run lint` is red only because of the untracked
   sandbox-injected `skills/` directory** (211 pre-existing findings in
   files that are not part of this repository — a clean checkout never sees
   them). The CI-equivalent scoped run over `src tests scripts` is clean.
2. `--wa-bubble-in` changed `#ffffff → #fffdf9` per the spec's token sheet
   (an imperceptible warm shift). The tower mirror uses a half-step stronger
   bubble `#fffefc` and divider `#e3d2bd`: its briefing rows are denser and
   needed slightly more separation from the sand to read as messages —
   verified by re-running the vision check after the change.
3. The full 5734-test suite ran before the final polish (tower nav initial
   tiles + the tower token half-step — CSS and one presentational
   `data-initial` attribute); `typecheck` was re-run clean after it. No
   test asserts those values (the tower unit tests don't touch nav markup).
4. The mobile top bar got the sand canvas rather than dark ink: its children
   (tenant switcher, presence pill) are light-bordered components and a dark
   bar would have required restyling them all — the dark-ink header signal
   is carried by every surface's page head instead.
5. The `QUICK ACCESS` persona panel on /signin is the dev-only demo harness
   (it renders only in development); production keeps `.aurum-auth-quick`
   absent, as the journey suite asserts.
