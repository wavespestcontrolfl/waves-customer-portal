# Inactive monetary pricing findings

`inspectEmailReplyMonetaryPricing({ text = '', commercialProposal = false } = {})`
consumes the shared price-evidence recognizer once. It returns only
`{ disposition: 'needs_review', violations }`. It has no approval flag:
absence of a violation is not permission to send, including for empty or
unrecognized text. No runtime caller or customer communication is added.

A recognized visit-family monetary candidate produces
`customer_copy_compliance`. Application, timing, and period families do not
produce this policy's violation. Amount-free billing and plan totals belong
to separate consumers. The shared recognizers own all vocabulary, amount
context, connectors and candidate eligibility; this consumer has no parser.

Only the strict trusted option `commercialProposal === true` exempts a
recognized monetary finding. Text claiming to be commercial is not trusted.
The exemption does not bypass normalization limits or the review disposition.
Scanner failures return their original reason in `violations`.

This policy does not check company names, regulatory language, presentation,
account facts, or every possible English pricing construction. The inherited
finite grammar, amount and newline limits remain. Every result still needs
review, so unknown phrasing cannot become a compliant/sendable result here.

The test suite preserves all 390 frozen monetary tests and their original
violation expectations. A test-only projection checks their historical
`{ok,violations}` assertions while also requiring `needs_review` and absence
of an `ok` field on every actual result. Six R5 regression cases are added.
No compatibility wrapper ships in production.
