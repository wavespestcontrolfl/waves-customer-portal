# Email reply monetary visit-pricing wording

`server/services/email/email-reply-monetary-verifier.js` exports
`verifyEmailReplyMonetaryPricing({ text = '', commercialProposal = false })`,
returning `{ ok, violations }`. A recognized amount-bearing visit price returns
`customer_copy_compliance`; customer pricing uses `per application`.

This inactive slice preserves the monetary pricing regressions from the
combined customer-copy policy. It recognizes currency amounts before and after
visit units, including modified visit nouns, singular/plural forms, possessive
prices such as `Each visit's price is$98`, and price or billing verbs. Monetary
forms include dollar symbols, USD prefixes/suffixes, and amounts followed by
`dollars` or `bucks`. Bare numbers match only with explicit pricing context,
such as `Each visit costs 98`; duration and photo counts remain valid.
Visit noun phrases allow at most eight modifiers and stop at clause words,
prepositions, determiners, and account/payment/access nouns. Thus an account
payment followed later by visit timing, such as `We received $98 for your
account before the next visit`, does not become a visit price.

The shared `email-reply-copy-normalizer` bounds raw input at 8,192 UTF-8 bytes,
512 whitespace-delimited tokens, and eight formatting passes before matching.
Normalization failures return their reason (`copy_type`, `copy_size`,
`copy_tokens`, or `copy_format_depth`) as the sole violation. They fail closed
even for a trusted commercial proposal; matching text is exempt only when
`commercialProposal` is the boolean `true`.

Amountless wording such as `Billing is per visit` belongs to the sibling
amountless policy and is intentionally accepted here. Per-application prices,
unrelated visit references, reminders, access discussions, and visit durations
also remain valid. This helper checks recognized wording, not arbitrary
natural-language meaning or the accuracy of monetary facts.

Company-name and report/regulatory policies are independent sibling slices.
This function does not check those policies, presentation, account facts, or
permission to create or send a draft. It has no runtime caller, provider call,
database write, or sending integration.

Run from the repository root with UTC:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-monetary-verifier.test.js`.
Tests use synthetic input and require no credentials or database.
