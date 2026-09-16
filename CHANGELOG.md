# Changelog

## 0.2.0

- Replaced the agent list with a responsive two-pane TUI: search, filters, collapsible trees, activity/history scrolling, full evidence and execution details.
- Added multiline steering with preserved drafts, explicit resume, visible pending actions and attention states for blocked work.
- Added a native in-process runner behind an opt-in setting; processes remain the default.
- Added startup capability checks, explicit child extension packages, read-only explorer/reviewer roles and the writable worker role.
- Retry completion delivery after transient failures and deduplicate normal restored receipts.
- Added layered configuration, separate concurrency/session budgets (64 runs by default), retained sessions, explicit continuation and seven-day owned-file cleanup.
- Ledger v2 reads v1. Legacy child session files are never deleted automatically.
- Added offline native-runner integration tests, TUI fixtures/benchmarks, CI and manual provenance publishing.

## 0.1.0

- Extracted the subagent runtime from pi-team into its own package:
  `agent_delegate` and `agent_jobs` tools (formerly `team_delegate` and
  `team_jobs`), with the `/agents` command.
- `/agents` is a live panel over the ledger — tree, state, model, elapsed,
  cost — with report detail and stop; a widget names live jobs while any run.
- Children inherit the session's active tools; built-in file tools are fenced to their directory;
  in plan mode that set is read-only. Bash is disabled by default and can be
  enabled for writable children with `PI_SUBAGENTS_ALLOW_BASH=1`; when enabled
  it is explicitly unrestricted and not described as a filesystem sandbox.
- A child chooses its own model from the machine's catalogue, presented
  without recommendation.
- Auto-delegation: `/agents auto on` triages complex typed prompts and
  launches up to three expert subagents beside the turn.
- Siblings in a delegation tree reach each other over the tree's wire
  (`subagent_send` / `subagent_inbox`), budgeted against loops.
- A stuck child escalates with `subagent_ask`; answers come back down by steer,
  or from the session with `agent_reply`.
