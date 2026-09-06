---
name: waves-ship
description: Use for Waves implementation workspace safety, PR preparation, review remediation, authorized merge/deploy verification, and interrupted-task handoff. Apply only the stages authorized by the task. Do not activate merely because an audit or explanation mentions shipping.
---

# Waves Ship — PR lifecycle for the portal and astro repos

## Purpose
Ship code changes through the Waves review/deploy pipeline without triggering the failure modes that have burned past sessions: wrong-branch commits, hijacked pushes, premature merges, silently-lost commits, and broken Railway builds. The quality system is the Codex pre-push hook, the @codex GitHub bot, the GitHub Actions `tests` workflow (`.github/workflows/tests.yml`, since 2026-07-12 — server/client/gates/native jobs on every PR), and Railway's prebuild gates — so this procedure is load-bearing. ⚠️ The tests workflow SILENTLY NEVER FIRES for a CONFLICTING PR (the pull_request merge ref can't be built), leaving a stale green from the old head — that check is automated in §4.

## When to Use
- Starting any implementation task on waves-customer-portal or wavespestcontrol-astro.
- Pushing commits, opening PRs, responding to Codex reviews, merging, or verifying deploys.
- Deciding how to hand off fixes to a branch another session owns.

## Scope and completion

Identify the requested outcome and existing approval before applying the
procedure. A local implementation does not require push, PR, merge, deploy,
or a gate flip to be complete. A read-only task does not authorize writes.
Tool permissions and the explicit merge, blast-radius, gate, and customer
communication boundaries remain in force.

Report the achieved state precisely: audit complete; implementation
complete locally; verification blocked; PR ready for review; merge-ready,
awaiting authorization; or deployed and verified. Include missing evidence
without implying it was obtained.

Run required checks for the applicable stage. Reuse recorded results only
when the checked code, environment, and relevant inputs are unchanged.
Repeat checks for changed code, failures, or unresolved risk; preserve
all final-HEAD CI and Codex requirements.

## Procedure

### 1. Start clean
- Record the repository/worktree path, branch, HEAD, and existing changes.
  Verify checkout state; do not assume a named path is bare, stale, or idle.
- For implementation, use a task-owned worktree. Reuse the selected
  task-owned worktree when suitable; create another only when the authorized
  work requires isolation. Preserve unrelated changes.
- When creating a new branch and worktree, resolve and record the user-selected base, or
  a refreshed `origin/main` when no base was selected. Pass that revision
  explicitly: `git worktree add <path> -b <branch> <base-sha>`; never rely
  on the current checkout's HEAD as the implicit base.
- When attaching an existing selected branch, verify its recorded SHA and
  check `git worktree list` before `git worktree add <path> <branch>`.
  Do not recreate or reset the branch with `-b`/`-B`, or use `--force` to
  bypass another worktree's checkout. If it is already checked out, reuse
  only a suitable task-owned worktree or follow the §7 handoff rule.
- Record whether this task created or reused the worktree. Selecting or
  reusing an existing worktree does not authorize removing it.
- For audits and reviews, use the user's selected branch, worktree, diff,
  or commit. Record the resolved SHA(s). Read-only review does not require
  creating a worktree.
- For an audit explicitly seeking current production defects, establish
  the deployed revision and reachability. State whether origin/main was
  refreshed and whether deployment was verified; never silently substitute
  origin/main for another selected target.
- Check dependency availability before installing. Follow the selected
  checkout's setup procedure only when execution requires it. Write only
  at the task-owned worktree path. For portal runtime verification, follow
  `docs/development.md`: run `worktree:setup` in manually created worktrees
  and the relevant `dev:doctor` before managed startup. `worktree:create`
  creates a new branch from refreshed origin/main and installs dependencies;
  use it only when those effects and that base match the authorized task.

### 2. Before every commit
- `git branch --show-current` — auto-applied CLAUDE.md edits and parallel sessions can silently flip HEAD.
- Stage explicit paths. Never `git add -A` (the external Codex process leaves stray files, and a live-edit fetch-stub under `client/public/__stub/` is REAL prod payload — a stub once reached the public repo and forced a token rotation; gitignore `client/public/__stub/` in every worktree that uses the rig BEFORE the first commit).
- Write the commit message from a FILE (`git commit -F`), never reconstructed from `git log` — squash-merge uses the COMMIT MESSAGE, not the PR title, so this text is what lands on main.

### 3. Before every push
- If the diff touches `client/`: `npm run check:portal-brand` — one violation kills EVERY Railway build for everyone.
- If the diff changes a public API contract (`server/routes/*` request shape, a newly required field, an endpoint rename): sweep EXTERNAL consumers before shipping — the astro repo (`wavespestcontrol-astro`) posts to these routes from BookingForm/QuoteForm/ChatWidget/EstimateForm and more. `grep -rn "<route path>" ../wavespestcontrol-astro/src/` for every touched route; a consumer that doesn't send the new required field must be updated in the SAME change window. (July 2026: #2572 made /booking/confirm require slot_sig, the astro form was missed, and online booking silently 409'd for 8 days.)
- If the diff touches blog schema: `npm run verify:blog-schema` (both run in Railway `prebuild`; catching it locally is the only pre-deploy chance).
- The pre-push hook runs a blocking ~30–60s Codex audit and blocks on P0. Only bypass (`SKIP_CODEX_REVIEW=1 git push --no-verify --no-thin`) when the external branch-hijack strikes — see REFERENCE.md.
- After EVERY push: `git ls-remote origin <branch>` and confirm the remote tip is your SHA. Re-check ~2 minutes later — an external Codex process has reset branches to `refs/codex/curated-sync` mid-push.
- **Before any FORCE-push or recovery push (re-pushing a SHA that was already the tip), capture `export VERIFY_PR_PUSH_AFTER=$(date -u +%Y-%m-%dT%H:%M:%SZ)` FIRST and pass it to `verify-pr-checks.sh` afterwards.** A leftover CI run from the earlier push looks identical to a fresh one, and the script's reflog-based detection can't see a hijack that moved the remote without your tracking ref being fetched. Normal pushes of new commits need nothing extra. Never pipe a push through `| tail` — it swallows the hook's verdict.
- If the pre-push hook blocked or produced no output: the findings JSON + codex logs survive at `$(git rev-parse --absolute-git-dir)/codex-review-last/` — read them there instead of re-rolling the audit (its counts are nondeterministic run-to-run).

### 4. PR and Codex review
- `gh pr create --head <branch> --base main` — always explicit flags (shared-worktree sessions have opened PRs from the wrong head).
- **Screenshots and recordings go on the PR as native attachments** — never a local path, a pasted base64 blob, or a third-party image host. `gh` ≥ 2.99.0 (2026-09-01) adds a repeatable `--attach <file>` to `gh pr create` / `gh pr edit` / `gh pr comment` (and `gh issue create` / `edit` / `comment`). Alt text via a `#` suffix: `--attach './login.png#Login error state'`. Formats: PNG, JPEG, GIF, WebP, SVG, MP4, MOV, WebM; 10 MB for images/GIFs, 100 MB for video on a paid plan. A Markdown image reference in the body to an attached file is rewritten in place; unreferenced attachments append at the end. Needs write access and an OAuth or classic PAT token; GitHub Enterprise Server is unsupported. Use `gh pr create --attach` on a new PR and `gh pr edit --attach` to update an existing PR's description (`gh pr comment --attach` adds a separate comment and leaves the description stale). Check `gh --version` first — older builds reject the flag. **Fallback below 2.99** (Codex environments, machines where the Homebrew bottle has not caught up): put the vision findings in the PR body as text, state that the screenshots were reviewed in-session but not attached, and upgrade `gh` at the next opportunity; still never paste base64 or link an external image host. UI PRs attach the ui-verify desktop + mobile screenshots this way. Source: https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/
- **PORTAL ONLY — after every push once the PR exists, RUN `scripts/verify-pr-checks.sh` (don't just remember the rule)** — it verifies the remote tip is your SHA, the PR head matches, the PR is not CONFLICTING, and a `tests` pull_request run exists for your head SHA, attributable to this push (re-verifying both heads after the wait; it prints whether attribution is `exact` or `inferred`). The script lives in the portal repo and hardcodes that repo + `tests.yml`; **the astro repo has no equivalent — there, check mergeable and the Pages build by hand** (see Astro-repo differences below). A CONFLICTING PR makes the tests workflow silently never fire (bit #3251 and #3253 the same night) — whenever CI looks green-but-quiet, this script is the check. On failure it prints the fix (merge origin/main, push, re-tag `@codex review`).
- Tag bare `@codex` on a fresh PR. After each subsequent push, post `@codex review` (a bare re-tag is a no-op; a quote-reply "> @codex" spawns a cloud code-editing task, not a review).
- **A pending review is a wait, not a handoff.** After tagging Codex, keep polling the PR (paginated reviews + issue comments, every 3–5 min; the 15-min stable-count rule and the limits-silence rule in the gate below still apply) until the round lands, then fix, rebut, or defer per the gate and re-tag. Use a scheduled wakeup or a bash poll loop for the wait. Adam having to report "N has codex comments" means this step was skipped (owner ruling 2026-09-05). The same applies to CI: wait for the `tests` conclusion instead of reporting "CI pending".
- **Stop reasons (the whole list).** A lane comes back to Adam mid-flight only for: (1) a design or functionality question the codebase and owner rulings cannot answer; (2) a blast-radius diff under CLAUDE.md rule 18 or an AGENTS.md P0 domain, reported at MERGE-READY; (3) a round-cap stop with a split proposal; (4) a re-disputed P0/P1 rebuttal. Splitting a PR, choosing how to fix a finding, tagging, and merging a clean non-blast-radius PR are not stop reasons. Write the stop reason in the PR body under `Open for Adam`.
- Stacked PRs: open children as DRAFT and retarget them to `main` BEFORE the parent squash-merges — squash merges strand children (recurred 4×; GitHub only auto-retargets on head-branch deletion, which squash-merge flows don't guarantee).
- Run the full merge gate in CHECKLIST.md. Core rules:
  - Codex-complete on a HEAD = either the clean ISSUE comment whose Reviewed-commit SHA matches your final HEAD, or a review whose inline threads anchor to it (Codex never emits both — REFERENCE.md). A clean top-level with unresolved inline threads on the current head is NOT complete — check `original_commit_id`.
  - Inline findings lag the top-level wrapper — usually 1–2 minutes, but up to ~12 minutes on a heavy round (bit #3669 r4: three findings landed 12 min after the wrapper, after the fix for the first had already been pushed). Poll until comment count is stable for 15 minutes after the wrapper before treating a round as fully delivered.
  - **The gate is severity-based, not count-based.** Two scales exist: the GitHub `@codex` review badges findings P0–P3 (P3 = lightgrey advisory badge); the pre-push hook's schema (`.github/codex-review-schema.json`) has only P0–P2, where its P2 covers what GitHub splits into P2 and P3. The merge gate is defined on the GitHub scale: P0 = security/money/data loss, P1 = correctness/footgun, P2 = should-fix quality (AGENTS.md flags speculative abstraction and leftover compat shims here), P3 = advisory. This is the same bar the autonomous blog lane already enforces in code (`server/services/content/codex-remediation.js`, the P2-only merge bar: P0/P1 always block, a P2/P3-only round is mergeable once a remediation round has been spent).
  - Merge-ready = zero UNRESOLVED P0/P1 on the final HEAD. A P0/P1 is resolved only when it is FIXED, or when its inline rebuttal (file:line evidence) has been ACCEPTED — by Adam in-session, or by a subsequent Codex round on that same head that does not re-dispute it. An unevaluated rebuttal is unresolved: after rebutting a P0/P1, post `@codex review` and wait for the confirmation round (if Codex will not re-review an unchanged head, use the empty nudge commit from REFERENCE.md). That is one confirmation round, not fishing.
  - P2s: fix when the fix is local and adds no surface (a few lines in files already in the diff). Otherwise rebut inline, or defer it — list it under a `Deferred P2s` heading in the PR body with file:line and one line of why. A listed deferral is addressed; an unlisted P2 is silently unaddressed and blocks. P3s are advisory: no action or listing required.
  - A rebutted round IS a clean round once its P0/P1 rebuttals are accepted per the bullet above; P2 rebuttals need no confirmation round. If Codex re-disputes a P0/P1 rebuttal, stop re-arguing and do not push again for it: it stays UNRESOLVED and needs Adam's decision before any merge (standing authorization included) — record it under an `Open for Adam` heading in the PR body. A re-disputed P2 goes under `Deferred P2s` with the rebuttal and does not block.
  - Round cap: from round 4 on, a round that yields only P2s makes the PR merge-ready under the P2 rule. If round 5 or later still surfaces a NEW P0/P1, the PR is too large to converge — stop, report the round history, and propose a split. Never push to fish for a zero-comment round: Codex's counts are nondeterministic run-to-run (REFERENCE.md), so a zero is a lucky draw, not evidence.
  - NEVER merge until Codex has completed on the final commit. Green CI + COMMENTED is not enough.
  - During Codex usage limits, a bounced re-tag is not queued — post a fresh one after reset. >15–20 min of silence on a heavy day usually means limits, not clean.

### 5. Merge and verify
- **Merge when clean is the standing default** (owner ruling 2026-09-05: agents own review follow-through, splits, tagging, and merging; only design/functionality questions come back). A self-authored PR that passes the §4 gate on its final HEAD is merged by the session that owns it — no in-session "merge" message is required. The only PRs that stop at MERGE-READY are the ones named under Stop reasons in §4: blast-radius diffs, round-cap stops, and re-disputed P0/P1s.
- **Continue the lane.** After a verified merge, if the lane has another PR (a stacked child, or a planned next PR named in the lane memory or PR body), start it in the same session without waiting for a prompt. Report the lane state when the lane is done or a stop reason lands, not after each PR.
- Clean = the §4 gate on the final HEAD: zero unresolved P0/P1 (a P0/P1 rebuttal is resolved only after Adam accepts it or a confirmation round on the same head leaves it undisputed; a re-disputed one is unresolved), every P2 fixed, rebutted, or listed as deferred in the PR body. A rebutted round qualifies. A round-cap stop (new P0/P1 at round 5+) does NOT — that PR goes back to Adam with a split proposal.
- Standing authorization never covers a blast-radius diff: anything touching an AGENTS.md P0 domain or ANY CLAUDE.md rule-18 contract. Rule 18 is the authority and its list is the whole list — money movement, customer comms, DB schema and CHECK-constrained values, public `/:token` routes, every inbound webhook payload, admin auth, iOS/Android-consumed endpoints (push/app-link payloads included), astro spoke-fleet form posts and feeds, the retained V1 named exports, persisted identifiers. Read rule 18 before deciding a diff is not blast-radius. Those stop at MERGE-READY with the severity summary and wait for Adam's in-session authorization.
- After merge: confirm your final commit actually landed — "PR merged" doesn't prove it. Squash merges rewrite SHAs, so ancestry checks fail even on success: check `gh pr view <n> --json state,headRefOid,mergeCommit` and confirm `headRefOid` equals your final push SHA. Only for true merge commits does `git merge-base --is-ancestor <final-sha> <merge-sha>` apply. If your last push isn't in the merged head, recover via cherry-pick.
- For an authorized merged release, confirm the Railway deploy went green
  before reporting it deployed. Local and PR-only tasks use the completion
  states above.
- When the lane closes, remove only a worktree created by this task, after
  confirming its changes are preserved, no other session is using it, and
  no process or shared dependency still needs it. Never force removal.
  Leave reused worktrees in place unless the owner explicitly authorizes
  their removal.

### 6. Dark-ship pattern (user-visible features)
- New user-visible behavior ships behind an env-var gate (`GATE_*`) or query param, default OFF in prod. Name the kill switch in the PR body.
- Owner (Adam) flips gates — never flip a customer-facing gate without his authorization.
- After a gate flip, verify in prod (the gated page/flow renders; the kill switch works).

### 7. Parallel sessions
- Another session's hot branch (tip moved recently): deliver fixes as committable PR review suggestions, never competing pushes. One PR = one session.
- Pull the LIVE PR state before commenting or re-tagging @codex — pasted snapshots go stale.
- **Paginate every Codex comment read**: `gh api --paginate "repos/{owner}/{repo}/pulls/N/comments?per_page=100"`. The REST default is 30 per page; once threads plus replies pass 30, the newest findings fall off the end and a round reads as 2 findings when it was 3 (#3818 r5 missed a P1 this way, 2026-09-03). Counting by `created_at > tag time` does not help — the cut-off is positional.

When interrupted or handing off, record:
- Objective and acceptance criteria.
- Repository/worktree, branch, HEAD, and relevant dirty/index state.
- Changes made and unrelated work to preserve.
- Checks, exact checked state, and results.
- First concrete blocker.
- Existing approval, its source, and scope.
- Next safe action.

Keep secrets, customer records, and raw transcripts out. On resume,
revalidate the code state and ownership before relying on the handoff.
A quiet worktree or old memory note alone does not establish ownership.

### Astro-repo differences
- Every push fans out builds across the whole Cloudflare Pages fleet (1 concurrent build account-wide; hub lags 30–45 min) — batch changes, pace commits.
- Bump `modified:` frontmatter on any content edit (drives sitemap lastmod).
- Brand-isolation CI fails the PR on hardcoded "Waves Pest Control"/hub URLs in spoke-shared content — use `{{brandName}}`-style tokens.

## Verification
Before reporting a shipped change as done, all of: final-commit-in-merge check passed; Codex gate passed on final HEAD (zero unresolved P0/P1 — every P0/P1 rebuttal confirmed by a later Codex round or accepted by Adam, none re-disputed and awaiting Adam; every P2 fixed, rebutted inline, or listed under Deferred P2s in the PR body); Railway deploy green (or Pages build green for astro); gate/kill-switch documented for user-visible features; remote tip verified after last push. If any step was skipped or impossible, say so explicitly — never imply it happened.

## Failure Modes
- Merging on a stale clean signal (Codex reviewed an earlier commit).
- Self-merging a blast-radius diff, a round-cap stop, or a PR with a re-disputed P0/P1 — the §4 stop reasons hold regardless of the merge-when-clean default.
- Ending the turn with a Codex round or CI run pending, so Adam has to relay the result.
- Blocking a merge on P2 nits, or re-pushing to fish for a zero-comment round — the gate is severity-based and the round cap exists for this reason.
- Piping jest through `grep`/`tail` for pass/fail — it masks the exit code (a failing test shipped this way once). Run bare and check the exit code.
- Trusting "PR merged" as proof your last push landed.
- Pushing client/ changes without the brand check.
- Editing files outside the selected task-owned worktree or overwriting unrelated work.
- Claiming "deployed" when only "merged".
- `git checkout <ref> -- <path>` to read an old version (overwrites working tree) — use `git show <ref>:<path>`.

## Escalation
Ask Adam only for: the four §4 stop reasons (a design/functionality question, a blast-radius diff at MERGE-READY, a round-cap split, a re-disputed P0/P1), gate flips on customer-facing features, pushes to main without a PR (requires his explicit "push to main"), and anything that would send customer-facing communications.
