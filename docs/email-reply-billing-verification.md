# Email reply amountless billing wording

`server/services/email/email-reply-billing-verifier.js` exports
`verifyEmailReplyBilling({ text = '', commercialProposal = false })`, returning
`{ ok, violations }`. It rejects explicit amountless visit-billing language
with `customer_copy_compliance`, including billing or price terms followed by a
per-visit unit and visit-first statements such as `Our visits are billed
separately` or `Our visits were charged individually`.

The helper consumes `recognizeEmailReplyPricingClauses`, the shared bounded
normalization and clause-recognition prerequisite. It screens canonical token
kinds within each clause instead of maintaining a separate raw-text visit
grammar. A recognition failure rejects with its reason (`copy_type`,
`copy_size`, `copy_tokens`, or `copy_format_depth`) and no partial clause is
screened. This fail-closed result applies even when trusted
commercial-proposal context is present.

Only explicit boolean `commercialProposal: true` exempts recognized billing
wording. A future caller must obtain that context from trusted proposal data;
words in the draft cannot grant the exemption. Ordinary reminders, access
discussions, feedback uses of `rate`, and per-application billing remain valid.
Visit modifiers are capped at eight words and stop at clause, preposition, or
determiner boundaries, so a payment reminder such as `pay the outstanding
balance before our next visit` is not mistaken for per-visit billing. Stop
words must be complete whitespace-delimited tokens; compounds such as
`on-site`, `in-home`, and `after-hours` remain valid visit modifiers. Include
and cover predicates also end the phrase, so plan coverage is not treated as a
billing unit. A singular `on your next visit` is payment timing; recurring
forms such as `on each visit` remain subject to the policy. Singular invoice,
payment, and charge references such as `this invoice is for your recent visit`
are likewise outside the recurring-unit policy. Billing labels accept bounded
colon, comma, and dash separators, including after a copula. Bare `rate` is
classified as billing only with an explicit visit unit, preserving feedback
requests such as `Please rate each visit` and `Please rate, for each visit, how
we did`. Recipient objects may intervene between a billing verb and the unit
(`bill you per visit`, `invoice your account for every visit`). The inverse
`per-visit fee` form is also screened, as are `by visit` and
`visit-by-visit` units. The bounded scheduling idiom `pay you a visit` is not
a billing unit, while `pay you per visit` and `pay you for each visit` are.
Separate-billing language is screened with the adverb before or after the
billing verb, including `get`, `gets`, `got`, and perfect passive forms. This
also covers separate payment wording and bounded nominal predicates such as a
visit having a separate charge, incurring a fee, or generating its own
invoice. Bounded `occurs`, `applies`, and `frequency is` connectors join a
billing term to an explicit unit. The explicit unit remains prohibited when
connected by bounded `not` or `never` negation. Duration modifiers accept
hyphenated and spaced numeric forms such as `30-minute` and `30 minute`.
Recipient and inverse-noun determiners are bounded, including `each`, `every`,
and `any`. Connector auxiliaries accept emphatic/perfect forms and negation;
separate adverbs may precede the copula. Possessive fees also follow `incur`.
Consecutive separators remain within the scanner token bound. Direct-object
feedback about a technician or service remains valid after a fronted unit.

Monetary recognition belongs to the separately reviewed monetary sibling, but
the lexical policies can overlap: `The $98 fee is per visit` contains the
amountless `fee is per visit` form and is rejected here too. The local
composition check deduplicates the shared `customer_copy_compliance` violation;
a future combined verifier must do the same. This slice does not add broad
monetary-anchor parsing merely to divide that overlap;
amount-only forms such as `$98 per visit`, `the rate is 98 per visit`, or `each
visit is billed at 98` remain the monetary sibling's responsibility. It also
does not check presentation, company names, regulatory language, account facts,
or permission to create or send a draft. No runtime caller, provider request,
database access, or sending integration is included.

The 139-case frozen billing corpus from `8abbfb605c` remains covered, with
separate R5 cases for recipients, modal passives, punctuated feedback,
inverse unit placement, and by-visit wording. This adapter has no runtime
caller or monetary parser of its own.

Run from the repository root with UTC:
`TZ=UTC node node_modules/jest/bin/jest.js --runInBand --no-coverage server/tests/email-reply-billing-verifier.test.js`.
Tests use synthetic input and require no credentials or database.
