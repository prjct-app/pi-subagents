## 0.5.0 (2026-10-06)

- Remove the classifier client, tool, credentials, and classifier-based routing.
- Preserve task language and constraints; workers and reviewers verify through the Pi SDK with inherited model/reasoning.
- Isolate all tests from personal credentials and block native keychain access.

## 0.4.2 (2026-10-06)

- Protect direct SDK and optional Jev requests with the published pi-secrets outbound guard.

# Changelog

## 0.4.1 — 2026-10-06

- Use the public Pi SDK in process by default; inherit model, reasoning and original task text. Restrict inherited extension tools to loaded packages and remove automatic classifier vetoes.

## 0.4.0

- Workers and reviewers have Bash by default; explorers never do, and `PI_SUBAGENTS_ALLOW_BASH=0` turns it off for every subagent. Without it a child could not run a test or a build and asked its parent to run them (35 times in one session, several jobs timing out at 600 s). The child prompt now tells it to run its own commands and never ask the session that started it.

## Unreleased

- Add `ask_jev`: a yes/no, pick-one or score judgement about files or text from Jev, without reading them into context; `each: true` asks every path in parallel. It is in the prompt only when a TypeSafe key is found, and never sends `.env`, key files or binaries.
- Auto-delegation asks Jev whether a prompt is complex before a model writes a plan; below 0.6 no generative call is made. Without a key, or on any Jev error, the model triage runs as before.
- Start every subagent admitted by the default 64-job session budget in parallel instead of holding all but two in a queue; return the post-launch state so active entities no longer render as queued.
- Theme generated subagent names around the whole Matrix saga: the four films, The Animatrix, Enter the Matrix, The Matrix Online, and The Matrix Comics.
- Replace the conflicting `agent`/`role` delegation selectors with one required `agent` selector that accepts factory profiles and base roles. Legacy calls remain accepted, and rejected calls render as failures instead of `Job unavailable`.
- Publish the agents mode through `@prjct.app/pi-tui-kit` (`◆ agents ● n` on the shared mode line that p-ui draws) instead of drawing a separate widget.
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
