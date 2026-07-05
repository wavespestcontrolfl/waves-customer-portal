# waves-ship merge gate checklist

Run top to bottom before merging any portal/astro PR. Every unchecked item is a blocked merge.

## Pre-push
- [ ] `git branch --show-current` matches the intended branch
- [ ] Staged explicit paths only (no `git add -A`)
- [ ] Diff touches `client/` → `npm run check:portal-brand` passes
- [ ] Diff touches blog schema → `npm run verify:blog-schema` passes
- [ ] New raw SQL / migration → waves-db skill verification done (read-only prod check; BEGIN…ROLLBACK dry-run on dev/preview)
- [ ] Money-touching diff → waves-billing invariants reviewed

## Post-push
- [ ] `git ls-remote origin <branch>` shows my SHA
- [ ] Re-checked remote tip ~2 min later (external Codex hijack watch)
- [ ] `@codex` (fresh PR) or `@codex review` (subsequent push) posted and not bounced

## Codex clean gate (all four, on the FINAL commit)
- [ ] Issue comment exists with Reviewed-commit SHA == final HEAD
- [ ] PR reviews + inline comments polled with `--paginate`; count stable for ~90s
- [ ] Every finding on the current head (`original_commit_id` checked for staleness) — including P2s — is either fixed or rebutted inline with file:line evidence; nothing self-downgraded to a follow-up
- [ ] No finding left silently unaddressed

## Post-merge
- [ ] Final commit landed: `gh pr view <n> --json headRefOid` == final push SHA (squash rewrites SHAs — ancestry check only valid for true merge commits)
- [ ] Railway deploy green (portal) / Pages builds green (astro)
- [ ] Stacked children retargeted to main (should have happened BEFORE merge)
- [ ] Gate/kill-switch documented; prod behavior spot-checked if a gate was flipped
- [ ] Worktree removed if the lane is closed
