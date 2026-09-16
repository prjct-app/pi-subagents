# pi-subagents

Focused delegation for Pi, with a live two-pane terminal workspace, evidence-based
reports and explicit continuation. No external service, scheduler or team setup.

```bash
pi install npm:@prjct.app/pi-subagents
```

Requires Pi **0.85.1–0.85.x** and Node **22.19+**. The default runner launches a
child Pi process for each active job; a native in-process runner is opt-in.

## Watch and control work

Open **`/agents`**. The panel stays bounded at 110 columns by 24 rows and shrinks
to the available terminal space. Wide layouts keep a compact agent list beside the
selected job; narrow layouts use a one-row list and drill down without losing the
selection. Activity, reports and execution details remain separate: see what is
happening, check the evidence, then inspect capabilities and limits.

- Search by name, task or job ID; filter All, Active or Attention.
- Fold delegation trees, scroll activity and inspect tool output.
- Read all reported criteria, findings and blockers. Blocked reports are marked
  **Needs attention**, even when their execution has finished.
- Send multiline instructions without losing your draft after a failed send.
- Continue a retained conversation as a new execution, preserving previous reports.
- Keep the parent chat readable: one compact summary appears only while subagents are running.

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Select an agent or scroll the focused detail |
| `Tab` | Switch tree / detail |
| `←` / `→` | Fold / unfold a tree |
| `1` / `2` / `3` | Activity / Result / Details |
| `/` | Search |
| `f` | Cycle All / Active / Attention |
| `PgUp` / `PgDn`, `Home` | Browse activity; PgUp at the top loads older history |
| `End` | Follow the latest activity |
| `h` | Open retained history |
| `t` | Expand / collapse tool details |
| `s` | Message a live agent |
| `r` | Continue a finished agent |
| `x` twice | Confirm, then stop an agent and its descendants |
| `?` | Keyboard help |
| `Esc` | Keep draft / go back / close |

In the message editor, `Enter` inserts a newline; `Ctrl+Enter` or `Ctrl+S` sends.
The limit is 4,000 characters. Oversized pastes are rejected with a visible notice,
not silently shortened. Standard Pi themes and Unicode editing are preserved.

## Lean software factory

`agent_delegate` can select one package-owned factory profile instead of a base role:

- `product-discovery` — evidence-led research and lean design sprints.
- `specification-architect` — one non-duplicative SDD/BDD specification.
- `bug-triager` — reproduction, severity, regression boundary and likely cause.
- `implementer` — technology-agnostic changes in an external Git snapshot.
- `quality-reviewer` — risk-based product and engineering verification.
- `delivery-engineer` — rollout, rollback, migration and operational readiness.
- `product-documenter` — customer-facing documentation, only after an explicit user request.

The specification profile opens a keyboard checklist where one or many clarification
topics can be selected before work starts. Product documentation is never inferred
from an implementation or release. It is proposed as an external patch and cannot
write into the client checkout automatically.

Factory implementers and documenters receive only fenced file tools in a private
snapshot under `~/.prjct/subagents/workspaces/`; they never receive Bash or arbitrary
mutation extensions. The snapshot includes tracked changes and non-ignored untracked
files. The resulting `changes.patch` must be reviewed and applied separately.

## Three tools

- **`agent_delegate`**: choose either `agent` or `role`, plus `subject`, `task`, and optional `context`, `model`, `cwd`. `requestedByUser: true` is required for `product-documenter`.
- **`agent_jobs`**: `action: status | result | cancel | steer | resume`, optional
  `jobId` and `message` (required for steer/resume). `result` returns the full report.
- **`agent_reply`**: `name`, `answer`; answer a question escalated by a live child.

Jobs return immediately; results arrive in the parent session. Delivery failures
are retried, including while idle, and receipt IDs prevent duplicate delivery on
normal session restoration. Pi does not provide transactional send-and-ack, so a
crash between acceptance and persistence can still cause a duplicate notification.

## Roles and capabilities

**`explorer`** maps code and **`reviewer`** checks evidence. Both only inherit active
`read`, `grep`, `find` and `ls` tools. **`worker`** may inherit active mutation tools.
A read-only parent cannot grant a worker edit/write permissions it does not have.
Grandchildren cannot expand their parent's capability set.

Built-in file tools are fenced to the assigned directory, including symlink
resolution. Bash is disabled unless `PI_SUBAGENTS_ALLOW_BASH=1` and the worker
inherits edit or write. **Bash is unrestricted, not a filesystem sandbox.**
Extension tools have their own semantics; loading their code is a trusted action,
and this package does not sandbox arbitrary extension code.

Children load only the package guard and explicitly configured extension packages.
Ambient extensions, skills and prompt templates are disabled. The process runner
checks the guard's capability handshake before sending the task; the native runner
checks the SDK tool registry. Unavailable tools/models fail explicitly.

A child starts on the requested or inherited model and may choose another from the
parent's catalogue. A missing provider extension must be explicitly enabled; there
is no silent model substitution. Children can delegate within the shared tree
limits, coordinate over a bounded wire, and escalate questions to their parent.

## Configuration

Optional files: `<Pi agent directory>/prjct-subagents.json` and
`<project>/.pi/prjct-subagents.json`. Project fields override global fields;
invalid fields warn and retain the previous valid value. Changes take effect when
the parent session starts again.

```json
{
  "runner": "process",
  "retentionDays": 7,
  "workspaceRetentionHours": 24,
  "artifactPolicy": "requested",
  "extensionPackages": [],
  "limits": {
    "concurrency": 2,
    "jobs": 64,
    "timeoutMs": 600000,
    "depth": 2,
    "descendants": 4,
    "taskBytes": 24576
  }
}
```

`jobs` is a cumulative per-parent-session budget, including continuations;
completed jobs do not refund it. Concurrency is a separate live capacity limit.
The clock covers the entire tree from admission, including queued time. Running roots receive
best-effort reminders at 60% and 85% of that budget so they narrow scope and report before
the hard deadline. Supported maxima are 16 concurrent jobs, 256 session runs, depth 8, 64 descendants,
24 hours per tree and 48 KiB of task plus context. Session retention accepts 1–365 days;
external workspace retention accepts 1–720 hours. `artifactPolicy` is `requested` by
default or `none` to disable product-documentation artifacts.

`extensionPackages` names already-installed npm packages with explicit
`pi.extensions` entries. Packages are resolved from the project and Pi agent/npm
directories; nothing is downloaded automatically. Read-only roles do not gain
arbitrary extension tools by enabling a package.

Set `runner` to **`in-process`** to use native Pi sessions. The same lifecycle,
reports, role restrictions and retention apply. This mode shares the host process:
uncooperative extension code can affect Pi itself. A child that does not acknowledge
cancellation keeps its capacity reserved. Process execution remains the default;
there is no automatic switch between runners.

Environment variables remain supported:

- `PI_AGENTS_AUTO=1`: opt into automatic triage of complex typed prompts. Default
  off; toggle per session with `/agents auto on|off`. Automatic roles remain readers.
- `PI_SUBAGENTS_ALLOW_BASH=1`: enable unrestricted Bash for writable workers.
- `PI_SUBAGENTS_PI_COMMAND`: override child Pi invocation for the process runner.
- `PI_CODING_AGENT_DIR`: Pi agent home, used for configuration and model credentials.
- `PRJCT_HOME`: package-owned data root; defaults to `~/.prjct`.

## History and recovery

New child sessions and coordination files live under
`~/.prjct/subagents/state/`, partitioned by parent session. Isolated implementation
and documentation snapshots live under `~/.prjct/subagents/workspaces/`. The default
retention is seven days for sessions and 24 hours for settled workspaces. Startup
cleanup removes only expired package-owned data, skips live owners and symlink
directories, and never deletes legacy external session files. Parent reports remain
in the parent Pi session.

Resume explicitly forks the retained conversation into a new execution with a new
ID, a new clock and the intersection of the previous and current permissions. Only
one active continuation per source session is admitted. Reports from previous runs
are preserved; the previous job links to its continuation. Expired or unavailable
history requires a fresh delegation. Restoring the parent marks unfinished work
interrupted; it never automatically repeats a model call.

Ledger v1 remains readable and is upgraded to v2 on restoration. Existing tool
names and the optional `pi-team` integration remain compatible. Compared with 0.1,
**use `worker` for edits**; explorer/reviewer no longer inherit write tools.

## Development and release

```bash
npm ci
npm run check
npm test
npm run check:package
npm run demo:tui       # interactive, offline fixture
npm run preview:tui    # build/tui-preview.html, exact component renders
npm run benchmark     # offline native/process timing and memory observations
```

Tests include native Pi runs against a local deterministic provider. They require
no API credentials or external model calls. The preview is a visual rendering of
the component output; the interactive demo runs it in a real terminal.

CI runs the checks on Linux and macOS with Node 22/24. Release publishing is a
separate manual workflow. Configure the npm package's GitHub trusted publisher
for `prjct-app/pi-subagents`, workflow `publish.yml`, then dispatch it on a matching
`vX.Y.Z` tag. It verifies the version, runs checks, and publishes with provenance.
No long-lived npm token is stored in the workflow. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for registry setup.
