# provider-sdk — Provider Adapter SDK and OSS Technology Registry (W089)

The shared, provider-agnostic SDK every gateway module uses to standardize its
provider adapters: one lifecycle contract, one error-normalization taxonomy,
one capability/health mapping, one conformance test kit, one hot-swap
evidence format, plus the committed OSS technology registry.

**Purity** (enforced by `bun run arch`): this module imports no provider SDKs,
no `next/*`/`react`, and no other module's contract. It is a leaf. Provider
objects never enter its types.

**Provider selection stays OUTSIDE this module** (W089 acceptance): the SDK
defines what a conforming adapter looks like — never which provider to use.
Routing/policy belong to the owning gateway modules (llm routing, agents
policy, …).

Public surface: `src/modules/provider-sdk/contract.ts` only.

---

## 1. Adapter lifecycle contract

```
registered → discovered → configured → verified → active ⇄ degraded → retired
                (health/capability    (credentials +   (conformance
                 discovery)            configuration)   verified)
```

- `retired` is terminal; every non-retired state may retire.
- Transitions are enforced by `PROVIDER_LIFECYCLE_TRANSITIONS` (the single
  source of truth) and the append-only `ProviderLifecycleTracker`.
- Health (`healthy | degraded | unavailable`) is a **separate axis** derived
  from canonical failures; the lifecycle `degraded` state is for providers
  installed but not currently trusted to serve.
- The owning gateway persists lifecycle/availability state through its own
  tables when it needs durability (the llm module's
  `llm_availability_events` is the precedent); the tracker is the in-memory
  canonical machine.

## 2. Error normalization (§9 failure isolation)

`CANONICAL_FAILURE_SEMANTICS` binds every `CanonicalErrorCategory` to
`retryable` / `recovery` (`automatic | operator | none`) / `healthImpact`
(`degrade | unavailable | none`). `normalizeProviderError(error, ctx)`
normalizes ANY thrown value:

1. the adapter's provider-specific classifier (`classifyError`);
2. the SDK's conservative heuristics (HTTP status fields, `ETIMEDOUT`/
   `ECONNREFUSED`/… codes, `TimeoutError`/`AbortError` names);
3. `unknown_failure` (conservative: operator recovery, unavailable impact).

Provider-native error objects never cross the adapter boundary as themselves.

## 3. The adapter definition template

```ts
import { createProviderAdapterDefinition } from '@/modules/provider-sdk/contract';

const definition = createProviderAdapterDefinition({
  gateway: 'llm',
  provider: 'openai',
  capabilities: ['text-generation', 'embedding'],
  classifyError: (error) => /* provider-native → canonical category, or null */,
});
```

The returned `ProviderAdapterDefinition` (`sdk`, `sdkVersion`, `gateway`,
`provider`, `describeCapabilities()`, `mapError()`) is merged into the
gateway-native adapter object (e.g. the llm module's `LlmAdapter`) — it adds
the canonical SDK surface **without changing the adapter's behavior**.

## 4. Conformance test kit

An adapter's test file proves conformance with ~4 lines of glue:

```ts
import { describe, it } from 'vitest';
import { defineAdapterConformanceSuite } from '@/modules/provider-sdk/contract';

defineAdapterConformanceSuite(
  {
    definition: myAdapter,
    gateway: 'llm',
    errorSpecimens: [ /* provider-native failures → expected categories */ ],
    expectedCapabilities: ['text-generation'],
    hotSwapEvidence: () => buildHotSwapEvidence({ /* from the gateway's verification flow */ }),
  },
  { describe, it },
);
```

The generated checks cover: definition shape/version, capability reporting
(well-formed, deterministic, gateway-expected), lifecycle conformance
(canonical flow, illegal dispatches, retire terminal), error normalization
(specimens, unknown fallback, semantics-table consistency, health mapping)
and hot-swap evidence emission (canonical format, differing providers,
digest, determinism). `collectAdapterConformanceChecks(subject)` returns the
raw checks for non-vitest runners.

## 5. Hot-swap evidence format

`HotSwapEvidenceRecord` (versioned `evidenceVersion: 1`) proves one provider
can replace another for a capability without domain changes:
`requestDigest` (SHA-256 of the canonical request), the two differing
targets with per-target completion, and a **deterministic structural**
`outcome` (`equivalent | completed-divergent | failed`) — semantic judgment
stays with the caller (the llm module's precedent). The owning gateway
persists evidence in its own append-only tables
(`llm_hot_swap_verifications`); `buildHotSwapEvidence` /
`validateHotSwapEvidenceRecord` produce and check the canonical record.

## 6. OSS technology registry

- **Data**: `registry/technologies.json` — versioned
  (`registryVersion: 1`), committed, git-reviewable. Seeded from
  `spec/TECHNOLOGY-RESEARCH-2026-09-23.md` with **strict provenance**: fields
  the research record did not assess are `null`/`unknown` (never invented),
  and every entry cites its `sources`.
- **Why JSON, not a SQL table**: registry entries are platform reference
  data, not tenant data (every domain table must carry `tenant_id` — arch
  rule (d)); the llm module's code-owned registry is the precedent. JSON
  gives the Tech Lead reviewable diffs and avoids touching the shared
  `scripts/arch-allowlist.json`.
- **Schema** (validated at load and by tests; see `registry.ts` types):

  | Field | Meaning |
  |---|---|
  | `entryId` | stable kebab-case slug |
  | `capability` | capability family evaluated for |
  | `technology` / `summary` | provider/project + what it solves |
  | `priority` | `P0/P1/P2` from the research record; `null` for adopted/unranked |
  | `license` | `{ spdx, source, notes }` |
  | `security` | `{ posture, notes }` |
  | `maintenance` | `{ health, notes }` |
  | `operations` | `{ fit, deployment, notes }` |
  | `dataHandling` / `costPerformance` | `{ summary, notes }` |
  | `failureModes` | known failure modes (array) |
  | `exitStrategy` | `{ replacementPath, notes }` |
  | `adapterStatus` | `adopted / adapter-planned / candidate / monitoring / rejected` |
  | `adapterModule` | repository path of the implementing adapter (null when none yet) |
  | `lastReviewed` / `reviewedBy` / `sources` | review provenance |

- **Queries** (contract + CLI): `listTechnologyEntries`,
  `findTechnologyEntry`, `listTechnologyEntriesByCapability`,
  `listTechnologyEntriesByPriority`, `listTechnologyEntriesByAdapterStatus`,
  `listTechnologyCapabilities`, `technologyRegistryReviewSummary` (counts +
  the §15 due-diligence backlog).
- **CLI review** (Tech Lead): `bun scripts/technology-registry.ts` (options:
  `--capability <c>`, `--status <s>`, `--priority <p>`, `--entry <id>`,
  `--summary`).
- **Adding/updating an entry**: edit `registry/technologies.json`, keep the
  schema valid (load-time validation fails loudly otherwise), cite sources,
  and let the change ride a reviewable commit. Work items adopting a
  technology must complete its `null`/`unknown` §15 fields before their
  adapter merges.
- **Communication-neutrality** (Wave-0 reconciliation): entries record
  evaluated technologies without presupposing any communication-kernel
  technology; the CommOS fusion section of the research record is therefore
  not seeded as an entry.

## 7. Proven conformance (the two-provider proof)

The llm gateway's `openai` and `anthropic` adapters implement
`ProviderAdapterDefinition` (behavior unchanged; existing llm suites stay
green) and pass the full conformance suite in
`src/modules/llm/tests/llm-adapter-sdk-conformance.test.ts`, including
hot-swap evidence built from a real `verifyProviderHotSwap` run. A third
adapter creatable from the kit alone is demonstrated in
`src/modules/provider-sdk/tests/` (example gateway with two providers built
purely from the template).
