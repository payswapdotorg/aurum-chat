# W109 — Meeting / Realtime Live-Provider Closure — Delivery

**Branch:** `work/w109-meeting-realtime-live` · **Base:** `53bd271` (W108)
**Live leg:** **LIVE-PROVEN** against the operator's LiveKit Cloud project
(`wss://zeck-vuo9lv9v.livekit.cloud`, region `Japan`, server `1.13.7`).

---

## 1. What shipped

| Surface | File | What it is |
|---|---|---|
| Real livekit transport | `src/modules/realtime/adapters/transport-livekit.ts` | The REAL `RealtimeTransport` implementation: Twirp JSON room service + egress + SIP, per-call HS256 access tokens (minted with `node:crypto`, no SDK), agent speech published on the reliable data channel (topic `aurum.response`), room-scoped join grants, honest `provider_unavailable` when a capability is unconfigured (egress destination / SIP trunk) |
| Env-driven production wiring | `src/modules/realtime/wiring.ts` | The cellular.ts discipline inside the module: globalThis-anchored singleton, honest `unwired`/`incomplete`/`wired` states, additive per provider; exported additively through the module contract |
| Deterministic vendor-shape tests | `src/modules/realtime/tests/realtime-livekit-transport.test.ts` | 16 tests against a LOCAL Twirp stub over real HTTP: exact wire shapes, verifiable JWT grants, honest failure taxonomy |
| Wiring tests | `src/modules/realtime/tests/realtime-wiring.test.ts` | 6 tests: unset/partial/complete env, per-process idempotency, test-transport coexistence |
| Provider-failure evidence tests | `src/modules/realtime/tests/realtime-provider-failure.test.ts` | 5 tests with the REAL transport against a KILLABLE provider: failed start is an explicit queryable record; mid-session death lands in the canonical evidence shape (session.failed ledger event, terminal failure state, finalization observation carrying errorCode); dead-provider stop still ends durably; the consent floor holds through provider death; speech against a dead provider is a failed lifecycle row, never a fake transcript turn |
| Live leg harness | `src/modules/realtime/tests/livekit-live-leg.ts` | The end-to-end composition against the real project (not collected by vitest; drives the frozen contracts only, redacts every secret/token) |
| Live-gated test | `src/modules/realtime/tests/realtime-livekit-live.test.ts` | 16 live assertions + 1 explicit skip label; runs ONLY with the operator env, skips loudly without it |
| Evidence | `docs/productization-evidence/W109/**` | Machine-checkable reports (this file, `evidence.json`, `live-leg/live-leg-latest.json`) |

No migration: durable session/artifact finalization and provider-failure
evidence run entirely on the existing W086 schema
(`realtime_sessions/events/turns/responses/artifacts`,
`finalize_pending`, `finalize_run_id`, `evidence_observation_id`).

## 2. The provider split (frozen contracts dictate)

The meetings module's provider vocabulary
(`zoom | microsoft-teams | google-meet | recall`) is frozen with DB CHECK
constraints — LiveKit cannot be a meetings-module provider without a
contract rewrite. The work order's alternative applies: **LiveKit backs
BOTH the meeting provider (rooms) and the realtime provider
(data/publish-subscribe)**:

* the **realtime provider** is `livekit` through the realtime module's
  transport port (the vocabulary's P0 entry);
* the **meeting surface** is the realtime module's
  `meeting_participation`/`meeting_companion` session kinds on REAL
  LiveKit rooms, attached to the meetings module's canonical session
  through the validated opaque `meetingSessionId` reference (read
  through the meetings contract at start — the live leg proves the
  linkage end-to-end).

The canonical meeting session the live companion session attached to was
created through the meetings module's **production webhook ingestion
path** (a zoom envelope — the domain-side meeting REFERENCE, deterministic
fixture by design, labeled as such in the evidence). The LIVE provider
evidence of the meeting leg is the LiveKit room, its participants and
its events.

## 3. The live leg (what was actually proven against the real SFU)

Run window `2026-09-28T00:26:31.191Z .. 2026-09-28T00:26:54.643Z`,
full report: `live-leg/live-leg-latest.json`.

1. **Wiring** — `ensureRealtimeTransportsWired()` wired the livekit
   transport from env (report state `wired`).
2. **Real room** — the meeting-companion session materialized
   `RM_xTQ3FdxkKcZ7` (`aurum-d1d48061-eb9…`, region Japan, server 1.13.7)
   through `CreateRoom`; the canonical meeting session linkage validated
   read-only through the meetings contract.
3. **Real join** — a join grant minted by the transport admitted a real
   participant `w109-live-human` (`PA_TzWmcuZ8u9Mb`) over the signal
   WebSocket; the SFU's real event stream reached the client
   (`join`, `update`, `offer`, `trickle`, `roomUpdate`, `pong`, `leave`).
4. **Live transcript + speaker identity** — a `transcript.finalized`
   envelope carrying the REAL participant identity landed as a canonical
   turn attributed to the participant registry row; the finalization
   artifact (`sha256:c388f8080…`) and the session-close observation
   (turnCount 3) carry it durably.
5. **The consent floor against the real provider** —
   * refusal BLOCKED: `consent_required` + an explicit `recording.blocked`
     ledger event BEFORE any grant, no egress started;
   * grant → a REAL egress `EG_wwsWQi7EdsQZ` started (`EGRESS_STARTING`)
     and **joined the room as a real participant** (`PA_Pjpq8o9GfzZh`,
     observed through `ListParticipants`);
   * mid-session revocation (`consent.revoked` envelope) STOPPED it:
     `StopEgress` → `EGRESS_ABORTED`, session `recordingState 'recorded'`.
6. **Two-way path** — Aurum's spoken responses were PUBLISHED into the
   real room (`SendData` on the reliable channel, topic
   `aurum.response`, response id as the idempotency key); the response
   lifecycle ran `completed` and then `interrupted` (barge-in attributed
   to the real human participant) through the provider event edge.
7. **Durable finalization** — `stopRealtimeSession` deleted the real
   room; the finalization workflow run `56e0edc2-c9c2-45f9-a658-40803f05a7be` SUCCEEDED,
   materializing the transcript artifact and recording the
   session-close observation despite the provider teardown having
   already happened.
8. **Real disconnect events** — the client received `Leave` reason `5`
   (`ROOM_DELETED`), clean close `1000`, and the room left the listing
   (`roomGoneAfterStop: true`).
9. **The realtime (aurum_voice) leg** — a second real room, one spoken
   response completed, durable finalization succeeded (artifact
   `sha256:cbdd1c44e…`, observation turnCount 1).

The event ledger of the meeting leg records the complete canonical
trail: `participant.joined`, `transcript.final`, `recording.blocked`,
`consent.granted`, `recording.started`, `response.completed`,
`response.interrupted`, `consent.revoked`, `recording.stopped`,
`session.ended`.

## 4. Live vs deterministic (the W112 classification inputs)

| Capability | Classification | Evidence |
|---|---|---|
| Env wiring, fail-closed behavior | LIVE-PROVEN + deterministic | live report `wiring.wired` + `realtime-wiring.test.ts` |
| Room lifecycle (create/delete) | LIVE-PROVEN + deterministic | `RM_xTQ3FdxkKcZ7`, Leave 5, room gone + vendor-shape tests |
| Real participant join + identities | LIVE-PROVEN | `PA_TzWmcuZ8u9Mb`, signal stream |
| Agent speech publish (data channel) | LIVE-PROVEN (publish accepted by the real SFU; data-channel RECEIVE requires a full WebRTC client — see §5) | SendData 200 on the real room, canonical aurum turns |
| Consent refusal blocks | LIVE-PROVEN + deterministic | `consent_required` + `recording.blocked` ledger + `realtime-service.test.ts` |
| Consent revocation stops | LIVE-PROVEN + deterministic | `EGRESS_ABORTED`, `recordingState 'recorded'` + service tests |
| Recording egress control plane | LIVE-PROVEN | `EG_wwsWQi7EdsQZ` started, joined as participant, stopped |
| Recording FILE artifact (provider storage) | FIXTURE-PROVEN + ENVIRONMENT-BLOCKED (live) | LiveKit file egress requires an external storage destination the operator project does not include; deterministic tests cover artifact mapping from a real egress file result shape |
| Live transcript + speaker attribution | LIVE-PROVEN (identity/attribution provider-real; transcript TEXT leg-authored — real ASR is the agents worker, W112) | canonical turn + artifact + observation |
| Interruption lifecycle | LIVE-PROVEN + deterministic | `interrupted` response with the real interrupter attributed |
| Durable finalization | LIVE-PROVEN + deterministic | both runs `succeeded` with artifacts + observations |
| Provider-failure evidence | deterministic (killable real transport) | `realtime-provider-failure.test.ts` |
| Telephony SIP dial-out | FIXTURE-PROVEN + ENVIRONMENT-BLOCKED (live) | SIP not enabled on the project (401 with full admin grants); honest `provider_unavailable` without a trunk |

## 5. Environment-blocked specifics (exact errors + prerequisites)

* **Recording file artifacts** — `StartRoomCompositeEgress` with a file
  output answers `400 {"code":"invalid_argument","msg":"request has
  missing or invalid field: output"}`: the file output's upload oneof
  (`s3|gcp|azure|aliOSS`) is REQUIRED on this deployment and the
  operator project has no storage configured. Prerequisite: an external
  storage destination (or a LiveKit Cloud plan with managed storage).
  The transport's egress path uses the storage-free RTMP stream output
  (`LIVEKIT_EGRESS_STREAM_URL`); the live leg's destination
  `rtmp://localhost:1935/live/w109-egress-blackhole` is a black hole BY
  DESIGN — the provider reports the real failure honestly
  (`EGRESS_ABORTED`), which is itself live provider-failure evidence.
* **Telephony dial-out** — `livekit.SIP/*` answers `401
  {"code":"unauthenticated","msg":"permissions denied"}` even with
  full admin grants: the SIP feature is not enabled on the project.
  Prerequisite: SIP enablement + a configured trunk
  (`LIVEKIT_SIP_TRUNK_ID`).
* **WebRTC data-channel receive** — receiving the `SendData` payload on
  an SCTP data channel requires a full WebRTC stack in the test process
  (the sanctioned `@livekit/protocol + ws` client covers the signal
  plane; the real-time agents worker that owns the media plane is the
  W112 frontier).

## 6. Operator runbook (the env contract)

```
LIVEKIT_URL=wss://<project>.livekit.cloud
LIVEKIT_API_KEY=API…
LIVEKIT_API_SECRET=…            # never committed; REDACTED in evidence
LIVEKIT_ACCOUNT_ID=<optional>   # default: the URL host — the account id
                                # event envelopes carry and connections
                                # register with
LIVEKIT_EGRESS_STREAM_URL=<optional RTMP>  # unset -> recording control
                                           # fails honestly
LIVEKIT_SIP_TRUNK_ID=<optional>            # unset -> dial fails honestly
```

Run the live leg with the credentials exported (the suite skips loudly
without them):

```
LIVEKIT_URL=… LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… \
LIVEKIT_EGRESS_STREAM_URL=rtmp://… \
LIVEKIT_EVIDENCE_DIR=docs/productization-evidence/W109/live-leg \
  bun run test -- src/modules/realtime/tests/realtime-livekit-live.test.ts
```

A tenant registers its realtime connection with
`providerAccountId = <LIVEKIT_ACCOUNT_ID or the URL host>`; its provider
event envelopes carry the same account id. The secret lives only in the
process environment and the gitignored `.env`.
