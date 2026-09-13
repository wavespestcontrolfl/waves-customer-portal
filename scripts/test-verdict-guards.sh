#!/usr/bin/env bash
# Regression tests for the pre-push hook's fallback-verdict guards.
#
# WHY THIS EXISTS
# Three small functions in scripts/hooks/pre-push decide whether a Claude
# fallback verdict is trustworthy. Each one has already shipped a bug that
# the next reader would not have predicted:
#
#   verdict_reviewed_nothing  twice produced a FALSE POSITIVE that would have
#                             thrown away a good review and manufactured a
#                             fake UN-AUDITED — the exact darkness the
#                             fallback exists to remove. Both times the
#                             culprit was an alternative ending on a bare
#                             noun ("no code changes", "no diff").
#   verdict_matches_schema    exists because a finding with priority "[P0]"
#                             counted as zero P0s and the push was allowed.
#   extract_review_json       took the FIRST object in a prose reply, so an
#                             illustrative clean example followed by the real
#                             P0 verdict salvaged as clean.
#
# These guards sit on the P0 gate, so a regression in them is silent and
# expensive. Add a case here BEFORE changing any of them.
#
# No model calls, no network, runs in about a second.
#
#   scripts/test-verdict-guards.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/hooks/pre-push"
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq not on PATH"; exit 1; }
[ -f "$HOOK" ]                || { echo "FAIL: cannot find $HOOK"; exit 1; }

WORK="$(mktemp -d -t verdict-guards.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Pull the functions out of the hook so the tests exercise the SHIPPING code
# rather than a copy that can drift away from it.
for fn in verdict_reviewed_nothing verdict_matches_schema extract_review_json; do
  awk -v f="$fn() {" 'index($0,f)==1{p=1} p{print} p&&/^}$/{exit}' "$HOOK" >> "$WORK/fns.sh"
  echo "" >> "$WORK/fns.sh"
done
for fn in verdict_reviewed_nothing verdict_matches_schema extract_review_json; do
  grep -q "^$fn() {" "$WORK/fns.sh" || { echo "FAIL: could not extract $fn from the hook"; exit 1; }
done
# shellcheck disable=SC1091
. "$WORK/fns.sh"

FAILURES=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }

json() { printf '%s' "$1" > "$WORK/v.json"; }

# ── verdict_reviewed_nothing ─────────────────────────────────────────────
# A zero-finding verdict must be KEPT unless the summary actually says the
# diff was absent or unreachable.
echo "verdict_reviewed_nothing — must NOT fire on a genuine clean review:"
while IFS= read -r summary; do
  [ -z "$summary" ] && continue
  json "{\"summary\":$(printf '%s' "$summary" | jq -Rs .),\"findings\":[]}"
  if verdict_reviewed_nothing "$WORK/v.json"; then
    fail "wrongly rejected: $summary"
  else
    pass "kept: $summary"
  fi
done <<'CLEAN'
No code changes introduce correctness issues, and no P0 issues were found.
No diff issues were found; the changes look safe.
No diff-related concerns in this push.
Reviewed the diff; two files, no issues found.
Tooling-only diff. No changes of concern; nothing to flag.
The patch is small and correct. No P0 issues found.
CLEAN

echo "verdict_reviewed_nothing — MUST fire when the reviewer saw nothing:"
while IFS= read -r summary; do
  [ -z "$summary" ] && continue
  json "{\"summary\":$(printf '%s' "$summary" | jq -Rs .),\"findings\":[]}"
  if verdict_reviewed_nothing "$WORK/v.json"; then
    pass "caught: $summary"
  else
    fail "missed: $summary"
  fi
done <<'EMPTY'
No diff content was available in this session to review.
The diff was not provided, so nothing was reviewed.
I could not read the diff.
No code changes were provided.
The diff is empty.
Nothing was provided to review.
Could not access the changes.
EMPTY

echo "verdict_reviewed_nothing — must never fire when findings exist:"
json '{"summary":"could not read the diff","findings":[{"priority":"P0","file":"a.js","line":1,"title":"t","description":"d"}]}'
if verdict_reviewed_nothing "$WORK/v.json"; then
  fail "fired on a verdict that HAS findings"
else
  pass "ignored a verdict that has findings, whatever the summary says"
fi

# ── verdict_matches_schema ───────────────────────────────────────────────
echo "verdict_matches_schema:"
check_schema() { # $1 = json, $2 = expect ok|bad, $3 = label
  json "$1"
  if verdict_matches_schema "$WORK/v.json"; then got=ok; else got=bad; fi
  [ "$got" = "$2" ] && pass "$3" || fail "$3 (expected $2, got $got)"
}
check_schema '{"summary":"s","findings":[{"priority":"P0","file":"a.js","line":3,"title":"t","description":"d"}]}' ok  "accepts a well-formed P0"
check_schema '{"summary":"s","findings":[]}' ok  "accepts an empty findings array"
check_schema '{"summary":"s","findings":[{"priority":"P1","file":"a","line":null,"title":"t","description":"d"}]}' ok  "accepts a null line"
check_schema '{"summary":"s","findings":[{"priority":"[P0]","file":"a","line":1,"title":"t","description":"d"}]}' bad "rejects a bracketed priority (would count as zero P0s)"
check_schema '{"summary":"s","findings":[{"priority":"p0","file":"a","line":1,"title":"t","description":"d"}]}' bad "rejects a lowercase priority"
check_schema '{"summary":"s","findings":[{"priority":"P0","line":1,"title":"t"}]}' bad "rejects a finding missing file and description"
check_schema '{"summary":"","findings":[]}' bad "rejects an empty summary"
check_schema '{"findings":[]}' bad "rejects a missing summary"
check_schema '{"summary":"s"}' bad "rejects a missing findings array"
check_schema '{"summary":"s","findings":[{"priority":"P0","file":"a","title":"t","description":"d"}]}' bad "rejects a finding with no line key at all (schema requires it)"
check_schema '{"summary":"s","findings":[{"priority":"P0","file":"a","line":0,"title":"t","description":"d"}]}' bad "rejects line 0"
check_schema '{"summary":"s","findings":[{"priority":"P0","file":"a","line":-4,"title":"t","description":"d"}]}' bad "rejects a negative line"
check_schema '{"summary":"s","findings":[{"priority":"P0","file":"a","line":3.5,"title":"t","description":"d"}]}' bad "rejects a fractional line"
# additionalProperties:false at both levels. The dangerous shape is a blocker
# parked in a sibling key with findings left empty — schema-valid to every
# other check, scored P0: 0, push allowed.
check_schema '{"summary":"s","findings":[],"issues":[{"priority":"P0","file":"a","line":1,"title":"t","description":"d"}]}' bad "rejects a top-level key outside the schema (blocker parked in issues)"
check_schema '{"summary":"s","findings":[{"priority":"P0","file":"a","line":1,"title":"t","description":"d","severity":"high"}]}' bad "rejects a finding with a key outside the schema"
check_schema '["not","an","object"]' bad "rejects a top-level array"

# A STREAM of two objects: jq empty accepts it, and the P0 counter would then
# emit "0\n1" and blow up Bash arithmetic — blocking a push on two clean
# verdicts, the opposite of the hook's fail-open policy.
printf '%s\n%s' '{"summary":"one","findings":[]}' '{"summary":"two","findings":[]}' > "$WORK/v.json"
if verdict_matches_schema "$WORK/v.json"; then
  fail "accepted a two-object JSON stream (would break the counters)"
else
  pass "rejects a two-object JSON stream"
fi

# ── extract_review_json ──────────────────────────────────────────────────
echo "extract_review_json:"
raw() { printf '%s' "$1" > "$WORK/raw.txt"; }
salvage() { extract_review_json "$WORK/raw.txt" "$WORK/out.json"; echo $?; }

raw 'Some prose. {"summary":"one","findings":[]} More prose.'
[ "$(salvage)" = "0" ] && pass "salvages a single object from prose" || fail "single object"

raw 'Prose with a { brace } in it.
{"summary":"has a } brace inside a string","findings":[{"priority":"P0","file":"a.js","line":1,"title":"t","description":"a } brace"}]}
trailing'
if [ "$(salvage)" = "0" ] && [ "$(jq -r '.findings[0].priority' "$WORK/out.json")" = "P0" ]; then
  pass "a brace inside a string does not truncate the object"
else
  fail "brace inside a string"
fi

raw 'Example of a clean verdict:
{"summary":"clean","findings":[]}
And the real one:
{"summary":"real","findings":[{"priority":"P0","file":"a.js","line":1,"title":"t","description":"d"}]}'
[ "$(salvage)" = "2" ] && pass "refuses two candidate objects instead of taking the first" || fail "ambiguous reply"

raw 'No JSON here at all, just prose about findings.'
[ "$(salvage)" = "1" ] && pass "reports nothing usable when there is no object" || fail "no object"

raw '{"summary":"not a review","other":[]}'
[ "$(salvage)" = "1" ] && pass "ignores an object with no findings array" || fail "non-review object"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All verdict-guard tests passed."
  exit 0
fi
echo "$FAILURES verdict-guard test(s) FAILED — the P0 gate is not trustworthy."
exit 1
