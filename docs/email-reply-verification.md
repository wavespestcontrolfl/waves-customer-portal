# Email reply structure checks

`server/services/email/email-reply-verifier.js` exports
`verifyEmailReplyStructure({text, customer, wordBudget})` and `wordCount`.
The checker returns `{ok, violations}` for the complete visible reply.
`customer.firstName`, when supplied, determines the expected greeting.

This first slice checks reply budget, greeting, HTML/bullets, boilerplate,
recognized instruction-like content, signatures, links/access codes and
existing customer-copy rules. It reuses the canonical customer-copy and
report-access-code helpers. Customer-copy and boilerplate checks normalize
Unicode dashes and apostrophes; greetings fold the same punctuation on both
sides, and credential screening folds compatibility digits. Boilerplate
screening also folds internal whitespace. Regression cases cover equivalent visit-based
price units, common closing phrases and dashed names, plus-prefixed bullets,
HTML comments/declarations, and Markdown links with relative or fragment
destinations. Paired plain-prose cases protect ordinary mentions of visits,
names, punctuation, and bracketed placeholders.

Word-separating dashes count toward the budget; hyphenated compounds remain
one word. Outbound prompt-control screening is intentionally separate from
`sms-shadow-drafter`'s stricter exemplar-admission screen: legitimate customer
preparation corrections can refer to previous instructions. Pricing-unit
checks require a price or pricing noun, so reminders per visit remain valid.

This is a structure check, not fact verification. It does not validate
amounts, statuses, dates, arrival windows, technician names, placeholders or
facts copied from examples. A successful result must not authorize draft
creation or sending. No runtime caller is added; the module makes no model
request, database write or Gmail call.

The remaining work will add separately reviewed financial and scheduling
checks, followed by complete verification and the shared drafter. The
original implementation and its full regression suite remain preserved on
`feat/email-reply-verifier` at `d47770a57e`. Its unresolved review findings
remain assigned to their financial/scheduling slices. Runtime activation
requires separate evaluation and approval.

Run from `server/` with Node 20 and `TZ=UTC`:
`node ../node_modules/jest/bin/jest.js --runInBand --no-coverage tests/email-reply-verifier.test.js`.
The tests use synthetic inputs and require no provider/database credentials.
