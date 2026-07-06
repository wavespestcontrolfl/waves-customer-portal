---
name: waves-ship
description: Use for any code change destined for a wavespestcontrolfl repo — from creating the branch/worktree through pushing, Codex review, merging, Railway deploy verification, and dark-ship gate flips. Also use when checking whether a PR is safe to merge or whether a merged PR actually landed.
---

# Waves Ship — PR lifecycle for the portal and astro repos

## Purpose
Ship code changes through the Waves review/deploy pipeline without triggering the failure modes that have burned past sessions: wrong-branch commits, hijacked pushes, premature merges, silently-lost commits, and broken Railway builds. There is no GitHub Actions CI on the portal repo — the Codex pre-push hook, the @codex GitHub bot, and Railway's prebuild gates ARE the quality system, so this procedure is load-bearing.

## When to Use
- Starting any implementation task on waves-customer-portal or wavespestcontrol-astro.
- Pushing commits, opening PRs, responding to Codex reviews, merging, or verifying deploys.
- Deciding how to hand off fixes to a branch another session owns.

## Procedure

### 1. Start clean
- Work in a worktree, never in the bare host repo (`~/waves-customer-portal` is a bare/stale host): `git -C ~/waves-customer-portal fetch origin main && git -C ~/waves-customer-portal worktree add ~/wt-<slug> -b <branch> origin/main`.
- Branch off `origin/main`, never local main (base contamination). Audits and reviews also run against `origin/main`, not the current checkout — stale feature branches produce phantom findings; verify the ref before fanning out review agents.
- Fresh portal worktrees need `npm ci` before tests — `@waves/*` workspace packages are absolute symlinks; an interrupted install makes jest hang silently (fix: `rm -rf node_modules && npm ci`).
- Edit/Write files at the WORKTREE path. Writing to the original repo path edits the wrong branch's tree.

### 2. Before every commit
- `git branch --show-current` — auto-applied CLAUDE.md edits and parallel sessions can silently flip HEAD.
- Stage explicit paths. Never `git add -A` (the external Codex process leaves stray files).

### 3. Before every push
- If the diff touches `client/`: `npm run check:portal-brand` — one violation kills EVERY Railway build for everyone.
- If the diff touches blog schema: `npm run verify:blog-schema` (both run in Railway `prebuild`; catching it locally is the only pre-deploy chance).
- The pre-push hook runs a blocking ~30–60s Codex audit and blocks on P0. Only bypass (`SKIP_CODEX_REVIEW=1 git push --no-verify --no-thin`) when the external branch-hijack strikes — see REFERENCE.md.
- After EVERY push: `git ls-remote origin <branch>` and confirm the remote tip is your SHA. Re-check ~2 minutes later — an external Codex process has reset branches to `refs/codex/curated-sync` mid-push.

### 4. PR and Codex review
- `gh pr create --head <branch> --base main` — always explicit flags (shared-worktree sessions have opened PRs from the wrong head).
- Tag bare `@codex` on a fresh PR. After each subsequent push, post `@codex review` (a bare re-tag is a no-op; a quote-reply "> @codex" spawns a cloud code-editing task, not a review).
- Stacked PRs: open children as DRAFT and retarget them to `main` BEFORE the parent squash-merges — squash merges strand children (recurred 4×; GitHub only auto-retargets on head-branch deletion, which squash-merge flows don't guarantee).
- Run the full merge gate in CHECKLIST.md. Core rules:
  - Clean = an ISSUE comment containing the Reviewed-commit SHA that matches your final HEAD. A clean top-level with unresolved inline threads on the current head is NOT clean — check `original_commit_id`.
  - Inline findings lag the top-level wrapper by 1–2 minutes; poll until comment count is stable ~90s.
  - "Clean" includes P2s: fix every finding or rebut inline with file:line evidence. Never self-downgrade a P2 to a follow-up.
  - NEVER merge until Codex has completed on the final commit. Green CI + COMMENTED is not enough.
  - During Codex usage limits, a bounced re-tag is not queued — post a fresh one after reset. >15–20 min of silence on a heavy day usually means limits, not clean.

### 5. Merge and verify
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
Before reporting a shipped change as done, all of: final-commit-in-merge check passed; Codex clean on final HEAD (or findings rebutted inline); Railway deploy green (or Pages build green for astro); gate/kill-switch documented for user-visible features; remote tip verified after last push. If any step was skipped or impossible, say so explicitly — never imply it happened.

## Failure Modes
- Merging on a stale clean signal (Codex reviewed an earlier commit).
- Trusting "PR merged" as proof your last push landed.
- Pushing client/ changes without the brand check.
- Editing files in the bare host or another worktree's path.
- Claiming "deployed" when only "merged".
- `git checkout <ref> -- <path>` to read an old version (overwrites working tree) — use `git show <ref>:<path>`.

## Escalation
Ask Adam only for: gate flips on customer-facing features, pushes to main without a PR (requires his explicit "push to main"), and anything that would send customer-facing communications.
