# Implementation Governance

## Roles

**Architect / Reviewer** owns architecture, ADRs, work decomposition, dependency ordering, acceptance evidence and architecture-change decisions.

**Implementer** owns repository inspection, implementation, migrations, tests, verification evidence and PRs. The implementer does not redefine frozen architecture.

## Mandatory behavior

Before every work item:
1. inspect actual repository state;
2. read the applicable architecture lock, ADR and work order;
3. verify dependencies exist in repository state;
4. do not trust previous agent reports as evidence;
5. implement only declared scope;
6. add/update tests;
7. run architecture checks;
8. run relevant integration and behavioral tests;
9. report exact commit/PR plus objective evidence.

## Completion standard

Implemented means code exists, contracts match the frozen architecture, tests pass, architecture checks pass, integration behavior is verified, and evidence is reproducible.

## Architecture change

If implementation finds a genuine conflict:
`IMPLEMENTATION → ARCHITECTURE_CHANGE_REQUIRED → architect review → explicit decision → architecture version update if accepted → revised work item`.

No silent redesign.

## Mandatory security invariants

- tenant isolation is tested at repository and application boundaries;
- source/channel/agent credentials are tenant-scoped and never stored in semantic memory;
- every API/MCP operation carries tenant and principal context;
- high-impact actions are policy-gated;
- employee-impacting findings preserve evidence and uncertainty;
- marketplace submissions cannot bypass platform approval.

## Provider swap evidence

The same provider-independent AI capability must execute through at least two providers/models. The same agent contract must execute through at least two runtime/provider adapters where available. Domain semantics and persisted authoritative state must remain unchanged.
