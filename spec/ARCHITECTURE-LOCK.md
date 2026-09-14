# Aurum Architecture Lock

**Lock version:** 2.1
**Status:** FROZEN

1. Aurum is an organizational intelligence employee, not a chatbot product.
2. The company intelligence loop is the product core; chat is a channel.
3. Every business datum is tenant-scoped.
4. Company and external environment share provenance-aware world-model semantics.
5. Events and observations are immutable.
6. Claims, beliefs, hypotheses and unknowns are distinct.
7. Unknown is first-class.
8. LearningMission is first-class and is goal/decision-driven.
9. Employees are first-class knowledge sources; useful knowledge contributions may be rewarded under explicit policy.
10. LLM output is never authoritative merely because an LLM generated it.
11. Consequential beliefs have provenance and freshness metadata.
12. Contradictory evidence is retained.
13. Goals and desired states are distinct from beliefs and attention policy.
14. Learning cannot silently override explicit policy.
15. Identity resolution must prevent channel accounts from becoming disconnected pseudo-employees.
16. Channel providers cannot leak provider-specific objects into domain contracts.
17. Knowledge Acquisition Planner decides where to investigate next; it does not blindly query all sources.
18. EnvironmentWatch and Opportunity are first-class concepts.
19. Process intelligence can create explicit AutomationOpportunity findings.
20. Workforce intelligence must represent alternative explanations and alternatives before employment-impacting recommendations.
21. Aurum never autonomously terminates human employees.
22. Agent and AgentTeam are organizational actors with explicit contracts, budgets, permissions and outcomes.
23. Agent recruitment and termination obey policy/approval.
24. Agent providers/runtimes are hidden behind the Agent Gateway.
25. Extensions are general software capabilities, not a fixed product-feature catalog.
26. Marketplace publication and tenant installation/activation are separate states.
27. Third-party marketplace packages remain pending until platform approval.
28. AI/LLM providers are accessed only through the LLM Gateway.
29. Tenants may BYOA through explicit AIProviderAccount and agent/provider account boundaries.
30. No provider/model is architecturally privileged.
31. API and MCP expose application capabilities, not raw persistence.
32. API/MCP operations are tenant-scoped, permission-checked and audited.
33. Management control surfaces expose goals, situation, unknowns, missions, risks, opportunities, capabilities, workforce, agents, automation, evidence and approvals.
34. Management briefings are derived intelligence, not authoritative source state.
35. PostgreSQL is authoritative domain state; Redis is never domain truth.
36. Long-running cognition and execution are asynchronous, resumable and traceable.
37. Consequential decisions are reconstructable from evidence through outcome and learning.
38. Modules expose public contracts; internal cross-module imports are forbidden.
39. Frozen architecture cannot be silently changed during implementation.
40. Genuine architectural changes require an explicit change request and versioned approval.
41. Implementer prose is not evidence of completion; repository state and verification are required.
