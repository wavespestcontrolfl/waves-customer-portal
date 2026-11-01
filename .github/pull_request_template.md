## Summary

<!-- What changed and why. Link the issue / owner ask if there is one. -->

## Verification

<!-- What was actually run and observed: suites, live flows driven, screenshots.
     If a step was skipped or impossible (e.g. no dev DATABASE_URL in the
     sandbox), say so explicitly — never imply it happened. -->

## Live records hit

<!-- If this PR refuses, hides or narrows something a customer can do (sign,
     pay, book, view a page), say how many live records it hits today and how
     you counted them (commercial proposals: the read-only MCP tool
     list_commercial_proposals). A hit list goes to the owner before the merge.
     "n/a" otherwise. (Owner 2026-11-01: a signing guard changed a live
     customer page at deploy time and nobody knew.) -->

## Kill switch / gate

<!-- User-visible behavior ships dark behind a GATE_* env var or feature flag,
     default OFF in prod (owner flips). Name it here, or "none — not
     user-visible". -->

## Encoded lesson

<!-- If this PR fixes a recurring class of issue — a repeated review finding,
     a second occurrence of a bug, an incident — name the check, test, lint
     rule, or skill that now prevents the CLASS, not just this instance
     (or say why none is warranted). "n/a" for feature work with no
     recurring class. -->
