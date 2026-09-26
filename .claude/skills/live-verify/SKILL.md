---
name: live-verify
description: Independent live verification of a finished change — an agent that did not write it runs the changed behavior on a dev/preview stack, compares it with main, and posts a PASS / PASS+NOTES / FAIL / BLOCKED verdict. Required before merging a Full-tier PR (waves-ship CHECKLIST.md). Not a substitute for tests, ui-verify, or Codex.
---

# Live verify

CI proves the tests pass. Codex reads the diff. Neither one runs the change.
This skill is the check that does: someone who did not write the code
exercises the changed behavior on a running stack, compares it with `main`,
and records what actually happened.

## Who and when

- **Verifier:** an agent that did not write the change — a fresh subagent
  (in Claude Code lanes, `tree-verifier`) or another session. The author's
  own `ui-verify` pass is still expected; it does not count as the verdict.
- **Brief:** PR number, head SHA, the PR body's review map, and the
  intended behavior in plain words. Derive the claims to test from the diff
  as well; do not take the PR body's account of what the code does on trust.
- **When:** once the head is code-ready, before the first `@codex` tag, so
  behavior bugs surface before review rounds are spent. Again before merge
  only when the patch-id changed (§Patch-id), and then only the scenarios
  whose files changed.
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
- A `GATE_*` flag is turned on only in the environment of your own local
  process, never on a shared deployment.
- Bound jest (`--runInBand`, or `-w 2` for a broad pattern).

## Evidence ladder

Use the highest rung the changed surface allows. Name any higher rung you
skipped and why.

1. **Real database journey.** Per `docs/development.md` §Application QA:
   `qa:database` → `dev:migrate` → `dev:doctor` → `qa:e2e` (or `qa:seed` for
   a fixture to drive by hand, credentials in the private
   `.tmp/qa/e2e/fixture.json`). Then drive the changed route or page on the
   managed `npm run dev` stack and read the resulting rows back.
2. **Real components, synthetic API.** The per-surface harnesses in
   `scripts/qa/` (`node scripts/qa/<name>`), `npm run qa:previews`, and
   `npm run audit:estimate-previews`. External requests are blocked.
3. **Direct execution.** Call the changed service function, job, or route
   handler with fixture input from a script under `.tmp/live-verify/` or a
   targeted test.

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
| Background job or cron | run the job's function once against the QA database from `.tmp/live-verify/` | rows before and after; a second run converges (idempotent) |
| Inbound webhook (Stripe, Twilio, SendGrid, Resend, Bouncie, ElevenLabs) | replay a signed synthetic payload at the local route, the way `qa:e2e` settles its webhook | response, resulting rows, and a replay that changes nothing |
| Intelligence Bar tool | `npm run test:contracts`, then `executeTool` against the QA database | tool output and any rows it wrote |
| LLM call site or prompt | the lane's eval if one exists (`eval:voice-relay`, `eval:call-replay`, `eval:lawn-diagnostic`), else one direct call with synthetic input. Evals need the model API key in that one process and contact no customer | the eval report, or input and output |
| Voice relay (Sandy) | `eval:voice-relay`. Live calls only through the sandbox number (CLAUDE.md), only when the owner has arranged one | eval report |
| Email or SMS template | rung 3: call the server render function with synthetic variables. The composing UI via `admin-email*.cjs` or `communications-sms-reliability.cjs`. Never send | rendered HTML screenshot or the final text |
| Dark `GATE_*` behavior | run the scenario with the gate unset and with it on, in your own process | both outputs. A "gate off is unchanged" claim is checked against `main`'s output |

## Regression lane

Run the same scenario on the PR's merge-base as well as the head, so the
verdict shows a change and not just a state. Use a throwaway worktree at
`$(git merge-base origin/main HEAD)` under `.tmp/live-verify/base` with its
own `npm ci` (never share `node_modules`). For a bug fix, the base must show
the bug. For a new capability absent on `main`, record "not on main" and
verify the end state the user waits for instead.

## Patch-id

A verdict describes a patch, not a SHA. Record, after `git fetch origin`:

```sh
git diff "$(git merge-base origin/main HEAD)" HEAD | git patch-id --stable | cut -d' ' -f1
```

Before merge, recompute on the final head. The same patch-id means the
verdict stands, for example after a merge of `main` that did not touch the
PR's own changes. CI and Codex still run on the new head. A different
patch-id needs a fresh verdict for the scenarios whose files changed. Never
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
```

- **PASS.** Every scenario from the review map behaved as intended on the
  highest available rung, and the regression lane shows the change.
- **PASS+NOTES.** Works. Each note is fixed, or deferred under
  `Deferred P2s` with the verifier's evidence.
- **FAIL.** A scenario misbehaved. The author fixes it with a red-first test
  covering every site of the same defect, and the new head gets a fresh
  verdict. A note describing a defect is a FAIL, not a note.
- **BLOCKED.** No rung could run, for example no verified dev cluster and no
  way to execute the code directly. Name the missing prerequisite. It blocks
  merge until it is resolved or Adam decides.
