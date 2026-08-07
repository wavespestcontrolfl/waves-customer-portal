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
#    ONE implementation, used both here and in the post-poll re-check (§5).
#    Two copies of this rule drifted once already: the final check rejected
#    CONFLICTING but let UNKNOWN pass, silently weakening the same guarantee.
#    Sets MERGEABLE / MERGE_STATE / PR_HEAD_NOW; fails on CONFLICTING and on
#    UNKNOWN, because a pass here MEANS "proved not conflicting".
assert_mergeable() {
  when="$1"   # human label for the failure text
  MERGEABLE="UNKNOWN"
  MERGE_STATE=""
  PR_HEAD_NOW=""
  t=0
  while [ "$t" -lt "$MERGEABLE_TRIES" ]; do
    VIEW_JSON="$(gh pr view "$PR_NUMBER" --repo "$REPO_SLUG" \
      --json mergeable,mergeStateStatus,headRefOid 2>/dev/null)" \
      || fail "gh pr view failed for PR #$PR_NUMBER ($when)."
    MERGEABLE="$(printf '%s' "$VIEW_JSON" | jq -r '.mergeable // "UNKNOWN"')"
    MERGE_STATE="$(printf '%s' "$VIEW_JSON" | jq -r '.mergeStateStatus // ""')"
    PR_HEAD_NOW="$(printf '%s' "$VIEW_JSON" | jq -r '.headRefOid // empty')"
    [ "$MERGEABLE" != "UNKNOWN" ] && break
    t=$((t + 1))
    [ "$t" -lt "$MERGEABLE_TRIES" ] && sleep 5
  done
  if [ "$MERGEABLE" = "CONFLICTING" ]; then
    fail "PR #$PR_NUMBER is CONFLICTING with main ($when) — the tests workflow will SILENTLY NEVER FIRE for this head." \
      "The pull_request merge ref can't be built, so the checks tab keeps a STALE green from the old head." \
      "Fix: git fetch origin main && git merge origin/main   (resolve, commit, push)" \
      "Then: re-run this script, and post '@codex review' — the pre-conflict clean does not cover the merge commit."
  fi
  if [ "$MERGEABLE" = "UNKNOWN" ]; then
    fail "PR #$PR_NUMBER mergeability is still UNKNOWN after $((MERGEABLE_TRIES * 5))s ($when) — this gate cannot prove the PR is non-conflicting." \
      "A pass here is supposed to MEAN 'not conflicting, so CI silence would be real'. UNKNOWN proves nothing, so it fails." \
      "GitHub is usually just slow computing the merge ref: wait a moment and re-run this script." \
      "If it stays UNKNOWN, check the PR on GitHub directly before trusting any CI state."
  fi
}

assert_mergeable "before CI polling"
PRE_MERGEABLE="$MERGEABLE"
PRE_MERGE_STATE="$MERGE_STATE"

# 4. The tests workflow actually triggered a run for this head SHA, attributable
#    to this push. Re-pushing the same SHA (the documented hijack recovery)
#    leaves the previous run visible, so "a run exists for this SHA" could pass
#    even when the new push triggered nothing.
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
RUN_FIELDS="status,conclusion,event,url,databaseId,createdAt,headSha,headBranch"

REFLOG_SHAS="$(git log -g --format='%H' "origin/$BRANCH" 2>/dev/null)"
if [ -z "$REFLOG_SHAS" ]; then
  PUSH_KIND="unknown"
elif [ "$(printf '%s\n' "$REFLOG_SHAS" | grep -c "^$LOCAL_SHA$")" -gt 1 ]; then
  PUSH_KIND="re-push"
else
  PUSH_KIND="fresh"
fi

if [ "$PUSH_KIND" = "re-push" ] && [ -z "$PUSH_AFTER" ]; then
  fail "head $LOCAL_SHA was the tip of '$BRANCH' before this push (force-push / recovery) — an existing CI run may predate it and would prove nothing." \
    "Re-run with the timestamp captured immediately BEFORE the push so runs can be told apart:" \
    "  export VERIFY_PR_PUSH_AFTER=\$(date -u +%Y-%m-%dT%H:%M:%SZ)   # BEFORE git push" \
    "(A normal push of a new commit does not need this — only same-SHA re-pushes do.)"
fi

# LIMIT OF THIS CHECK, stated rather than papered over: re-push detection reads
# the LOCAL remote-tracking reflog. In the hijack case the remote can move
# without that ref being fetched, so pushing the original SHA back may add no
# second entry and this classifies as "fresh" — accepting the earlier push's
# run as evidence. Local state cannot rule that out. The procedure carries the
# requirement instead: after ANY force-push or recovery push, capture
# VERIFY_PR_PUSH_AFTER before pushing (waves-ship §3). When it is set, run
# attribution is exact and none of this inference is used.
ATTRIBUTION="exact (createdAt >= $PUSH_AFTER)"
if [ -z "$PUSH_AFTER" ]; then
  ATTRIBUTION="inferred from reflog — set VERIFY_PR_PUSH_AFTER before a recovery push for an exact check"
fi

RUNS_JSON="[]"
NEW_JSON="[]"
try=0
while [ "$try" -lt "$WORKFLOW_TRIES" ]; do
  RUNS_JSON="$(gh run list --repo "$REPO_SLUG" --workflow "$WORKFLOW_FILE" \
    --commit "$LOCAL_SHA" --json "$RUN_FIELDS" 2>/dev/null)" \
    || fail "gh run list failed — check gh auth."
  # Only runs for THIS head on THIS branch, triggered by the PR itself.
  # --commit filters by SHA alone, so the same SHA sitting at the head of
  # another branch or a stacked PR would otherwise satisfy this gate with a
  # run the target PR never triggered. headBranch ties it to this PR's ref.
  MINE_JSON="$(printf '%s' "$RUNS_JSON" \
    | jq -r --arg sha "$LOCAL_SHA" --arg br "$BRANCH" \
      '[.[] | select(.headSha == $sha and .event == "pull_request" and .headBranch == $br)]')"
  if [ -n "$PUSH_AFTER" ]; then
    NEW_JSON="$(printf '%s' "$MINE_JSON" \
      | jq -r --arg after "$PUSH_AFTER" '[.[] | select(.createdAt >= $after)]')"
  else
    NEW_JSON="$MINE_JSON"
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
#    Mergeability is re-asserted through the SAME function as §3: `main` can
#    advance during the wait and make this PR conflicting without either SHA
#    changing, which would leave the cached pre-poll value printed as if it
#    still held. Same rule, one implementation — CONFLICTING and UNKNOWN both
#    fail here exactly as they do before polling.
assert_mergeable "after CI polling"
if [ "$PR_HEAD_NOW" != "$LOCAL_SHA" ]; then
  fail "PR #$PR_NUMBER head moved to $PR_HEAD_NOW during the wait (was $LOCAL_SHA) — CI evidence is stale." \
    "Re-run this script against the current head before trusting any check state."
fi
if [ "$MERGEABLE" != "$PRE_MERGEABLE" ] || [ "$MERGE_STATE" != "$PRE_MERGE_STATE" ]; then
  echo "ℹ️  verify-pr-checks: mergeability changed during the wait: $PRE_MERGEABLE/$PRE_MERGE_STATE → $MERGEABLE/$MERGE_STATE" >&2
fi

echo "✅ verify-pr-checks: PR #$PR_NUMBER head $LOCAL_SHA — mergeable=$MERGEABLE ($MERGE_STATE), push=$PUSH_KIND, $NEW_COUNT tests-workflow run(s) attributable to this push:"
echo "   run attribution: $ATTRIBUTION"
printf '%s' "$NEW_JSON" | jq -r '.[] | "   \(.status) \(.conclusion // "-") (\(.event)) \(.url)"'
echo "   (A run existing ≠ a run passing — wait for green before the merge gate.)"
exit 0
