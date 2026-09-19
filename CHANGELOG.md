# Changelog

## Unreleased

- Give an idle child one prompt to call `subagent_report` when it settles without reporting. An accepted RPC steer starts no turn after `agent_settled`, so completed research was being discarded as a failed job.
- Stop passing ambient third-party tools to children that never load their package; they failed the startup capability handshake. Tools from explicitly configured `extensionPackages` are still passed.
- Subagents are now off by default, like plan mode. While off, the model does not see `agent_delegate`, and a call that slips through is refused with "do this task yourself". `/agents on` allows delegation and keeps a fixed `Agents on` line below the editor. `/agents off` hides both, and `/agents` opens the panel. The choice survives a reload. `/agents auto on|off` is removed; `PI_AGENTS_AUTO=1` triages only while delegation is on.
- Add `npm run build:pi`: a compiled local build in `~/.pi/agent/builds/<package>` that Pi loads instead of the TypeScript sources.
- Coalesce `agent-jobs` ledger snapshots into one write per second (settled jobs are written at once) and stop repeating delivered reports in them; reload restores reports from their `agent-job` entries. Sessions had accumulated 47MB of snapshots in three days.
- Answer an unchanged `agent_jobs` status check in one line and tell the model not to poll: reports already arrive and wake an idle session. Status-only polling was ~11% of prompt tokens in real sessions.

## 0.3.0 - 2026-09-16

- Reworked `/agents` into a bounded, content-first panel with one-row agent lists, explicit pane focus, compact contextual controls, confirmed stop actions and usable layouts down to 40×12 terminals.
- Reduce the editor status widget to compact text symbols (`●`, `○`, `!`) and hide it as soon as no subagent is running; completed attention items remain available in `/agents` without occupying the chat.
- Add seven package-owned software-factory agents and nine lean playbooks for discovery, SDD/BDD, bug triage, implementation, quality, delivery and explicit product documentation.
- Move package-owned runtime data to `~/.prjct/subagents`, isolate factory writers in external Git snapshots, and retain proposed changes as reviewable patches instead of writing client repositories.
- Give agent trees ten minutes by default and steer running roots toward a report before their hard deadline.

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
