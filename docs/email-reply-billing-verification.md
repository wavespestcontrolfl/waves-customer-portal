# Email reply amountless billing wording

`server/services/email/email-reply-billing-verifier.js` exports
`verifyEmailReplyBilling({ text = '', commercialProposal = false })`, returning
`{ ok, violations }`. It rejects explicit amountless visit-billing language
with `customer_copy_compliance`, including billing or price terms followed by a
per-visit unit and visit-first statements such as `Our visits are billed
separately` or `Our visits were charged individually`.

The helper consumes the bounded `normalizeEmailReplyCopy` prerequisite. A
normalization failure rejects with its reason (`copy_type`, `copy_size`,
`copy_tokens`, or `copy_format_depth`) and no partial text is screened. This
fail-closed result applies even when trusted commercial-proposal context is
present.

Only explicit boolean `commercialProposal: true` exempts recognized billing
wording. A future caller must obtain that context from trusted proposal data;
words in the draft cannot grant the exemption. Ordinary reminders, access
discussions, feedback uses of `rate`, and per-application billing remain valid.

Monetary clauses such as `$98 per visit`, `the rate is 98 per visit`, or `each
visit is billed at 98` belong to the separately reviewed monetary sibling and
are deliberately outside this verifier. It also does not check presentation,
company names, regulatory language, account facts, or permission to create or
send a draft. No runtime caller, provider request, database access, or sending
integration is included.

This recut preserves the amountless billing behavior from the frozen pricing
source at `4f944d3868` and adds the unresolved plural-copula cases without
changing the shared normalizer.

Run from the repository root with UTC:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-billing-verifier.test.js`.
Tests use synthetic input and require no credentials or database.
