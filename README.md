# pi-subagents

Subagents for PI Agent: expert child processes that work beside your session
and report back with evidence. Each one is its own `pi` process — its file
tools fenced to a directory, armed with selected active tools from your session,
on a model it chooses for itself — and it is gone when it reports.

No team, no alias, no mailbox required. When
[pi-team](https://github.com/prjct-app/pi-team) is installed beside this
package, a job started inside a team task is filed under that task's thread;
without it, jobs belong to the session that started them.

## Install

```bash
pi install npm:@prjct.app/pi-subagents
```

## What you get

- **Auto-delegation** — off by default. With `/agents auto on` (or
  `PI_AGENTS_AUTO=1`), a complex typed prompt is triaged by the cheapest model
  you have — beside the turn, never blocking it — and becomes up to three
  expert subagents while your session is told who is reading what. Questions,
  single-file changes and one-lookup tasks are never split.
- **`agent_delegate`** (tool) — start a subagent on one separable piece of
  work, explicitly. Same machinery, your call instead of the triage's.
- **`agent_jobs`** (tool) — review the subagents this session started, or stop
  one. **`agent_reply`** (tool) — answer a question one escalated to you.
- **`/agents`** (command) — a live panel over the ledger: the tree, each job's
  state in color, model, elapsed and cost; `enter` unfolds a report, `x` stops
  a job and everything under it, `esc` closes.

## What a subagent is

A first-class citizen with one task. It inherits the session's *active* tools.
Built-in file tools are fenced to the directory it was given; in plan mode that
set is read-only, while an ordinary writable session can pass edit and write. Bash is disabled by default
and never presented as a read-only shell or a filesystem sandbox. It chooses
its own model from the machine's catalogue,
presented as facts, never as advice. It can ask for a subagent of its own
(depth 2, one budget and one clock per tree), message its siblings over the
tree's wire, and ask its parent — or its grandparent, up to your session —
when a decision is not its own. A session that ends takes every job it owns
with it.

## Environment

- `PI_AGENTS_AUTO` — `1` turns auto-delegation on for every session.
- `PI_SUBAGENTS_PI_COMMAND` — how to launch `pi`, when the default (the same
  build this session runs on) does not fit the host.
- `PI_SUBAGENTS_ALLOW_BASH` — `1` lets children that inherited `edit` or
  `write` inherit Bash too. **This is an unrestricted capability, not a
  sandbox.** The child starts in its assigned directory, but Bash can access
  anything available to your operating-system account: files outside that
  directory, credentials, the network, and other processes. Leave it unset
  unless that reach is intentional; use an operating-system sandbox when you
  need isolation.

## Development

```bash
npm install
npm run check   # tsc --noEmit + no `let` under src/
npm test        # node --import tsx --test tests/*.test.ts tests/*.test.mjs
```
