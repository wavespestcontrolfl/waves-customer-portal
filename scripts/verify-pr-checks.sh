#!/usr/bin/env bash
# verify-pr-checks.sh — post-push PR verification for the waves-ship flow.
#
# Encodes the CI-silence trap as an EXECUTED step instead of a remembered
# rule (it bit PRs #3251 and #3253 the same night): a CONFLICTING PR's
# pull_request merge ref can't be built, so the `tests` workflow silently
# never fires for the new head — the checks tab keeps showing a stale green
# from the old head and "CI green" is a lie. Whenever CI is silent, check
# mergeable.
#
# What it verifies, loudly failing on the first miss:
#   1. The remote branch tip is the SHA you think you pushed (hijack watch).
#   2. An OPEN PR exists for the branch and its headRefOid == that SHA.
#   3. The PR is not CONFLICTING (polls while GitHub computes UNKNOWN).
#   4. The `tests` workflow actually TRIGGERED a run for that head SHA
#      (polls for trigger lag; reports run status/conclusion when found).
#
# Usage, from anywhere inside the worktree, after `git push` + ls-remote:
#   scripts/verify-pr-checks.sh                # current branch, local HEAD
#   scripts/verify-pr-checks.sh <branch>       # explicit branch
#
# Exit 0 = mergeable + workflow fired (run may still be in progress — this
# script checks that CI is ALIVE, not that it passed). Exit 1 = fail loudly
# with instructions. House rules honored: no `gh api --jq --arg`; gh output
# is parsed by a separate plain jq.

set -u

REPO_SLUG="wavespestcontrolfl/waves-customer-portal"
WORKFLOW_FILE="tests.yml"
MERGEABLE_TRIES="${VERIFY_PR_MERGEABLE_TRIES:-6}"      # x5s while UNKNOWN
WORKFLOW_TRIES="${VERIFY_PR_WORKFLOW_TRIES:-10}"       # x15s for trigger lag

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
PR_JSON="$(gh pr list --repo "$REPO_SLUG" --head "$BRANCH" --state open \
  --json number,headRefOid 2>/dev/null)" \
  || fail "gh pr list failed — check gh auth."
PR_NUMBER="$(printf '%s' "$PR_JSON" | jq -r '.[0].number // empty')"
[ -n "$PR_NUMBER" ] || fail "no OPEN PR found for branch '$BRANCH'." \
  "Open one first: gh pr create --head $BRANCH --base main"
PR_HEAD="$(printf '%s' "$PR_JSON" | jq -r '.[0].headRefOid // empty')"
if [ "$PR_HEAD" != "$LOCAL_SHA" ]; then
  fail "PR #$PR_NUMBER headRefOid $PR_HEAD != pushed $LOCAL_SHA — GitHub hasn't seen your push (or the branch moved)." \
    "Re-check: git ls-remote origin $BRANCH ; gh pr view $PR_NUMBER --json headRefOid"
fi

# 3. Mergeable — poll while GitHub computes (UNKNOWN right after a push).
MERGEABLE="UNKNOWN"
MERGE_STATE=""
try=0
while [ "$try" -lt "$MERGEABLE_TRIES" ]; do
  VIEW_JSON="$(gh pr view "$PR_NUMBER" --repo "$REPO_SLUG" \
    --json mergeable,mergeStateStatus 2>/dev/null)" \
    || fail "gh pr view failed for PR #$PR_NUMBER."
  MERGEABLE="$(printf '%s' "$VIEW_JSON" | jq -r '.mergeable // "UNKNOWN"')"
  MERGE_STATE="$(printf '%s' "$VIEW_JSON" | jq -r '.mergeStateStatus // ""')"
  [ "$MERGEABLE" != "UNKNOWN" ] && break
  try=$((try + 1))
  [ "$try" -lt "$MERGEABLE_TRIES" ] && sleep 5
done
if [ "$MERGEABLE" = "CONFLICTING" ]; then
  fail "PR #$PR_NUMBER is CONFLICTING with main — the tests workflow will SILENTLY NEVER FIRE for this head." \
    "The pull_request merge ref can't be built, so the checks tab keeps a STALE green from the old head." \
    "Fix: git fetch origin main && git merge origin/main   (resolve, commit, push)" \
    "Then: re-run this script, and post '@codex review' — the pre-conflict clean does not cover the merge commit."
fi
if [ "$MERGEABLE" = "UNKNOWN" ]; then
  fail "PR #$PR_NUMBER mergeability is still UNKNOWN after $((MERGEABLE_TRIES * 5))s — this gate cannot prove the PR is non-conflicting." \
    "A pass here is supposed to MEAN 'not conflicting, so CI silence would be real'. UNKNOWN proves nothing, so it fails." \
    "GitHub is usually just slow computing the merge ref: wait a moment and re-run this script." \
    "If it stays UNKNOWN, check the PR on GitHub directly before trusting any CI state."
fi

# 4. The tests workflow actually triggered a run for this head SHA — and one
#    created BY THIS PUSH. Re-pushing the same SHA (the documented hijack
#    recovery) leaves the previous run visible, so "a run exists for this SHA"
#    would pass instantly even when the new push triggered nothing.
#    Baseline: the run IDs already present before we start polling. A run that
#    appears afterwards is provably new. Set VERIFY_PR_PUSH_AFTER to an ISO8601
#    timestamp taken immediately BEFORE the push to use createdAt instead —
#    needed when GitHub creates the run before this script starts.
#    Whether an existing run counts depends on how this SHA reached the tip:
#      fresh head  — the SHA was never the branch tip before, so ANY run for it
#                    can only have been created by this push. Accept it.
#      re-push     — the SHA was already the tip earlier (force-push / hijack
#                    recovery), so an old run may predate this push and proves
#                    nothing. Require VERIFY_PR_PUSH_AFTER (ISO8601 taken before
#                    the push) to disambiguate by createdAt.
#    The remote-tracking reflog is the evidence; it is written by the push
#    itself, so no timestamp comparison and no workflow change is needed.
PUSH_AFTER="${VERIFY_PR_PUSH_AFTER:-}"
RUN_FIELDS="status,conclusion,event,url,databaseId,createdAt,headSha"

REFLOG_SHAS="$(git log -g --format='%H' "origin/$BRANCH" 2>/dev/null)"
if [ -z "$REFLOG_SHAS" ]; then
  PUSH_KIND="unknown"
elif [ "$(printf '%s\n' "$REFLOG_SHAS" | grep -c "^$LOCAL_SHA$")" -gt 1 ]; then
  PUSH_KIND="re-push"
else
  PUSH_KIND="fresh"
fi

if [ "$PUSH_KIND" = "re-push" ] && [ -z "$PUSH_AFTER" ]; then
  fail "head $LOCAL_SHA was the tip of '$BRANCH' before this push (force-push / hijack recovery) — an existing CI run may predate it and would prove nothing." \
    "Re-run with the timestamp captured immediately BEFORE the push so runs can be told apart:" \
    "  VERIFY_PR_PUSH_AFTER=\$(date -u +%Y-%m-%dT%H:%M:%SZ)   # BEFORE git push" \
    "(A normal push of a new commit does not need this — only same-SHA re-pushes do.)"
fi

RUNS_JSON="[]"
NEW_JSON="[]"
try=0
while [ "$try" -lt "$WORKFLOW_TRIES" ]; do
  RUNS_JSON="$(gh run list --repo "$REPO_SLUG" --workflow "$WORKFLOW_FILE" \
    --commit "$LOCAL_SHA" --json "$RUN_FIELDS" 2>/dev/null)" \
    || fail "gh run list failed — check gh auth."
  if [ -n "$PUSH_AFTER" ]; then
    NEW_JSON="$(printf '%s' "$RUNS_JSON" \
      | jq -r --arg after "$PUSH_AFTER" '[.[] | select(.createdAt >= $after)]')"
  else
    NEW_JSON="$RUNS_JSON"
  fi
  [ "$(printf '%s' "$NEW_JSON" | jq -r 'length')" -gt 0 ] && break
  try=$((try + 1))
  [ "$try" -lt "$WORKFLOW_TRIES" ] && sleep 15
done

NEW_COUNT="$(printf '%s' "$NEW_JSON" | jq -r 'length')"
TOTAL_COUNT="$(printf '%s' "$RUNS_JSON" | jq -r 'length')"
if [ "${NEW_COUNT:-0}" -eq 0 ]; then
  if [ -n "$PUSH_AFTER" ] && [ "${TOTAL_COUNT:-0}" -gt 0 ]; then
    fail "no '$WORKFLOW_FILE' run created after $PUSH_AFTER for head $LOCAL_SHA (waited ~$((WORKFLOW_TRIES * 15))s) — only $TOTAL_COUNT older run(s)." \
      "On a same-SHA re-push an older run does NOT prove this push triggered CI." \
      "Check mergeable ($MERGEABLE/$MERGE_STATE) and the Actions tab; if the PR conflicts, merge origin/main and push again." \
      "If VERIFY_PR_PUSH_AFTER was captured AFTER the push, re-take it before a fresh push."
  fi
  fail "the '$WORKFLOW_FILE' workflow NEVER TRIGGERED for head $LOCAL_SHA (waited ~$((WORKFLOW_TRIES * 15))s) — CI is silent." \
    "Most likely cause: the PR was CONFLICTING when the push landed (mergeable above: $MERGEABLE/$MERGE_STATE)." \
    "If it conflicts: merge origin/main, push, re-run. If it's a GitHub Actions outage: substitute the full local" \
    "test evidence in the PR (precedent #441/#3240) and say so explicitly — never report a stale green as CI."
fi

# 5. Re-verify the head AFTER polling — the branch can move during the wait,
#    which is precisely the hijack race this script exists to catch.
FINAL_REMOTE="$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
if [ "$FINAL_REMOTE" != "$LOCAL_SHA" ]; then
  fail "remote tip moved to $FINAL_REMOTE during the wait (was $LOCAL_SHA) — the CI evidence above is for a SHA that is no longer the branch tip." \
    "See waves-ship REFERENCE.md 'external push-hijack hazard', then re-push and re-run this script."
fi
FINAL_HEAD="$(gh pr view "$PR_NUMBER" --repo "$REPO_SLUG" --json headRefOid 2>/dev/null \
  | jq -r '.headRefOid // empty')"
if [ "$FINAL_HEAD" != "$LOCAL_SHA" ]; then
  fail "PR #$PR_NUMBER head moved to $FINAL_HEAD during the wait (was $LOCAL_SHA) — CI evidence is stale." \
    "Re-run this script against the current head before trusting any check state."
fi

echo "✅ verify-pr-checks: PR #$PR_NUMBER head $LOCAL_SHA — mergeable=$MERGEABLE ($MERGE_STATE), push=$PUSH_KIND, $NEW_COUNT tests-workflow run(s) attributable to this push:"
printf '%s' "$NEW_JSON" | jq -r '.[] | "   \(.status) \(.conclusion // "-") (\(.event)) \(.url)"'
echo "   (A run existing ≠ a run passing — wait for green before the merge gate.)"
exit 0
