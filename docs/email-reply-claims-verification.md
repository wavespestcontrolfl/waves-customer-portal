# Email reply report and regulatory claims policy

`server/services/email/email-reply-claims-verifier.js` exports
`verifyEmailReplyClaims({ text })`, returning `{ ok, violations }`.
It is an inactive, copy-only policy with no customer or account context.

The helper reuses the canonical `findBannedCustomerCopy` report screen and
`reentrySafetyClaimFinding` instead of maintaining another list of those
claims. Unicode dashes are folded before report screening. Paired inline
Markdown emphasis delimiters are removed so rendered formatting cannot hide a
banned phrase; stray unmatched punctuation is left in place. EPA certification
wording is rejected in direct, reverse, and possessive forms, including both
`EPA's certification` and `EPA’s certification`. `EPA-registered` and
`EPA-exempt` remain valid.

The canonical report-copy policy rejects `resolved` without a subject check.
This inactive helper conservatively retains that ban, including copy such as
`billing resolved`. A subject-aware distinction requires contextual review;
this text-only API has no facts from which to establish the subject.

Passing the policy does not prove an account status, treatment fact, schedule,
or other claim accurate. Pricing units and company names belong to separately
reviewed sibling policies. This slice adds no runtime caller, model request,
database access, shared-policy change, or draft/send authorization.

This recut preserves the report and regulatory behavior from the complete
combined implementation on PR #4532, `feat/email-reply-copy-policy` at
`f1da996589`, and fixes its outstanding possessive EPA-certification finding.

Run the dedicated synthetic regressions from the repository root with Node 20
and UTC: `TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-claims-verifier.test.js`.
