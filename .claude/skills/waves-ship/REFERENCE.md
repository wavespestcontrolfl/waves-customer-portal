# waves-ship reference — Codex signal detection & push-hazard recovery

## Reading Codex's verdict (the reliable way)

Codex has two mutually exclusive output shapes:
- **Clean** → an ISSUE comment ("no major issues" + `Reviewed-commit <sha>`). It does NOT appear in `/reviews`.
- **Findings** → a PR review + inline comments. There may be NO issue comment at all.

Poll BOTH endpoints, always with `--paginate` and the `repos/` prefix (page 1 returns the OLDEST 30 comments — an unpaginated read produces a false clean):

```sh
gh api --paginate repos/wavespestcontrolfl/waves-customer-portal/issues/<PR>/comments --jq '.[] | {user: .user.login, body: .body[0:200]}'
gh api --paginate repos/wavespestcontrolfl/waves-customer-portal/pulls/<PR>/reviews --jq '.[] | {user: .user.login, state, body: .body[0:200]}'
gh api --paginate repos/wavespestcontrolfl/waves-customer-portal/pulls/<PR>/comments --jq '.[] | {path, original_commit_id, body: .body[0:200]}'
```

Distinguish stale vs fresh inline threads by `original_commit_id`: a thread anchored to an old commit you've since fixed is stale; a thread anchored to your current HEAD is a live finding. GraphQL `reviewThreads` gives `isResolved` if needed.

Timing: inline P1/P2 comments land ~1–2 minutes AFTER the top-level wrapper. Poll until the total comment count is stable for ~90 seconds before treating the review as complete.

## Codex quirks
- Bare `@codex` only works on the first tag of a PR. Re-reviews need the literal text `@codex review`.
- Quote-replying (`> @codex …`) spawns a cloud TASK that edits code — never use it to request a review.
- During usage limits, bounced/swallowed re-tags are NOT queued. Post a fresh `@codex review` after the limit resets. Silence >15–20 min on a heavy usage day = assume limited, not clean.
- If Codex infra is flaky (tag ignored, no bounce): push an empty commit (`git commit --allow-empty -m "nudge codex"`) and re-tag fresh — this has revived stuck reviews.

## The external push-hijack hazard

An EXTERNAL Codex process (not the tracked pre-push hook) can reset your remote branch to `refs/codex/curated-sync` mid-push. Symptoms: push "succeeds" but `ls-remote` shows a foreign SHA, or your branch tip silently moves.

Recovery:
```sh
SKIP_CODEX_REVIEW=1 git push --no-verify --no-thin origin <local-sha>:refs/heads/<branch> --force-with-lease
git ls-remote origin <branch>   # verify NOW
sleep 120 && git ls-remote origin <branch>   # verify AGAIN — the process can re-strike
```
Always push by explicit `sha:ref` when recovering. The tracked hook at `scripts/hooks/pre-push` (wired via `core.hooksPath` in the npm `prepare` script) is innocent — it's a read-only Codex audit that blocks P0 findings and fails open on infra errors.

## Pre-push hook facts
- Lives at `scripts/hooks/pre-push` (NOT `.git/hooks/` — AGENTS.md's claim of `.git/hooks/pre-push` is stale).
- Runs `codex exec --sandbox read-only` against the diff vs `origin/main` (override base with `CODEX_REVIEW_BASE`).
- Blocks on P0, warns on P1, output schema at `.github/codex-review-schema.json`.
- Bypass: `SKIP_CODEX_REVIEW=1` — use only for hijack recovery or docs-only emergencies; the GitHub bot still reviews the PR.

## Worktree & workspace traps
- `@waves/*` packages are ABSOLUTE symlinks; removing the worktree they point into breaks other builds — if a worktree owns a symlink target, copy the package into the bare repo `packages/` and relink relatively before removing.
- Interrupted `npm install` → jest hangs with no error. Fix: `rm -rf node_modules && npm ci`.
- Never `git stash` bare in a shared worktree (another session may pop it) — commit to a WIP branch instead.

## Review rulebook
The content standard for what Codex flags (and what you should self-check before pushing) is `AGENTS.md` at the repo root — P0/P1 rules citing the files they protect. Read the relevant section before touching Stripe webhooks, surcharge math, terminal handoff, scheduled_services status, admin auth, public token routes, or model IDs. Do not duplicate AGENTS.md here; it is the source of truth.
