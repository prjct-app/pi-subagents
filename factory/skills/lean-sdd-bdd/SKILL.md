---
name: lean-sdd-bdd
description: Create a single lean software design and behavior specification for a feature or system change. Use when architecture, interfaces, data, quality attributes, acceptance behavior, or edge cases need clarification, especially before implementation.
---

# Lean SDD and BDD

Clarify before writing. Use the operator's multi-select topics as the focus and ask only questions whose answers could change behavior, boundaries, safety, or delivery.

## One source of truth

Keep these concerns complementary:

- **SDD:** context, scope, boundaries, interfaces, data lifecycle, integrations, quality attributes, constraints, and consequential decisions.
- **BDD:** observable examples that demonstrate acceptance, edge cases, failures, permissions, and state transitions.

Do not restate architecture as scenarios or rewrite scenarios as prose requirements. Link each scenario to the capability or decision it verifies.

## Minimal structure

1. Problem and outcome.
2. In scope / out of scope.
3. Decisions and system boundaries.
4. Interfaces and data affected.
5. Security, reliability, performance, privacy, or accessibility only where relevant.
6. Acceptance examples in Given/When/Then or an equally precise observable form.
7. Open questions, assumptions, migration, rollout, and rollback where relevant.

Create an ADR only for a durable cross-cutting decision. Create executable `.feature` files only when the project actually executes them. Otherwise keep acceptance examples in the single specification report.

Do not write a specification file unless explicitly requested; return it in the report for approval or export.
