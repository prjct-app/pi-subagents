# pi-subagents

Delegate separable pieces of work to ephemeral subagents that run beside your
PI Agent session and report back with evidence. Each subagent is its own `pi`
process: read-only, fenced to a directory you choose, on a model you choose,
and gone when it reports.

No team, no alias, no mailbox required. When
[pi-team](https://github.com/prjct-app/pi-team) is installed beside this
package, a job started inside a team task is filed under that task's thread;
without it, jobs simply belong to the session that started them.

## Install

```bash
pi install npm:@prjct.app/pi-subagents
```

## What you get

- **`agent_delegate`** (tool the model calls) — start a read-only subagent on
  one separable piece of work. It derives its own acceptance criteria, returns
  evidence, and ends. It cannot write, run anything, or reach anyone.
- **`agent_jobs`** (tool) — review the subagents this session started, or stop
  one. A job that came back blocked is unresolved work you own.
- **`/agents`** (command) — the ledger, as a person reads it.

A subagent at an allowed depth can ask its parent for a subagent of its own.
Delegation stops at depth 2, every tree has a wall clock, and a session that
ends takes every job it owns with it.

## Environment

- `PI_SUBAGENTS_PI_COMMAND` — how to launch `pi`, when the default (the same
  build this session runs on) does not fit the host.

## Development

```bash
npm install
npm run check   # tsc --noEmit + no `let` under src/
npm test        # node --import tsx --test tests/*.test.ts tests/*.test.mjs
```
