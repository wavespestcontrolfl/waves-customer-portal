# Resume stopped shipping sessions

The local session supervisor keeps an explicitly enrolled shipping PR moving
when its owning Codex or Claude **process exits**. macOS launchd runs it every
minute while you are logged in and the Mac is awake. Closing a terminal does
not remove its queue; after a reboot it continues at your next login.
It does not run while the Mac is asleep or powered off.

It watches GitHub without a model, waits for a stable change in review/CI
results, then invokes the provider's supported resume command with the exact
saved session UUID. The resumed agent applies `waves-ship` to the live PR,
including final-HEAD review, CI, merge exceptions, and deployment verification.
The supervisor itself cannot approve or merge a PR.

A live terminal session, including one idle or waiting on a permission prompt,
is deliberately left alone. Exit that session after enrollment to let the
worker take over. It never kills an existing interactive session, forks it,
or types into its terminal. Enrollment is ongoing authorization until paused;
use **pause** before closing a terminal if you want the work to stay stopped.

## Install on this Mac

No npm/pip dependencies, server startup, database, API key copying, or Railway
service is needed. Requires Python 3.9+, `git`, `gh`, `lsof`, and signed-in
`codex` and `claude` CLIs on PATH. CLI permissions and model configuration remain
in force; this does not install permission allowlists or bypass flags. SSH agent
authentication is preserved: launchd supplies its current per-login socket, and
an explicitly customized `SSH_AUTH_SOCK` is retained during installation.

From the reviewed checkout:

```sh
python3 scripts/agents/session-supervisor.py install
python3 scripts/agents/session-supervisor.py install --execute
```

Without `--execute`, commands inspect/preview and do not change queue or
service state. Installation copies this reviewed script to
`~/.local/share/waves-session-supervisor/session-supervisor.py` and installs
`~/Library/LaunchAgents/com.waves.session-supervisor.plist`. It starts with an
empty queue: no existing conversations or PRs are automatically enrolled.
A second install refuses to overwrite the running service. To update it, run
`stop --execute`, then run `install --execute` from the new reviewed checkout;
the existing queue remains paused until explicitly retried. The source copy
in a worktree can be removed after shipping; the installed copy is independent.

## Enroll from the owning agent

For an authorized shipping task, the agent runs this after opening its PR and
before its session exits. Use its **current** saved session UUID, current
worktree root, and the open PR at its HEAD. The script finds the calling
Codex/Claude ancestor process, or accepts `--owner-pid` for an explicitly
identified owning process. A task branch is required; shared main checkouts
and cross-repository PRs are refused. One session, worktree, and PR can have
only one active enrollment.

```sh
python3 ~/.local/share/waves-session-supervisor/session-supervisor.py watch \
  --provider codex --session SESSION_UUID --worktree /absolute/task/worktree \
  --pr PR_NUMBER --execute
```

Use `--provider claude` for Claude. Codex exposes the current UUID through
`CODEX_THREAD_ID`; Claude's `/status` identifies its session. Never use
`--last`, guess the session from recency, or enroll an audit/proposal-only task.
Enrollment reads only the selected session's filename, not an archive sample.

The worker waits while the original process exists or another process has its
transcript open. It also checks live Codex/Claude working directories (including
Codex `--cd` and attached `-C/path`) and Claude's native agent listing, so a different session that
claims the same worktree blocks a resume.
PID start times distinguish a restarted process from a reused PID. Worktree,
origin, branch, and pushed HEAD must still match before a resume. An ambiguous
interrupted launch fences the whole queue until inspected and explicitly retried.
Worker cleanup drains the CLI and its remaining live tool process group;
zombies count as exited because they cannot run or respond to signals.
Re-enrollment cannot erase a surviving worker or unresolved launch record.
After a supervisor crash, the next tick terminates any recorded surviving worker
before another job can launch. An interrupted job requires an explicit retry
even when its worker has already exited, because its final disposition was lost.

## See progress, pause, and recover

```sh
python3 ~/.local/share/waves-session-supervisor/session-supervisor.py status
python3 ~/.local/share/waves-session-supervisor/session-supervisor.py tick
python3 ~/.local/share/waves-session-supervisor/session-supervisor.py pause codex:SESSION_UUID --execute
python3 ~/.local/share/waves-session-supervisor/session-supervisor.py retry codex:SESSION_UUID --execute
python3 ~/.local/share/waves-session-supervisor/session-supervisor.py finish codex:SESSION_UUID --execute
python3 ~/.local/share/waves-session-supervisor/session-supervisor.py stop --execute
```

`status` shows enrolled PRs and their state/reason. `tick` previews eligibility
without resuming anything. `pause` revokes the job, including an active worker;
`retry` is an explicit re-arm after resolving its blocker. `stop` pauses all
jobs, waits for any active worker to exit, and unloads the launch agent.
Its plist and private state remain for recovery. To restart the service:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.waves.session-supervisor.plist
```

Jobs remain paused until explicitly retried. Closing a PR without merging
completes its job; a merged PR gets a continuation for post-merge verification.
Background continuations stop after the enrolled PR. Remaining authorized lane
work is recorded in the saved session; the next PR needs its own enrollment
from the live owning session after the previous worker has exited. The worker retains worktrees so a
stopped run cannot erase its own recovery path.
When the original session finishes its own PR, run `finish` after merge and
deployment verification, then perform the normal worktree cleanup. `finish`
requires the PR to be merged and refuses while its worker group is active
or a launch is unresolved,
so completion cannot race worktree removal. It does not itself verify deployment.
A background worker returns its final disposition instead of invoking `finish`
on itself; the supervisor drains it before recording completion.

Only one resumed model process runs at a time. A run lasts at most 30 minutes,
with at least five minutes between starts, at most three starts for unchanged
PR evidence (including human comments and reviews) and twelve starts per job per rolling day. A permission denial,
owner question, quota error, invalid final result, or failed CLI invocation
parks the job. Blocking reasons are enforced even if the model reports an
inconsistent state. Reaching a resume limit keeps watching: new PR evidence resets
the unchanged-evidence count, and rolling daily slots become available as they
expire. These are conservative limits, not guarantees about token use.
The two CLI commands are `codex exec --cd WORKTREE resume SESSION_UUID` and
`claude -p --resume SESSION_UUID`; both return a structured disposition.
No provider switching, model override, or new approval authority is introduced.

State is private JSON under `~/.local/share/waves-session-supervisor/` with
atomic writes and file locks. Logs contain IDs and status reasons; raw provider
output is temporary and discarded. The worker does not copy portal environment
variables into children. Existing CLI settings/hooks still apply, so background
operation cannot complete an action the CLI itself refuses.

## Validation and existing mechanisms

```sh
python3 -m unittest discover -s scripts/agents/tests -v
```

The CI gates job runs these tests without live providers or GitHub writes.
They exercise process ownership, concurrent ticks, pause races, pagination,
branch/origin drift, bounded retries, and actual subprocess invocation through
fixture CLIs. Live provider smoke tests should use disposable repositories and
sessions, never customer data or production flows.

The existing Hermes watchdog (`docs/hermes/watchdog_poll.py`) observes portal
health and pages the owner; it has neither access to these local sessions nor
permission to resume them. This worker uses the existing CLI resume interfaces
and `waves-ship` merge gate rather than extending that remote health monitor.

Supported interfaces: [Codex non-interactive resume](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude programmatic sessions](https://code.claude.com/docs/en/headless), and
[Claude agent status](https://code.claude.com/docs/en/agent-view).
