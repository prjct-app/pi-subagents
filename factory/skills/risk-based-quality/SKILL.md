---
name: risk-based-quality
description: Review and verify software changes proportionally to their actual product and technical risk. Use for acceptance, regression, security, privacy, accessibility, performance, compatibility, and maintainability checks without generating ceremonial QA documents.
---

# Risk-Based Quality

Derive checks from changed behavior, affected boundaries, failure cost, and reversibility. A typo and an authorization change do not need the same process.

## Review order

1. Acceptance behavior and explicit non-goals.
2. Regression surface and state transitions.
3. Security, privacy, and data integrity where trust boundaries changed.
4. Accessibility for user interfaces.
5. Performance and reliability where workload or critical paths changed.
6. Compatibility, migration, rollback, and operational evidence.
7. Maintainability only when it creates a concrete future failure risk.

Report findings by severity with reproduction or exact evidence. Separate confirmed defects from risks and unverified concerns. Name missing tests without demanding test types that add no confidence.

Do not create test plans or QA reports by default. Tests, CI output, and the agent report are the evidence.
