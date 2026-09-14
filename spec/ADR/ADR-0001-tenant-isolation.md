# ADR-0001 — Tenant Isolation and Workspace Authority

**Status:** Accepted

Aurum is a multi-tenant company workspace. Tenant identity is mandatory context for every business operation and every information-bearing record. Workspaces do not replace tenant isolation; they partition tenant experience.

All aggregates must be directly tenant-owned or reachable only through an immutable tenant-owned parent. Authorization checks happen before retrieval and mutation. Background jobs preserve tenant context. Search, embeddings, object storage, caches and queues are tenant-aware.

Rejected: relying only on UI filtering or shared search indexes without tenant constraints.
