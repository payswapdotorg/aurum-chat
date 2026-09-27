# Post-W106 Continuation DAG — 2026-09-27

**Purpose:** close the live-provider / composition seams discovered after the W080–W101 roadmap
reached contract-complete + W106-certified state.

**Architecture:** v2.1 frozen.
**Workers:** maximum 3 concurrent.
**W099:** optional and never blocking.

## W107 — Vertical Kit ↔ Edge Execution Composition Closure

Dependencies: W084, W088, W092.

Scope:
- bind the existing W092 `VerticalKitEdge` seam to the W088 Edge Connector transport;
- reuse W084 DeepActionTransport/reconciliation;
- preserve kit-scoped grants and W009 authority;
- remove stale `deferred-on-w088` wording only after the actual composition exists.

Acceptance:
- a kit integration can inspect and execute through the W088-backed edge transport shape;
- no vertical module imports edge internals;
- edge result/evidence remains W084-shaped;
- tenant isolation and grant denial are covered;
- deterministic proof uses the real W088 implementation, not a duplicate fake;
- live customer-edge evidence is recorded separately when available.

## W108 — Cellular Live Transport + Manager-Inbound Authority Closure

Dependencies: W087, W095, W009, W030, W031.

Scope:
- production-configurable Twilio/Telnyx transport wiring;
- carrier webhook/reply path;
- manager-originated inbound SMS/voice request path;
- formal W009 authority record for inbound requests;
- retain explicit `provider_unavailable` behavior when transport is not configured.

Acceptance:
- real test transport can execute a manager “tell Sarah” outcome end-to-end when credentials and
  carrier route exist;
- SMS → voice fallback honors policy and budget;
- recipient does not require Internet/Aurum;
- reply returns into the canonical conversation;
- manager-originated request carries an auditable authority decision;
- a no-credential environment remains honest and retryable.

## W109 — Meeting / Realtime Live-Provider Closure

Dependencies: W085, W086, W095, W097.

Scope:
- production wiring for at least one meeting provider and one realtime provider;
- capture and two-way companion path;
- consent/recording floor;
- live transcript/speaker attribution/interruption;
- durable session/artifact finalization;
- provider-failure evidence.

Acceptance:
- one live provider path is exercised end-to-end;
- one realtime path is exercised end-to-end;
- consent refusal blocks recording;
- mid-session consent revocation stops recording;
- live transcript and speaker identity reach canonical evidence;
- spoken response/interruption lifecycle is durable;
- production evidence distinguishes live provider proof from deterministic fixtures.

## W110 — Real Browser / Computer-Use Driver Composition

Dependencies: W084, W088, W093.

Scope:
- add a real browser adapter behind the existing BrowserDriver contract;
- prefer an already-reviewed provider/OSS implementation;
- edge/browser execution stays last-mile and tenant-scoped;
- no second evidence/reconciliation model.

Acceptance:
- at least one real browser task is executed through the existing W093 lifecycle;
- credentials remain isolated and opaque;
- allowlist is checked at all existing enforcement points;
- verified observed state is required;
- failure/retry/resume produces the existing evidence shape;
- no provider-specific object crosses the contract.

## W111 — Production Migration Reader / Native-Reader Adapters

Dependencies: W088, W092, W094, W096.

Scope:
- one real incumbent reader adapter;
- one real/native Aurum reader adapter;
- staged import + compare + verification + progressive retirement;
- private/on-prem incumbents use W088 where appropriate.

Acceptance:
- no silent data loss;
- explicit conflicts remain unresolved until human decision;
- imported state never becomes duplicate authority;
- live comparison uses W084 reconciliation;
- rollback remains sequestration;
- one real environment proves the full migration path, or the exact external prerequisite is
  captured as BLOCKED.

## W112 — Post-W106 Live-Capability Certification

Dependencies: W107, W108, W109, W110, W111.

Purpose:
- certify what is actually live in the deployed environment after adapter closure.

Required matrix:
- live-provider proof;
- deterministic fixture proof;
- environment-blocked proof where credentials are absent;
- exact deployment ID/SHA;
- two-run agreement where the governing release contract requires it.

W112 must never manufacture live evidence from deterministic doubles.

## Optional W099 — Matrix

Dependencies: W030, W089, W095.
Only dispatch when a concrete customer/use-case is recorded. Never blocks W107–W112.

## Parallel waves

### Wave 1 — dispatch now

- Worker A → W107
- Worker B → W108
- Worker C → W109

These three have independent ownership boundaries and can proceed concurrently.

### Wave 2

After Wave 1 integration:

- Worker A → W110
- Worker B → W111
- Worker C → migration-runner hardening investigation (implementation only if evidence warrants it)

### Wave 3

- Tech Lead reconciliation
- W112 certification
- Optional W099 only if separately justified

## Ownership rule

Workers must not concurrently edit:

- the same public contract;
- the same migration file;
- the same route/registry registration file;

unless the TL assigns disjoint sections and performs one final deterministic reconciliation.

## Completion rule

No work item is delivered from a worker narrative alone. Require source + tests + repository gates +
exact evidence. Live-provider claims must be backed by live-provider evidence.
