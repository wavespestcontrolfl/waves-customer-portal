# Email reply customer-copy policy

`server/services/email/email-reply-copy-verifier.js` exports
`verifyEmailReplyCustomerCopy({ text, commercialProposal = false })`, returning
`{ ok, violations }`. Only explicit boolean `commercialProposal: true` exempts
visit-price wording, matching the existing communications policy. A future
caller must supply that context from verified proposal data, not draft text.
Regulatory and company-name checks still apply to commercial proposals.
It checks visit-based price units, retired company names, and existing
report/customer regulatory copy. It shares the existing previsit company-name
patterns through `server/services/customer-company-name.js`; previsit matching
is unchanged by that extraction. It reuses `findBannedCustomerCopy` and
`reentrySafetyClaimFinding` rather than maintaining another list of their
claims. Unicode dashes are folded before matching, so pasted punctuation
does not change the outcome. Paired inline Markdown emphasis delimiters are
removed before copy screening, so formatting cannot hide a rendered banned
phrase; stray unmatched punctuation is left in place. Explicit truncated
company forms `Waves Lawn Care` and `Waves Pest Services` are screened here
without changing the shared previsit name rules. A price per application and an unrelated
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
20 and UTC: `TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-copy-verifier.test.js`.
