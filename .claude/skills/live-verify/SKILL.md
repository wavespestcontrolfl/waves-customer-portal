---
name: live-verify
description: Independent live verification of a finished change — an agent that did not write it runs the changed behavior (on a dev/preview stack where one exists), compares it with the merge-base, and posts a PASS / PASS+NOTES / FAIL / BLOCKED verdict. On trial since 2026-09-26: not a merge gate. Not a substitute for tests, ui-verify, or Codex.
---

# Live verify

CI proves the tests pass. Codex reads the diff. Neither one runs the change.
This skill is the check that does: someone who did not write the code
exercises the changed behavior, on a running stack wherever the surface has
one, compares it with the merge-base, and records what actually happened.

## Trial status

Owner ruling 2026-09-26: this is a trial, not a merge requirement. Run it
on Full-tier PRs the owner or the lane picks, roughly the next five. Each
verdict records whether it caught something Codex did not (§Verdict), so
the trial is scored by searching PR comments for `<!-- live-verify -->`.
It becomes a gate in waves-ship only if it earns one. Until then, merge
gates are unchanged.

## Who and when

- **Verifier:** an agent that did not write the change — a fresh subagent
  (in Claude Code lanes, `tree-verifier`) or another session. The author's
  own `ui-verify` pass is still expected; it does not count as the verdict.
- **Brief:** PR number, head SHA, the PR body's review map, and the
  intended behavior in plain words. Derive the claims to test from the diff
  as well; do not take the PR body's account of what the code does on trust.
- **When:** once the head is code-ready, before the first `@codex` tag, so
  behavior bugs surface before review rounds are spent. A later run is
  needed only when the patch-id changed (§Patch-id), and then only for the
  scenarios whose files changed.
- **Scope:** the verifier writes only under `.tmp/live-verify/` and test
  files. It never edits source, commits, pushes, comments on the PR, or tags
  Codex. The owning session posts the verdict file verbatim (§Verdict).

## Hard lines

- Never production: no production database, credentials, or deployment.
  Managed commands run only against a verified dev/preview cluster
  (`docs/development.md` §Dev database).
- Never a real customer's record (CLAUDE.md rule 13) and never a customer
  message (rule 12). Managed runs exclude provider credentials; do not add
  them back. A scenario that could only be shown by messaging someone is
  `Not exercised`, with the strongest safe substitute named.
- **One rule for every process:** it is either managed or started through
  the safe launcher below. Managed means the `npm run dev`, `dev:*`, and
  `qa:*` scripts and the `scripts/qa/*` harnesses, which all build their
  child environment with `childEnvironment` in `scripts/dev/context.js`.
  Everything else, including the `eval:*` scripts, goes through the
  launcher. A bare `node` that loads server modules reads the checkout's
  `.env`, which can point at production.
- The only credential that may be added is a model API key, for an eval or
  a direct LLM call, through the launcher's `--model-key` (below). Never a
  messaging, payment, email, or database credential.
- A `GATE_*` flag is turned on only through the launcher for your own
  process, never on a shared deployment. The managed runner drops every
  `GATE_*` you export, so a gate-on run on `npm run dev` silently runs
  gate-off.
- Never run the repo's operational scripts (`server/scripts/*`,
  `scripts/*` backfills and audits) as a scenario: many call `dotenv`
  directly. Write the scenario script under `.tmp/live-verify/` and require
  the service modules it exercises.
- Targeted tests also run through the launcher, with jest bounded
  (`--runInBand`, or `-w 2` for a broad pattern).

## Safe launcher

Copy this to `.tmp/live-verify/qa-env.sh` and run every direct-execution
script, job run, tool call, and gate-on server through it. It passes the
same allowlist as the managed runner (`scripts/dev/context.js`
`childEnvironment`), refuses anything but a dev/preview/test selection,
refuses a checkout that has a `.env` (application modules skip it under
`WAVES_LOCAL_DEV=1`, but a module or script that calls `dotenv` itself
would load provider keys from it), and takes extra `NAME=value` pairs, for example
`sh .tmp/live-verify/qa-env.sh GATE_FOO=true node .tmp/live-verify/run.js`.
With `--model-key` first, it also reads `.tmp/live-verify/model.env`
(`chmod 600`, only `ANTHROPIC_API_KEY=` / `OPENAI_API_KEY=` token lines)
inside the launched shell, so the key never appears in a command line or
shell history. Neither file is sourced: values are read with `sed`, so a
`$(...)` in either file is never executed.

```sh
#!/bin/sh
set -eu
for f in .env server/.env; do
  [ ! -e "$f" ] || { echo "refusing: $f exists and scripts can load it" >&2; exit 1; }
done
val() { sed -n "s/^$1=//p" "$2" | tail -n 1 | sed 's/^"\(.*\)"$/\1/'; }
db=./.tmp/dev/database.env
[ -f "$db" ] || { echo "refusing: missing $db" >&2; exit 1; }
case "$(val WAVES_DATABASE_ENVIRONMENT "$db")" in development|preview|test) ;;
  *) echo "refusing: database.env is not development/preview/test" >&2; exit 1 ;; esac
url=$(val DATABASE_URL "$db")
case "$url" in postgres://*|postgresql://*) ;;
  *) echo "refusing: DATABASE_URL is not a PostgreSQL URL" >&2; exit 1 ;; esac
if [ "${1:-}" = "--model-key" ]; then
  shift
  if grep -qvE '^((ANTHROPIC|OPENAI)_API_KEY=[A-Za-z0-9_-]+)?$' ./.tmp/live-verify/model.env; then
    echo "refusing: model.env may hold only ANTHROPIC_API_KEY / OPENAI_API_KEY tokens" >&2; exit 1
  fi
  set -- sh -c 'k() { sed -n "s/^$1=//p" ./.tmp/live-verify/model.env | tail -n 1; }
    a=$(k ANTHROPIC_API_KEY); o=$(k OPENAI_API_KEY)
    [ -z "$a" ] || export ANTHROPIC_API_KEY="$a"
    [ -z "$o" ] || export OPENAI_API_KEY="$o"
    exec env "$@"' sh "$@"
fi
exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  NODE_ENV=development WAVES_LOCAL_DEV=1 GATE_CRON_JOBS=false \
  DATABASE_URL="$url" "$@"
```

Run it from the worktree root after `qa:database`, so `DATABASE_URL` is
this worktree's private QA database. A gate-on server run adds `PORT`,
`JWT_SECRET`, and `CLIENT_URL` pairs and starts `node server/index.js`.

## Evidence ladder

Use the highest rung the changed surface allows. Name any higher rung you
skipped and why.

1. **Real database journey.** Per `docs/development.md` §Application QA:
   `qa:database` → `dev:migrate` → `dev:doctor` → `qa:e2e` (or `qa:seed` for
   a fixture to drive by hand, credentials in the private
   `.tmp/qa/e2e/fixture.json`). Then drive the changed route or page on the
   managed `npm run dev` stack and read the resulting rows back.
2. **Real components, synthetic API.** The per-surface harnesses in
   `scripts/qa/` (`node scripts/qa/<name>`; managed, see §Hard lines),
   `npm run qa:previews`, and `npm run audit:estimate-previews`. External
   requests are blocked.
3. **Direct execution.** Call the changed service function, job, or route
   handler with fixture input from a script under `.tmp/live-verify/`,
   started through the safe launcher, or a targeted test.

Rung 3 alone earns at most `PASS+NOTES` when this map lists a higher rung
for the surface. Rungs 2 and 3 are not end-to-end database evidence; say so.

## Surface map

| Change touches | Drive it with | Proof to capture |
|---|---|---|
| Admin page | the matching `scripts/qa/admin-*` harness; if none covers the change, the page on the rung-1 stack via `ui-verify` | 1440 and 390 screenshots of the changed state, plus the result of the changed interaction |
| Customer portal, secure appointment, service report, track, schedule | `qa:previews` and its `preview-*.html` entries; rung 1 via `qa:e2e` | same, both widths |
| Estimate page (`estimate-public.js`, React estimate) | `audit:estimate-previews`; `estimate-foundation.cjs`; rung 1 for acceptance | screenshots or PDF. Never click frequency tabs on a real estimate |
| Tech portal | `tech-foundation.cjs`, `field-team.cjs` | 390 screenshots, interaction result |
| Server route or service | rung 1: call the route on the managed stack with the seeded admin's token | request, response, and the DB rows read back |
| Migration or raw SQL | `dev:migrate` on this worktree's QA database, plus the waves-db verification | the schema or rows read back; a second `dev:migrate` is a no-op |
| Background job or cron | run the job's function once against the QA database from `.tmp/live-verify/`, through the safe launcher | rows before and after; a second run converges (idempotent) |
| Inbound webhook (Stripe, Twilio, SendGrid, Resend, Bouncie, ElevenLabs) | replay a signed synthetic payload at the local route, the way `qa:e2e` settles its webhook | response, resulting rows, and a replay that changes nothing |
| Intelligence Bar tool | `executeTool` for the changed tool only, through the safe launcher. Do not run `test:contracts` locally: CI runs it on every PR, and locally it reads `.env` and executes every tool, some against live provider APIs. Cite the CI job's result instead | tool output and any rows it wrote |
| LLM call site or prompt | a synthetic-fixture eval if the lane has one, through the launcher: `qa-env.sh --model-key npm run eval:voice-relay` (or `eval:lawn-diagnostic`). Else one direct call with synthetic input the same way. Never `eval:call-replay`: it reads production `call_log` rows. Use synthetic transcripts through direct execution instead | the eval report, or input and output |
| Voice relay (Sandy) | `eval:voice-relay` through the launcher with `--model-key`. Live calls only through the sandbox number (CLAUDE.md), only when the owner has arranged one | eval report |
| Email or SMS template | rung 3: call the server render function with synthetic variables. The composing UI via `admin-email*.cjs` or `communications-sms-reliability.cjs`. Never send | rendered HTML screenshot or the final text |
| Dark `GATE_*` behavior | run the scenario with the gate unset and with it on, both through the safe launcher (the managed runner drops `GATE_*`). Confirm the gate-on run actually read the gate, for example a log line or a response field that only exists when it is on | both outputs. A "gate off is unchanged" claim is checked against the base's output |

## Regression lane

Run the same scenario on the PR's merge-base as well as the head, so the
verdict shows a change and not just a state. Resolve the PR's real base
first, since a stacked child's base is its parent, not `main`:
`BASE=origin/$(gh pr view <n> --json baseRefName -q .baseRefName)`. Use a
throwaway worktree at `$(git merge-base "$BASE" HEAD)` under
`.tmp/live-verify/base`, set up
like any checkout: `npm ci` (never share `node_modules`), then
`npm run worktree:setup`, since every managed command refuses to start
without it. A rung-1 base run also needs its own `.tmp/dev/database.env`
pointing at the same verified dev cluster and its own `npm run qa:database`,
`dev:migrate`, and `dev:doctor` (`docs/development.md`); never reuse the
head worktree's private database. When that setup cannot be done, run the
base scenario on the highest rung it can reach and say which. For a bug fix,
the base must show the bug. For a new capability absent on `main`, record "not on main" and
verify the end state the user waits for instead.

## Patch-id

A verdict describes a patch, not a SHA. Record, after `git fetch origin`,
with `BASE` resolved as in §Regression lane:

```sh
git diff "$(git merge-base "$BASE" HEAD)" HEAD | git patch-id --verbatim | cut -d' ' -f1
```

On a later head, recompute. The same patch-id means the
verdict stands, for example after a merge of `main` that did not touch the
PR's own changes. `--verbatim` keeps whitespace, so a whitespace-only edit
inside a string or markup still changes the id (`--stable` would hide it).
CI and Codex still run on the new head. A different patch-id needs a fresh verdict for the scenarios whose files changed. Never
carry a verdict across on matching commit messages or an older green check.

## Verdict

Write `.tmp/live-verify/<head-sha>.md` in this shape. The owning session
posts it unedited with `gh pr comment <n> --body-file <file>`, attaching
screenshots with `--attach` (waves-ship §4).

```markdown
<!-- live-verify -->
**Live verify: PASS+NOTES**
Head `<sha>` · patch-id `<id>` · verifier `<agent / model>`, did not write this change · rung 1

| Scenario | merge-base | head | Evidence |
|---|---|---|---|
| Paid invoice shows receipt link | no link (bug) | link opens receipt | `mobile-390.png`, rows read back |

**Notes:** one line each, with file:line and how to reproduce.
**Not exercised:** the path, why, and the substitute used.
**Caught beyond Codex:** yes or no. If yes, what, and which Codex round missed it.
```

- **PASS.** Every scenario from the review map behaved as intended on the
  highest available rung, and the regression lane shows the change.
- **PASS+NOTES.** Works. Each note is handled like a Codex P2: fixed, or
  deferred under `Deferred P2s` with the verifier's evidence.
- **FAIL.** A scenario misbehaved. The author fixes it with a red-first test
  covering every site of the same defect, and the new head gets a fresh
  verdict. A note describing a defect is a FAIL, not a note.
- **BLOCKED.** No rung could run, for example no verified dev cluster and no
  way to execute the code directly. Name the missing prerequisite. During
  the trial this does not hold a merge; it is a finding about the tooling.
