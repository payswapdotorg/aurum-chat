# W141 — End-to-End + Cross-Platform Certification Plan (TL-owned)

**Status:** PLANNED (authored during the 2026-10-04 degraded-window shift; executes at integration time)
**Owner:** TL (workers provide fixes/evidence only)
**Source:** spec/MASTER-ROADMAP-2026-10-04.md W141 + the operator's mandatory demonstrations

## Certification shape

W141 is NOT a new implementation — it is the proof layer over W124-W140.
It produces a machine-readable evidence record bound to an exact commit SHA
and an exact deployment (Vercel), with every demonstration classified LIVE
or FIXTURE per the completion law.

## The six mandatory demonstrations (from the operator's handoff)

### D1 — Provider/model swap (LIVE if a second real provider credential exists, else FIXTURE-two-path)
Journey: connect provider → models appear → select one → Aurum works →
switch provider/model → same body continues.
Proof surface: W132's two-provider swap fixture + W133's swap-continuity
longitudinal fixture; LIVE upgrade only if two real provider accounts are
connectable at certification time (OpenRouter key available — a custom
openai-compatible provider definition over OpenRouter is the intended LIVE
path; the fabric's custom-provider support is exactly this).

### D2 — Ride journey (FIXTURE, end-to-end machinery)
"Book me a ride." → Aurum → Ride Agent → ride provider → completion →
PaySwap Agent → payment → Aurum.
Proof surface: W136's ride-flow fixture extended to the chat surface: the
operator can type the request in the product chat and watch the plan
execute through the fixture packages. LIVE ride/pay providers are out of
scope (no credentials) — classified FIXTURE, honestly.

### D3 — Construction journey (FIXTURE context + REAL Lab selection)
"Make sure construction works on site A are executed correctly." →
context reconstruction → information strategy → Lab → best contextual
organization → recruitment → agent execution → site/person/system relay →
evidence → deviation detection → Aurum.
Proof surface: W134 strategy + W135 Lab + W136 exchange + W128-substance
deviation (folded per the CURRENT-STATE ruling), driven through the
construction fixture scenario.

### D4 — Context variation (the operator's explicit demand)
Same construction subject under altered season, duration, staffing and
experience fixtures → the Lab selects DIFFERENT organizations when the
measured objective changes.
Proof surface: W135's context-diversity test made operator-visible in the
/lab UI: two saved scenarios (spring/novice-heavy vs fall/expert-crew)
rendered side by side with different selected organizations and the
evidence trail explaining why.

### D5 — Emergent role proposal → marketplace submission boundary (FIXTURE)
A role proposal that reaches marketplace submission but cannot bypass
marketplace approval.
Proof surface: W138's governance-boundary test + the /roles UI showing a
submitted proposal awaiting review with the Lab-cannot-self-approve notice.

### D6 — Cross-platform continuity (FIXTURE clients + LIVE server state)
Continue the same active work across Web/Desktop/Mobile without competing
semantic state.
Proof surface: W139's two-client no-divergence fixture + the continuity
endpoints exercised against the real server state; desktop/mobile shells
typecheck-verified (bundle steps may be ENVIRONMENT-BLOCKED, honestly
recorded).

## Gate battery (the W141 acceptance run)

1. `bun run typecheck && bun run test && bun run arch && bun run lint && bun run build`
   — against the exact release SHA, with the known-failures baseline diff
   (no NEW failures).
2. Tenant-isolation suite re-run (the W444 sweeps + the upgraded sweeps for
   the new modules).
3. The D1-D6 demonstrations executed and recorded with per-step evidence
   (screenshots for operator-visible surfaces via agent-browser; structured
   API evidence for machinery).
4. Production deployment through the Vercel project (Composio-managed),
   deployment ID + SHA recorded; smoke check on the production URL.
5. Evidence record: spec/evidence/W141-CERTIFICATION-<date>.md with the
   exact commit, deployment ID, per-demonstration classification table,
   and honest deviations.

## Execution order at integration time

1. All waves merged; main green at the release SHA.
2. Deploy to production (Vercel) — record deployment identity.
3. Run the battery + demonstrations against the deployment.
4. Write the evidence record; update CURRENT-STATE; push.
5. Report to the operator with the per-demonstration classification table.

## Honesty rules (binding)

- Fixture evidence never becomes a live claim.
- The record names every ENVIRONMENT-BLOCKED step and why.
- Production certification binds to the exact deployment ID/SHA (the
  POST-W123 doctrine: production behind main is NOT recertified by main
  advancing).
