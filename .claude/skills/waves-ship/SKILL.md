---
name: waves-ship
description: Use for any code change destined for a wavespestcontrolfl repo — from creating the branch/worktree through pushing, Codex review, merging, Railway deploy verification, and dark-ship gate flips. Also use when checking whether a PR is safe to merge or whether a merged PR actually landed.
---

# Waves Ship — PR lifecycle for the portal and astro repos

## Purpose
Ship code changes through the Waves review/deploy pipeline without triggering the failure modes that have burned past sessions: wrong-branch commits, hijacked pushes, premature merges, silently-lost commits, and broken Railway builds. The quality system is the Codex pre-push hook, the @codex GitHub bot, the GitHub Actions `tests` workflow (`.github/workflows/tests.yml`, since 2026-07-12 — server/client/gates/native jobs on every PR), and Railway's prebuild gates — so this procedure is load-bearing. ⚠️ The tests workflow SILENTLY NEVER FIRES for a CONFLICTING PR (the pull_request merge ref can't be built), leaving a stale green from the old head — that check is automated in §4.

## When to Use
- Starting any implementation task on waves-customer-portal or wavespestcontrol-astro.
- Pushing commits, opening PRs, responding to Codex reviews, merging, or verifying deploys.
- Deciding how to hand off fixes to a branch another session owns.

## Procedure

### 1. Start clean
- Work in a worktree, never in the bare host repo (`~/waves-customer-portal` is a bare/stale host): `git -C ~/waves-customer-portal fetch origin main && git -C ~/waves-customer-portal worktree add ~/wt-<slug> -b <branch> origin/main`.
- Branch off `origin/main`, never local main (base contamination). Audits and reviews also run against `origin/main`, not the current checkout — stale feature branches produce phantom findings; verify the ref before fanning out review agents.
- An audit finding needs TWO proofs before it's reported as live: it exists on `origin/main` AND it's reachable (page routed in `App.jsx`, function imported outside tests, path actually fires in prod). One phantom finding → re-verify every other finding in the same batch.
- Fresh portal worktrees need `npm ci` before tests — `@waves/*` workspace packages are absolute symlinks; an interrupted install makes jest hang silently (fix: `rm -rf node_modules && npm ci`).
- Edit/Write files at the WORKTREE path. Writing to the original repo path edits the wrong branch's tree.

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
- **PORTAL ONLY — after every push once the PR exists, RUN `scripts/verify-pr-checks.sh` (don't just remember the rule)** — it verifies the remote tip is your SHA, the PR head matches, the PR is not CONFLICTING, and a `tests` pull_request run exists for your head SHA, attributable to this push (re-verifying both heads after the wait; it prints whether attribution is `exact` or `inferred`). The script lives in the portal repo and hardcodes that repo + `tests.yml`; **the astro repo has no equivalent — there, check mergeable and the Pages build by hand** (see Astro-repo differences below). A CONFLICTING PR makes the tests workflow silently never fire (bit #3251 and #3253 the same night) — whenever CI looks green-but-quiet, this script is the check. On failure it prints the fix (merge origin/main, push, re-tag `@codex review`).
- Tag bare `@codex` on a fresh PR. After each subsequent push, post `@codex review` (a bare re-tag is a no-op; a quote-reply "> @codex" spawns a cloud code-editing task, not a review).
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
- **Merging is Adam's step.** A self-authored PR stops at MERGE-READY unless Adam explicitly authorized merging in this session — "ok go" on a build plan authorizes building and opening the PR, not merging it.
- Under a standing "merge when clean" authorization, clean = the §4 gate on the final HEAD: zero unresolved P0/P1 (a P0/P1 rebuttal is resolved only after Adam accepts it or a confirmation round on the same head leaves it undisputed; a re-disputed one is unresolved), every P2 fixed, rebutted, or listed as deferred in the PR body. A rebutted round qualifies. A round-cap stop (new P0/P1 at round 5+) does NOT — that PR goes back to Adam with a split proposal.
- Standing authorization never covers a blast-radius diff: anything touching an AGENTS.md P0 domain or ANY CLAUDE.md rule-18 contract. Rule 18 is the authority and its list is the whole list — money movement, customer comms, DB schema and CHECK-constrained values, public `/:token` routes, every inbound webhook payload, admin auth, iOS/Android-consumed endpoints (push/app-link payloads included), astro spoke-fleet form posts and feeds, the retained V1 named exports, persisted identifiers. Read rule 18 before deciding a diff is not blast-radius. Those stop at MERGE-READY with the severity summary and wait for Adam's in-session authorization.
- After merge: confirm your final commit actually landed — "PR merged" doesn't prove it. Squash merges rewrite SHAs, so ancestry checks fail even on success: check `gh pr view <n> --json state,headRefOid,mergeCommit` and confirm `headRefOid` equals your final push SHA. Only for true merge commits does `git merge-base --is-ancestor <final-sha> <merge-sha>` apply. If your last push isn't in the merged head, recover via cherry-pick.
- Confirm the Railway deploy went green before reporting done. A merged PR with a red deploy is not shipped.
- Clean up the worktree when the lane closes: `git worktree remove ~/wt-<slug>`.

### 6. Dark-ship pattern (user-visible features)
- New user-visible behavior ships behind an env-var gate (`GATE_*`) or query param, default OFF in prod. Name the kill switch in the PR body.
- Owner (Adam) flips gates — never flip a customer-facing gate without his authorization.
- After a gate flip, verify in prod (the gated page/flow renders; the kill switch works).

### 7. Parallel sessions
- Another session's hot branch (tip moved recently): deliver fixes as committable PR review suggestions, never competing pushes. One PR = one session.
- Pull the LIVE PR state before commenting or re-tagging @codex — pasted snapshots go stale.

### Astro-repo differences
- Every push fans out builds across the whole Cloudflare Pages fleet (1 concurrent build account-wide; hub lags 30–45 min) — batch changes, pace commits.
- Bump `modified:` frontmatter on any content edit (drives sitemap lastmod).
- Brand-isolation CI fails the PR on hardcoded "Waves Pest Control"/hub URLs in spoke-shared content — use `{{brandName}}`-style tokens.

## Verification
Before reporting a shipped change as done, all of: final-commit-in-merge check passed; Codex gate passed on final HEAD (zero unresolved P0/P1 — every P0/P1 rebuttal confirmed by a later Codex round or accepted by Adam, none re-disputed and awaiting Adam; every P2 fixed, rebutted inline, or listed under Deferred P2s in the PR body); Railway deploy green (or Pages build green for astro); gate/kill-switch documented for user-visible features; remote tip verified after last push. If any step was skipped or impossible, say so explicitly — never imply it happened.

## Failure Modes
- Merging on a stale clean signal (Codex reviewed an earlier commit).
- Self-merging without in-session authorization, or self-merging a blast-radius diff under a standing authorization.
- Blocking a merge on P2 nits, or re-pushing to fish for a zero-comment round — the gate is severity-based and the round cap exists for this reason.
- Piping jest through `grep`/`tail` for pass/fail — it masks the exit code (a failing test shipped this way once). Run bare and check the exit code.
- Trusting "PR merged" as proof your last push landed.
- Pushing client/ changes without the brand check.
- Editing files in the bare host or another worktree's path.
- Claiming "deployed" when only "merged".
- `git checkout <ref> -- <path>` to read an old version (overwrites working tree) — use `git show <ref>:<path>`.

## Escalation
Ask Adam only for: merging a self-authored PR (unless authorized in-session — see §5), gate flips on customer-facing features, pushes to main without a PR (requires his explicit "push to main"), and anything that would send customer-facing communications.
