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
- [ ] **(portal only)** `scripts/verify-pr-checks.sh` passed — PR head == my SHA, NOT CONFLICTING, and a `tests` pull_request run exists for this head (a CONFLICTING PR's workflow silently never fires, and a stale green from the OLD head is not CI). Read the "run attribution" line it prints: `exact` only when `VERIFY_PR_PUSH_AFTER` was set before the push; otherwise it is inferred, which cannot distinguish a leftover run from a same-SHA re-push. **After any force-push or recovery push, export that timestamp before pushing.** Astro repo: no script — check mergeable + the Pages build by hand.
- [ ] `@codex` (fresh PR) or `@codex review` (subsequent push) posted and not bounced

## CI green gate (separate from the trigger check above)
- [ ] The `tests` run for the FINAL head **concluded `success`** — `gh pr checks <n>` shows every job pass. `verify-pr-checks.sh` proves CI is ALIVE, not that it passed, and exits 0 on a run that is still in progress or that failed/was cancelled/skipped. Nothing else in this checklist requires a green conclusion, so without this box an operator can satisfy every item and merge on red CI.

## Codex gate (all, on the FINAL commit)
- [ ] Codex completed on the final HEAD: either the clean issue comment (Reviewed-commit SHA == final HEAD) or a review whose findings anchor to the final HEAD
- [ ] PR reviews + inline comments polled with `--paginate`; count stable for 15 min after the wrapper (inline findings have lagged it by up to ~12 min — #3669 r4)
- [ ] Zero unresolved P0/P1 on the current head (`original_commit_id` checked for staleness): each one fixed or rebutted inline with file:line evidence
- [ ] Every P2 on the current head is fixed, rebutted inline, or listed under `Deferred P2s` in the PR body with file:line + reason — nothing silently unaddressed
- [ ] Round history checked: if round 5 or later produced a NEW P0/P1, this PR is a split proposal for Adam, not a merge

## Merge authorization
- [ ] Blast-radius diff (AGENTS.md P0 domains / CLAUDE.md rule-18 contracts: money, customer comms, schema/CHECK values, public token routes, webhooks, admin auth, native-app endpoints)? → Adam's in-session authorization is REQUIRED; standing "merge when clean" does not apply
- [ ] Otherwise: Adam authorized this merge in-session, OR a standing "merge when clean" applies AND the Codex gate above passed (a rebutted round qualifies)
- [ ] If the PR was just un-drafted: the deeper un-draft review has completed on the final HEAD
- [ ] Squash commit message checked — it comes from the commit message (written from a file), not the PR title

## Post-merge
- [ ] Final commit landed: `gh pr view <n> --json headRefOid` == final push SHA (squash rewrites SHAs — ancestry check only valid for true merge commits)
- [ ] Railway deploy green (portal) / Pages builds green (astro)
- [ ] Stacked children retargeted to main (should have happened BEFORE merge)
- [ ] Gate/kill-switch documented; prod behavior spot-checked if a gate was flipped
- [ ] Worktree removed if the lane is closed
