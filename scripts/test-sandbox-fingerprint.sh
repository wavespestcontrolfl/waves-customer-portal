#!/usr/bin/env bash
# Regression tests for the fallback-auditor sandbox fingerprint tripwire.
#
# WHY THIS EXISTS
# The pre-push hook warns when the sandbox it is about to run differs from
# the one scripts/verify-fallback-auditor-sandbox.sh last actually proved.
# That warning is only worth anything if the fingerprint moves when the
# sandbox moves. It did not: an earlier version hashed only the three
# assignments, so deleting `env -i` or $CLAUDE_SANDBOX_FLAGS from the real
# `claude -p` command left the number identical, the stamp still matched,
# and nothing warned before an untrusted diff went into a weakened sandbox.
#
# The other half matters just as much and pulls the opposite way: a
# fingerprint that also moves when someone merely re-indents the command
# warns on every unrelated edit, and a warning that is always on is a
# warning nobody reads. So both directions are pinned here.
#
# No model calls, no network, runs in well under a second.
#
#   scripts/test-sandbox-fingerprint.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/hooks/pre-push"
TOOL="$SCRIPT_DIR/hooks/sandbox-fingerprint.sh"
WORK="$(mktemp -d -t sandbox-fp.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURES=$((FAILURES + 1)); }

[ -f "$HOOK" ] || { echo "FAIL: cannot find $HOOK"; exit 1; }
[ -f "$TOOL" ] || { echo "FAIL: cannot find $TOOL"; exit 1; }

fp() { bash "$TOOL" "$1" 2>/dev/null; }

BASE="$(fp "$HOOK")"
if [ -n "$BASE" ]; then
  pass "the real hook produces a fingerprint"
else
  fail "the real hook produces a fingerprint (got nothing)"
  echo "$FAILURES test(s) FAILED."; exit 1
fi

# $1 = label, $2 = sed program, $3 = "differs" | "same"
mutate() {
  local label="$1" program="$2" expect="$3" file="$WORK/hook" got
  sed "$program" "$HOOK" > "$file"
  # A sed that matched nothing would leave the file identical and quietly
  # "pass" the `same` cases, so every mutation must really change the text.
  if cmp -s "$file" "$HOOK"; then
    fail "$label — the test's own sed matched nothing, so this proves nothing"
    return
  fi
  got="$(fp "$file")"
  if [ -z "$got" ]; then
    fail "$label — mutated hook produced no fingerprint at all"
    return
  fi
  case "$expect" in
    differs)
      if [ "$got" != "$BASE" ]; then pass "$label changes the fingerprint"
      else fail "$label does NOT change the fingerprint — the tripwire is blind to it"; fi ;;
    same)
      if [ "$got" = "$BASE" ]; then pass "$label leaves the fingerprint alone"
      else fail "$label changes the fingerprint — the tripwire will cry wolf"; fi ;;
  esac
}

# The invocation is the sandbox. These are the edits that used to be silent.
mutate "dropping env -i from the invocation" \
  's/env -i "${claude_env\[@\]}" claude -p/claude -p/' differs
mutate "dropping \$CLAUDE_SANDBOX_FLAGS from the invocation" \
  's/^           \$CLAUDE_SANDBOX_FLAGS \\$/           \\/' differs
mutate "dropping --disallowedTools from the invocation" \
  's/^           --disallowedTools "\$CLAUDE_DISALLOWED_TOOLS" \\$/           \\/' differs

# The three assignments still count too.
mutate "weakening CLAUDE_SANDBOX_FLAGS" \
  's/^CLAUDE_SANDBOX_FLAGS="--restricted --strict-mcp-config"$/CLAUDE_SANDBOX_FLAGS="--restricted"/' differs
mutate "adding a name to CLAUDE_ENV_ALLOW" \
  's/^CLAUDE_ENV_ALLOW="HOME /CLAUDE_ENV_ALLOW="STRIPE_SECRET_KEY HOME /' differs
mutate "removing a tool from CLAUDE_DISALLOWED_TOOLS" \
  's/^CLAUDE_DISALLOWED_TOOLS="Bash /CLAUDE_DISALLOWED_TOOLS="/' differs

# ...and cosmetic edits must not, or the warning becomes noise.
mutate "re-indenting a line of the invocation" \
  's/^           \$CLAUDE_SANDBOX_FLAGS \\$/             \$CLAUDE_SANDBOX_FLAGS \\/' same

# Failing to compute must be an error, never an empty string that compares
# equal to another empty string and reads as "no drift".
if bash "$TOOL" "$WORK/does-not-exist" >/dev/null 2>&1; then
  fail "a missing hook file should exit non-zero"
else
  pass "a missing hook file exits non-zero"
fi

grep -v 'claude -p' "$HOOK" > "$WORK/no-invocation"
if bash "$TOOL" "$WORK/no-invocation" >/dev/null 2>&1; then
  fail "a hook with no claude -p invocation should exit non-zero"
else
  pass "a hook with no claude -p invocation exits non-zero"
fi

# Both callers must go through this helper; an inline copy in either one is
# how the stamp and the runtime check drift apart.
if grep -q 'sandbox-fingerprint.sh' "$HOOK"; then
  pass "the hook computes its fingerprint via the shared helper"
else
  fail "the hook no longer calls the shared helper"
fi
if grep -q 'sandbox-fingerprint.sh' "$SCRIPT_DIR/verify-fallback-auditor-sandbox.sh"; then
  pass "the verifier stamps the fingerprint from the shared helper"
else
  fail "the verifier no longer calls the shared helper"
fi

# Calling the helper is not enough if a second copy of the extraction is
# sitting next to the call. The verifier asserts the sandbox components
# against the invocation and the helper hashes it; a duplicated awk pattern
# is how those two quietly stop describing the same command.
if grep -q 'in_fn && /\[\[:space:\]\]claude -p' "$SCRIPT_DIR/verify-fallback-auditor-sandbox.sh"; then
  fail "the verifier carries its own copy of the invocation-extraction awk"
else
  pass "the verifier has no duplicate copy of the invocation-extraction awk"
fi

# The extraction mode has to actually return the command, or the verifier's
# component assertions are checking an empty string and passing vacuously.
INVOCATION="$(bash "$TOOL" --print-invocation "$HOOK" 2>/dev/null)"
MISSING=""
for component in 'env -i "${claude_env[@]}" claude -p' '$CLAUDE_SANDBOX_FLAGS' '--disallowedTools "$CLAUDE_DISALLOWED_TOOLS"'; do
  case "$INVOCATION" in
    *"$component"*) ;;
    *) MISSING="$MISSING $component" ;;
  esac
done
if [ -z "$MISSING" ]; then
  pass "--print-invocation returns the command with every sandbox component in it"
else
  fail "--print-invocation is missing:$MISSING"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All sandbox-fingerprint tests passed."
  exit 0
fi
echo "$FAILURES sandbox-fingerprint test(s) FAILED — the drift tripwire is not trustworthy."
exit 1
