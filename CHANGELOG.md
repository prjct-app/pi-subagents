# Changelog

## Unreleased

- Extracted the subagent runtime from pi-team into its own package:
  `agent_delegate` and `agent_jobs` tools (formerly `team_delegate` and
  `team_jobs`), the `/agents` command, and the process-wide registry pi-team
  uses to file jobs under a team thread.
