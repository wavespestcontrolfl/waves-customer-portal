#!/usr/bin/env bash
# verify-pr-checks.sh — post-push PR verification for the waves-ship flow.
#
# Encodes two traps as an EXECUTED step instead of a remembered rule:
#   - a CONFLICTING PR's pull_request merge ref can't be built, so the `tests`
#     workflow can never run for that head, asked for or not (it bit PRs #3251
#     and #3253 the same night);
#   - the checks tab keeps showing the green from an OLDER head, and "CI
#     green" read off it is a lie.
#
# Since 2026-10-03 `tests` runs a PR when it opens and when a run is requested
# (a label change, by convention a toggle of `run-ci`), never on a push. A
# head with no run is therefore the normal state after a push: this script
# reports it, it does not fail on it.
#
# What it verifies, loudly failing on the first miss:
#   1. The remote branch tip is the SHA you think you pushed (hijack watch).
#   2. An OPEN PR exists for the branch and its headRefOid == that SHA.
#   3. The PR is not CONFLICTING (polls while GitHub computes UNKNOWN).
# What it reports:
#   4. The `tests` run(s) for that exact head SHA, or that there is none yet
#      and how to request one.
#
# Usage, from anywhere inside the worktree, after `git push` + ls-remote:
#   scripts/verify-pr-checks.sh                # current branch, local HEAD
#   scripts/verify-pr-checks.sh <branch>       # explicit branch
#
# Exit 0 = the pushed SHA is the PR head and the PR is not conflicting. It
# says nothing about CI passing: the merge gate needs `tests` green on this
# exact head. Exit 1 = fail loudly with instructions. House rules honored:
# no `gh api --jq --arg`; gh output is parsed by a separate plain jq.

set -u

REPO_SLUG="wavespestcontrolfl/waves-customer-portal"
BASE_BRANCH="main"
WORKFLOW_FILE="tests.yml"
MERGEABLE_TRIES="${VERIFY_PR_MERGEABLE_TRIES:-6}"      # x5s while UNKNOWN

fail() {
  echo "" >&2
  echo "❌ verify-pr-checks: $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  exit 1
}

command -v gh >/dev/null 2>&1 || fail "gh CLI not found on PATH."
command -v jq >/dev/null 2>&1 || fail "jq not found on PATH — brew install jq."
git rev-parse --git-dir >/dev/null 2>&1 || fail "not inside a git worktree."

BRANCH="${1:-$(git branch --show-current)}"
[ -n "$BRANCH" ] || fail "no branch given and HEAD is detached."
LOCAL_SHA="$(git rev-parse "$BRANCH" 2>/dev/null)" \
  || fail "cannot resolve local branch '$BRANCH'."

# 1. Remote tip = local SHA (the external hijack resets branches mid-push).
REMOTE_SHA="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
[ -n "$REMOTE_SHA" ] || fail "branch '$BRANCH' does not exist on origin." \
  "Push it first: git push -u origin $BRANCH"
if [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
  fail "remote tip $REMOTE_SHA != local $LOCAL_SHA — your push did not land (or was hijacked)." \
    "See waves-ship REFERENCE.md 'external push-hijack hazard' for the recovery recipe."
fi

# 2. Open PR for the branch, head == pushed SHA.
#    --head filters the head branch ONLY, so --base pins the target: a PR of
#    this branch into some other base would otherwise be selected and its
#    mergeability reported as if it were against main (and tests.yml runs on
#    PRs to every base, so it can supply a qualifying run too).
PR_JSON="$(gh pr list --repo "$REPO_SLUG" --head "$BRANCH" --base "$BASE_BRANCH" \
  --state open --json number,headRefOid,baseRefName 2>/dev/null)" \
  || fail "gh pr list failed — check gh auth."
PR_COUNT="$(printf '%s' "$PR_JSON" | jq -r 'length')"
if [ "${PR_COUNT:-0}" -gt 1 ]; then
  fail "$PR_COUNT open PRs from '$BRANCH' into '$BASE_BRANCH' — this gate cannot tell which one it is verifying." \
    "Close or retarget the duplicates, then re-run:  gh pr list --head $BRANCH --state open"
fi
PR_NUMBER="$(printf '%s' "$PR_JSON" | jq -r '.[0].number // empty')"
[ -n "$PR_NUMBER" ] || fail "no OPEN PR from '$BRANCH' into '$BASE_BRANCH' found." \
  "Open one first: gh pr create --head $BRANCH --base $BASE_BRANCH" \
  "(A PR of this branch into a different base does not satisfy the portal merge gate.)"
PR_HEAD="$(printf '%s' "$PR_JSON" | jq -r '.[0].headRefOid // empty')"
if [ "$PR_HEAD" != "$LOCAL_SHA" ]; then
  fail "PR #$PR_NUMBER headRefOid $PR_HEAD != pushed $LOCAL_SHA — GitHub hasn't seen your push (or the branch moved)." \
    "Re-check: git ls-remote origin $BRANCH ; gh pr view $PR_NUMBER --json headRefOid"
fi

# 3. Mergeable — poll while GitHub computes (UNKNOWN right after a push).
#    Sets MERGEABLE / MERGE_STATE / PR_HEAD_NOW; fails on CONFLICTING and on
#    UNKNOWN, because a pass here MEANS "proved not conflicting".
assert_mergeable() {
  MERGEABLE="UNKNOWN"
  MERGE_STATE=""
  PR_HEAD_NOW=""
  t=0
  while [ "$t" -lt "$MERGEABLE_TRIES" ]; do
    VIEW_JSON="$(gh pr view "$PR_NUMBER" --repo "$REPO_SLUG" \
      --json mergeable,mergeStateStatus,headRefOid 2>/dev/null)" \
      || fail "gh pr view failed for PR #$PR_NUMBER."
    MERGEABLE="$(printf '%s' "$VIEW_JSON" | jq -r '.mergeable // "UNKNOWN"')"
    MERGE_STATE="$(printf '%s' "$VIEW_JSON" | jq -r '.mergeStateStatus // ""')"
    PR_HEAD_NOW="$(printf '%s' "$VIEW_JSON" | jq -r '.headRefOid // empty')"
    [ "$MERGEABLE" != "UNKNOWN" ] && break
    t=$((t + 1))
    [ "$t" -lt "$MERGEABLE_TRIES" ] && sleep 5
  done
  if [ "$MERGEABLE" = "CONFLICTING" ]; then
    fail "PR #$PR_NUMBER is CONFLICTING with main — the tests workflow CANNOT RUN for this head, requested or not." \
      "The pull_request merge ref can't be built, so the checks tab keeps a STALE green from the old head." \
      "Fix: git fetch origin main && git merge origin/main   (resolve, commit, push)" \
      "Then: re-run this script, and post '@codex review' — the pre-conflict clean does not cover the merge commit."
  fi
  if [ "$MERGEABLE" = "UNKNOWN" ]; then
    fail "PR #$PR_NUMBER mergeability is still UNKNOWN after $((MERGEABLE_TRIES * 5))s — this gate cannot prove the PR is non-conflicting." \
      "A pass here is supposed to MEAN 'not conflicting, so a requested run can start'. UNKNOWN proves nothing, so it fails." \
      "GitHub is usually just slow computing the merge ref: wait a moment and re-run this script." \
      "If it stays UNKNOWN, check the PR on GitHub directly before trusting any CI state."
  fi
}

assert_mergeable
if [ "$PR_HEAD_NOW" != "$LOCAL_SHA" ]; then
  fail "PR #$PR_NUMBER head moved to $PR_HEAD_NOW while mergeability was computed (was $LOCAL_SHA)." \
    "Re-run this script against the current head before trusting any check state."
fi

# 4. Report the tests run(s) for THIS head. A push starts none (see the header),
#    so "no run" is reported with how to request one, never failed.
#    --commit filters by SHA alone, so the same SHA sitting at the head of
#    another branch or a stacked PR would otherwise be reported as this PR's
#    run. headBranch + event tie it to this PR's ref.
RUNS_JSON="$(gh run list --repo "$REPO_SLUG" --workflow "$WORKFLOW_FILE" \
  --commit "$LOCAL_SHA" --json status,conclusion,event,url,headSha,headBranch 2>/dev/null)" \
  || fail "gh run list failed — check gh auth."
MINE_JSON="$(printf '%s' "$RUNS_JSON" \
  | jq -r --arg sha "$LOCAL_SHA" --arg br "$BRANCH" \
    '[.[] | select(.headSha == $sha and .event == "pull_request" and .headBranch == $br)]')"
RUN_COUNT="$(printf '%s' "$MINE_JSON" | jq -r 'length')"

echo "✅ verify-pr-checks: PR #$PR_NUMBER head $LOCAL_SHA — mergeable=$MERGEABLE ($MERGE_STATE)."
if [ "${RUN_COUNT:-0}" -gt 0 ]; then
  echo "   $RUN_COUNT tests-workflow run(s) on this head:"
  printf '%s' "$MINE_JSON" | jq -r '.[] | "   \(.status) \(.conclusion // "-") (\(.event)) \(.url)"'
  echo "   (A run existing ≠ a run passing — wait for green before the merge gate.)"
else
  echo "   No tests-workflow run on this head. A push does not start one."
  echo "   Request it once the head is the one you mean to merge, by changing the run-ci label:"
  echo "     gh pr edit $PR_NUMBER --repo $REPO_SLUG --add-label run-ci      # or --remove-label run-ci if it is already on"
  echo "   Green on an OLDER head is not CI for this one."
fi
exit 0
