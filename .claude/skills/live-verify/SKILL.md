---
name: live-verify
description: Independent live verification of a finished change — an agent that did not write it runs the changed behavior through the repo's managed dev/QA tooling, compares it with the PR's base, and posts a PASS / PASS+NOTES / FAIL / BLOCKED verdict. On trial since 2026-09-26, not a merge gate. Not a substitute for tests, ui-verify, or Codex.
---

# Live verify

CI proves the tests pass. Codex reads the diff. Neither one runs the change.
In this check, someone who did not write the code runs the changed behavior
and compares it with the PR's base. It records what actually happened.

## Trial status

Owner rulings 2026-09-26: this is a trial, not a merge requirement, and it
uses only the repo's existing managed tooling. Run it on Full-tier PRs the
owner or the lane picks, roughly the next five. Each verdict records
whether it caught something Codex did not (§Verdict). Score the trial by
searching PR comments for `<!-- live-verify -->`. It becomes a waves-ship
gate, or gets tooling for the out-of-scope surfaces below, only if it earns
one. Merge gates are unchanged until then.

## Who and when

- **Verifier.** An agent that did not write the change, such as a fresh
  subagent or another session. The author's own `ui-verify` pass does not
  count as the verdict.
- **Brief.** PR number, head SHA, the PR body's review map, and the
  intended behavior in plain words. Derive what to test from the diff too;
  do not take the PR body's account on trust.
- **When.** Once the head is code-ready, before the first `@codex` tag. A
  later run is needed only when the patch-id changed (§Patch-id), and only
  for the scenarios whose files changed.
- **Scope.** The verifier writes only under `.tmp/`. It never edits
  source, commits, pushes, comments on the PR, or tags Codex. The owning
  session posts the verdict file unedited.

## Hard lines

- **Managed tooling only.** Use the `npm run dev`, `dev:*`, and `qa:*`
  scripts and the `scripts/qa/*` harnesses, which build their environment
  with `childEnvironment` in `scripts/dev/context.js`. The verifier starts
  nothing else that loads server code: no bare `node`, no repo operational
  scripts, no local `test:contracts`, no `eval:*`. Outside the managed
  runner, server code can read the checkout's `.env`, which may point at
  production. Talking to the managed stack over HTTP (a browser, `curl`) is
  fine.
- Only a verified dev/preview cluster, per `docs/development.md` §Dev
  database. Never production.
- Never a real customer's record (CLAUDE.md rule 13) and never a customer
  message (rule 12). Never add credentials to a managed run.

## Evidence

1. **Real database journey.** Per `docs/development.md` §Application QA:
   `qa:database`, `dev:migrate`, `dev:doctor`, then `qa:e2e` or `qa:seed`.
   Drive the changed page or route on the managed `npm run dev` stack as
   the seeded fixture users, logging in the way `scripts/qa/e2e.js` does
   (credentials in the private `.tmp/qa/e2e/fixture.json`). Read changed
   state back through the app's own admin routes.
2. **Real components, synthetic API.** `node scripts/qa/<harness>`,
   `npm run qa:previews`, `npm run audit:estimate-previews`. External
   requests are blocked. This is not database evidence; say so.

## Surface map

| Change touches | Drive it with | Proof to capture |
|---|---|---|
| Admin page | the matching `scripts/qa/admin-*` harness; if none covers the change, the page on the rung-1 stack via `ui-verify` | 1440 and 390 screenshots of the changed state and the changed interaction's result |
| Customer portal, secure appointment, service report, track, schedule | `qa:previews` and its `preview-*.html` entries; rung 1 via `qa:e2e` | same, both widths |
| Estimate page | `audit:estimate-previews`, `estimate-foundation.cjs`; rung 1 for acceptance | screenshots or PDF. Never click frequency tabs on a real estimate |
| Tech portal | `tech-foundation.cjs`, `field-team.cjs` | 390 screenshots, interaction result |
| Server route reachable over HTTP | rung 1: call it on the managed stack as a seeded user | request, response, and the changed state read back over HTTP |
| Migration | `dev:migrate` on this worktree's QA database, then rung 1 | the behavior that depends on it; a second `dev:migrate` is a no-op |

**Out of trial scope.** Record these as `Not exercised: out of trial
scope`: behavior behind a `GATE_*` that is off by default (the managed
runner drops exported `GATE_*`), background jobs and crons, LLM call sites
and evals, inbound webhooks beyond `qa:e2e`'s own journeys, Intelligence Bar
tools, and email or SMS rendering outside a harness. If a PR's change lives
entirely there, the verdict is `BLOCKED`, which is the trial's finding
about tooling. It says nothing about the code.

## Regression lane

Run the same scenario on the PR's base so the verdict shows a change, not
just a state. First resolve and fetch the real base, since a stacked
child's base is its parent:

```sh
BASE_REF=$(gh pr view <n> --json baseRefName -q .baseRefName)
git fetch origin "$BASE_REF"
BASE=origin/$BASE_REF
```

Make a throwaway worktree at `$(git merge-base "$BASE" HEAD)` under
`.tmp/live-verify/base`. Set it up like any checkout: `npm ci` (never share
`node_modules`), then `npm run worktree:setup`. A rung-1 base run needs its
own `.tmp/dev/database.env` on the same verified cluster, plus its own
`qa:database`, `dev:migrate`, and `dev:doctor`. Never reuse the head
worktree's private database. If that setup is not possible, run the base on
rung 2 and say so. For a bug fix, the base must show the bug. For a new
capability, record "not on base" and verify the end state instead.

## Patch-id

A verdict describes a patch, not a SHA. With `BASE` resolved and fetched as
above, record:

```sh
git diff "$(git merge-base "$BASE" HEAD)" HEAD | git patch-id --verbatim | cut -d' ' -f1
```

On a later head, recompute. If the patch-id is the same, the verdict stands,
for example after a merge of the base that did not touch the PR's own
changes. `--verbatim` keeps whitespace, so a whitespace-only edit inside a
string still changes the id.

## Verdict

Write `.tmp/live-verify/<head-sha>.md` in this shape. The owning session
posts it unedited with `gh pr comment <n> --body-file <file>` and attaches
screenshots with `--attach` (waves-ship §4).

```markdown
<!-- live-verify -->
**Live verify: PASS+NOTES**
Head `<sha>` · patch-id `<id>` · verifier `<agent / model>`, did not write this change · rung 1

| Scenario | base | head | Evidence |
|---|---|---|---|
| Paid invoice shows receipt link | no link (bug) | link opens receipt | `mobile-390.png` |

**Notes:** one line each, with file:line and how to reproduce.
**Not exercised:** the path and why (including "out of trial scope").
**Caught beyond Codex:** yes or no. If yes, what, and which Codex round missed it.
```

- **PASS.** Every in-scope scenario from the review map behaved as
  intended, and the regression lane shows the change.
- **PASS+NOTES.** It works. Handle each note like a Codex P2.
- **FAIL.** A scenario misbehaved. Fix it with a red-first test covering
  every site of the same defect. The new head gets a fresh verdict. A note
  that describes a defect is a FAIL.
- **BLOCKED.** Nothing in scope could run. Name what was missing.
