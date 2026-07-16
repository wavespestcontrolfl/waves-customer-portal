---
description: Commit, push, and open/refresh the PR for the current work via the waves-ship flow
argument-hint: optional context (e.g. "no PR yet, just push" or extra notes for the PR body)
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git branch --show-current), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(git ls-remote:*), Bash(npm run check:portal-brand), Bash(npm run verify:blog-schema), Bash(gh pr view:*), Bash(gh pr create:*), Bash(gh pr comment:*)
---

## Current state (precomputed)

- Branch: !`git branch --show-current`
- Status: !`git status --porcelain=v1 -b`
- Uncommitted changes: !`git diff --stat HEAD`
- Branch vs origin/main (committed, unshipped): !`git diff --stat origin/main...HEAD`
- Recent commits: !`git log --oneline -5`

## Task

Ship the work shown above. Load and follow the `waves-ship` skill — it is the
authoritative procedure. Non-negotiables from it:

1. Confirm the branch above is the one this session owns before committing.
2. Stage explicit paths only — never `git add -A`.
3. If `client/` appears in EITHER diff above (uncommitted OR branch vs
   origin/main), run `npm run check:portal-brand` before pushing. If blog
   schema is touched, run `npm run verify:blog-schema`.
4. Commit with a clear, descriptive message.
5. Push, then verify the remote tip matches your SHA (`git ls-remote`).
   `git push` and `gh api` are deliberately NOT pre-approved — push is the
   irreversible step and `gh api` can write, so each prompts once. Never
   push with `--no-verify`/`-f` here; hook bypass is a waves-ship
   REFERENCE.md escape hatch, not a /ship default.
6. Open the PR (or update the existing one) per the waves-ship procedure,
   including the @codex tagging rules and the merge gate.

Additional context for this run: $ARGUMENTS
