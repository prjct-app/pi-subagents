---
name: software-factory-routing
description: Route product and software work through only the discovery, specification, bug triage, implementation, quality, documentation, and delivery stages justified by its uncertainty and risk. Use for new products, features, defects, releases, and ambiguous requests so the factory stays rigorous without becoming bureaucratic.
---

# Software Factory Routing

Choose work from evidence, not from a mandatory ceremony.

## Classify the request

- **New product or unresolved problem:** discovery and design sprint, then specification.
- **Material feature with understood value:** specification, implementation, quality, delivery readiness.
- **Small well-understood change:** implementation and proportionate verification.
- **Defect or production symptom:** bug triage before implementation unless the cause and reproduction are already proven.
- **Documentation request:** product documentation; do not infer a documentation task from ordinary delivery work.
- **Release or migration:** delivery readiness using existing implementation and quality evidence.

Skip stages whose decisions already have current evidence. Never repeat research or rewrite a specification merely to satisfy a workflow.

## Handoffs

Each stage returns decisions, evidence, risks, and unresolved questions in its report. The next stage consumes that report; it does not create a second document that paraphrases it.

Use external state under `~/.prjct/subagents`. Do not create client-repository artifacts unless a person explicitly requests an export and approves its destination.
