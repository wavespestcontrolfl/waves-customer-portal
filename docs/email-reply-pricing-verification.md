# Email reply visit-pricing wording

`server/services/email/email-reply-pricing-verifier.js` exports
`verifyEmailReplyPricing({ text, commercialProposal = false })`, returning
`{ ok, violations }`. A recognized visit-based price returns
`customer_copy_compliance`; customer pricing uses `per application`.

This inactive slice preserves the pricing regressions from the combined
customer-copy PR #4532 at `f1da996589`. It recognizes prices before and after
visit units, including modified visit nouns, singular/plural forms, and
price/billing verbs without an amount. Monetary forms include dollar symbols,
USD prefixes/suffixes, and amounts followed by `dollars` or `bucks`; the USD
prefix and bucks forms match the established vocabulary in `comms-lint.js`.
Unicode typography and paired inline Markdown emphasis are normalized.

Only explicit boolean `commercialProposal: true` exempts visit-price wording.
A future caller must obtain that context from trusted proposal data; words in
the draft cannot grant the exemption. A per-application price and unrelated
visit reference remain valid, as do ordinary reminders and access discussions.

The existing communications linter applies a broader blanket `per visit` rule
to its callers. This email-specific policy requires pricing context, preserving
the approved reply examples such as `one reminder per visit`. That existing
linter and its callers are unchanged. This helper checks recognized wording,
not arbitrary natural-language meaning or the accuracy of monetary facts.

Company-name and report/regulatory policies are independent sibling slices.
This function does not check those policies, presentation, account facts, or
permission to create/send a draft. No runtime caller, provider call, database
write, or sending integration is included. Empty text is not a pricing
violation; the separate presentation helper checks reply completeness.

Run from `server/` with UTC:
`TZ=UTC node ../node_modules/jest/bin/jest.js --runInBand --no-coverage tests/email-reply-pricing-verifier.test.js`.
Tests use synthetic input and require no credentials or database.
