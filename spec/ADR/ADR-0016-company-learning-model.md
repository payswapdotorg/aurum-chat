# ADR-0016 — Company Learning Model

## Status

Accepted

## Decision

Aurum maintains a versioned `CompanyModel` representing what it has learned about a specific tenant beyond raw memories. The CompanyModel is derived from evidence, outcomes and validated interactions and is never authoritative merely because it was learned.

The model contains provider-independent, auditable knowledge about:

- company vocabulary and semantic conventions;
- organizational structure and role relationships;
- process patterns and documented-versus-observed exceptions;
- source reliability and freshness characteristics;
- employee expertise and transactive-memory signals;
- capability patterns and known capability gaps;
- goal interpretation and priority patterns;
- investigation/source-selection preferences;
- intervention effectiveness priors;
- recurring organizational norms and exceptions.

Each learned assertion has provenance, confidence, validity interval and learning/version metadata. Explicit policy remains authoritative over learned preference.

## Learning invariant

A completed project or intervention may improve future behavior only through a recorded learning update linked to evidence and outcome. The learning update must identify what changed and why.

## Consequences

- Organizational learning becomes durable company-specific state rather than generic chat personalization.
- Future missions can become cheaper, faster and better targeted as the CompanyModel improves.
- Learned source/person/intervention reliability can be evaluated independently of business truth.
- CompanyModel state must survive model/provider replacement.

## Required verification

A longitudinal fixture must show that repeated work on the same synthetic company causes measurable improvement in source selection, unknown resolution efficiency or intervention recommendation quality without changing the explicit policy.
