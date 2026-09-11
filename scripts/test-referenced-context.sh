#!/usr/bin/env bash
# Regression tests for the Claude fallback's referenced-file context.
#
# WHY THIS EXISTS
# The fallback auditor has no tools, so it cannot open a file the diff
# merely references. That produced a real hedged finding — "confirm this
# policy exists before merging" — about a file that did exist. The hook now
# inlines those referenced files.
#
# The paths come out of a diff the repo did not write, which makes this a
# trust boundary rather than a convenience: a diff that can name a file can
# try to name ~/.ssh/id_rsa or an untracked .env and have the hook paste it
# into a prompt. Every guard below is therefore a security test, and the
# cheap mistake is to let one silently stop matching while the feature keeps
# working — so each rejection case also proves the SAME shape is accepted
# when the unsafe property is removed.
#
# Everything resolves against the AUDITED COMMIT, never the working tree.
# That distinction is a correctness guard, not a detail: a dirty tree or a
# push of a branch you are not standing on would otherwise inline different
# content than the diff ships, labelled as authoritative context, and hide
# the defect the audit exists to find. Both cases are pinned below.
#
# No model calls, no network, runs in about a second.
#
#   scripts/test-referenced-context.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/hooks/pre-push"
[ -f "$HOOK" ] || { echo "FAIL: cannot find $HOOK"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not on PATH — the feature is a no-op without it"; exit 0; }

WORK="$(mktemp -d -t referenced-context.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Pull the functions out of the hook so these tests exercise the SHIPPING
# code rather than a copy that can drift away from it.
for fn in write_referenced_context_script collect_referenced_context; do
  awk -v f="$fn() {" 'index($0,f)==1{p=1} p{print} p&&/^}$/{exit}' "$HOOK" >> "$WORK/fns.sh"
  echo "" >> "$WORK/fns.sh"
  grep -q "^$fn() {" "$WORK/fns.sh" || { echo "FAIL: could not extract $fn from the hook"; exit 1; }
done
# shellcheck disable=SC1091
. "$WORK/fns.sh"

TMPDIR_RUN="$WORK/run"; mkdir -p "$TMPDIR_RUN"
CLAUDE_CONTEXT_MAX_FILES=5
CLAUDE_CONTEXT_MAX_BYTES=50000

FAILURES=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }

# ── A throwaway repo to resolve against ──────────────────────────────────
# The changed set now comes from `git diff --name-only BASE...SHA`, so the
# fixture has to be real history rather than one commit: a referenced file
# must be present in BASE and untouched by the push to count as unchanged.
REPO="$WORK/repo"
mkdir -p "$REPO/server/services/mod" "$REPO/server/config" "$REPO/node_modules/pkg"
cd "$REPO" || exit 1
git init -q .
git config user.email t@t.t; git config user.name t

echo "module.exports = { POLICY: 1 };"       > server/config/models.js
echo "module.exports = { helper: 1 };"       > server/services/helper.js
echo "module.exports = { data: 1 };"         > server/services/data.json
echo "module.exports = { dep: 1 };"          > node_modules/pkg/index.js
echo "module.exports = { from_index: 1 };"   > server/services/mod/index.js
# ./helper has TWO possible targets. helper.js wins; helper/index.js must
# never be substituted for it when helper.js is filtered out.
mkdir -p server/services/helper
echo "module.exports = { helper_index_substituted: 1 };" > server/services/helper/index.js
# A root helper.js and a nested one: if a parser ever loses track of which
# file an added line belongs to, ./helper resolves from the repo root and
# lands on the wrong one. These two make that visible instead of silent.
mkdir -p server/services/nested
echo "module.exports = { ROOT_HELPER: 1 };"   > helper.js
# Competing EXACT targets: an extensionless entry that Node would resolve
# first, sitting beside a same-named .js. Neither may be substituted for the
# other — the .js is the tempting wrong answer in both cases.
ln -s /etc/passwd server/services/widget
echo "module.exports = { widget_js_substituted: 1 };" > server/services/widget.js
printf '#!/bin/sh\necho gadget\n' > server/services/gadget
echo "module.exports = { gadget_js_substituted: 1 };" > server/services/gadget.js
echo "module.exports = { NESTED_HELPER: 1 };" > server/services/nested/helper.js
printf 'module.exports = { big: "%s" };\n' "$(head -c 4000 < /dev/zero | tr '\0' 'x')" > server/services/big.js
ln -s /etc/passwd server/services/link.js
git add -A >/dev/null 2>&1
git commit -qm support >/dev/null 2>&1
BASE_SHA="$(git rev-parse HEAD)"

# The push under test: it adds a caller and touches nothing else, so every
# support file above is tracked-and-unchanged.
echo "module.exports = {};" > server/services/caller.js
git add -A >/dev/null 2>&1
git commit -qm push >/dev/null 2>&1
PUSH_SHA="$(git rev-parse HEAD)"

# Deliberately NOT committed yet — the .env-shaped case.
echo "module.exports = { SECRET: 'sk_live_do_not_leak' };" > server/services/secrets.js

AUDIT_BASE="$BASE_SHA"
AUDIT_SHA="$PUSH_SHA"

# $1 = the added source line, $2 = path the diff claims to change
make_diff() {
  local added="$1" path="${2:-server/services/caller.js}"
  {
    echo "diff --git a/$path b/$path"
    echo "--- /dev/null"
    echo "+++ b/$path"
    echo "@@ -0,0 +1,2 @@"
    printf '+%s\n' "$added"
    echo "+module.exports = {};"
  } > "$WORK/diff.txt"
}

run_collect() { collect_referenced_context "$WORK/diff.txt" "$WORK/out.txt" "$AUDIT_SHA" "$AUDIT_BASE"; }

# $1 = label, $2 = added line, $3 = "includes"|"excludes", $4 = needle
expect() {
  local label="$1" added="$2" mode="$3" needle="$4"
  make_diff "$added"
  run_collect
  if grep -qa -- "$needle" "$WORK/out.txt" 2>/dev/null; then
    [ "$mode" = "includes" ] && pass "$label" || fail "$label — LEAKED: $needle is in the prompt"
  else
    [ "$mode" = "excludes" ] && pass "$label" || fail "$label — missing: $needle"
  fi
}

echo "accepts what it should:"
expect "inlines a tracked sibling the diff requires" \
  "const m = require('../config/models');" includes "POLICY"
expect "resolves a directory import through its index file" \
  "const p = require('./mod');" includes "from_index"

echo ""
echo "refuses what it must — each paired with the same shape made safe:"

# Path escape.
expect "drops a path that resolves outside the repo" \
  "const x = require('../../../../../../etc/passwd');" excludes "root:"
expect "  ...but keeps the same require shape when it stays inside" \
  "const x = require('../services/helper');" includes "helper"

# Untracked file — the .env-shaped case.
expect "drops an UNTRACKED file (the .env / dropped-credential case)" \
  "const s = require('./secrets');" excludes "sk_live_do_not_leak"
git add server/services/secrets.js >/dev/null 2>&1
git commit -qm secrets >/dev/null 2>&1
SECRETS_BASE="$(git rev-parse HEAD)"
echo "module.exports = {};" > server/services/later.js
git add -A >/dev/null 2>&1
git commit -qm later >/dev/null 2>&1
SAVED_SHA="$AUDIT_SHA"; SAVED_BASE="$AUDIT_BASE"
AUDIT_SHA="$(git rev-parse HEAD)"; AUDIT_BASE="$SECRETS_BASE"
expect "  ...and accepts that very file once it is committed and unchanged" \
  "const s = require('./secrets');" includes "sk_live_do_not_leak"
AUDIT_SHA="$SAVED_SHA"; AUDIT_BASE="$SAVED_BASE"
expect "  ...and drops it again when auditing a commit that predates it" \
  "const s = require('./secrets');" excludes "sk_live_do_not_leak"

# Symlink escape — containment is checked after resolution.
expect "drops an in-repo symlink pointing outside the repo" \
  "const l = require('./link');" excludes "root:"

# node_modules.
expect "drops a node_modules dependency" \
  "const d = require('../../node_modules/pkg/index.js');" excludes "dep"

# Non-source extension.
expect "drops a non-source extension" \
  "const d = require('./data.json');" excludes '"data"'

# Already in the diff — no point paying tokens twice.
git checkout -q -B changed-models "$PUSH_SHA" >/dev/null 2>&1
echo "module.exports = { POLICY: 2 };" > server/config/models.js
git add -A >/dev/null 2>&1; git commit -qm touch-models >/dev/null 2>&1
SAVED_SHA="$AUDIT_SHA"; SAVED_BASE="$AUDIT_BASE"
AUDIT_SHA="$(git rev-parse HEAD)"; AUDIT_BASE="$PUSH_SHA"
make_diff "const m = require('../config/models');" "server/config/models.js"
run_collect
if [ -s "$WORK/out.txt" ]; then
  fail "re-inlines a file the push actually changes"
else
  pass "skips a file the push actually changes"
fi
AUDIT_SHA="$SAVED_SHA"; AUDIT_BASE="$SAVED_BASE"
git checkout -q - >/dev/null 2>&1

# Bare specifiers are not paths.
expect "ignores a bare package specifier" \
  "const knex = require('knex');" excludes "knex"

# Resolution must settle on ONE target before any filter runs. If ./helper
# resolves to helper.js and that file is excluded, the collector must drop
# the reference — not walk on and inline helper/index.js while presenting it
# as what the import points at.
git checkout -q -B competing "$PUSH_SHA" >/dev/null 2>&1
echo "module.exports = { helper: 2 };" > server/services/helper.js
git add -A >/dev/null 2>&1; git commit -qm touch-helper >/dev/null 2>&1
SAVED_SHA="$AUDIT_SHA"; SAVED_BASE="$AUDIT_BASE"
AUDIT_SHA="$(git rev-parse HEAD)"; AUDIT_BASE="$PUSH_SHA"
expect "does not substitute helper/index.js when helper.js is changed" \
  "const h = require('./helper');" excludes "helper_index_substituted"
AUDIT_SHA="$SAVED_SHA"; AUDIT_BASE="$SAVED_BASE"
git checkout -q - >/dev/null 2>&1

# The same specifier twice must be inlined once, and must not fall through
# to the competing candidate on the second pass.
make_diff "const a = require('./helper'); const b = require('./helper');"
run_collect
HELPER_HITS="$(grep -ac '^----- server/services/helper.js' "$WORK/out.txt" 2>/dev/null || echo 0)"
if [ "$HELPER_HITS" = "1" ] && ! grep -qa "helper_index_substituted" "$WORK/out.txt"; then
  pass "a repeated import is inlined once and never falls through"
else
  fail "repeated import: helper.js inlined $HELPER_HITS time(s), or index.js substituted"
fi

# `++ counter;` reaches the patch as `+++ counter;`. Read as a file header
# it repoints the parser at a garbage path and every relative import after
# it resolves from the repo root — a nested ./helper silently becomes the
# root helper.js, inlined as authoritative.
{
  echo "diff --git a/server/services/nested/caller.js b/server/services/nested/caller.js"
  echo "--- /dev/null"
  echo "+++ b/server/services/nested/caller.js"
  echo "@@ -0,0 +1,2 @@"
  echo "+++ counter;"
  echo "+const h = require('./helper');"
} > "$WORK/diff.txt"
run_collect
if grep -qa "ROOT_HELPER" "$WORK/out.txt"; then
  fail "an added ++ line was read as a file header — resolved from the repo root"
elif grep -qa "NESTED_HELPER" "$WORK/out.txt"; then
  pass "an added ++ line is not mistaken for a file header"
else
  fail "resolved neither helper — the ++ case inlined nothing at all"
fi

# Node tries the EXACT path first, so that entry is the target even when it
# is a symlink or carries no usable extension. Rejecting it must drop the
# reference, never fall through to the same-named .js and present that as
# what the import points at.
expect "does not substitute widget.js for an extensionless symlink" \
  "const w = require('./widget');" excludes "widget_js_substituted"
expect "does not substitute gadget.js for an extensionless exact match" \
  "const g = require('./gadget');" excludes "gadget_js_substituted"

echo ""
echo "reads the audited commit, not the working tree:"

# A dirty working tree must not be able to substitute content.
echo "module.exports = { POLICY: 'DIRTY_WORKTREE' };" > server/config/models.js
make_diff "const m = require('../config/models');"
run_collect
if grep -qa "DIRTY_WORKTREE" "$WORK/out.txt"; then
  fail "inlines the DIRTY WORKING TREE instead of the audited commit"
else
  grep -qa "POLICY" "$WORK/out.txt" \
    && pass "ignores uncommitted edits and inlines the committed content" \
    || fail "inlined nothing at all with a dirty tree"
fi
git checkout -q -- server/config/models.js

# Auditing a ref that is not the checked-out branch.
git checkout -q -B other "$BASE_SHA" >/dev/null 2>&1
echo "module.exports = { POLICY: 'OTHER_BRANCH' };" > server/config/models.js
git commit -qam other >/dev/null 2>&1
OTHER_BASE="$(git rev-parse HEAD)"
echo "module.exports = {};" > server/services/other-caller.js
git add -A >/dev/null 2>&1; git commit -qm other2 >/dev/null 2>&1
OTHER_SHA="$(git rev-parse HEAD)"
git checkout -q - >/dev/null 2>&1
SAVED_SHA="$AUDIT_SHA"; SAVED_BASE="$AUDIT_BASE"
AUDIT_SHA="$OTHER_SHA"; AUDIT_BASE="$OTHER_BASE"
make_diff "const m = require('../config/models');"
run_collect
if grep -qa "OTHER_BRANCH" "$WORK/out.txt"; then
  pass "audits a ref that is not checked out from that ref's own tree"
else
  fail "did not read the pushed ref's content when it is not checked out"
fi
AUDIT_SHA="$SAVED_SHA"; AUDIT_BASE="$SAVED_BASE"

# No sha, no context — never a silent fall-back to the working tree.
SAVED_SHA="$AUDIT_SHA"; AUDIT_SHA=""
expect "emits nothing when given no commit" \
  "const m = require('../config/models');" excludes "POLICY"
AUDIT_SHA="$SAVED_SHA"

# A file git renders as BINARY has no `+++` header, so a parser that reads
# the patch text does not see it as changed and will inline its NEW contents
# under the "UNCHANGED, do not report findings" heading — a changed file that
# skips review. The changed set therefore comes from git metadata.
git checkout -q -B binmain "$PUSH_SHA" >/dev/null 2>&1
printf '\000module.exports={SECRET:"binary_payload_evaded_review"};\n' > server/services/helper.js
printf "const h = require('./helper');\n" > server/services/binary-caller.js
git add -A >/dev/null 2>&1
git commit -qm binary >/dev/null 2>&1
BIN_SHA="$(git rev-parse HEAD)"
git diff "$PUSH_SHA...$BIN_SHA" > "$WORK/diff.txt" 2>/dev/null
SAVED_SHA="$AUDIT_SHA"; SAVED_BASE="$AUDIT_BASE"
AUDIT_SHA="$BIN_SHA"; AUDIT_BASE="$PUSH_SHA"
run_collect
if grep -qa "binary_payload_evaded_review" "$WORK/out.txt"; then
  fail "inlines a CHANGED binary-rendered file as unchanged — it skips review"
else
  pass "a changed file git renders as binary is not inlined as unchanged"
fi
AUDIT_SHA="$SAVED_SHA"; AUDIT_BASE="$SAVED_BASE"
git checkout -q - >/dev/null 2>&1

# No base, no authoritative changed set — fail closed rather than fall back
# to reading the patch text.
SAVED_BASE="$AUDIT_BASE"; AUDIT_BASE=""
expect "emits nothing when given no base to diff against" \
  "const m = require('../config/models');" excludes "POLICY"
AUDIT_BASE="$SAVED_BASE"

echo ""
echo "caps and framing:"

CLAUDE_CONTEXT_MAX_BYTES=100
expect "honours the byte cap" \
  "const b = require('./big');" excludes "big"
CLAUDE_CONTEXT_MAX_BYTES=50000

CLAUDE_CONTEXT_MAX_FILES=0
expect "honours a zero file cap as a kill switch" \
  "const m = require('../config/models');" excludes "POLICY"
CLAUDE_CONTEXT_MAX_FILES=5

make_diff "const m = require('../config/models');"
run_collect
if grep -qa "NOT part of the diff" "$WORK/out.txt" && grep -qa "Do NOT raise findings" "$WORK/out.txt"; then
  pass "labels the section as unchanged and off-limits for findings"
else
  fail "the section does not tell the model these files are unchanged"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All referenced-context tests passed."
  exit 0
fi
echo "$FAILURES referenced-context test(s) FAILED — do not ship: this path pastes files into a prompt."
exit 1
