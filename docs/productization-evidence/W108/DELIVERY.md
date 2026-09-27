# W108 — Cellular Live Transport + Manager-Inbound Authority Closure — Delivery Record

**Work item:** W108 (spec/POST-W106-CONTINUATION-DAG-2026-09-27.md; spec/work-items/WORK-ITEM-CATALOG.md §W108)
**Base SHA:** 361c6a5d889b1bf38a2ff9df5a994fb4beedb4e7
**Branch:** `work/w108-cellular-live-transport`
**Implementation commit:** see `git log -1` on the branch (this file is committed with the implementation).
**Delivery type:** DELIVERED (deterministic + vendor-shape layers) with the LIVE leg honestly ENVIRONMENT-BLOCKED (prerequisites below; never faked).

---

## 1. What was delivered

1. **REAL TRANSPORTS** (`src/modules/cellular/adapters/`):
   - `transport-twilio.ts` — `createTwilioTransport(config)`: live Twilio REST
     transport (Messages + Calls APIs, HTTP Basic auth with Account SID + Auth
     Token, plain `fetch` + timeout, no SDK). SMS: `POST
     /2010-04-01/Accounts/{sid}/Messages.json` (form-encoded To/From/Body) →
     `CellularSmsReceipt`. Voice: `POST …/Calls.json` with
     `Twiml=<Response><Say>…</Say></Response>` (XML-escaped), then a BOUNDED
     POLL of `GET …/Calls/{sid}.json` until the call's terminal status (the
     honest synchronous bridge the frozen receipt contract demands):
     `completed→answered`, `no-answer|busy|canceled→no_answer`, `failed→failed`;
     window expiry maps `in-progress→answered`, `ringing/queued→no_answer`
     with explicit incomplete-observation detail.
   - `transport-telnyx.ts` — `createTelnyxTransport(config)`: live Telnyx v2
     REST transport (Bearer API key). SMS: `POST /v2/messages`
     ({from,to,text}) → receipt from `data.id`. Voice (Call Control): `POST
     /v2/calls` ({from,to,connection_id}) → poll `GET /v2/calls/{id}`
     (`data.call_state`) → on the answered state issue the documented
     `POST /v2/calls/{id}/actions/speak` ({payload}) → poll to terminal.
     Without `callControlAppId` the transport is SMS-only and fails voice
     placements honestly.
   - `transport-shared.ts` — the shared taxonomy classifier: 2xx→`accepted`;
     401/402/429/5xx/network/timeout→`failed` (TRANSIENT, budget-retried);
     every other 4xx→`rejected` (PERMANENT — invalid number, blocked content).
     Vendor error codes/messages ride in `detail` (bounded).
   - `webhook-verify.ts` — the documented carrier request-signature
     algorithms: Twilio `X-Twilio-Signature` = base64(HMAC-SHA1(authToken,
     url + Σ sorted(key+value))) (timing-safe compare; form-encoded AND JSON
     bodies); Telnyx `Telnyx-Signature`/`Telnyx-Timestamp` = Ed25519 over
     `${timestamp}|${rawBody}` verified with the configured base64-DER/SPKI
     public key. Both fail CLOSED.
   - All transports are constructed from CONFIGURATION OBJECTS, never ambient
     singletons; vendor objects stay inside the adapters (lock 16); the port
   (`CellularTransport`) speaks only provider-neutral requests/receipts.

2. **PRODUCTION WIRING** (`src/infra/cellular.ts`, env-driven, idempotent
   per process — the email/blob Family-A globalThis discipline):
   - `ensureCellularTransportsWired()` reads the env block, constructs the
     matching live transport(s) via the cellular contract's
     `createCellularTransportFromConfig`, and wires them through the NEW
     per-provider registry `setCellularTransportForProvider` (additive; the
     frozen single-transport seam `setCellularTransport` remains the explicit
     override and keeps precedence for its own provider, so test overrides are
     always honored). The attempt's pinned connection decides which provider's
     transport serves the delivery — both providers can be wired at once.
   - Env names (documented in `.env.example` + `docs/DEPLOYMENT.md` §6):
     `CELLULAR_TWILIO_ACCOUNT_SID`, `CELLULAR_TWILIO_AUTH_TOKEN`,
     `CELLULAR_TELNYX_API_KEY`, `CELLULAR_TELNYX_CALL_CONTROL_APP_ID`
     (optional — SMS-only without it), `CELLULAR_TELNYX_PUBLIC_KEY`,
     `CELLULAR_WEBHOOK_PUBLIC_URL` (optional proxy-safe signature URL).
   - UNSET or PARTIAL env → the matching transport stays UNWIRED → the
     existing honest `provider_unavailable` (retryable, visible). Sending
     numbers are deliberately NOT env: they are per-tenant CONNECTION data
     (`registerCellularConnection`) — the architectural home of endpoint
     identity.
   - Invocation sites: the carrier webhook edge (`/api/webhooks/cellular/**`
     — the production cellular HTTP surface) ensures the wiring lazily at
     first carrier contact; the function is exported for every future
     delivery entry point. NOTE (honest frontier): no production route or the
     resident worker currently invokes `pumpCellularReach`/`reachAnyone`
     (verified by grep at base — the demo seed is the only caller, and it
     deliberately exercises the honest unwired failure); wiring the pump into
     the worker's schedule is the W112 certification frontier, out of W108's
     ownership.

3. **CARRIER WEBHOOK ROUTE** (`src/app/api/webhooks/cellular/[provider]/`):
   - `POST /api/webhooks/cellular/twilio` and `…/telnyx` — thin `route.ts` +
     `lib.ts` handler (the house convention: `dynamic='force-dynamic'`,
     `HandlerResult`, tested directly without booting Next.js).
   - Pipeline: fail-closed verification-config check (503 when the provider's
     verification credential is absent — an unverifiable carrier edge never
     processes anything) → vendor signature verification (403 on failure,
     NEVER processed) → content-type parse (form-encoded — the Twilio
     default — or JSON) → the module's composite carrier edge
     `receiveCellularCarrierWebhook` (contract): adapter parse (unsupported
     pings → 200-acknowledge; malformed → 400) → platform-level account→tenant
     resolution (unknown tenant → 202 observed-not-errored) →
     `receiveCellularEvent` under the resolved tenant with the deterministic
     system principal `system:cellular-carrier-webhook` (ledger claim/dedupe,
     transcript turn + on-sight identity, reach correlation, receipt
     refinement).
   - Carrier retry semantics: 200 applied (or acknowledged ping; `applied:false`
     on redelivery — the event ledger deduped), 202 unknown tenant, 400
     malformed, 403 bad signature, 413 oversized (1 MiB guard), 503
     unconfigured.

4. **MANAGER-INBOUND W009 AUTHORITY RECORD** (the W097 deferral closure):
   - Migration `006-cellular-inbound-authority.sql` (NEW immutable file; the
     W102 discipline): `cellular_reach_requests` gains INSERT-time origin
     columns (`origin_reply_id`/`origin_provider`/`origin_provider_event_id`,
     shape-CHECKed, protected by the EXTENDED guard function — replaced
     additively from this file, migration 003 never edited); NEW append-only
     table `cellular_inbound_authority` (UNIQUE (tenant_id, provider,
     provider_event_id) — idempotent per inbound event; determination ∈
     {consequential, not_consequential, ambiguous_sender}; shape CHECK:
     consequential ⇒ action_request_id NOT NULL; UPDATE/DELETE/TRUNCATE
     rejected by triggers).
   - `reachAnyone` gains the optional `origin` triple (additive; frozen
     reach/policy semantics untouched): the origin reply must exist in THIS
     tenant, be an `inbound_request`, and match the evidence triple exactly.
     The W009 gate payload AND justification reference the origin
     (auditable through the actions module's own surface:
     `getActionRequest`/`listActionRequests`), and the per-event
     determination ledger records `consequential` with the gate record id —
     recorded for ALL gate outcomes (approved, pending, rejected: the
     authority decision exists regardless of the outcome).
   - `recordCellularInboundDetermination` records NEGATIVE
     (`not_consequential`) and AMBIGUOUS (`ambiguous_sender`) determinations —
     evidence, not silence. Ambiguous senders are recorded WITHOUT acting and
     WITHOUT merging the identity (lock 15 / the W002 posture — verified:
     the identity stays unverified/unlinked, no person attribution, no reach).
   - `listCellularInboundDeterminations` — the ledger's tenant-scoped read
     surface.
   - Direct `consequential` recording is impossible by contract (validation
     rejects it — only the reach path may record it, keeping every
     consequential row anchored to a real action request).

5. **Count-pins extended deliberately (with comments):**
   `EXPECTED_TABLE_CENSUS` 256→257 (src/app/api/health/lib.ts — the new
   table); the W102 schema-reconciliation pins 133→134 and 136→137
   (tests/e2e/platform/schema-reconciliation.test.ts — the new migration).

---

## 2. Dependency verification (present at base 361c6a5)

| Dependency | File + symbol evidence (verified at base) |
| --- | --- |
| W087 (cellular contract-complete) | `src/modules/cellular/contract.ts` exports `reachAnyone`, `retryCellularReach`, `pumpCellularReach`, `receiveCellularEvent`, `setCellularTransport`/`getCellularTransport`; `src/modules/cellular/service.ts` `authorizeReachGate` (W009 gate at the outbound path); `src/modules/cellular/types.ts` `CellularTransport` port + `CellularSmsReceipt`/`CellularVoiceReceipt`; adapters `twilio.ts`/`telnyx.ts` (parse side). |
| W095 (unified cross-channel/meeting/telephony identity verification) | `src/modules/identity/contract.ts` exports `attestIdentity`, `attachVerifiedSubject`, `findExternalIdentityByProviderKey`, `registerExternalIdentity`; consumed by cellular `resolvePersonRecipient`/`resolvePhoneIdentity` (service.ts) — the verified-phone-identity resolution this delivery builds on; ambiguous matches stay unverified (W095 acceptance) — reused verbatim for the ambiguous-sender posture. |
| W009 (actions authority gate) | `src/modules/actions/contract.ts` exports `authorizeAction`, `evaluateActionAuthority`, `resolveAuthorityPolicy`, `getActionRequest`, `decideApproval`; `action_requests`/`action_approval_decisions` migrations (002/003); `src/modules/cellular/policy.ts` `CELLULAR_REACH_AUTHORITY_LEVEL = 'ASK'`, `reachGateKey`. |
| W030 (channels canonical inbound edge) | `src/modules/channels/contract.ts` exports `receiveInbound` (+ `InboundResult`); `src/modules/channels/service.ts` `receiveInbound` (on-sight identity registration + transcript turn) — the path manager-inbound requests return through. |
| W031 (notifications) | `src/modules/notifications/contract.ts` exports `createNotification`; cellular `notifyFailure` (service.ts) delivers `CELLULAR_FAILURE_NOTIFICATION_KIND` — unchanged by this delivery. |

---

## 3. Exact tests run (this delivery)

New test files (all passing):

| File | Tests | What each proves |
| --- | --- | --- |
| `src/modules/cellular/tests/cellular-transports.test.ts` | 20 | Vendor-shape verification: Twilio Messages/Calls request construction (URL, Basic auth, form body, XML-escaped Twiml), Telnyx /v2/messages + call-control flow construction (Bearer, JSON bodies, connection_id, speak payload); receipt mapping (sid/data.id); error taxonomy (400→rejected permanent; 401/402/429/5xx/network→failed transient); no fabricated ids; voice bounded-poll mappings incl. honest window-expiry outcomes; construction guards. No network (injected fetch double). |
| `src/modules/cellular/tests/cellular-authority.test.ts` | 11 | Manager-inbound W009 closure: consequential determination + gate payload origin reference (both directions auditable); pending-gate determinations; idempotency per event (second action from one ask → one ledger row); negative determination (idempotent replay); ambiguous sender WITHOUT identity merge (unverified/unlinked identity, no person, no reach); direct-consequential recording rejected; origin validation (cross-tenant uniform, mismatched triple, reach_reply rejected); tenant isolation of the ledger; append-only storage + origin-column immutability (extended guard). |
| `src/app/api/webhooks/cellular/[provider]/tests/cellular-carrier-webhook.test.ts` | 14 | The carrier edge end-to-end: Twilio valid signature (form + JSON) → applied + reply/transcript land; redelivery → applied:false (one reply row, one ledger row); invalid/missing signature → 403 (nothing processed); unconfigured → 503 fail-closed; queued ping → 200 acknowledged (nothing recorded); unknown tenant → 202 observed (nothing recorded); malformed → 400; unknown provider → 404; CELLULAR_WEBHOOK_PUBLIC_URL proxy verification; 413 body guard; Telnyx Ed25519 valid → applied; wrong signature/tampered body/missing headers → 403; unconfigured key → 503; malformed key → 403. Test-side signatures are INDEPENDENT implementations of the documented algorithms. |
| `src/infra/cellular.test.ts` | 14 | Env → transport construction: unset → unwired; full twilio → wired; partial twilio (either half) → incomplete + unwired; telnyx key → wired SMS-only; key+app → wired; app without key → unwired; both → both; idempotent per process; reset; verification config readers; signature-URL override semantics. |
| `src/modules/cellular/tests/cellular-live-composition.test.ts` | 7 | The composed path: contract factory + per-provider wiring (partial config rejected loudly); multi-provider composition (per-provider twilio live + single-seam telnyx scripted — each connection served by its own provider's transport); SMS→voice fallback through the REAL transport shapes (503 SMS → budget → voice call → poll completed → delivered; Twiml speaks the reach text); forbidden policy → no call ever placed; lifetime cost cap refuses BEFORE the vendor call; provider_unavailable honesty (leg-less honest attempt pair, terminal failure, retryable after wiring); live telnyx journey (provider-swap evidence through live adapter code). |

Amended test files:
- `tests/e2e/platform/schema-reconciliation.test.ts` — the three W102
  count-pins extended deliberately (133→134, 136→137 ×2) with comments
  (25/25 pass).

Full-suite execution (the W101 chunked-batch precedent — one `bun run test`
exceeds the single-command window; 271 files split into 6 per-file batches):

| Batch | Files | Result |
| --- | --- | --- |
| 1 | 42 | 884 passed |
| 2 | 50 | 1025 passed, 1 skipped (pre-existing real-provider opt-in) |
| 3 | 44 | 1195 passed |
| 4 | 42 | 1040 passed |
| 5 | 44 | 982 passed |
| 6 | 49 | 531 passed (after the deliberate W102 count-pin extension; the 3 failures shown by the first pass were exactly those pins) |
| **Total** | **271** | **5657 passed, 1 skipped, 0 failed** |

---

## 4. Gate results (on the delivery tree)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | **PASS** (tsc --noEmit, clean) |
| Lint | `bun run lint` | **PASS** (eslint ., 0 problems) |
| Architecture | `bun run arch` | **PASS** — module files: 673, app/mcp files: 307, tables checked: 249; vendor objects stay inside adapters; infra/app import the cellular contract only |
| Tests | `bun run test` (chunked, above) | **PASS** — 271 files, 5657 passed / 1 skipped / 0 failed |
| Build | `bun run build` | **PASS** — compiled successfully; `/api/webhooks/cellular/[provider]` mounted as a dynamic route |
| Secrets hygiene | `git grep` over the changed tree for `ghp_`, `AC[0-9a-f]{32}`, `SK…`/`KEY…` token patterns | **PASS** — zero matches; all credential values in tests/docs are placeholders (`AC_test`, `token-test`, `live-token-placeholder`, `KEY_placeholder`, …) |

---

## 5. Evidence separation (deterministic / vendor-shape / live)

### (a) DETERMINISTIC-COMPOSITION EVIDENCE (proven by tests, no network)

- The carrier edge composition: signature verification (both vendors,
  including fail-closed postures), account→tenant resolution, redelivery
  idempotency (one application per provider event id), unknown-tenant
  observation, unsupported-ping acknowledgement, envelope parse →
  `receiveCellularEvent` → reply/transcript/ledger rows (14 tests).
- The manager-inbound authority closure: consequential/negative/ambiguous
  determinations, idempotency per event, both-direction audit references,
  ambiguous-identity non-merge, tenant isolation, append-only storage
  (11 tests).
- The wiring composition: env → transport construction, honest
  unset/partial postures, multi-provider per-connection routing, retryability
  after wiring (21 tests across two files).
- The fallback discipline through the composed path: policy-gated SMS→voice
  (permitted/forbidden), budget exhaustion, lifetime cost cap, honest
  provider_unavailable (7 tests).

### (b) VENDOR-SHAPE VERIFICATION (against the vendors' documented contracts, no live calls)

The following API shapes were verified against the vendors' documented REST
contracts by constructing/consuming them in tests with a deterministic fetch
double (the exact request URLs, methods, auth headers, bodies and response
fields asserted):

- **Twilio Messages**: `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`,
  HTTP Basic (SID:token), form-encoded `To`/`From`/`Body`; 201 response
  `{sid, status}` — `sid` as the provider message id. Error body shape
  `{code, message, more_info}` surfaced in `detail`.
- **Twilio Calls**: `POST …/Calls.json` form-encoded `To`/`From`/`Twiml`
  (`<Response><Say>` — XML-escaped); 201 `{sid}`; call status vocabulary
  (`queued/ringing/in-progress/completed/busy/no-answer/canceled/failed`)
  polled via `GET …/Calls/{CallSid}.json` `{status}`.
- **Twilio request validation**: `X-Twilio-Signature` =
  base64(HMAC-SHA1(authToken, fullUrl + Σ sorted params(key+value))) —
  implemented and cross-verified by an INDEPENDENT test-side implementation,
  for both form-encoded (the vendor default) and JSON bodies.
- **Telnyx Messages**: `POST https://api.telnyx.com/v2/messages`, Bearer key,
  JSON `{from, to, text}`; 201 `{data: {id, status}}` — `data.id` as the
  provider message id. Error body shape `{errors: [{code, title, detail}]}`.
- **Telnyx Call Control**: `POST /v2/calls` `{from, to, connection_id}`;
  `GET /v2/calls/{id}` `{data: {call_state}}`; the speak command
  `POST /v2/calls/{id}/actions/speak` `{payload}`. **Shape confidence note:**
  the SMS surface and the webhook envelope (message.received etc.) are
  high-confidence (the parse side was already contract-complete at base and
  is exercised natively); the VOICE call-control state vocabulary
  (`answered`/`bridged`/`completed`/`no-answer`/…) is implemented per the
  documented webhook event types but has the highest residual shape
  uncertainty of this delivery — it is marked SHAPE-VERIFIED ONLY and must be
  live-verified before production voice reliance (see known limitations).
- **Telnyx request validation**: `Telnyx-Signature` (base64 Ed25519) +
  `Telnyx-Timestamp`, verified over `${timestamp}|${rawBody}` with the
  base64-DER/SPKI public key — implemented with node:crypto and
  cross-verified by an independent test-side keypair/signing.

### (c) LIVE LEG — ENVIRONMENT-BLOCKED (the honest record)

**No live Twilio or Telnyx call was made, and none was faked.** The
production environment has NO Twilio/Telnyx credentials configured (the
tech lead verified the production env vars at dispatch: only infra keys
exist). Per REPOSITORY-SOURCE-OF-TRUTH rule 8, a missing credential is an
environment prerequisite, never permission to fake success. The exact
prerequisites to turn the live path on:

1. **Twilio**: `CELLULAR_TWILIO_ACCOUNT_SID` (the 'AC…' Account SID),
   `CELLULAR_TELNYX…`-equivalent: `CELLULAR_TWILIO_AUTH_TOKEN` (the account
   auth token — REST auth + webhook co-signature), and the carrier webhook
   route configured in the Twilio Console (see the runbook).
2. **Telnyx**: `CELLULAR_TELNYX_API_KEY` (API key), optionally
   `CELLULAR_TELNYX_CALL_CONTROL_APP_ID` (voice), `CELLULAR_TELNYX_PUBLIC_KEY`
   (the webhook signing public key from the Telnyx portal), and the carrier
   webhook route configured in the Telnyx portal.
3. **Carrier webhook route**: the carrier must be configured to POST to the
   deployed `/api/webhooks/cellular/{twilio|telnyx}` endpoint (exact URL in
   the runbook; `CELLULAR_WEBHOOK_PUBLIC_URL` when a proxy rewrites the
   Host).
4. **A tenant-side connection registration** per provider account
   (`registerCellularConnection` with the SAME provider account id the env
   transport delivers for — see known limitations).

Until these exist: transports stay unwired (`provider_unavailable`),
the carrier edge fails closed (503), and the module's behavior is exactly
the pre-W108 honest posture.

---

## 6. Operator runbook — turning the live path on

### Step 0 — prerequisites

- A Twilio account (Account SID + Auth Token; a sender/phone number capable
  of SMS and, for voice, Programmable Voice) and/or a Telnyx account
  (API key; a number; for voice, a Call Control Application whose id you
  know; for webhook verification, the portal's webhook signing PUBLIC key).
- Deploy access to the Aurum environment variables (Vercel project env or
  the self-hosted `.env`).

### Step 1 — set the environment block

```
# Twilio (SMS + voice):
CELLULAR_TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CELLULAR_TWILIO_AUTH_TOKEN=<your auth token>

# Telnyx (SMS; voice optional):
CELLULAR_TELNYX_API_KEY=<your API key>
CELLULAR_TELNYX_CALL_CONTROL_APP_ID=<call control application UUID>   # optional — SMS-only without it
CELLULAR_TELNYX_PUBLIC_KEY=<base64 DER/SPKI Ed25519 public key>       # required for the webhook edge

# Only when a proxy rewrites the Host (the signature URL must match what
# the carrier was configured to POST to):
CELLULAR_WEBHOOK_PUBLIC_URL=https://your-public-host.example.com
```

Redeploy/restart. UNSET or PARTIAL values keep the matching transport
honestly unwired — deliveries then fail explicitly with
`provider_unavailable` (retryable once completed).

### Step 2 — configure the carrier webhook

- **Twilio Console** → Phone Numbers → your number → Messaging:
  "A message comes in" → Webhook → `https://<your-host>/api/webhooks/cellular/twilio`
  (HTTP POST). For voice: Voice → "A call comes in" → the same URL (the
  module's twilio adapter parses Twilio-style voice envelopes; Twilio must
  be configured to deliver `CallStatus`/`SpeechResult` webhooks — use a
  TwiML Bin or Twilio Functions integration that relays the call events as
  documented in `src/modules/cellular/adapters/twilio.ts`'s header, the same
  normalized relay envelope the module has consumed since W087).
- **Telnyx Portal** → your Call/Messaging Application → Webhook URL:
  `https://<your-host>/api/webhooks/cellular/telnyx`. Copy the webhook
  signing public key into `CELLULAR_TELNYX_PUBLIC_KEY`.

### Step 3 — register the tenant connection

Through the ordinary product surface (or the v1 API's
`cellular.connections.register`): register the provider account with its
E.164 sending number, e.g. provider `twilio`, providerAccountId
`ACxxxxxxxx…` (the SAME Account SID the env transport delivers for),
phoneNumber `+1555…`, credentialRef → your secret-store reference. The
sending number is tenant CONNECTION data, never env.

### Step 4 — verify

1. **Wiring**: `GET /api/worker` (or any carrier contact) — or simply send a
   test inbound message; on the process's first carrier contact the wiring
   runs. Check for honest failures: an unwired provider's reach fails with
   `provider_unavailable` in the attempt detail — none should remain for a
   fully configured provider.
2. **Carrier edge**: from the Twilio Console's webhook testing tool (or by
   texting the number): the message must appear in the tenant's
   `listCellularReplies` as an `inbound_request` with a conversation turn;
   a forged request (e.g. curl without the signature header) must get 403.
3. **Round trip**: create a reach (`reachAnyone`) to a test number → observe
   `sent` → the carrier's delivery receipt webhook moves it to `delivered`
   → a reply moves it to `replied` (all through the webhook route).
4. **Voice (Twilio)**: force an SMS failure (e.g. an invalid test number with
   voice-permitted policy) → the call leg is placed; the poll + the carrier's
   call-status webhooks refine the attempt.
5. **Health**: `GET /api/health` — the table census must report
   `census: 257` (the new `cellular_inbound_authority` table migrated).

### Rollback

- Remove the env block (or set the values empty) and redeploy: transports
  unwire (honest `provider_unavailable`), the carrier edge fails closed —
  no data is lost; all rows written by the live leg are ordinary cellular
  rows with the module's standard immutability guarantees.
- The migration is forward-only like every module migration (immutable
  history); no W108 migration needs reversal — the new table/columns are
  additive and unused when unwired.

---

## 7. Known limitations (honest)

1. **Single provider account per provider transport (env-level).** The env
   wiring constructs ONE twilio transport (for the configured Account SID)
   and ONE telnyx transport. A tenant whose registered connection carries a
   DIFFERENT provider account id than the env-configured one will still send
   through the env account while its webhook events resolve to its own
   connection — a documented operator contract (register the connection
   with the SAME account id as the env transport). Per-account credential
   routing (the `credentialRef`/secret-store seam) is future work.
2. **Voice legs are synchronous bridges over asynchronous vendors.** The
   frozen `CellularVoiceReceipt` contract forces a synchronous outcome; the
   transports bridge honestly via a bounded poll (default 60 s window, 2 s
   interval, configurable). A voice leg can therefore occupy its worker/
   request for up to the wait window; expiry outcomes are recorded with
   explicit incomplete-observation detail and remain refinable by carrier
   call events. Twilio's poll surface is documented; Telnyx's call-control
   STATE vocabulary is the highest residual shape uncertainty (marked
   shape-verified-only above).
3. **Carrier account→tenant resolution is first-match deterministic.** Two
   tenants registering the same provider account id is a misconfiguration;
   the webhook resolves to the first-registered tenant. A platform-level
   routing table would remove the ambiguity (future work).
4. **Twilio request-level idempotency is not vendor-guaranteed** for
   Messages; the module's at-least-once discipline (guarded status updates,
   event-ledger dedupe) is the correctness boundary (documented in the
   adapter header).
5. **Pump composition frontier**: nothing in production schedules
   `pumpCellularReach` yet (true at base; unchanged by this delivery) — the
   wiring module is process-start-ready and invoked by the carrier edge;
   the pump's production invocation is W112's frontier.
6. **The webhook route signature URL** depends on the deployed host being
   the host the carrier posts to; behind Host-rewriting proxies set
   `CELLULAR_WEBHOOK_PUBLIC_URL` (documented, tested).

## 8. Rollback implications

Additive-only: the frozen contracts gained optional fields/functions; the
single-transport seam, reach/policy/fallback semantics, and every
pre-W108 behavior are unchanged (the pre-existing 71 cellular tests pass
unmodified). Unsetting the env block restores the exact pre-W108 honest
posture. The migration adds a table + columns; no applied migration was
edited (the guard function extension is carried by the NEW 006 file per the
W102 discipline).

## 9. Final disposition

**DELIVERED** — deterministic-composition and vendor-shape layers complete
and green on all gates; the LIVE leg is **ENVIRONMENT-BLOCKED** with the
exact prerequisites recorded above (no credentials exist in any audited
environment; nothing was faked). The manager-inbound W009 authority record
(the W097 deferral) is closed and proven by tests in both audit directions.
