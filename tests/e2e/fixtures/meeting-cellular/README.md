# W097 — Meeting and Cellular End-to-End Fixture

The machine-readable fixture that drives
`tests/e2e/journeys/meeting-cellular.e2e.test.ts`. The journey test loads
this file, materializes each scenario's world through the REAL module
contracts (meetings W085, realtime W086, cellular W087, unified-identity
W095, identity/people W002, actions W009, notifications W031,
conversations W029, observations W004, workflow W080) against the
embedded PostgreSQL (PGlite `:memory:`), executes each scenario's script
step by step, and asserts the durable records at every hop.

## Schema identity

* `schema`: `aurum.meeting-cellular-fixture`
* `version`: `1`

The fixture file carries both fields; the test refuses to run a file
whose `schema`/`version` it does not implement (the schema is versioned —
a future incompatible change bumps `version` and ships a new interpreter,
never a silent redefinition).

## Provider doubles (contract-faithful, deterministic)

No live telephony or meeting-provider credentials exist in this
environment, so every live path stays fixture-covered (environment
dependent — see the delivery report). The doubles are:

* **meetings** — raw **zoom webhook envelopes** in the documented adapter
  shape (`src/modules/meetings/adapters/zoom.ts` header), fed through the
  real `receiveMeetingWebhook` edge: the module's private zoom adapter
  parses them.
* **realtime** — raw **livekit event envelopes** in the documented adapter
  shape (`src/modules/realtime/adapters/livekit.ts` header), fed through
  the real `receiveRealtimeEvent` edge, plus a scripted
  `RealtimeTransport` implementing the provider-neutral transport port
  (`setRealtimeTransport`).
* **cellular** — raw **twilio carrier envelopes** in the documented
  adapter shape (`src/modules/cellular/adapters/twilio.ts` header), fed
  through the real `receiveCellularEvent` edge, plus a scripted
  `CellularTransport` implementing the provider-neutral delivery port
  (`setCellularTransport`).

No mock of the interpreter's own invention is asserted against: every
assertion reads durable state through a module contract, and every
provider artifact is an envelope the corresponding adapter documents.

## Scenario shape

```
{
  "id": "<unique scenario id>",
  "proves": "<what the scenario proves, in one sentence>",
  "deferred": [ { "note": "...", "missingContract": "..." } ],   // optional
  "world": {
    "people": [
      { "key": "sarah", "fullName": "Sarah Chen",
        "employee": { "title": "...", "department": "..." } | null,
        "verifiedIdentities": [
          { "provider": "email|sms|voice", "providerAccountId": "...", "evidence": "..." }
        ] }
    ],
    "connections": {
      "meetings":  { "provider": "zoom", ... } | null,
      "realtime":  { "provider": "livekit", ... } | null,
      "cellular":  { "provider": "twilio", "phoneNumber": "+1555...", ... } | null
    },
    "cellularPolicy": { "voiceFallback": "...", "smsMaxAttempts": N, ... } | null,
    "authorityPolicy": { ... } | null
  },
  "baseTime": "<ISO 8601 — the scenario's service clock start>",
  "script": [ <step>... ],
  "final": [ <assertion>... ]
}
```

Every scenario runs in its OWN freshly minted tenant, so registry counts
and trail assertions stay deterministic.

## Script steps

| op | meaning |
| --- | --- |
| `ingestMeeting` | feed `payload` (raw zoom envelope) through `receiveMeetingWebhook`; `bindSession` binds the canonical meeting session created by the envelope's `session.id` |
| `ingestRealtime` | feed `payload` (raw livekit envelope, `$ref`-resolved) through `receiveRealtimeEvent` |
| `ingestCellular` | feed `payload` (raw twilio envelope, `$ref`-resolved) through `receiveCellularEvent` |
| `startCompanion` | `startRealtimeSession` with kind `meeting_companion` + the bound canonical meeting session reference (read-only through the meetings contract); binds the session and its provider room |
| `recordConsent` | `recordRealtimeConsent` (the domain consent path) for the participant identified by provider participant id |
| `startRecording` / `stopRecording` | the explicit recording controls |
| `speak` | `speakRealtimeResponse` (binds the spoken response id) |
| `stopSession` | `stopRealtimeSession` (durable end + finalization run) |
| `finalize` | drive the W080 finalization workflow to a terminal state through a fresh engine |
| `reach` | `reachAnyone` — the outcome-oriented ask (`person` key or raw `phoneNumber`); binds the reach request |
| `pump` | `pumpCellularReach` — the worker seam |
| `retryReach` | `retryCellularReach` |
| `elapse` | advance the deterministic service clock |
| `providerScript` | flip the deterministic transport double's outcomes / recording artifact |
| `unwireCellular` / `rewireCellular` | remove / restore the wired cellular transport (the provider_unavailable path) |
| `unifyMeetings` / `unifyRealtime` | the W095 unification passes |
| `setAuthorityPolicy` | `setAuthorityPolicy` on the actions contract (the tenant's consent/policy control) |
| `decideApproval` | `decideApproval` on a bound reach's action request |
| `assert` | evaluate `expect` assertions only |

Each step may carry `expect` (assertions evaluated immediately after the
step — durable records at every hop) and `expectError` (the op must throw
a typed error with that `code`).

### `$ref` tokens inside payloads

Provider envelopes reference runtime-minted values symbolically:

* `{"$ref": "room", "key": "<sessionKey>"}` — the provider room of a bound realtime session
* `{"$ref": "response", "key": "<responseKey>"}` — a bound spoken response id
* `{"$ref": "smsMessageId", "n": N}` — the provider message id of the N-th accepted SMS send
* `{"$ref": "callId", "n": N}` — the provider call id of the N-th placed voice call

## Assertions

| kind | proves |
| --- | --- |
| `transportSends` | exactly how many SMS/voice envelopes the provider double carried (nothing sent is `0`) |
| `selfContainedEnvelopes` | every recorded outbound envelope on the given legs is a plain PSTN message — E.164 addresses, plain text, no URL/deep-link/app reference: the recipient needs neither Aurum nor Internet |
| `reach` | the durable reach request's fields (status, failure code, recipient kind, action kind, policy snapshot, timestamps) |
| `attempts` | the append-only attempt audit (legs + statuses, provider acks on delivered legs) |
| `replies` | the inbound record (reply/manager request, channel, person attribution, reach correlation, text) |
| `replyInTranscript` | the reply continuity proof: the message exists in the canonical conversations transcript attributed to the person |
| `actionRequest` | the authority-gate record of a reach (status, evaluation outcome, the append-only decision trail — the auditable refusal with its policy reason) |
| `notifications` | W031 failure/blocking visibility (`kindOf` selects the notification kind) |
| `meetings` | the canonical meeting registry counts (meetings/sessions/transcripts/artifacts/access events/participants) |
| `observations` | the immutable W004 evidence kinds captured for a channel |
| `realtimeSession` | the companion session's durable state (status, end reason, recording state, evidence observation, artifact kinds) |
| `realtimeTurns` | attributed live-transcript turns and spoken Aurum responses |
| `realtimeEvents` | the append-only realtime event ledger (blocked recordings, consent grants/revocations, …) — `eventKind` selects the event |
| `cellularEvents` | the provider-event ledger kinds |
| `unifySummary` | a W095 unification pass's counters |
| `unifiedResolution` | W095 recognition of a (modality, provider, account) key — `resolved` to a person, or honestly `unverified`/`unknown_identity` |
| `unifiedProfile` | a person's verified reach across modalities (`verifiedModalityCount` is the W095 acceptance number) |
| `ambiguities` | the open/resolved ambiguity ledger with its candidate persons |
| `foreignInvisible` | the tenant-isolation dimension: a foreign tenant sees the bound records as uniformly not-found |

## Scenarios

1. **golden-journey** — transcript/artifact ingestion → Meeting Companion
   (consented recording, spoken response, durable finalization) → SMS
   fallback (delivery + reply continuity) → voice fallback (spoken reply)
   → W095 recognition at every modality hop (one person, five
   modalities: messaging, sms, voice, meeting, realtime — the same E.164
   is a verified SMS row AND a verified voice row, per-modality proof of
   one organizational identity).
2. **consent-and-policy-refusal** — consent absent → blocked (nothing
   sent, auditable refusal + notification); granted → sends; revoked →
   blocked again; realtime consent floor (refused recording → blocked
   event; mid-recording revocation → stop).
3. **manager-originated** — a manager with no usable Internet data texts
   and calls Aurum's own number; both requests return into Aurum with
   attribution and land as canonical conversation turns. The
   authority-gate record for inbound requests is DEFERRED (see the
   scenario's `deferred` entry — the exact missing contract).
4. **provider-failure** — honest degradation: explicit meeting access
   failure (event + observation), provider-side companion failure (failed
   session still finalizes), unwired cellular transport
   (`provider_unavailable`, retryable), unanswered voice fallback
   (`voice_no_answer` + failure notification).
5. **ambiguous-identity** — the W095 rule in-chain: a companion
   participant whose facets disagree stays external/unverified with an
   OPEN ambiguity; never auto-merged; verified per-channel rows keep
   resolving their own person.
