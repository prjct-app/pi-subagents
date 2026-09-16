---
name: bug-triage-and-debugging
description: Triage and investigate bug reports, regressions, crashes, incorrect behavior, and production symptoms. Use to reproduce the issue, classify impact, isolate the failure boundary, and hand implementation an evidence-backed cause and regression target.
---

# Bug Triage and Debugging

Treat every report as a hypothesis until reproduced or otherwise evidenced.

## Flow

1. Capture expected behavior, observed behavior, environment, version, frequency, impact, and available evidence.
2. Build the smallest safe reproduction.
3. Classify severity and whether security, privacy, integrity, or availability is involved.
4. Distinguish product defect from configuration, data, dependency, environment, and misunderstood expectation.
5. Find the regression boundary when history permits.
6. Narrow the failing component and test competing causes.
7. State the likely root cause with confidence and contrary evidence.
8. Define the regression test and adjacent risks for implementation and quality review.

Do not fix the bug during triage. Do not create `BUG_REPORT.md`; retain the structured evidence under factory state and in the final report unless export was requested.
