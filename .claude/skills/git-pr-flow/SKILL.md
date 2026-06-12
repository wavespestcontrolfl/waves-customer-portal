---
name: git-pr-flow
description: Use at the start of any change (branching), before every commit/push, and when taking a PR through review to merge. Encodes the branch hygiene and Codex review flow this repo requires — multiple parallel Claude sessions share these checkouts, and these rules exist because each has been violated with real damage.
---

# Branch, commit, review, merge

## Branching

- Branch off **origin/main**, never local `main`:
  `git fetch origin && git checkout -B <branch> origin/main`
  (local main drifts behind and may carry un-pushed contamination).
- Prefer a dedicated worktree per task:
  `git worktree add ../waves-customer-portal-<task> -B <branch> origin/main`.
  Parallel sessions flip HEAD in shared checkouts; a worktree is the only
  reliable isolation. In a worktree session, Edit/Write the WORKTREE path —
  never the original repo path.
- Audit/review against `origin/main`, not the current checkout — stale
  feature branches produce phantom findings. Verify the ref before fanning
  out review agents.

## Before EVERY commit/push

- Re-verify `git branch --show-current` IMMEDIATELY before each
  commit/push — parallel sessions and auto-applied CLAUDE.md edits silently
  flip HEAD.
- Never `git checkout <ref> -- <path>` to read a file (it overwrites the
  working tree). Use `git show <ref>:<path>`.

## Codex review flow

1. Open the PR, tag **bare `@codex`** (first review).
2. After follow-up commits, re-request with **`@codex review`**.
3. Check the LIVE PR state before re-tagging — parallel sessions push and
   tag concurrently; pull current head + reviews first. Codex leaves both PR
   reviews AND inline file comments — check `.reviews` and
   `pulls/:n/comments`.
4. **Clean = ZERO findings including P2.** Fix all P0/P1/P2 or push back
   with reasoning; don't self-downgrade P2s to follow-ups.
5. Wait for the full PR review on the FINAL commit before merging — the
   pre-push hook is pre-flight only.

## Merging

- Never direct-push to main; branch → PR → merge unless explicitly told.
- "Already merged" ≠ your last commit landed: verify the merge SHA contains
  your final push (`git branch --contains <sha>` on the merge commit);
  recover via cherry-pick if not.
- Stacked PRs: squash-merging the parent strands the child — retarget the
  child to main BEFORE merging the parent (auto-retarget happens only on
  head-branch deletion). Verify the merge-base afterwards.
