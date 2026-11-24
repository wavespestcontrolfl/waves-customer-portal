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

## Gate and how to undo

<!-- A gate only when the change needs one (waves-ship §6, owner 2026-11-05):
     it can text, email or call a customer; change a price; charge, invoice
     or refund; delete data; spend money (a paid API or service); add a new
     public link page (a /:token route); or it carries a named risk that
     needs an instant off switch. Then name the GATE_* (default OFF in prod,
     owner flips) and the reason. Everything else ships live: write
     "none — ships live".
     Then say how to undo this change: "revert + deploy", or name what a
     revert does NOT undo (a run migration, a sent message, a charge,
     deleted data). -->

## Encoded lesson

<!-- If this PR fixes a recurring class of issue — a repeated review finding,
     a second occurrence of a bug, an incident — name the check, test, lint
     rule, or skill that now prevents the CLASS, not just this instance
     (or say why none is warranted). "n/a" for feature work with no
     recurring class. -->
