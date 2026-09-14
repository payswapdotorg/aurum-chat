# Module Dependency Map

## Rules

- Modules expose contracts; consumers cannot import internals.
- Every business object is tenant-scoped.
- Provider SDKs are adapter-private.
- Redis is never a source of truth.
- UI/API/MCP cannot access repositories or persistence internals directly.
- LLM output cannot become authoritative truth without domain validation.

## Layers

### L0 Foundation
`auth`, `organizations`, `identity`, `audit`, `events`

### L1 Reality / Evidence
`people`, `world`, `observations`, `sources`, `destinations`, `memory`, `freshness`

### L2 Epistemics / Direction
`epistemics`, `goals`, `attention`, `investigation`, `missions`, `knowledge-acquisition`, `cognition`

### L3 Organizational Intelligence
`environment`, `opportunities`, `presence`, `processes`, `capabilities`, `automation`, `workforce`, `suppliers`

### L4 Capability Workforce
`actions`, `agents`, `extensions`, `marketplace`

### L5 Learning / Incentives
`learning`, `rewards`

### L6 Human Experience
`conversations`, `channels`, `notifications`, `briefings`

### L7 External Product Surfaces
`api`, `mcp`

## Critical dependencies

```text
organizations → identity → people
organizations → world → observations
sources → observations
channels → identity → conversations → observations
observations → memory → epistemics
world + epistemics → missions
missions + identity + sources → knowledge-acquisition
world + goals + epistemics + missions → cognition
goals + world + cognition → environment/opportunities/processes/capabilities/workforce
processes + capabilities → automation
actions + llm → agents
agents + extensions → marketplace
knowledge-acquisition → learning → rewards
cognition + actions → notifications/briefings
all application contracts → api/mcp
```

## Provider boundaries

- `sources` owns source connector adapters.
- `destinations` owns output/destination adapters.
- `channels` owns communication providers.
- `llm` owns AI/LLM providers.
- `agents` owns agent runtime providers.
- `marketplace` owns package catalog/review/install governance.

No domain module may depend on provider-specific identity types, message types, model objects or runtime state.
