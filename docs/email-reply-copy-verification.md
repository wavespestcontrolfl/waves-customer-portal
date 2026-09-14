# Email reply customer-copy policy

`server/services/email/email-reply-copy-verifier.js` exports
`verifyEmailReplyCustomerCopy({ text })`, returning `{ ok, violations }`.
It checks visit-based price units, retired company names, and existing
report/customer regulatory copy. It reuses `findBannedCustomerCopy` and
`reentrySafetyClaimFinding` rather than maintaining another list of their
claims. Unicode dashes are folded before matching, so pasted punctuation
does not change the outcome. A price per application and an unrelated
reference to a visit remain valid.

The canonical report-copy policy rejects `resolved` without a subject check.
This inactive helper conservatively retains that ban, including for billing
or account prose. A subject-aware distinction requires contextual review;
this copy-only API has no facts from which to establish the subject.

Passing the policy does not prove the price, account status, treatment,
or any other claim accurate. It does not validate presentation, greeting,
links, access codes, or prompt instructions. No runtime caller, model call,
database write, or send authorization is included in this slice.

Run the dedicated synthetic regressions from the repository root with Node
20 and UTC: `TZ=UTC /opt/homebrew/opt/node@20/bin/node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-copy-verifier.test.js`.
