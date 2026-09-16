---
name: technology-agnostic-implementation
description: Implement a bounded software change in the technology already used by a repository. Use for feature, bug-fix, refactor, migration, and maintenance work where the implementer must discover conventions instead of assuming a language or framework.
---

# Technology-Agnostic Implementation

Work only in the external snapshot provided by the factory. The client checkout is a source, never a write target.

## Flow

1. Read repository instructions and inspect the existing stack, architecture, tests, and neighboring implementation.
2. Resolve the acceptance behavior and constraints from the task and supplied evidence.
3. Ask when a consequential decision remains ambiguous; do not invent product policy.
4. Make the smallest complete change consistent with existing patterns.
5. Add or update tests at the narrowest useful level.
6. Run relevant validation only through tools explicitly provided. Factory agents do not receive an unrestricted shell; when execution is unavailable, report the exact formatter, checks, tests, or build the parent should run.
7. Inspect the resulting diff for unrelated changes, secrets, generated noise, and accidental documentation.
8. Report changed paths, validation evidence, risks, and blockers.

Do not introduce a framework-specific methodology through this skill. Load a technology-specific skill only when the detected stack needs one. Leave changes as an external patch; never claim they were applied to the client checkout.
