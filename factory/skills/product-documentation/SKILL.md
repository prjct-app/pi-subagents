---
name: product-documentation
description: Create or improve concise, accurate customer-facing product documentation when the user explicitly requests documentation. Use for README content, onboarding, user guides, API references, troubleshooting, migration guidance, and release notes; do not trigger for ordinary implementation or internal process reporting.
---

# Product Documentation

Documentation is a product surface. Write for the reader's task and preserve the product's existing terminology, voice, structure, and language.

## Before writing

1. Confirm the requested audience, outcome, scope, format, and language when existing documentation does not answer them.
2. Inspect existing documentation and code evidence.
3. Choose the existing source of truth to update. Create a new document only when it serves a distinct reader need.
4. Verify commands, examples, defaults, constraints, and version-specific claims.

## Writing

Lead with what the reader can accomplish. Prefer concrete examples and progressive disclosure. For procedural documentation, pair each verified command with the outcome a reader should observe; never invent flags or exact output. Include prerequisites, common failures, and recovery only where useful. Avoid marketing filler, implementation diary content, duplicated architecture, and generic sections with no reader value.

## Delivery

Work in the external snapshot. Return the existing source-of-truth path to update, rationale, and verification in the report. When files are unavailable but the request names an existing document, propose updating that document and label the missing inspection as a limitation rather than silently proposing a duplicate. Always state that the documentation remains an external proposal or patch until a person explicitly approves applying or exporting it. Never create documentation merely because another stage completed.
