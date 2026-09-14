# Changelog

## Unreleased

- Extracted the subagent runtime from pi-team into its own package:
  `agent_delegate` and `agent_jobs` tools (formerly `team_delegate` and
  `team_jobs`), with the `/agents` command.
- `/agents` is a live panel over the ledger — tree, state, model, elapsed,
  cost — with report detail and stop; a widget names live jobs while any run.
- Children inherit the session's active tools, fenced to their directory; in
  plan mode that set is read-only, and their shell answers read-only commands.
- A child chooses its own model from the machine's catalogue, presented
  without recommendation.
- Auto-delegation: `/agents auto on` triages complex typed prompts and
  launches up to three expert subagents beside the turn.
- Siblings in a delegation tree reach each other over the tree's wire
  (`subagent_send` / `subagent_inbox`), budgeted against loops.
- A stuck child escalates with `subagent_ask`; answers come back down by steer,
  or from the session with `agent_reply`.
