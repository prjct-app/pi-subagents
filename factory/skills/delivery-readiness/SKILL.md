---
name: delivery-readiness
description: Assess whether a change is safe to release, including build evidence, configuration, data migration, rollout, rollback, observability, support, and user-facing communication. Use before a release or when delivery risk is material.
---

# Delivery Readiness

Never deploy from this skill. Determine whether the available evidence supports a release decision and identify the smallest safe delivery plan.

Check only what the change makes relevant:

- required CI, build, and test evidence;
- configuration and secret changes;
- schema or data migration and backward compatibility;
- rollout sequencing, feature flags, and blast radius;
- rollback feasibility and irreversible actions;
- health signals, logs, metrics, alerts, and support ownership;
- customer communication or documentation that is genuinely required.

A missing customer document is a prompt to ask whether documentation should be prepared, not permission to invoke the documenter automatically.

Return readiness, evidence, risks, blockers, rollout, and rollback in the report. Do not produce a release checklist file unless requested.
