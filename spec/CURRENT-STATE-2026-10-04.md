# Aurum Current State — 2026-10-04

## Snapshot identity

- Repository: payswapdotorg/aurum-chat
- Canonical branch: main
- Main SHA at snapshot: 8836c080a4381771615fdbfafc46dde997b2569c
- This snapshot supersedes the dated 2026-09-27 takeover snapshot for future orchestration.
- Historical certification/evidence remains immutable historical evidence.

## Production identity observed at takeover

- Vercel project: aurum-chat
- Project ID: prj_PljFx5DnZ1MCqQ5bA1uK6G1o8gFy
- Production alias: aurum-chat-livid.vercel.app
- Latest production deployment observed: dpl_HHZeajTYPksduy1VnrR3KCku86d8
- Production deployment Git SHA observed: 2733b3398e90159916062df4464d4896a382335a
- Therefore production is currently behind main.
- Current main has a Vercel status failure corresponding to a build/deployment-rate-limit condition; this is not treated as an application test failure.

## Architecture state

Architecture v2.1 remains frozen.

The company intelligence loop remains:

observe → remember → understand → evaluate goals → detect gaps/unknowns → prioritize learning missions → acquire knowledge → update world model → detect risks/opportunities/capability gaps → recommend capability changes → execute when authorized → measure outcome → learn

Chat remains a channel. The world model, evidence, goals, learning and authorized capability execution remain the cognitive/product core.

## Delivered foundation

W001–W112 are implemented/evidenced according to their respective contracts, with W099 remaining optional/non-blocking.

Post-W112 productization work verified in repository history includes:
- W113 UX harmonization;
- W114 app-wide conversation-language harmonization;
- W115 navigation/journey repairs;
- W116 waitlist-gated authentication;
- W117/W119 marketplace catalog deduplication work;
- W118 health/schema diagnostics;
- W120 production journey sweep;
- W121 adversarial copy audit;
- W123 adversarial re-audit and repair chain.

W123 evidence recorded a 37-surface adversarial browser re-audit with zero console/page errors and zero remaining development-artifact findings after the repair set. The latest re-audit also found a public metadata middleware issue; the code fix was merged as c5b4c15c4797be2d65802c59f8f83339c4a89e20.

## Important deployment distinction

The code fix above exists on main, but the currently observed production deployment was built from 2733b339, before that fix.

Accordingly:

**Current production status: NOT RECERTIFIED for the current main revision.**

The previously recorded W106/W112 certification remains valid only for its exact historical deployment/revision under that certification contract. It is not inherited by current main.

## Provider/composition posture

The repository intentionally distinguishes:
- LIVE-PROVEN capability evidence;
- FIXTURE-PROVEN deterministic/vendor-shape evidence;
- ENVIRONMENT-BLOCKED live-provider evidence.

Known environment-dependent frontiers include carrier credentials, production browser-driver wiring and some meeting/realtime sub-capabilities. This distinction is architectural and must remain intact.

## New approved product frontier

The next product objective is Company Coverage + Company Query + Closed-Loop Monitoring.

Canonical architecture:
spec/COMPANY-COVERAGE-ARCHITECTURE.md

Canonical continuation DAG:
spec/POST-W123-COVERAGE-DAG-2026-10-04.md

Immediate repository closure:
W124

Implementation frontier after W124:
W125 + W126 in parallel, then W127 + W129, then W128 + W130.

## Product interpretation

Aurum should make the company queriable, but never imply unrestricted universal capture.

The durable product promise is:

**Aurum makes the company queriable from authorized evidence, shows what it knows and how fresh it is, exposes material blind spots, and continuously compares company reality with desired outcomes so the company can adjust.**

Coverage is therefore not a dashboard add-on. It is a measurable property of the intelligence loop.

## Takeover rules for the next TL

1. Fetch current main; never assume this snapshot SHA remains current.
2. Reconcile W124 first before dispatching implementation workers.
3. Read the company-coverage architecture and DAG before modifying query/coverage behavior.
4. Preserve frozen Architecture v2.1 unless a versioned change request is explicitly approved.
5. Keep provider adapters behind existing gateways.
6. Keep PostgreSQL as domain truth.
7. Keep W009 as the sole consequential authority gate.
8. Treat production evidence as exact-deployment/SHA evidence.
9. Never convert missing credentials or disconnected providers into successful coverage.
10. Update this state record or a newer dated snapshot whenever the continuation frontier changes.

## Approved unified frontier after company coverage

The company-coverage program W124-W130 is now explicitly joined to W131-W141. The master roadmap is the latest orchestration record: spec/MASTER-ROADMAP-2026-10-04.md

The next conceptual product is: Aurum Agent Body + user-selected Model + Company Coverage/Query + goal/context-conditioned Organizational Lab + governed specialist Agent Exchange + replaceable execution environment + Web/Desktop/Mobile shared experience.

The Lab must treat organization choice as contextual. Same subject may yield different organizations under different season, duration, staffing, staff experience, workload, capability, environmental or constraint conditions. These are hypotheses to measure, not hardcoded industry rules.

Production remains not recertified for current main until a new exact-deployment certification is run.