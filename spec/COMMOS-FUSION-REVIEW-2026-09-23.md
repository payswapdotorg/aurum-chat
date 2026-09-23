# Aurum + Universal Comm OS Fusion Review — 2026-09-23

**Repositories reviewed:** `payswapdotorg/aurum-chat` and `payswapdotorg/commos`  
**Aurum main reviewed:** `c43193b3a6ae1b1275a2dd8f78936f54a165b6c9`  
**CommOS main reviewed:** `9d1f24250e5037cb49b3499794c158f09caf4398`  
**Decision status:** APPROVED DIRECTION — use one product, with CommOS fused as the communications substrate.

## Executive decision

Do **not** build Aurum and CommOS as two end-user products.

Make **Aurum** the single product and organizational employee. Make **Universal Comm OS** the communications substrate that Aurum uses to reach people and route communication across channels, gateways, edge nodes and future offline transports.

Conceptually:

`Aurum intent → identity → authorized communication → CommOS routing → transport/gateway → delivery evidence → Aurum conversation/evidence`

The communications substrate must remain below Aurum's organizational intelligence semantics. It must not become a second CompanyModel, policy system, employee directory or cognition engine.

## Why the fusion is unusually strong

CommOS already implements or specifies a set of primitives that Aurum would otherwise have to recreate:

- Universal Identity and channel identity links;
- identity verification state machine;
- communication intent;
- encrypted CommunicationBundle;
- delivery state machine and delivery evidence/proofs;
- capability advertisements/cache;
- policy-aware routing;
- relay/gateway abstraction;
- transport interface;
- persistent bundle store / DTN concepts;
- gateway adapters;
- Android runtime foundation;
- edge process-death recovery concepts;
- multi-hop and store-and-forward architecture.

Aurum already owns or implements the adjacent organizational semantics:

- Person/Employee and tenant identity;
- organizational goals and desired state;
- CompanyModel and organizational memory;
- evidence and epistemics;
- learning missions;
- source/destination gateways;
- action authority;
- notifications and briefings;
- cognitive orchestration;
- management control tower;
- agent/extension workforce;
- provider routing/BYOA;
- chat UX.

These are complementary rather than competing responsibilities.

## Direct mapping

| CommOS | Aurum destination | Fusion decision |
|---|---|---|
| UniversalIdentity | W002 Identity / people | Reuse concept; Aurum remains tenant authority |
| ChannelIdentity / identity links | W002 + W045 | Reuse state machine and proof ideas |
| Intent | W009 + W029/W030 + cognition | Map to Aurum intent/action request; transport remains below |
| CommunicationBundle | W029/W030 + event/evidence envelope | Reuse as transport envelope, adapt for Aurum references |
| DeliveryTracker | W030/W031 + W046 | Reuse canonical delivery semantics |
| Capability advertisement/cache | W030 + routing infrastructure | Reuse for communication reachability |
| RoutingPolicy/Router | W009 + W030 | Reuse routing algorithm as transport-level implementation |
| Trust/CryptoEnvelope/Proof | W045/W046 + channel security | Reuse after security/licensing review |
| Transport interface | W030 | Reuse as internal transport port |
| GatewayRuntime | W030/W036/W037 | Adapt into Aurum gateways |
| SMS/Email/WhatsApp adapters | W030 | Reuse structures/tests, replace experimental sinks with real provider adapters |
| DTN persistent store / relay | W030 + W088 | Reuse for edge/offline communication |
| Android edge runtime | W086/W087/W088 | Reuse after validation; do not rewrite from scratch |
| Matrix | W030 optional | Adapter only; do not make core dependency |
| CommOS web consumer UI | Aurum Chat | Do not merge as a second UI; Aurum UI remains canonical |
| CommOS AI intent/summarization | Aurum cognition | Do not adopt as a second AI brain; Aurum cognition remains authoritative |
| CommOS analytics/routing dashboard | Aurum Control Tower | Port useful delivery observability into Aurum surfaces |
| CommOS business-platform CRM/billing placeholders | Aurum platform | Do not duplicate; Aurum owns these concerns |

## Reuse level

### High-value direct reuse

The most reusable portion is the lower communication stack: identity-link semantics, encrypted bundle/proof envelope, delivery state machine, capability model, routing/transport interfaces, gateway boundary, DTN/store-and-forward concepts and Android edge runtime foundations.

### Adaptation required

CommOS currently has a separate server runtime, database persistence and demo network model. Aurum must not import that as a second application runtime.

Instead:

`CommOS core protocol → Aurum communication kernel adapter`

Provider adapters must be moved behind Aurum's provider isolation rules. CommOS's current SMS/Email/WhatsApp adapters are explicitly experimental in-process transcripts and are not evidence of real external delivery.

### Keep out of Aurum core

Do not import CommOS's demo/network UI, its application-level singleton network, its separate auth/user model, its AI intent interpretation, or its deferred business platform features as parallel subsystems.

## Critical repo findings

CommOS roadmap currently marks P1 universal protocol, P2 local loopback, P3 DTN, P5 multi-hop capability gossip, P6 Internet gateway, P8 Email/SMS/WhatsApp experimental adapters, P9 intelligent routing, P10 identity graph and P11 inbox as implemented/validated at various levels.

CommOS P4 Android edge is **not fully validated**: its worklog states P4.1-B source is implemented but validation is still in progress, and P4.2 BLE remains blocked. Therefore the fusion plan must reuse these assets without claiming BLE/Wi-Fi Direct production capability before fresh physical-device evidence.

CommOS P7 Matrix is not implemented. It remains optional.

CommOS has no root LICENSE/README file visible in the reviewed repository. Because both repositories are user-owned, internal code transfer is feasible operationally, but any external distribution of the extracted protocol library requires an explicit licensing decision before publication.

## Offline communication consequence

The manager/secretary scenario is now covered by a concrete transport hierarchy:

`Aurum request → verified employee identity → best permitted route → Aurum/Internet channel → SMS/voice cellular fallback → local/edge transport when available → DTN store-and-forward where applicable`

A completely disconnected recipient does not need Internet or Aurum if their phone is reachable through the cellular network.

Where there is no cellular service, no local network and no peer radio path, the system must report that no communication path exists.

## Product boundary

Aurum remains responsible for:

- what the user wants;
- who the organization believes the recipient is;
- whether communication is allowed;
- why the communication matters;
- organizational context;
- policy and approvals;
- conversation and evidence;
- learning from communication outcomes.

CommOS is responsible for:

- how a permitted communication is represented safely;
- identity-link evidence at the communications boundary;
- routing;
- transport capabilities;
- encryption envelope/proofs;
- delivery state;
- relays/gateways;
- offline/edge transport behavior.

## Fusion implementation strategy

Do not copy the whole CommOS repository into Aurum.

Perform a staged extraction:

1. Freeze the target CommOS protocol contracts and record exact source SHAs.
2. Create an Aurum-owned `communication-kernel` adapter package or module boundary.
3. Port/reuse only provider-neutral protocol primitives first.
4. Rewire persistence to Aurum's PostgreSQL/domain ownership.
5. Rewire identity links to Aurum Person/Employee/ExternalIdentity while preserving CommOS verification semantics.
6. Rewire communication bundles to Aurum conversations/events/evidence.
7. Reuse delivery state and proofs as communication evidence.
8. Bring SMS/voice first for cellular Reach Anyone, then meeting/social channels.
9. Bring Android/edge runtime after actual-device validation.
10. Make Matrix one optional adapter.
11. Keep CommOS as an upstream/reference repository until extraction is proven; then archive/de-emphasize the duplicate consumer application rather than maintaining two products.

## Non-negotiable fusion gates

- No duplicated employee/person identity authority.
- No duplicated authorization policy authority.
- No duplicated organizational conversation truth.
- No provider SDK leakage into Aurum domain contracts.
- No CommOS demo fallback in production.
- No claim of BLE/Wi-Fi Direct support without physical-device evidence.
- No Matrix dependency in Aurum core.
- No second AI cognition loop.
- No second billing system.
- No second analytics truth store.

## Final recommendation

**Fuse the projects at the product level and subsystem level.**

One product:

**Aurum — organizational intelligence employee**

One communications substrate inside it:

**Universal Comm OS — provider/transport/routing/edge communication kernel**

Keep `payswapdotorg/commos` temporarily as the upstream/reference source while the validated protocol subset is extracted into Aurum. The long-term repository topology can later be decided based on whether the protocol is released as a reusable library; this is a packaging decision, not a reason to maintain two end-user products.