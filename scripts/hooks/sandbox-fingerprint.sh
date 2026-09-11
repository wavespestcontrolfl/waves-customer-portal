#!/usr/bin/env bash
# Single source of truth for the fallback-auditor sandbox fingerprint.
#
# WHY IT IS ITS OWN FILE
# Two places need this number and they must never disagree: the pre-push
# hook computes it on every fallback run to decide whether to warn about
# drift, and scripts/verify-fallback-auditor-sandbox.sh computes it to stamp
# what it actually proved. If each carried its own copy of the extraction,
# a change to one would read as permanent drift in the other — a warning
# that is always on is a warning nobody reads. One implementation, both
# callers.
#
# WHAT IT COVERS, AND WHY THAT IS MORE THAN THE THREE VARIABLES
# An earlier version hashed only CLAUDE_SANDBOX_FLAGS, CLAUDE_ENV_ALLOW and
# CLAUDE_DISALLOWED_TOOLS. That left a hole: the assignments are not the
# sandbox, the INVOCATION is. Dropping `env -i` or $CLAUDE_SANDBOX_FLAGS
# from the actual `claude -p` command while leaving the assignments untouched
# kept the fingerprint identical, so the stamp still matched and the hook
# said nothing before feeding an untrusted diff to a weakened sandbox. The
# verifier catches that, but only when someone remembers to run it. So the
# extracted invocation is hashed too, and any edit to it trips the tripwire.
#
# Everything is read out of the hook FILE rather than from the caller's live
# variables, so the hook and the verifier hash the same bytes.
#
# Usage: sandbox-fingerprint.sh [--print-invocation] <path-to-pre-push-hook>
# Prints the fingerprint on stdout, or with --print-invocation the extracted
# `claude -p` command it hashes. That second mode exists so the verifier can
# assert the sandbox components against the SAME extraction that gets hashed
# and stamped, instead of keeping a second copy of the awk here-too. A copy
# is how the assertion and the fingerprint quietly stop describing the same
# command.
# Exits non-zero with a message on stderr if any component cannot be found.
set -u

MODE="fingerprint"
if [ "${1:-}" = "--print-invocation" ]; then
  MODE="invocation"
  shift
fi

HOOK="${1:-}"
[ -n "$HOOK" ]  || { echo "sandbox-fingerprint: usage: $0 <path-to-pre-push-hook>" >&2; exit 2; }
[ -r "$HOOK" ]  || { echo "sandbox-fingerprint: cannot read $HOOK" >&2; exit 2; }

hook_var() { sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$HOOK" | head -1; }

FLAGS="$(hook_var CLAUDE_SANDBOX_FLAGS)"
ENV_ALLOW="$(hook_var CLAUDE_ENV_ALLOW)"
DISALLOWED="$(hook_var CLAUDE_DISALLOWED_TOOLS)"

[ -n "$FLAGS" ]      || { echo "sandbox-fingerprint: no CLAUDE_SANDBOX_FLAGS in $HOOK" >&2; exit 1; }
[ -n "$ENV_ALLOW" ]  || { echo "sandbox-fingerprint: no CLAUDE_ENV_ALLOW in $HOOK" >&2; exit 1; }
[ -n "$DISALLOWED" ] || { echo "sandbox-fingerprint: no CLAUDE_DISALLOWED_TOOLS in $HOOK" >&2; exit 1; }

# The same extraction the verifier asserts against: the `claude -p` command
# inside run_claude_audit, from the line it starts on to the backgrounding &.
# Whitespace is squeezed so re-indenting the command does not read as a
# sandbox change, while every token in it still does.
INVOCATION="$(awk '
  /^run_claude_audit\(\)/ { in_fn = 1 }
  in_fn && /[[:space:]]claude -p([[:space:]]|$)/ { in_cmd = 1 }
  in_cmd { print }
  in_cmd && /&[[:space:]]*$/ { exit }
' "$HOOK" | tr '\n' ' ' | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')"
[ -n "$INVOCATION" ] || { echo "sandbox-fingerprint: no claude -p invocation inside run_claude_audit in $HOOK" >&2; exit 1; }

if [ "$MODE" = "invocation" ]; then
  printf '%s\n' "$INVOCATION"
  exit 0
fi

printf '%s|%s|%s|%s' "$FLAGS" "$ENV_ALLOW" "$DISALLOWED" "$INVOCATION" \
  | (shasum -a 256 2>/dev/null || sha256sum 2>/dev/null) | awk '{print $1}'
