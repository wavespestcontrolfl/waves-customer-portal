# Email reply report and regulatory claims policy

`server/services/email/email-reply-claims-verifier.js` exports
`verifyEmailReplyClaims({ text })`, returning `{ ok, violations }`.
It is an inactive, copy-only policy with no customer or account context.

The helper reuses the canonical `findBannedCustomerCopy` report screen and
`reentrySafetyClaimFinding` instead of maintaining another list of those
claims. HTML character references are decoded, Unicode dashes are folded, and
rendered whitespace is collapsed before report screening. Whitespace around an
EPA claim dash is collapsed into the rendered compound. Paired inline Markdown
emphasis and inline-code delimiters are removed so formatting cannot hide a
banned phrase; line endings inside code spans render as spaces. CommonMark
escapes before ASCII punctuation are rendered before screening; unmatched
marks, backslashes, and escapes before nonpunctuation characters remain in
place. EPA certification wording is rejected in singular and plural direct,
reverse, and possessive forms. Bounded direct modifiers include `recently` and
`formally`; possessive modifiers include `full`, `formal`, and `official`.
`EPA-registered` and `EPA-exempt` remain valid, including rendered entity,
escaped, spaced-dash, and inline-code forms.

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
